/**
 * 出站拦截器的端到端回归测试 —— 用**真实链路**验证，不用替身判定层：
 *
 *   globalThis.fetch → 拦截器 → 上游 proxyFetch（undici ProxyAgent）
 *                    → 本测试内起的 HTTP 正向代理桩 → 目标服务
 *
 * 代理桩数命中数（≥1 即「请求真的走了代理出口」），并做透明转发，
 * 让目标也能断言收到的头。账号级用「凭据叶子 ↔ Authorization」命中；
 * 平台级用 PLATFORM_HOSTS 里的真实域名命中（桩不真正外连，只回固定响应，
 * 不会触网）。
 */

import { afterAll, beforeAll, test } from "vite-plus/test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installEgressInterceptor, type EgressInterceptor } from "../src/core/egress/interceptor.ts"

const SECRET_A = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9-account-a"

let home: string
let proxyHits = 0
let proxy: ReturnType<typeof createServer>
let target: ReturnType<typeof createServer>
let targetHits = 0
let interceptor: EgressInterceptor | undefined

/** 最小 HTTP 正向代理：127.0.0.1 目标做真转发；其余目标直答固定响应（不触外网）。 */
function forward(req: IncomingMessage, res: ServerResponse) {
  proxyHits += 1
  const url = new URL(String(req.url))
  if (url.hostname !== "127.0.0.1") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ viaProxyStub: true, host: url.host }))
    return
  }
  const upstream = httpRequest(
    {
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: url.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on("error", () => {
    res.writeHead(502).end("proxy stub upstream error")
  })
  req.pipe(upstream)
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "c2a-egress-"))
  mkdirSync(join(home, "jet-hub"), { recursive: true })
  writeFileSync(
    join(home, "jet-hub", "state.json"),
    JSON.stringify({ accounts: [{ id: "acc-a", provider: "zcode", credentialRef: "zcode_a", enabled: true }] }),
  )
  writeFileSync(
    join(home, ".credentials.yaml"),
    ["version: 1", "refs:", "  zcode_a: >-", `    ${JSON.stringify({ access_token: SECRET_A })}`, ""].join("\n"),
  )

  target = createServer((_req, res) => {
    targetHits += 1
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ seenAuth: _req.headers.authorization ?? null }))
  })
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))

  proxy = createServer((req, res) => forward(req, res))
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))

  // ⚠️ 绑定文件只写这一次（端口已定）：两次写若落进同一 mtimeMs，
  //    store 的 mtime 缓存会把第一次的内容当成最新 —— 教训式写法。
  const proxyPort = (proxy.address() as AddressInfo).port
  writeFileSync(
    join(home, "proxy-bindings.json"),
    JSON.stringify({ version: 1, accounts: { "zcode/acc-a": `http://127.0.0.1:${proxyPort}` } }),
  )

  interceptor = await installEgressInterceptor({ home, logger: fakeLogger() })
})

function fakeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} } as unknown as Console
}

afterAll(async () => {
  interceptor?.uninstall()
  await Promise.all([
    new Promise<void>((resolve) => proxy.close(() => resolve())),
    new Promise<void>((resolve) => target.close(() => resolve())),
  ])
})

test("账号级：带该账号凭据材料的请求走代理出口，目标收到的头原样", async () => {
  const port = (target.address() as AddressInfo).port
  const hitsBefore = proxyHits
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
    headers: { authorization: `Bearer ${SECRET_A}` },
  })
  const body = await res.json()
  assert.ok(proxyHits > hitsBefore, "请求应经过代理桩（出口绑定生效）")
  assert.equal(body.seenAuth, `Bearer ${SECRET_A}`)
})

test("平台级：host 命中平台表时，即使无账号材料也走代理桩（桩直答，不触外网）", async () => {
  const proxyPort = (proxy.address() as AddressInfo).port
  const bindings = interceptor!.internals.bindings
  const hitsBefore = proxyHits
  await bindings.save({ platforms: { cline: `http://127.0.0.1:${proxyPort}` } })
  try {
    // api.cline.bot 在平台表里。桩对非 127.0.0.1 目标只回固定响应 ——
    // 拿到这个响应 = 请求确实经过绑定出口进了桩，而不是直连真网关。
    const res = await fetch("http://api.cline.bot/api/v1/chats")
    const body = await res.json()
    assert.ok(proxyHits > hitsBefore, "平台级绑定应把请求送进代理桩")
    assert.equal(body.viaProxyStub, true)
    assert.equal(body.host, "api.cline.bot")
  } finally {
    await bindings.save({ platforms: { cline: "" } })
  }
})

test("无绑定（未知 host、未知材料）直连原始 fetch，不进代理桩", async () => {
  const port = (target.address() as AddressInfo).port
  const hitsBefore = proxyHits
  const res = await fetch(`http://127.0.0.1:${port}/direct`)
  assert.equal(res.status, 200)
  assert.equal(proxyHits, hitsBefore, "不相关请求不应进桩")
})

test("uninstall 恢复原装 fetch", async () => {
  const wrapped = globalThis.fetch
  interceptor!.uninstall()
  assert.notEqual(globalThis.fetch, wrapped)
  interceptor!.uninstall() // 重复调用：幂等，不得抛
  // 再装回去并更新句柄，after() 才能真正把全局表恢复干净。
  interceptor = await installEgressInterceptor({ home, logger: fakeLogger() })
})
