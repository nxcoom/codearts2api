/**
 * 出口代理管理 REST 控制器（挂在 /admin/proxy/api 下）。
 *
 * ## 与上游五家自带代理的关系
 *
 * opencode / gemini / minimax / qoder / monkeycode 五家在上游渠道设置里
 * **本来就**有每账号代理入口（走它们自己的池字段与 `proxyFetch`）。本接口
 * 管的是宿主侧的**两级绑定**（账号级 + 平台级），覆盖其余全部平台，也
 * 兼容这五家（设了上游代理时上游优先 —— 见拦截器说明）。前端把五家标为
 * 「渠道自带」，提示用户优先用渠道内设置。
 */

import express from "express"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { sendJson } from "../../http/respond.ts"
import { loadUpstreamProxyMask, loadUpstreamProxyModule } from "../../core/egress/proxy-fetch.ts"
import { createBindingsStore, type BindingsStore } from "../../core/egress/bindings.ts"
import { PLATFORM_HOSTS } from "../../core/egress/platform-hosts.ts"

/** 上游自带每账号代理的渠道（提示文案用；权威实现在上游渠道设置里）。 */
const UPSTREAM_NATIVE = ["opencode", "gemini", "minimax", "qoder", "monkeycode"] as const

/** 连通性测试的目标（回显出口 IP 的公共服务）。 */
const PROXY_TEST_URL = "https://api.ipify.org/?format=json"

export interface ProxyAdminError extends Error {
  status?: number
}

function badRequest(message: string): ProxyAdminError {
  const error = new Error(message) as ProxyAdminError
  error.status = 400
  return error
}

export function createProxyController({ home, logger }: { home: string; logger?: any }) {
  const bindings: BindingsStore = createBindingsStore(home)
  const router = express.Router()
  router.use(express.json({ limit: "256kb", type: () => true }))

  /** 账号清单：读上游 state.json（与 dashboard 同源），尽力而为。 */
  async function listAccounts(): Promise<{ id: string; provider: string; enabled: boolean }[]> {
    let text: string
    try {
      text = await readFile(join(home, "jet-hub", "state.json"), "utf8")
    } catch {
      return []
    }
    let state: any
    try {
      state = JSON.parse(text)
    } catch {
      return []
    }
    const raw = Array.isArray(state?.accounts) ? state.accounts : []
    const out: { id: string; provider: string; enabled: boolean }[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue
      const { id, provider } = entry as Record<string, unknown>
      if (typeof id !== "string" || id.length === 0 || typeof provider !== "string" || provider.length === 0) continue
      out.push({ id, provider, enabled: entry.enabled !== false })
    }
    return out
  }

  /** 按统一顺序归并账号 + 绑定 + 平台元数据。 */
  async function overview() {
    const [accounts, current, mask] = await Promise.all([listAccounts(), bindings.load(), loadUpstreamProxyMask()])
    const providers = [
      ...new Set([
        ...Object.keys(PLATFORM_HOSTS),
        ...accounts.map((a) => a.provider),
        ...Object.keys(current.platforms),
      ]),
    ]
    return {
      providers: providers.map((provider) => ({
        id: provider,
        /** 平台级绑定的代理（脱敏展示）。 */
        proxy: current.platforms[provider] === undefined ? "" : mask(current.platforms[provider]),
        /** 上游渠道自带每账号代理（建议用渠道内设置）。 */
        upstreamNative: (UPSTREAM_NATIVE as readonly string[]).includes(provider),
        accounts: accounts
          .filter((a) => a.provider === provider)
          .map((a) => ({
            id: a.id,
            enabled: a.enabled,
            proxy:
              current.accounts[`${provider}/${a.id}`] === undefined
                ? ""
                : mask(current.accounts[`${provider}/${a.id}`]),
          })),
      })),
    }
  }

  /** 校验并归一化一次用户输入的代理地址；空串表示清除。 */
  async function validatedUrl(raw: unknown, what: string): Promise<string> {
    if (typeof raw !== "string") throw badRequest(`${what}：缺少代理地址`)
    const trimmed = raw.trim()
    if (trimmed.length === 0) return "" // 清除
    const { normalizeProxy } = await loadUpstreamProxyModule()
    const normalized = normalizeProxy(trimmed)
    if (!normalized.ok) throw badRequest(`代理地址无效 — ${normalized.reason}`)
    return trimmed // 存用户输入的原文（normalizeProxy 的归一化展示由读取侧做）
  }

  router.get("/overview", async (_request, response) => {
    sendJson(response, 200, await overview())
  })

  router.put("/platforms/:provider", async (request, response) => {
    const provider = String(request.params.provider ?? "")
    if (!/^[a-z0-9-]+$/.test(provider)) throw badRequest(`provider 不合法：${provider}`)
    const url = await validatedUrl(request.body?.proxy, `平台 ${provider}`)
    const current = await bindings.load()
    const platforms = { ...current.platforms }
    if (url === "") delete platforms[provider]
    else platforms[provider] = url
    await bindings.save({ platforms })
    logger?.info?.(`[egress] 平台 ${provider} 出口代理 → ${url === "" ? "（清除，直连）" : "已更新"}`)
    sendJson(response, 200, await overview())
  })

  router.put("/accounts/:provider/:accountId", async (request, response) => {
    const provider = String(request.params.provider ?? "")
    const accountId = String(request.params.accountId ?? "")
    if (!/^[a-z0-9-]+$/.test(provider)) throw badRequest(`provider 不合法：${provider}`)
    if (!/^[A-Za-z0-9._:-]+$/.test(accountId)) throw badRequest(`accountId 不合法：${accountId}`)
    const url = await validatedUrl(request.body?.proxy, `账号 ${provider}/${accountId}`)
    const current = await bindings.load()
    const accounts = { ...current.accounts }
    const key = `${provider}/${accountId}`
    if (url === "") delete accounts[key]
    else accounts[key] = url
    await bindings.save({ accounts })
    logger?.info?.(`[egress] 账号 ${key} 出口代理 → ${url === "" ? "（清除，直连）" : "已更新"}`)
    sendJson(response, 200, await overview())
  })

  /** 用指定代理发一次真实请求，回显出口 IP 与耗时（连通性测试）。 */
  router.post("/test", async (request, response) => {
    const url = await validatedUrl(request.body?.proxy, "测试")
    if (url === "") throw badRequest("测试需要提供代理地址")
    const { proxyFetch, normalizeProxy } = await loadUpstreamProxyModule()
    const normalized = normalizeProxy(url)
    if (!normalized.ok) throw badRequest(`代理地址无效 — ${normalized.reason}`)
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const web = await proxyFetch(PROXY_TEST_URL, { signal: controller.signal }, normalized.proxy)
      const text = await web.text()
      let ip: string | undefined
      try {
        ip = JSON.parse(text)?.ip
      } catch {
        ip = undefined
      }
      sendJson(response, 200, {
        ok: web.ok,
        status: web.status,
        ip,
        elapsedMs: Date.now() - startedAt,
      })
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: String((error as any)?.cause ?? error).slice(0, 300),
      })
    } finally {
      clearTimeout(timer)
    }
  })

  return { router }
}
