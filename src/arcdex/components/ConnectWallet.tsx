import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAccount, useConnect, type Connector } from 'wagmi'
import { arc } from '../wagmi'
import { t as T } from '../lib/i18n'

// "Connect wallet" for the whole app — a small modal over wagmi's own
// connectors, in place of ConnectKit (which, with its Aave account kit,
// styled-components and animation libraries, was ~40% of the app's JS).
// Browser wallets announce themselves (EIP-6963) and each gets a row with
// its own icon; WalletConnect opens its QR code / mobile wallet list;
// Coinbase Wallet opens its own flow. Open it from anywhere with
// openConnectModal().

let isOpen = false
const subs = new Set<() => void>()
const setOpen = (v: boolean) => { isOpen = v; subs.forEach(f => f()) }
export const openConnectModal = () => setOpen(true)

export function ConnectButton({ label, style }: { label?: string; style?: React.CSSProperties }) {
  return <button className="connect-btn" onClick={openConnectModal} style={style}>{label ?? T("Connect Wallet")}</button>
}

const WC_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#3B99FC"/><path d="M12.3 15.6c4.3-4.2 11.2-4.2 15.4 0l.5.5c.2.2.2.6 0 .8l-1.8 1.7c-.1.1-.3.1-.4 0l-.7-.7c-3-2.9-7.8-2.9-10.8 0l-.8.7c-.1.1-.3.1-.4 0l-1.8-1.7c-.2-.2-.2-.6 0-.8l.8-.5zm19 3.5 1.6 1.6c.2.2.2.6 0 .8l-7.2 7c-.2.2-.6.2-.8 0l-5.1-5c-.1-.1-.1-.1-.2 0l-5.1 5c-.2.2-.6.2-.8 0l-7.2-7c-.2-.2-.2-.6 0-.8l1.6-1.6c.2-.2.6-.2.8 0l5.1 5c.1.1.1.1.2 0l5.1-5c.2-.2.6-.2.8 0l5.1 5c.1.1.1.1.2 0l5.1-5c.2-.2.6-.2.8 0z" fill="#fff"/></svg>')
const CB_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#0052FF"/><circle cx="20" cy="20" r="11" fill="#fff"/><rect x="16" y="16" width="8" height="8" rx="1.5" fill="#0052FF"/></svg>')
const MM_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#F6851B"/><path d="M29 11l-7.4 5.5 1.4-3.2L29 11zM11 11l7.3 5.6-1.3-3.3L11 11zm15.4 12.8-2 3 4.2 1.2 1.2-4.1-3.4-.1zm-16.4.1 1.2 4.1 4.2-1.2-2-3-3.4.1zm5.2-5.2-1.2 1.8 4.2.2-.1-4.5-2.9 2.5zm8.8 0-2.9-2.6-.1 4.6 4.2-.2-1.2-1.8zm-8.6 8.1 2.5-1.2-2.2-1.7-.3 2.9zm5.8-1.2 2.5 1.2-.3-2.9-2.2 1.7z" fill="#fff"/></svg>')

const isMobile = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

function label(c: Connector): { name: string; icon: string | undefined; hint?: string } {
  if (c.type === 'walletConnect') return { name: 'WalletConnect', icon: WC_ICON, hint: T("QR code · mobile wallets") }
  if (c.id === 'coinbaseWalletSDK') return { name: 'Coinbase Wallet', icon: CB_ICON }
  if (c.id === 'metaMask') return { name: 'MetaMask', icon: c.icon ?? MM_ICON }
  if (c.id === 'injected') return { name: T("Browser wallet"), icon: undefined }
  return { name: c.name, icon: c.icon }
}

