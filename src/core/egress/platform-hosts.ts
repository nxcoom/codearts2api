/**
 * 平台 → API 域名表 —— 平台级出口绑定的**路由判据**。
 *
 * ## 为什么需要这张表
 *
 * 出站请求有两级绑定：**账号级**（按请求头里的鉴权材料匹配凭据，平台无关）
 * 与**平台级**（整渠道走一个出口）。平台级只能靠「这个请求发往哪个域名」
 * 判断属于哪个渠道 —— 表即答案。
 *
 * ## 数据从哪来、怎么核对
 *
 * 逐条取自上游 `lib/*-product.js`（各平台的 agentHost / baseUrl 常量）与
 * 各 provider 主模块（`zcode-upstream.js` / `gemini.js` / `loomy.js` 等），
 * 采集脚本见 tests/unit/platform-hosts.spec.ts（断言每个条目在 lib 里仍可
 * grep 到）。**缺条目的平台不会坏**：平台级绑定不生效（回落直连），账号级
 * 匹配不受影响。上游加平台/换域名时按 spec 的提示补表。
 *
 * ⚠️ 故意**只收 API 业务域名**，不收登录/OAuth/静态资源域名（accounts.google、
 * geetest、微信 OAuth 等）：平台级绑定的目的是「推理/额度请求走独立出口」，
 * 把 OAuth 也代理走会让扫码登录那类浏览器流程莫名失败，得不偿失。
 */

/** provider id → 该平台 API 请求会发往的 host（不含端口；端口随 URL）。 */
export const PLATFORM_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  accio: ["phoenix-gw.alibaba.com", "zh.accio.com"],
  astudio: ["astronstudio-api-volces-prod.xf-yun.com", "maas-api.cn-huabei-1.xf-yun.com"],
  autoclaw: ["autoglm-acceleration-api.zhipuai.cn", "autoglm-api.autoglm.ai"],
  baizhi: ["ai-models.app.baizhi.cloud"],
  buddy: ["copilot.tencent.com"],
  cline: ["api.cline.bot"],
  codely: ["codely-litellm.tuanjie.cn", "codely.tuanjie.cn"],
  codearts: ["snap-access.cn-north-4.myhuaweicloud.com"],
  doubao: ["www.doubao.com"],
  gemini: ["daily-cloudcode-pa.googleapis.com", "daily-cloudcode-pa.sandbox.googleapis.com"],
  lobsterai: ["lobsterai-server.youdao.com", "api-overmind.youdao.com"],
  loomy: ["loomyad.xunfei.cn"],
  magicrew: ["i-magic-service.letsmagic.cn", "magic-service.magicrew.ai"],
  marvis: ["yybadaccess.3g.qq.com"],
  minimax: ["agent.minimax.cn", "agent.minimax.io"],
  modelscope: ["api-inference.modelscope.cn"],
  monkeycode: ["proxy.monkeycode-ai.com", "proxy.monkeycode-ai.net", "monkeycode-ai.com", "monkeycode-ai.net"],
  officeace: ["officeace.cn-southwest-2.huaweicloud-agentarts.com", "api.modelarts-maas.com"],
  opencode: ["opencode.ai"],
  qiniu: ["api.qnaigc.com"],
  qoder: ["openapi.qoder.sh", "api2.qoder.sh", "api2-v2.qoder.sh", "openapi.qoder.com.cn", "gateway.qoder.com.cn"],
  qodercn: ["openapi.qoder.com.cn", "gateway.qoder.com.cn"],
  raccoon: ["xiaohuanxiong.com"],
  trae: ["api.trae.cn", "api.trae.com.cn", "trae-api-cn.mchost.guru"],
  zcode: ["api.z.ai", "zcode.z.ai"],
})

/**
 * host → provider 候选列表。共享域名（如 qoder 的中国版/国际版两家各有
 * 绑定语义）保留**全部**声明者，按表内声明序 —— 调用方逐个试绑定，第一个
 * 有绑定的赢。表内不存在的 host 返回空数组。
 */
const HOST_TO_PROVIDERS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const [provider, hosts] of Object.entries(PLATFORM_HOSTS)) {
    for (const host of hosts) {
      const owners = map.get(host) ?? []
      if (!owners.includes(provider)) owners.push(provider)
      map.set(host, owners)
    }
  }
  return map
})()

/**
 * 按请求 URL 的 host 反查**全部**候选平台 id（声明序）。
 *
 * @param url - 绝对 URL（拦截器已保证；相对 URL 不进这里）。
 */
export function platformsForUrl(url: string | URL): readonly string[] {
  try {
    const host = typeof url === "string" ? new URL(url).hostname : url.hostname
    return HOST_TO_PROVIDERS.get(host) ?? []
  } catch {
    return []
  }
}

/** 单值便捷封装（首个候选）；拦截器走 {@link platformsForUrl} 逐个试绑定。 */
export function platformForUrl(url: string | URL): string | undefined {
  return platformsForUrl(url)[0]
}
