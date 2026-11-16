/**
 * 平台域名表与上游 lib 的**契约核对**。
 *
 * 表里的每个域名都应当还能在上游 `dsh-providers-hub/lib` 里找到 ——
 * 找不到说明上游换了域名或加了平台，而宿主的路由表没跟上：平台级绑定
 * 会静默失效（请求直连）。宁可测试红，也不要静默直连。
 */

import { test } from "vite-plus/test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"

import { PLATFORM_HOSTS, platformForUrl, platformsForUrl } from "../src/core/egress/platform-hosts.ts"

const libDir = join(createRequire(import.meta.url).resolve("dsh-providers-hub/package.json"), "..", "lib")
const libText = readdirSync(libDir)
  .filter((name) => name.endsWith(".js") || name.endsWith(".json"))
  .map((name) => readFileSync(join(libDir, name), "utf8"))
  .join("\n")

test("PLATFORM_HOSTS 的每个域名仍存在于上游 lib 中（防止上游换域名后平台级绑定静默失效）", () => {
  const missing: string[] = []
  for (const [provider, hosts] of Object.entries(PLATFORM_HOSTS)) {
    for (const host of hosts) {
      if (!libText.includes(host)) missing.push(`${provider}: ${host}`)
    }
  }
  assert.deepEqual(missing, [])
})

test("platformForUrl：命中 / 端口与协议不参与 / 未知 host 落空；共享域名返回全部候选", () => {
  assert.equal(platformForUrl("https://api.z.ai/api/biz/normal"), "zcode")
  assert.equal(platformForUrl(new URL("http://opencode.ai:443/zen/v1/x")), "opencode")
  assert.equal(platformForUrl("https://unknown.example.com/x"), undefined)
  assert.equal(platformForUrl("not-a-url"), undefined)
  // 中国版/国际版共用的域名：两个 provider 候选都返回，拦截器逐个试绑定。
  assert.deepEqual(platformsForUrl("https://openapi.qoder.com.cn/api/v1"), ["qoder", "qodercn"])
})
