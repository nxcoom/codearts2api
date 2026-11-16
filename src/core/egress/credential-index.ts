/**
 * 「鉴权材料 → 账号」索引 —— 账号级出口绑定的**匹配判据**。
 *
 * ## 为什么不按平台解析请求
 *
 * 各平台的鉴权头形状五花八门（Bearer JWT / Cookie / x-api-key / URL query
 * token……），宿主逐平台解析等于复制上游的鉴权逻辑 —— 红线。但这些形状
 * 有一个**共同不变量**：发出去的鉴权材料几乎都逐字来自该账号的凭据内容
 * （凭据 JSON 里的 token / cookie / key 字段）。故索引做成**平台无关**：
 *
 * 1. 从 `<home>/jet-hub/state.json` 取账号表（`id` / `provider` /
 *    `credentialRef` 三键，与上游归一化判据一致）；
 * 2. 用**官方解析器** `parseCredentialsDocument` 读 `<home>/.credentials.yaml`
 *    （`resolve()` 只读 `refs` 键空间 —— 见 dsh-credentials-local 实现，
 *    账号凭据就是 refs 里的 JSON 串）；
 * 3. 对每个账号的凭据做**通用叶子遍历**：JSON 则收集全部字符串叶子，
 *    非字符串则整串算一条 —— 每片叶子登记 `值 → {provider, accountId}`；
 * 4. 请求到达时从头/URL 里抽取候选材料（原样、剥 Bearer、剥 `workos:` 这类
 *    `scheme:` 前缀、Cookie 分段、query token），在索引里**精确命中**。
 *
 * ## 已知覆盖不了的形状（诚实边界）
 *
 * 出口材料**经远端换取**的平台（zcode 聊天腿：OAuth token 换 coding-plan
 * api-key）匹配不到账号 —— 这类请求落到**平台级绑定**（URL host 判据）。
 * 覆盖不了时行为 = 改造前的直连，不会更糟。
 *
 * ## 刷新与重建
 *
 * 凭据续期会改写 `.credentials.yaml`（mtime 变化）⇒ 索引自动重建；账号增删
 * 改的是 state.json（同理）。热路径只在两个 mtime 都没变时走内存。
 */

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local"

import { readJson } from "../fs-store.ts"

/** 索引命中的账号身份。 */
export interface CredentialOwner {
  provider: string
  accountId: string
}

/** 叶子串长度下限：太短的值（`public` / `true` / 数字）没有指纹意义。 */
const MIN_SECRET_LENGTH = 16

/** state.json 账号条目里宿主依赖的三个键（与上游归一化判据一致）。 */
interface AccountEntry {
  id: string
  provider: string
  credentialRef: string
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length >= MIN_SECRET_LENGTH) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
}

/** 从 state.json 里归一化账号表（缺三键任一的条目跳过 —— 与上游同判据）。 */
function normalizeAccounts(raw: unknown): AccountEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as any).accounts)
      ? (raw as any).accounts
      : []
  const out: AccountEntry[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue
    const { id, provider, credentialRef } = entry as Record<string, unknown>
    if (typeof id !== "string" || id.length === 0) continue
    if (typeof provider !== "string" || provider.length === 0) continue
    if (typeof credentialRef !== "string" || credentialRef.length === 0) continue
    out.push({ id, provider, credentialRef })
  }
  return out
}

export interface CredentialIndex {
  /** 材料命中 → 账号；未命中返回 undefined（调用方落到平台级绑定）。 */
  ownerOf(material: string): Promise<CredentialOwner | undefined>
  /** 已索引的账号数（诊断用）。 */
  size(): Promise<number>
}

