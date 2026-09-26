import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectButton } from '../components/ConnectWallet'
import { DepositModal, WithdrawModal } from '../components/CashModals'
import Sheet from '../components/Sheet'
import TokenSwap from '../components/TokenSwap'
import { hasStoredWallet } from '../lib/embeddedWallet'
import { shortAddr, useTrader } from '../lib/identity'
import { loadHoldings, type Holding } from '../lib/portfolio'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import { useCash } from '../lib/usdc'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// Your wallet on Arc: USDC cash and every coin you hold, valued live, with
// Sell (to USDC) and Send on each coin and Deposit / Withdraw for cash.
// "You" is the unlocked trading wallet, else the connected wallet
// (lib/identity.ts), the same wallet every trade uses.

interface Props {
  navigate: (p: Page) => void
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amountFmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 4 })
const priceFmt = (v: number) => v >= 1 ? `$${v.toFixed(4)}` : v > 0 ? `$${v.toPrecision(4)}` : '—'
/** Holdings worth less than this sit behind "Show small balances". */
const DUST_USD = 0.01

export default function Portfolio({ navigate }: Props) {
  const trader = useTrader()
  const me = trader.address
  const { cash, refresh: refreshCash } = useCash(me)
  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [showDust, setShowDust] = useState(false)
  const [sell, setSell] = useState<Holding | null>(null)
  const [send, setSend] = useState<Holding | null>(null)
  const [modal, setModal] = useState<'deposit' | 'withdraw' | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    if (!me) return
    const n = ++seq.current
    loadHoldings(me)
      .then(h => { if (n === seq.current) { setHoldings(h); setFailed(false) } })
      .catch(() => { if (n === seq.current) { setFailed(true); setHoldings(h => h ?? []) } })
  }, [me])

  useEffect(() => {
    setHoldings(null); setFailed(false)
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 45_000)
    return () => clearInterval(id)
  }, [load])

  const afterTrade = useCallback(() => { refreshCash(); load() }, [refreshCash, load])

  if (!me) {
    const stored = hasStoredWallet()
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '72px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: '3rem' }}>💼</div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{T("Your portfolio")}</h2>
        <p style={{ color: 'var(--text-muted)', maxWidth: 360, margin: 0, lineHeight: 1.5 }}>
          {stored ? T("Unlock your trading wallet to see your coins and cash.") : T("Create a trading wallet or connect a wallet to see your coins and cash on Arc.")}
        </p>
        <button className="btn-primary" style={{ padding: '11px 22px' }} onClick={openTradingWallet}>{stored ? T("Unlock trading wallet") : T("Create trading wallet")}</button>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{T("or")}</div>
        <ConnectButton />
      </div>
    )
  }

  const coinsValue = (holdings ?? []).reduce((s, h) => s + h.valueUsd, 0)
  const total = (cash ?? 0) + coinsValue
  const visible = (holdings ?? []).filter(h => showDust || h.valueUsd >= DUST_USD || h.priceUsd === 0)
  const dust = (holdings ?? []).length - visible.length

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: 4 }}>{T("Portfolio")}</h1>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {trader.kind === 'trading-wallet' ? `⚡ ${T("Trading wallet")}` : T("Wallet")} · {shortAddr(me)}{' '}{T("· Arc Mainnet")}
        </div>
      </div>

      <div className="arc-card" style={{ padding: 22, marginBottom: 20, background: 'linear-gradient(135deg,rgba(59,130,246,0.1),rgba(139,92,246,0.1))' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{T("Total Portfolio Value")}</div>
        <div className="sensitive" style={{ fontSize: '2.3rem', fontWeight: 800, fontFamily: 'var(--mono)' }}>{cash === null && holdings === null ? '…' : money(total)}</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 6 }}>
          <span>{T("Cash (USDC)")}: <b className="sensitive" style={{ color: 'var(--text)' }}>{cash === null ? '…' : money(cash)}</b></span>
          <span>{T("Coins")}: <b className="sensitive" style={{ color: 'var(--text)' }}>{holdings === null ? '…' : money(coinsValue)}</b></span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn-primary" style={{ flex: 1, padding: '10px 14px' }} onClick={() => setModal('deposit')}>{T("Deposit")}</button>
          <button className="btn-ghost" style={{ flex: 1, padding: '10px 14px' }} onClick={() => setModal('withdraw')}>{T("Withdraw")}</button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontSize: '0.95rem' }}>{T("Your coins")}</b>
        <button className="link-btn" onClick={load} style={{ fontSize: '0.75rem' }}>{T("Refresh")}</button>
      </div>

      {holdings === null && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>{T("Loading your coins…")}</div>}
      {failed && <div style={{ textAlign: 'center', padding: 12, color: '#fca5a5', fontSize: '0.8rem' }}>{T("Couldn't reach Arc to load every balance. Showing what loaded — tap Refresh to try again.")}</div>}
      {holdings !== null && holdings.length === 0 && !failed && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>{T("No coins yet — buy one from the Terminal and it shows up here.")}</div>
      )}

      {visible.map(h => (
        <div key={h.address} className="arc-card" style={{ padding: '14px 16px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={() => navigate({ name: 'argus', address: h.address, pool: h.pool ?? '' })}
            style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 220px', minWidth: 0, background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
            {h.image ? (
              <img src={h.image} width={40} height={40} style={{ borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }} alt=""
                onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
            ) : (
              <div style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0, background: `hsl(${parseInt(h.address.slice(2, 4), 16) * 1.4}deg 60% 40%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>{h.symbol.slice(0, 2)}</div>
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.symbol}</span>
                <span className="sensitive" style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{h.priceUsd > 0 ? money(h.valueUsd) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 3 }}>
                <span className="mono sensitive">{amountFmt(h.balance)} {h.symbol}</span>
                <span className="mono">{priceFmt(h.priceUsd)}</span>
              </div>
            </div>
          </button>
          <div style={{ display: 'flex', gap: 6, flex: '0 0 auto', marginLeft: 'auto' }}>
            <button onClick={() => setSell(h)} style={{ padding: '8px 14px', borderRadius: 8, fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', background: 'rgba(239,68,68,0.12)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.35)' }}>{T("Sell to USDC")}</button>
            <button onClick={() => setSend(h)} className="btn-ghost" style={{ padding: '8px 12px', fontSize: '0.8rem' }}>{T("Send")}</button>
          </div>
        </div>
      ))}

      {dust > 0 && (
        <div style={{ textAlign: 'center', marginTop: 6 }}>
          <button className="link-btn" onClick={() => setShowDust(true)} style={{ fontSize: '0.78rem' }}>{T("Show {n} small balances", { n: dust })}</button>
        </div>
      )}

      <Sheet open={!!sell} onClose={() => setSell(null)} title={sell ? T('Sell {symbol}', { symbol: sell.symbol }) : undefined}>
        {sell && <TokenSwap key={sell.address} address={sell.address} pool={sell.pool ?? undefined} initialMode="sell"
          fallback={{ symbol: sell.symbol, image: sell.image, priceUsd: sell.priceUsd }} onTraded={afterTrade} />}
      </Sheet>
      {send && <WithdrawModal trader={trader} asset={{ address: send.address, symbol: send.symbol, decimals: send.decimals }} onClose={() => setSend(null)} onSent={afterTrade} />}
      {modal === 'deposit' && <DepositModal trader={trader} navigate={navigate} onClose={() => { setModal(null); refreshCash() }} />}
      {modal === 'withdraw' && <WithdrawModal trader={trader} onClose={() => { setModal(null); refreshCash() }} onSent={refreshCash} />}
    </div>
  )
}
