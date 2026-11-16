/**
 * 出口绑定存储 —— `<home>/proxy-bindings.json`。
 *
 * ## 为什么放宿主自己的文件，而不是上游账号池
 *
 * 上游账号池只有五家平台有代理字段（`opencodeProxy` / `geminiProxy` /
 * `qoderProxy` / `minimaxIntlProxy`），且它们的**写入走上游 RPC**、
 * **消费在上游适配器内部** —— 宿主既写不进、也读不出其余平台的。本功能
 * 是宿主侧出站路由，数据自然放宿主自己的文档；`caller-keys.json` 已有
 * 同款先例（宿主自有能力放宿主自有文件）。
 *
 * ## 两级绑定与优先级
 *
 * - `accounts`：`"<provider>/<accountId>" → 代理地址`，按**请求头鉴权材料**
 *   命中该账号时生效；
 * - `platforms`：`"<provider>" → 代理地址`，按 **URL host** 命中平台时生效，
 *   是鉴权材料匹配不到（如 zcode 聊天请求用的是远端换取的 api-key）时的兜底。
 *
 * 实际出口优先级（高 → 低）：
 *   1. **上游自带**的五家每账号代理（它们走 `proxyFetch`，根本不经过全局
 *      fetch，天然优先）；
 *   2. 本文件 `accounts`；
 *   3. 本文件 `platforms`；
 *   4. 直连。
 *
 * ## 读取一致性
 *
 * 拦截器在**每个请求**上都要查表，而管理端随时可能改写。用 mtime 缓存：
 * 文件没变就直接用上一次的解析结果（热路径零 IO），变了重读 —— 与凭据
 * 服务 `watch: true` 的外部编辑语义一致（用户手改文件也生效）。
 */

import { stat } from "node:fs/promises"
import { join } from "node:path"

import { readJson, writeJsonAtomic } from "../fs-store.ts"

/** 代理地址的校验由上游 `normalizeProxy` 做，存储层只管形状与空值语义。 */
export interface ProxyBindings {
  accounts: Record<string, string>
  platforms: Record<string, string>
}

const EMPTY: ProxyBindings = { accounts: {}, platforms: {} }

/** 账号绑定的键（`<provider>/<accountId>`）。宿主与 UI 共用这一种拼法。 */
export function accountBindingKey(provider: string, accountId: string): string {
  return `${provider}/${accountId}`
}

/** 从绑定文档里归一化出有效值：空串视为「清除」，非法类型丢弃。 */
function normalizeMap(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue // 空串 = 未绑定，不存
    out[key] = trimmed
  }
  return out
}

function normalizeBindings(raw: any): ProxyBindings {
  if (raw === null || typeof raw !== "object") return { ...EMPTY }
  return { accounts: normalizeMap(raw.accounts), platforms: normalizeMap(raw.platforms) }
}

export interface BindingsStore {
  /** 读当前绑定（mtime 缓存；文件缺失 = 全空）。 */
  load(): Promise<ProxyBindings>
  /** 原子写回（保留另一层里已有条目；传入的层整体替换）。 */
  save(patch: { accounts?: Record<string, string>; platforms?: Record<string, string> }): Promise<ProxyBindings>
  /** 热路径查询封装：先账号级、后平台级，返回第一个命中的代理地址。 */
  resolve(provider: string | undefined, accountId: string | undefined): Promise<string | undefined>
}

/**
 * @param home - 状态目录（`<home>/proxy-bindings.json`）。
 */
export function createBindingsStore(home: string): BindingsStore {
  const file = join(home, "proxy-bindings.json")
  // 缓存键 = mtimeMs + size：同一毫秒内的两次外部写（测试桩 / 脚本批量写）
  // mtime 相同但内容不同，单靠 mtime 会把旧内容当最新（实测踩过）。
  let cache: { key: string; value: ProxyBindings } | undefined

  async function load(): Promise<ProxyBindings> {
    let key: string
    try {
      const info = await stat(file)
      key = `${info.mtimeMs}:${info.size}`
    } catch {
      cache = undefined
      return { ...EMPTY }
    }
    if (cache !== undefined && cache.key === key) return cache.value
    const value = normalizeBindings(await readJson(file))
    cache = { key, value }
    return value
  }

  async function save(patch: {
    accounts?: Record<string, string>
    platforms?: Record<string, string>
  }): Promise<ProxyBindings> {
    const current = await load()
    const next: ProxyBindings = {
      accounts: patch.accounts ?? current.accounts,
      platforms: patch.platforms ?? current.platforms,
    }
    await writeJsonAtomic(file, { version: 1, ...next })
    cache = undefined // 下次 load 重 stat，拿到新 mtime
    return next
  }

  async function resolve(provider: string | undefined, accountId: string | undefined): Promise<string | undefined> {
    const bindings = await load()
    if (accountId !== undefined && provider !== undefined) {
      const perAccount = bindings.accounts[accountBindingKey(provider, accountId)]
      if (perAccount !== undefined) return perAccount
    }
    if (provider !== undefined) return bindings.platforms[provider]
    return undefined
  }

  return { load, save, resolve }
}
