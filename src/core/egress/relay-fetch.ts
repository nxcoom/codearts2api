/**
 * relay 绑定类型的宿主原生传输层 —— 「HTTP 中继」协议。
 *
 * ## 为什么需要它
 *
 * 标准 HTTP/CONNECT 代理要求**代理端口**直接可达（undici 在其上发 CONNECT 或
 * 绝对 URI）。但 Serverless 边缘（orkestr 的反向代理、Cloudflare Workers 等）
 * 只暴露普通 HTTP：CONNECT 直接 405、绝对 URI 按 Host 路由 —— 标准代理协议
 * 过不去。relay 绑定把「出口」变成一个普通 HTTP 端点：
 *
 * ```
 * POST <relay>/forward
 * x-relay-target: <目标完整 URL>
 * x-relay-token: <共享令牌>
 * （原请求 method / headers / body 原样转述）
 * → 响应原样回传（流式，Connection: close 划界，SSE 可直通）
 * ```
 *
 * 绑定地址形如 `relay+https://host[:port][/prefix]?token=<共享令牌>` ——
 * scheme 前缀 `relay+` 是宿主与拦截器之间的约定；校验归宿主（上游
 * `normalizeProxy` 只认 http/socks5，两者互不重叠）。
 *
 * ## 与上游 proxyFetch 的关系
 *
 * 互不替代：http/socks5 走上游实现（雷区全在那份注释里）；relay 是宿主
 * 原生的新传输形态，上游没有对应物 —— 不构成「同一语义两套判据」。
 *
 * ## 边界
 *
 * - 请求体只接受字符串 / ArrayBuffer / Uint8Array（聊天与业务请求即此形态）；
 *   流式请求体（罕见）会被读取成 buffer —— 上游适配器不发流式请求体。
 * - relay 端自己控制上游读超时；SSE 长流依赖分块持续到达。
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length", // 由中继侧按真实体长重算
])

/** 解析 relay 绑定地址；非 relay 形态返回 undefined（交给上游 proxyFetch）。 */
export function parseRelayUrl(raw: string): { base: string; token: string } | undefined {
  const match = /^relay\+(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/.exec(raw.trim())
  if (!match) return undefined
  const [, scheme, authority, prefix = "", query = ""] = match
  const token = new URLSearchParams(query).get("token") ?? ""
  if (token.length === 0) return undefined
  return { base: `${scheme}://${authority}${prefix.replace(/\/$/, "")}`, token }
}

/**
 * 经 relay 端点转发一个请求。
 *
 * @param fetchImpl - **拦截器安装前的原始 fetch**。必须由调用方注入：本模块若
 *                    直接调全局 `fetch`，在拦截器装好之后会拿到的还是包装版 ——
 *                    转发请求自己又带鉴权材料（原样转述的头），会再次命中绑定
 *                    ⇒ 无限递归（真实缺陷，egress-relay 测试 30s 超时即此）。
 * @param input - 与 fetch 相同的第一参（string / URL；Request 形态走不到这里，
 *                拦截器与上游调用点都传原始值）。
 * @param init - 与 fetch 相同的第二参。
 * @param relay - parseRelayUrl 的结果。
 */
export async function relayFetch(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  relay: { base: string; token: string },
): Promise<Response> {
  // 用 Request 归一化 method / headers / body（与上游 proxyFetch 同一约定：
  // 不接受把 Request 对象当 init 传入 —— 展开静默丢头）。
  if (input instanceof Request) {
    throw new TypeError("relayFetch: 不要传 Request 对象作 input（与上游 proxyFetch 同一契约）")
  }
  const request = new Request(input, init)
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value)
  })
  headers.set("x-relay-target", request.url)
  headers.set("x-relay-token", relay.token)

  let body: ArrayBuffer | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer()
  }

  const relayResponse = await fetchImpl(`${relay.base}/forward`, {
    method: "POST",
    headers,
    body,
    signal: init?.signal ?? request.signal,
  })
  // 目标响应原样回传：状态/头透传，body 保持流式（SSE 增量不被缓冲）。
  const responseHeaders = new Headers()
  relayResponse.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value)
  })
  return new Response(relayResponse.body, {
    status: relayResponse.status,
    statusText: relayResponse.statusText,
    headers: responseHeaders,
  })
}
