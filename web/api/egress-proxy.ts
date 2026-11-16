/** 出口代理后端 REST 接口（/admin/proxy/api）。 */
const API = "/admin/proxy/api"

export interface ProxyAccount {
  id: string
  enabled: boolean
  /** 已绑定代理（服务端已脱敏）；空串 = 未绑定。 */
  proxy: string
}
export interface ProxyProvider {
  id: string
  /** 平台级绑定（整渠道共用出口）；空串 = 未绑定。 */
  proxy: string
  /** 上游渠道自带每账号代理（建议用渠道内设置）。 */
  upstreamNative: boolean
  accounts: ProxyAccount[]
}
export interface ProxyOverview {
  providers: ProxyProvider[]
}
export interface ProxyTestResult {
  ok: boolean
  status?: number
  ip?: string
  elapsedMs: number
  error?: string
}

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && (data as any).error) || "HTTP " + res.status)
  return data as T
}

export const getOverview = () => request<ProxyOverview>("/overview")
export const setPlatformProxy = (provider: string, proxy: string) =>
  request<ProxyOverview>(`/platforms/${encodeURIComponent(provider)}`, {
    method: "PUT",
    body: JSON.stringify({ proxy }),
  })
export const setAccountProxy = (provider: string, accountId: string, proxy: string) =>
  request<ProxyOverview>(`/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    body: JSON.stringify({ proxy }),
  })
export const testProxy = (proxy: string) =>
  request<ProxyTestResult>("/test", { method: "POST", body: JSON.stringify({ proxy }) })
