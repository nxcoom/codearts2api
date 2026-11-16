/**
 * 出口代理 —— 给每个平台的账号绑定独立出口（OpenCode 渠道同款能力的全平台版）。
 *
 * 两级绑定：账号级（按该账号请求头里的鉴权材料命中，最精确）与平台级
 * （整渠道兜底，覆盖凭据里看不到的派生 token）。五家「渠道自带」的渠道
 * 在上游设置里已有入口且优先于本页，页面上以徽标提示。
 */
import { useCallback, useEffect, useState } from "react"

import {
  getOverview,
  setAccountProxy,
  setPlatformProxy,
  testProxy,
  type ProxyProvider,
  type ProxyTestResult,
} from "../../api/egress-proxy"
import styles from "./index.module.less"

/** 一行绑定输入框 + 保存/清除/测试。 */
function ProxyRow({
  label,
  value,
  scope,
  scopeKey,
  native,
  onSaved,
}: {
  label: string
  value: string
  scope: "platform" | "account"
  scopeKey: { provider: string; accountId?: string }
  native?: boolean
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const save = async (clear: boolean) => {
    setBusy(true)
    setMessage(null)
    try {
      const next = clear ? "" : draft.trim()
      if (scope === "platform") await setPlatformProxy(scopeKey.provider, next)
      else await setAccountProxy(scopeKey.provider, scopeKey.accountId!, next)
      setMessage(
        clear && value
          ? { kind: "ok", text: "已清除，恢复直连" }
          : clear
            ? { kind: "ok", text: "未绑定" }
            : { kind: "ok", text: "已保存" },
      )
      onSaved()
    } catch (e: any) {
      setMessage({ kind: "err", text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const target = draft.trim() || value
      if (!target) {
        setMessage({ kind: "err", text: "先填一个代理地址" })
        return
      }
      const result: ProxyTestResult = await testProxy(target)
      if (result.ok) setMessage({ kind: "ok", text: `出口 ${result.ip ?? "?"} · ${result.elapsedMs}ms` })
      else setMessage({ kind: "err", text: `失败：${result.error ?? "HTTP " + result.status}` })
    } catch (e: any) {
      setMessage({ kind: "err", text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const dirty = draft.trim() !== value
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel} title={label}>
        {label}
      </span>
      <input
        className={styles.input}
        placeholder="形如 http://127.0.0.1:7897 或 socks5://user:pass@host:port"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={busy}
        aria-label={label + " 出口代理"}
      />
      <button
        type="button"
        className={styles.btn}
        disabled={busy || (!dirty && draft.trim() === value)}
        onClick={() => void save(false)}
      >
        保存
      </button>
      <button type="button" className={styles.btnGhost} disabled={busy || !value} onClick={() => void save(true)}>
        清除
      </button>
      <button type="button" className={styles.btnGhost} disabled={busy || !draft.trim()} onClick={() => void runTest()}>
        测试
      </button>
      {native ? (
        <span
          className={styles.nativeBadge}
          title="该渠道在上游渠道设置里自带每账号代理，且优先于本页绑定；建议在渠道内配置"
        >
          渠道自带
        </span>
      ) : null}
      {message ? (
        <span className={message.kind === "ok" ? styles.msgOk : styles.msgErr} role="status">
          {message.text}
        </span>
      ) : null}
    </div>
  )
}

function ProviderCard({ provider, onChanged }: { provider: ProxyProvider; onChanged: () => void }) {
  const [open, setOpen] = useState(provider.accounts.length > 0 && !provider.upstreamNative)
  return (
    <div className={styles.card}>
      <button type="button" className={styles.cardHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={styles.chevron} data-open={open || undefined} aria-hidden="true"></span>
        <span className={styles.providerId}>{provider.id}</span>
        {provider.proxy ? <span className={styles.bound}>平台已绑定</span> : null}
        {provider.upstreamNative ? <span className={styles.nativeBadge}>渠道自带</span> : null}
        <span className={styles.count}>{provider.accounts.length} 个账号</span>
      </button>
      {open ? (
        <div className={styles.cardBody}>
          <ProxyRow
            label="平台默认"
            value={provider.proxy}
            scope="platform"
            scopeKey={{ provider: provider.id }}
            native={provider.upstreamNative}
            onSaved={onChanged}
          />
          {provider.accounts.map((account) => (
            <ProxyRow
              key={account.id}
              label={account.id}
              value={account.proxy}
              scope="account"
              scopeKey={{ provider: provider.id, accountId: account.id }}
              onSaved={onChanged}
            />
          ))}
          {provider.accounts.length === 0 ? (
            <div className={styles.empty}>暂无账号（添加账号后这里会出现绑定行）</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default function EgressProxyPage() {
  const [providers, setProviders] = useState<ProxyProvider[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await getOverview()
      setProviders(data.providers)
      setError(null)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>出口代理</h1>
        <p className={styles.desc}>
          按出口 IP 限流/风控的渠道，可为每个账号绑定独立出口：不绑定的账号共用本机出口。优先级
          <code>上游渠道自带 &gt; 账号级 &gt; 平台级 &gt; 直连</code>
          ；绑定保存在 <code>proxy-bindings.json</code>，改动即时生效（无需重启）。
        </p>
      </div>
      {error ? <div className={styles.errBox}>加载失败：{error}</div> : null}
      {providers === null && !error ? <div className={styles.empty}>加载中…</div> : null}
      {providers !== null
        ? providers.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} onChanged={() => void load()} />
          ))
        : null}
    </div>
  )
}
