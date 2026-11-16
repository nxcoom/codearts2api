/**
 * 「鉴权材料 → 账号」索引与候选抽取的回归测试。
 *
 * 断言的是匹配判据本身：凭据 JSON 的字符串叶子可命中、非 JSON 原文可命中、
 * Bearer/`workos:` 前缀可剥、Cookie 分段可抽、query token 可抽、短杂讯不抽。
 */

import { test } from "vite-plus/test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { candidateMaterials, createCredentialIndex } from "../src/core/egress/credential-index.ts"

const SECRET_A = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9-account-a"
const SECRET_B = "sk-zcode-remote-key-99887766554433221100"
const SECRET_C = "cookie-session-value-2fd0a3be1f2c4477"

/** 造一个带两个账号的 home：state.json + .credentials.yaml（官方 v1 布局）。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "c2a-credidx-"))
  mkdirSync(join(home, "jet-hub"), { recursive: true })
  writeFileSync(
    join(home, "jet-hub", "state.json"),
    JSON.stringify({
      accounts: [
        { id: "acc-a", provider: "zcode", credentialRef: "zcode_a", enabled: true },
        { id: "acc-b", provider: "buddy", credentialRef: "buddy_b", enabled: true },
        { id: "broken", provider: "cline", credentialRef: "missing_ref", enabled: true },
        { id: "", provider: "bad" }, // 缺键：应被跳过
      ],
    }),
  )
  // refs 值 = 账号凭据（JSON 串或纯文本串）。records 键空间不属于 resolve()，不索引。
  const yaml = [
    "version: 1",
    "refs:",
    "  zcode_a: >-",
    `    ${JSON.stringify({ access_token: SECRET_A, nickname: "A" })}`,
    "  buddy_b: >-",
    `    ${JSON.stringify({ cookie: SECRET_C, nested: { refresh: SECRET_B } })}`,
    "records:",
    "  some/record:",
    "    kind: api-key",
    "    key: should-not-be-indexed-000000000000",
    "",
  ].join("\n")
  writeFileSync(join(home, ".credentials.yaml"), yaml)
  return home
}

test("凭据叶子命中对应账号；records 键空间不进索引", async () => {
  const index = createCredentialIndex(makeHome())
  assert.deepEqual(await index.ownerOf(SECRET_A), { provider: "zcode", accountId: "acc-a" })
  assert.deepEqual(await index.ownerOf(SECRET_C), { provider: "buddy", accountId: "acc-b" })
  // 嵌套叶子也要能中（JSON 树遍历）
  assert.deepEqual(await index.ownerOf(SECRET_B), { provider: "buddy", accountId: "acc-b" })
  assert.equal(await index.ownerOf("should-not-be-indexed-000000000000"), undefined)
})

test("凭据引用缺失/账号缺键的条目被跳过，不炸", async () => {
  const index = createCredentialIndex(makeHome())
  assert.equal(await index.ownerOf("no-such-material-anywhere-123456"), undefined)
  assert.equal((await index.size()) > 0, true)
})

test("candidateMaterials：Bearer / workos: 前缀 / Cookie 分段 / query token", () => {
  const headers = new Headers({
    authorization: `Bearer ${SECRET_A}`,
    cookie: `sid=${SECRET_C}; theme=dark; tz=8`,
  })
  const got = candidateMaterials(`https://api.example.com/v1/chat?key=${SECRET_B}&x=1`, headers)
  assert.ok(got.includes(SECRET_A), "应抽到剥掉 Bearer 的 token")
  assert.ok(got.includes(SECRET_C), "应抽到 Cookie 值")
  assert.ok(got.includes(SECRET_B), "应抽到 URL query 里的 key")
  assert.ok(!got.includes("dark"), "短杂讯不应入列")
})

test("candidateMaterials：workos:<jwt> 的 scheme 前缀单独成候选", () => {
  const jwt = "eyJhbGciOi-workos-style-token-0123456789"
  const got = candidateMaterials(undefined, new Headers({ authorization: `Bearer workos:${jwt}` }))
  assert.ok(got.includes(`workos:${jwt}`), "原样保留")
  assert.ok(got.includes(jwt), "剥掉 workos: 前缀")
})
