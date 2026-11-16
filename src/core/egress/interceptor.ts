/**
 * 出站拦截器 —— 把 `globalThis.fetch` 包一层「按绑定选出口」的路由。
 *
 * ## 为什么是全局 fetch 而不是逐适配器注入
 *
 * 本仓库是薄胶水：适配器由上游插件在 `apply()` 内部构造，宿主拿不到构造
 * 点，逐个传 `fetchImpl` 意味着 fork 上游。而上游所有未配代理的平台都落到
 * `fetchImpl ?? fetch` —— ESM 里裸 `fetch` 是**调用时**的全局查找，宿主在
 * 装插件**之前**替换 `globalThis.fetch`，全部适配器（以及探测/续期/积分腿）
 * 都会经过这一层。上游自己也把「宿主包装 fetch」当兼容场景守着
 * （qoder `baselineFetch` 修复，commit b9f57a0f0）。
 *
 * ## 判定顺序（每个请求）
 *
 * 1. URL 不是绝对 http(s) ⇒ 原样直通（本地请求、相对 URL 不归我们管）；
 * 2. 头/URL 里的鉴权材料命中**凭据索引** ⇒ 该账号的 `accounts` 绑定；
 * 3. 未命中 ⇒ URL host 反查平台，命中 `platforms` 绑定；
 * 4. 都没有 ⇒ 直通原始 fetch。
 *
 * 命中代理后走**上游 `proxyFetch`**（undici 同源 dispatcher；HTTP(S) 与
 * SOCKS5 双栈）。⚠️ 上游五家自带代理的请求在设了上游代理时走的是
 * `proxyFetch` 内部的 undici fetch、**不经过本层** —— 优先级天然是
 * 「上游自带 > 本层账号级 > 本层平台级 > 直连」，无需额外裁决。
 *
 * ## 失败语义（刻意保守）
 *
 * - 绑定的代理**地址本身不合法** ⇒ 记一条告警后**直通**（不让一个手误
 *   打死整条渠道）；
 * - 代理**连通失败** ⇒ 原样抛出，**绝不回退直连**：POST 有副作用，静默换
 *   出口重发等于一次请求打两份；且「墙外渠道配了代理但代理挂了」应当
 *   显式报错，而不是悄悄共用原出口把额度烧在同一 IP 上。
 *
 * ## 已知不覆盖的传输层
 *
 * - opencode 的 Bun 指纹腿（`wreq-js` 子进程，设了上游代理时才启用）；
 * - 个别用 `node:https` 的腿（officeace-auth / monkeycode-http）。
 *   它们不经过本层，行为与改造前一致。
 */

import { loadUpstreamProxyModule, type UpstreamProxyModule } from "./proxy-fetch.ts"
import { candidateMaterials, createCredentialIndex, type CredentialIndex } from "./credential-index.ts"
import { PLATFORM_HOSTS, platformsForUrl } from "./platform-hosts.ts"
import { createBindingsStore, type BindingsStore } from "./bindings.ts"

export interface EgressOptions {
  /** 状态目录（`<home>`）。 */
  home: string
  logger?: Pick<Console, "info" | "warn" | "error">
}

/** 拦截器句柄：测试与关闭用。 */
export interface EgressInterceptor {
  /** 恢复原装 `globalThis.fetch`。幂等。 */
  uninstall(): void
  /** 内部依赖（测试窥视用，不对外承诺形状）。 */
  readonly internals: {
    bindings: BindingsStore
    credentials: CredentialIndex
    upstream: UpstreamProxyModule
  }
}

/**
 * 安装出站拦截器。必须在 `createHost()`（装载上游插件）**之前**调用，
 * 让插件内模块首次调用 `fetch` 时拿到的就是包装后的版本。
 *
 * @returns 句柄；任何一步失败都会抛（启动期失败好过静默不生效）。
 */
