/**
 * relay 绑定类型的回归测试。
 *
 * relay+https:// 是宿主原生的「HTTP 中继」出口（Serverless 边缘场景：
 * 反向代理边缘不放行 CONNECT/绝对 URI，标准代理协议过不去）。这里用本地
 * 中继桩端到端断言：拦截器按 relay 绑定转发、鉴权材料命中、请求体/响应
 * 原样往返、SSE 增量不被缓冲；以及 parseRelayUrl 的解析边界。
 */

import { afterAll, beforeAll, test } from "vite-plus/test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseRelayUrl } from "../src/core/egress/relay-fetch.ts"
import { installEgressInterceptor, type EgressInterceptor } from "../src/core/egress/interceptor.ts"

const SECRET = "e2e-relay-token-codearts2api-0123456789abcdef"
const RELAY_TOKEN = "relay-shared-token"

let home: string
let relay: ReturnType<typeof createServer>
let relaySeen: { target?: string; token?: string; body?: string; method?: string; auth?: string | undefined } = {}
let sseChunks = 0
let interceptor: EgressInterceptor | undefined

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "c2a-relay-"))
  mkdirSync(join(home, "jet-hub"), { recursive: true })
  writeFileSync(
    join(home, "jet-hub", "state.json"),
    JSON.stringify({ accounts: [{ id: "acc-relay", provider: "zcode", credentialRef: "zcode_relay", enabled: true }] }),
  )
  writeFileSync(
    join(home, ".credentials.yaml"),
    ["version: 1", "refs:", "  zcode_relay: >-", `    ${JSON.stringify({ access_token: SECRET })}`, ""].join("\n"),
  )

  /** 本地中继桩：实现与 orkestr 代理相同的 /forward 协议（含 SSE 流式）。 */
  relay = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.startsWith("/forward")) {
      res.writeHead(404).end()
      return
    }
    relaySeen = {
      target: String(req.headers["x-relay-target"]),
      token: String(req.headers["x-relay-token"]),
      method: String(req.method),
      auth: req.headers.authorization,
    }
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      relaySeen.body = Buffer.concat(chunks).toString("utf8")
      const target = new URL(relaySeen.target ?? "http://unknown/")
      if (target.pathname.startsWith("/sse")) {
        res.writeHead(200, { "content-type": "text/event-stream", connection: "close" })
        for (const line of ["data: one", "data: two", "data: three"]) {
          sseChunks += 1
          res.write(`${line}\n\n`)
        }
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json", "x-via-relay": "1", connection: "close" })
      res.end(JSON.stringify({ seenBody: relaySeen.body, seenAuth: relaySeen.auth, host: target.host }))
    })
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))

  const relayPort = (relay.address() as AddressInfo).port
  writeFileSync(
    join(home, "proxy-bindings.json"),
    JSON.stringify({
      version: 1,
      accounts: { "zcode/acc-relay": `relay+http://127.0.0.1:${relayPort}?token=${RELAY_TOKEN}` },
    }),
  )
  interceptor = await installEgressInterceptor({
    home,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as unknown as Console,
  })
})

afterAll(async () => {
  interceptor?.uninstall()
  await new Promise<void>((resolve) => relay.close(() => resolve()))
})

test("parseRelayUrl：合法形态 / 非 relay / 缺 token", () => {
  assert.deepEqual(parseRelayUrl("relay+https://edge.example.com?token=t1"), {
    base: "https://edge.example.com",
    token: "t1",
  })
  assert.deepEqual(parseRelayUrl(" relay+http://h:8080/relay/v1?token=t2 "), {
    base: "http://h:8080/relay/v1",
    token: "t2",
  })
  assert.equal(parseRelayUrl("https://plain.example.com?token=t"), undefined)
  assert.equal(parseRelayUrl("relay+https://edge.example.com"), undefined) // 缺 token
})

test("账号级 relay 绑定：请求经中继转述，目标 URL/头/体原样到达", async () => {
  const res = await fetch("http://target.example.com/api/v1/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  })
  const body = await res.json()
  assert.equal(res.headers.get("x-via-relay"), "1")
  assert.equal(relaySeen.token, RELAY_TOKEN)
  assert.equal(relaySeen.target, "http://target.example.com/api/v1/chat")
  assert.equal(body.seenAuth, `Bearer ${SECRET}`)
  assert.equal(body.seenBody, JSON.stringify({ hello: "world" }))
})

test("relay 响应流式回传（SSE 增量不被缓冲）", async () => {
  const res = await fetch("http://target.example.com/sse", { headers: { authorization: `Bearer ${SECRET}` } })
  assert.equal(res.headers.get("content-type"), "text/event-stream")
  const text = await res.text()
  assert.equal(sseChunks >= 3, true)
  assert.match(text, /data: three/)
})

test("绑定指向不可达的中继 ⇒ 请求显式失败（绝不静默直连）", async () => {
  const bindings = interceptor!.internals.bindings
  await bindings.save({ accounts: { "zcode/acc-relay": "relay+http://127.0.0.1:1?token=whatever" } })
  try {
    // 127.0.0.1:1 上没有监听 ⇒ 连接拒绝。若是「静默回直连」，请求会 200。
    await assert.rejects(
      () => fetch("http://target.example.com/api/v1/chat", { headers: { authorization: `Bearer ${SECRET}` } }),
      (error: any) => {
        // 沿 cause 链找连接拒绝的证据（undici 把真因挂在 cause 上）。
        let current: unknown = error
        for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
          if (/ECONNREFUSED|fetch failed|UND_ERR/i.test(String((current as Error).message ?? current))) return true
          current = (current as Error).cause
        }
        return false
      },
    )
  } finally {
    const port = (relay.address() as AddressInfo).port
    await bindings.save({ accounts: { "zcode/acc-relay": `relay+http://127.0.0.1:${port}?token=${RELAY_TOKEN}` } })
  }
})
