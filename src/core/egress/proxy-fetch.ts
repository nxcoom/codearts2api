/**
 * 出站代理的**发送底座** —— 复用上游 `lib/opencode-proxy.js`。
 *
 * ## 为什么不自己写 ProxyAgent / SOCKS5
 *
 * 上游那份实现带着大量实测踩坑记录（HTTP 代理必须 `clientFactory` +
 * `pipelining: 0`、SOCKS5 CONNECT 端口空串判据、CONNECT 后要自己包 TLS、
 * dispatcher 必须与 fetch 同一 undici 实例……）。重写一份等于把每一颗雷
 * 都重新踩一遍，而且违反本仓库红线「同一语义两套判据」。故这里**文件路径
 * 直插**上游 lib 拿到同一份 `proxyFetch` / `normalizeProxy`。
 *
 * ## 为什么可以绕开 `exports` 地图
 *
 * 包的 `exports` 只暴露 `.` / `./client` / `./locale/*` / `./package.json`，
 * 深路径 import 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`。但 `./package.json` 是
 * 导出的 —— 用 `createRequire(...).resolve("dsh-providers-hub/package.json")`
 * 定位真实目录后按**文件 URL** 装 `lib/opencode-proxy.js`，Node 对直接文件
 * URL 不做 exports 校验。这仍是对上游内部布局的假设，所以 {@link loadUpstreamProxyModule}
 * 在启动时**逐项核对导出形状**，缺了就抛 —— 与 `src/core/upstream.ts` 的
 * 「启动即失败」是同一条纪律。
 *
 * ⚠️ 用文件 URL 装上游模块时，其内部的 `import 'undici'` 仍按**它自己的**
 * node_modules 解析 —— 这正是我们要的：dispatcher 与 undici fetch 同源，
 * 不存在跨实例契约问题（IKK4BY 的教训在复用侧天然免疫）。
 */

import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** 上游代理模块的形状（只取我们用到的导出）。 */
export interface UpstreamProxyModule {
  /** 走指定代理发请求；`proxy === undefined` 时回落全局 fetch。 */
  proxyFetch: (input: string | URL | Request, init: RequestInit | undefined, proxy: unknown) => Promise<Response>
  /** 代理地址归一化（唯一判据在上游：http/https/socks5 + 必须显式端口）。 */
  normalizeProxy: (input: string) => { ok: boolean; reason?: string; proxy?: unknown; label?: string }
  /** 缓存的 dispatcher 实例数（诊断用）。 */
  proxyCacheSize: () => number
  /** 关闭并清空全部缓存 dispatcher（进程退出路径）。 */
  closeAllProxyDispatchers: () => Promise<void>
}

let cached: UpstreamProxyModule | undefined

/** 代理 URL 脱敏（全仓唯一实现在上游 `lib/proxy-mask.js`，这里只取件）。 */
export async function loadUpstreamProxyMask(): Promise<(url: string) => string> {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve("dsh-providers-hub/package.json")
  const moduleUrl = pathToFileURL(join(join(pkgPath, ".."), "lib", "proxy-mask.js")).href
  const mod: any = await import(moduleUrl)
  if (typeof mod?.maskProxyPassword !== "function") {
    throw new Error("上游代理模块契约漂移：lib/proxy-mask.js 缺少导出 maskProxyPassword。")
  }
  return mod.maskProxyPassword
}

/** 按文件 URL 装上游 lib 里的一个模块。 */
function upstreamLibUrl(name: string): string {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve("dsh-providers-hub/package.json")
  return pathToFileURL(join(join(pkgPath, ".."), "lib", name)).href
}

/**
 * 装载并核对上游代理实现（进程内单次）。
 *
 * ⚠️ `normalizeProxy` 住在 `lib/opencode.js`（provider 实现模块），
 * `opencode-proxy.js` 只是 import 它、**没有**转导出 —— 所以要装两个文件。
 *
 * @throws 上游改了文件位置或导出名 —— 调用方应在启动路径上触发它，
 *         让漂移在启动期就失败，而不是第一个走代理的请求才炸。
 */
export async function loadUpstreamProxyModule(): Promise<UpstreamProxyModule> {
  if (cached !== undefined) return cached
  const proxyMod: any = await import(upstreamLibUrl("opencode-proxy.js"))
  const opencodeMod: any = await import(upstreamLibUrl("opencode.js"))
  const shape: UpstreamProxyModule = {
    proxyFetch: proxyMod?.proxyFetch,
    normalizeProxy: opencodeMod?.normalizeProxy,
    proxyCacheSize: proxyMod?.proxyCacheSize,
    closeAllProxyDispatchers: proxyMod?.closeAllProxyDispatchers,
  }
  // 逐项核对：任何一项缺失都说明上游动了这份契约 —— 宁可拒绝启动。
  for (const [name, value] of Object.entries(shape)) {
    if (typeof value !== "function") {
      throw new Error(
        `上游代理模块契约漂移：缺少导出 ${name}（取件处：lib/opencode-proxy.js 与 lib/opencode.js）。` +
          "请对照 src/core/egress/proxy-fetch.ts 顶部说明核对上游新布局，并同步修改本文件。",
      )
    }
  }
  cached = shape
  return shape
}
