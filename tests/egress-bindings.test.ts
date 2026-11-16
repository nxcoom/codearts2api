/**
 * 出口绑定存储的回归测试。
 *
 * 断言的是**行为边界**：归一化（脏输入不炸、空串=清除）、账号级优先于
 * 平台级、mtime 缓存在文件被外部改动后失效。
 */

import { test } from "vite-plus/test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { accountBindingKey, createBindingsStore } from "../src/core/egress/bindings.ts"

function makeHome() {
  return mkdtempSync(join(tmpdir(), "c2a-bindings-"))
}

test("缺文件 = 全空，不抛", async () => {
  const store = createBindingsStore(makeHome())
  const bindings = await store.load()
  assert.deepEqual(bindings, { accounts: {}, platforms: {} })
})

test("归一化：非法形状丢弃，空串视为未绑定", async () => {
  const home = makeHome()
  writeFileSync(
    join(home, "proxy-bindings.json"),
    JSON.stringify({
      version: 1,
      accounts: { "zcode/acc1": "  http://127.0.0.1:7897  ", bad: 12345, empty: "" },
      platforms: ["not-an-object"],
    }),
  )
  const store = createBindingsStore(home)
  const bindings = await store.load()
  assert.deepEqual(bindings, { accounts: { "zcode/acc1": "http://127.0.0.1:7897" }, platforms: {} })
})

test("保存后可读回，且两层互不覆盖", async () => {
  const home = makeHome()
  const store = createBindingsStore(home)
  await store.save({ platforms: { zcode: "socks5://127.0.0.1:1080" } })
  await store.save({ accounts: { [accountBindingKey("zcode", "a1")]: "http://127.0.0.1:7897" } })
  assert.deepEqual(await store.load(), {
    accounts: { "zcode/a1": "http://127.0.0.1:7897" },
    platforms: { zcode: "socks5://127.0.0.1:1080" },
  })
})

test("resolve：账号级命中优先，未命中回落平台级，再未命中 undefined", async () => {
  const home = makeHome()
  const store = createBindingsStore(home)
  await store.save({
    accounts: { [accountBindingKey("zcode", "a1")]: "http://account:1" },
    platforms: { zcode: "http://platform:2" },
  })
  assert.equal(await store.resolve("zcode", "a1"), "http://account:1")
  assert.equal(await store.resolve("zcode", "other"), "http://platform:2")
  assert.equal(await store.resolve("zcode", undefined), "http://platform:2")
  assert.equal(await store.resolve(undefined, "a1"), undefined)
})

test("外部手改文件（mtime 变化）后读到新值", async () => {
  const home = makeHome()
  const file = join(home, "proxy-bindings.json")
  const store = createBindingsStore(home)
  writeFileSync(file, JSON.stringify({ platforms: { zcode: "http://old:1" } }))
  assert.equal(await store.resolve("zcode", undefined), "http://old:1")
  // mtime 同刻会让缓存误判，这里显式把 mtime 往前拨 2 秒。
  writeFileSync(file, JSON.stringify({ platforms: { zcode: "http://new:2" } }))
  const stat = await import("node:fs/promises").then((fs) => fs.stat(file))
  utimesSync(file, new Date(stat.mtimeMs + 2000), new Date(stat.mtimeMs + 2000))
  assert.equal(await store.resolve("zcode", undefined), "http://new:2")
})