export async function installEgressInterceptor(options: EgressOptions): Promise<EgressInterceptor> {
  const logger = options.logger ?? console
  const upstream = await loadUpstreamProxyModule()
  const bindings = createBindingsStore(options.home)
  const credentials = createCredentialIndex(options.home)
  const original = globalThis.fetch

  /** 选出口：返回要走的代理（已归一化），undefined = 直通。 */
  async function chooseProxy(input: unknown, init: RequestInit | undefined): Promise<unknown | undefined> {
    // ① URL 判据：相对 URL / 非 http(s) 不归本层。
    let urlText: string | undefined
    try {
      if (typeof input === "string") urlText = input
      else if (input instanceof URL) urlText = input.href
      else if (input instanceof Request) urlText = input.url
    } catch {
      urlText = undefined
    }
    if (urlText === undefined) return undefined
    let parsed: URL
    try {
      parsed = new URL(urlText)
    } catch {
      return undefined
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined

    // ② 账号级：请求头/URL 里的鉴权材料 ↔ 凭据索引。
    let provider: string | undefined
    let accountId: string | undefined
    const headers =
      init?.headers !== undefined ? new Headers(init.headers) : input instanceof Request ? input.headers : undefined
    for (const material of candidateMaterials(parsed.href, headers)) {
      const owner = await credentials.ownerOf(material)
      if (owner !== undefined) {
        provider = owner.provider
        accountId = owner.accountId
        break
      }
    }
    if (accountId === undefined && provider === undefined) {
      // ③ 平台级兜底：host 反查（共享域名可能有多个候选，见 platformsForUrl）。
      const bound = await firstPlatformBinding(platformsForUrl(parsed))
      if (bound !== undefined) return bound.proxy
      return undefined
    }

    // ④ 查绑定（先账号级、后平台级，见 bindings.resolve）。
    const bound = await bindings.resolve(provider, accountId)
    if (bound === undefined) return undefined
    const normalized = upstream.normalizeProxy(bound)
    if (!normalized.ok) {
      // 地址不合法：直通 + 告警。代理字符串来自用户配置，逐请求打会刷屏，
      // 但这是配置错误，宁可吵也不能无声。
      logger.warn(
        `[egress] 绑定的代理地址无效，已回退直连：${provider ?? "?"}${accountId ? `/${accountId}` : ""} — ${normalized.reason}`,
      )
      return undefined
    }
    return normalized.proxy

    /** 依次试各候选平台的平台级绑定，返回第一个有效的归一化代理。 */
    async function firstPlatformBinding(candidates: readonly string[]): Promise<{ proxy: unknown } | undefined> {
      for (const candidate of candidates) {
        const url = await bindings.resolve(candidate, undefined)
        if (url === undefined) continue
        const normalized = upstream.normalizeProxy(url)
        if (!normalized.ok) {
          logger.warn(`[egress] 绑定的代理地址无效，已回退直连：${candidate}（平台级） — ${normalized.reason}`)
          continue
        }
        return { proxy: normalized.proxy }
      }
      return undefined
    }
  }

  const wrapped: typeof fetch = async (input, init) => {
    let proxy: unknown
    try {
      proxy = await chooseProxy(input, init)
    } catch (error) {
      // 判定层自身的意外错误绝不能拖垮业务请求：记日志、直通。
      logger.warn(`[egress] 出口判定异常，已回退直连：${String(error)}`)
      proxy = undefined
    }
    if (proxy === undefined) return original(input as any, init)
    // 请求体可能是流：proxyFetch 原样转发 init，我们也不触碰 body。
    return upstream.proxyFetch(input as any, init, proxy)
  }

  globalThis.fetch = wrapped
  logger.info(
    `[egress] 出站代理拦截器已安装（平台表 ${Object.keys(PLATFORM_HOSTS).length} 个平台；` +
      `在 ${options.home}/proxy-bindings.json 配置绑定）`,
  )

  return {
    uninstall() {
      if (globalThis.fetch === wrapped) globalThis.fetch = original
    },
    internals: { bindings, credentials, upstream },
  }
}