export function createCredentialIndex(home: string): CredentialIndex {
  const credentialsFile = join(home, ".credentials.yaml")
  const stateFile = join(home, "jet-hub", "state.json")
  let cache: { credentialsMtimeMs: number; stateMtimeMs: number; index: Map<string, CredentialOwner> } | undefined

  async function mtimeMsOf(file: string): Promise<number> {
    try {
      return (await stat(file)).mtimeMs
    } catch {
      return -1 // 文件不存在：固定值，避免每次重建
    }
  }

  async function index(): Promise<Map<string, CredentialOwner>> {
    const [credentialsMtimeMs, stateMtimeMs] = await Promise.all([mtimeMsOf(credentialsFile), mtimeMsOf(stateFile)])
    if (cache !== undefined && cache.credentialsMtimeMs === credentialsMtimeMs && cache.stateMtimeMs === stateMtimeMs) {
      return cache.index
    }
    const map = new Map<string, CredentialOwner>()
    let accounts: AccountEntry[] = []
    let refs = new Map<string, string>()
    const [stateRaw, credentialsText] = await Promise.all([
      readJson(stateFile),
      readFile(credentialsFile, "utf8").catch(() => undefined),
    ])
    accounts = normalizeAccounts(stateRaw)
    if (credentialsText !== undefined) {
      try {
        refs = parseCredentialsDocument(credentialsText, credentialsFile).refs
      } catch {
        // 文档暂不可解析（外部编辑到一半）：沿用空 refs，下一次 mtime 变化再试。
      }
    }
    for (const account of accounts) {
      const raw = refs.get(account.credentialRef)
      if (raw === undefined) continue
      const leaves: string[] = []
      try {
        collectStrings(JSON.parse(raw), leaves)
      } catch {
        collectStrings(raw, leaves) // 值本身不是 JSON：整串当一条
      }
      for (const leaf of leaves) {
        // 同值多账号（少见）：先到先得，保持确定性行为。
        if (!map.has(leaf)) map.set(leaf, { provider: account.provider, accountId: account.id })
      }
    }
    cache = { credentialsMtimeMs, stateMtimeMs, index: map }
    return map
  }

  return {
    ownerOf: async (material: string) => (await index()).get(material),
    size: async () => (await index()).size,
  } satisfies CredentialIndex
}

/**
 * 从一个出站请求里抽取**候选鉴权材料**（去重保序，调用方逐个查索引）。
 *
 * 抽取面刻意宽：`Authorization`（原样 + 剥 `Bearer ` + 剥 `<scheme>:` 前缀，
 * 覆盖 cline 的 `Bearer workos:<jwt>`）、`Cookie` 分段值、常见 key 头
 * （`x-api-key` / `api-key` / `x-auth-token`）、URL query 里的
 * `key` / `token` / `access_token` / `api_key`（覆盖 Gemini 的 `?key=`）。
 * 长度下限与索引一致，避免把 `gzip` 这类杂讯送进索引。
 *
 * @param url - 绝对 URL 字符串（相对 URL 时跳过 query 抽取）。
 * @param headers - 请求头（可为 undefined）。
 */
export function candidateMaterials(url: string | undefined, headers: Headers | undefined): string[] {
  const candidates: string[] = []
  const push = (value: string | undefined | null) => {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    const add = (candidate: string) => {
      if (candidate.length >= MIN_SECRET_LENGTH && !candidates.includes(candidate)) candidates.push(candidate)
    }
    add(trimmed)
    // 剥 `Bearer ` 前缀（cline 是 `Bearer workos:<jwt>`：先剥 Bearer 再剥 scheme）。
    const stripped = /^Bearer\s+/i.exec(trimmed) === null ? trimmed : trimmed.replace(/^Bearer\s+/i, "").trim()
    add(stripped)
    // 剥 `<scheme>:` 结构化前缀（`workos:<jwt>` 一类）。
    const schemeColon = /^[A-Za-z][A-Za-z0-9]+:(.+)$/.exec(stripped)
    if (schemeColon !== null) add(schemeColon[1])
  }

  if (headers !== undefined) {
    push(headers.get("authorization"))
    const cookie = headers.get("cookie")
    if (typeof cookie === "string") {
      for (const pair of cookie.split(";")) {
        const eq = pair.indexOf("=")
        if (eq > 0) push(pair.slice(eq + 1).trim())
      }
    }
    for (const name of ["x-api-key", "api-key", "x-auth-token", "x-goog-api-key"]) {
      push(headers.get(name))
    }
  }
  if (typeof url === "string") {
    try {
      const query = new URL(url).searchParams
      for (const name of ["key", "token", "access_token", "api_key"]) {
        push(query.get(name))
      }
    } catch {
      // 相对/坏 URL：不抽 query
    }
  }
  return [...new Set(candidates)]
}