export function ConnectModalHost() {
  const open = useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => isOpen)
  const { connectors, connectAsync } = useConnect()
  const { isConnected } = useAccount()
  const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState('')
  // Which injected connectors actually have a wallet behind them.
  const [present, setPresent] = useState<Set<string>>(new Set())

  useEffect(() => { if (isConnected && open) setOpen(false) }, [isConnected, open])
  useEffect(() => {
    if (!open) { setErr(''); setPending(null); return }
    let alive = true
    void Promise.all(connectors.filter(c => c.type === 'injected').map(async c => (await c.getProvider().catch(() => null)) ? c.id : null))
      .then(ids => { if (alive) setPresent(new Set(ids.filter((x): x is string => !!x))) })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { alive = false; document.removeEventListener('keydown', onKey) }
  }, [open, connectors])

  if (!open) return null

  // Announced wallets (MetaMask, Rabby, OKX…), then a generic "browser
  // wallet" only if nothing announced itself, then WalletConnect/Coinbase.
  // The legacy `metaMask` connector (kept so earlier sessions reconnect)
  // is hidden when MetaMask also announced itself, with its own icon.
  const seen = new Set<string>()
  const announced = connectors
    .filter(c => c.type === 'injected' && c.id !== 'injected' && present.has(c.id))
    .sort((a, b) => Number(a.id === 'metaMask') - Number(b.id === 'metaMask'))
    .filter(c => { const k = label(c).name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  const generic = announced.length === 0 ? connectors.filter(c => c.id === 'injected' && present.has(c.id)) : []
  const others = connectors.filter(c => c.type === 'walletConnect' || c.id === 'coinbaseWalletSDK')
  const rows = [...announced, ...generic, ...others]
  const noBrowserWallet = announced.length + generic.length === 0

  async function pick(c: Connector) {
    setErr(''); setPending(c.uid)
    // WalletConnect shows its own QR code / wallet list on top.
    if (c.type === 'walletConnect') setOpen(false)
    try {
      await connectAsync({ connector: c, chainId: arc.id })
      setOpen(false)
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : '')
      if (c.type === 'walletConnect' && !/reject|closed|denied/i.test(msg)) { setOpen(true); setErr(msg) }
      else if (!/reject|closed|denied|cancel/i.test(msg)) setErr(msg || T("Could not connect — try again"))
    } finally { setPending(null) }
  }

  const here = typeof window !== 'undefined' ? window.location.host + window.location.pathname : 'arcdex.online/app'
  return (
    <div className="modal-back" onClick={() => setOpen(false)}>
      <div className="modal-card" style={{ width: 'min(380px, 100%)' }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={T("Connect a wallet")}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <b style={{ fontSize: '1rem' }}>{T("Connect a wallet")}</b>
          <button onClick={() => setOpen(false)} aria-label={T("Close")} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(c => {
            const l = label(c)
            return (
              <button key={c.uid} className="wallet-row" onClick={() => void pick(c)} disabled={!!pending}>
                {l.icon ? <img src={l.icon} alt="" width={28} height={28} style={{ borderRadius: 7 }} /> : <span className="wallet-row-blank">🦊</span>}
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                  <span style={{ fontWeight: 700 }}>{l.name}</span>
                  {l.hint && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{l.hint}</span>}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{pending === c.uid ? T("Check your wallet…") : ''}</span>
              </button>
            )
          })}
          {noBrowserWallet && isMobile() && (
            <a className="wallet-row" href={`https://metamask.app.link/dapp/${here}`}>
              <img src={MM_ICON} alt="" width={28} height={28} style={{ borderRadius: 7 }} />
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <span style={{ fontWeight: 700 }}>{T("Open in MetaMask")}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{T("Uses the MetaMask app's browser")}</span>
              </span>
            </a>
          )}
        </div>
        {err && <div style={{ fontSize: '0.76rem', color: '#fca5a5', wordBreak: 'break-word' }}>{err}</div>}
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {noBrowserWallet && !isMobile() ? T("No browser wallet found — install MetaMask or Rabby, or scan with WalletConnect.") + ' ' : ''}
          {T("No wallet? The ARCDEX trading wallet lives in your browser — one-tap trades, no pop-ups.")}
        </div>
      </div>
    </div>
  )
}
