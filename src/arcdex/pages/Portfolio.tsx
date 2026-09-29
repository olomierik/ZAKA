import { useCallback, useEffect, useState } from 'react'
import { loadHoldings, type Holding } from '../api/holdings'
import { ConnectButton } from '../components/ConnectWallet'
import { DepositModal, WithdrawModal } from '../components/CashModals'
import Sheet from '../components/Sheet'
import TokenSwap from '../components/TokenSwap'
import { shortAddr, useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// Your cash and every coin you hold — from whichever wallet you trade with
// (the one-tap trading wallet or a connected one), with Deposit, Withdraw,
// and Sell to USDC on each coin.

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n >= 1 ? n.toFixed(2) : n.toPrecision(3)

export default function Portfolio({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address
  const { cash, refresh: refreshCash } = useCash(me)
  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [modal, setModal] = useState<'deposit' | 'withdraw' | null>(null)
  const [selling, setSelling] = useState<Holding | null>(null)

  const load = useCallback(() => {
    if (!me) return
    loadHoldings(me).then(setHoldings).catch(() => setHoldings(h => h ?? []))
  }, [me])
  useEffect(() => {
    setHoldings(null)
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 30_000)
    return () => clearInterval(id)
  }, [load])

  if (!me) return (
    <div className="pf-empty">
      <div style={{ fontSize: '2.6rem' }}>💼</div>
      <h2>{T("Your portfolio")}</h2>
      <p>{T("Your cash and coins show up here — from your one-tap trading wallet or a connected wallet.")}</p>
      <button className="btn-primary" onClick={openTradingWallet}>⚡ {T("Open trading wallet")}</button>
      <ConnectButton />
    </div>
  )

  const coins = holdings?.reduce((s, h) => s + h.valueUsd, 0) ?? 0
  const total = (cash ?? 0) + coins
  const afterTrade = () => { load(); refreshCash() }

  return (
    <div className="portfolio">
      <div className="pf-head">
        <h1>{T("Portfolio")}</h1>
        <span className="pf-wallet">{trader.kind === 'trading-wallet' ? `⚡ ${T("Trading wallet")}` : T("Wallet")} · <span className="mono">{shortAddr(me)}</span></span>
        <button className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => navigate({ name: 'transfers' })}>{T("Transfers")} →</button>
      </div>

      <div className="pf-summary">
        <div className="pf-label">{T("Total value")}</div>
        <div className="pf-total sensitive">{cash === null && holdings === null ? '…' : usd(total)}</div>
        <div className="pf-split">
          <span>{T("Cash")} <b className="sensitive">{cash === null ? '…' : usd(cash)}</b></span>
          <span>{T("Coins")} <b className="sensitive">{holdings === null ? '…' : usd(coins)}</b></span>
        </div>
        <div className="pf-actions">
          <button className="btn-primary" onClick={() => setModal('deposit')}>{T("Deposit")}</button>
          <button className="btn-ghost" onClick={() => setModal('withdraw')}>{T("Withdraw")}</button>
        </div>
      </div>

      <div className="pf-section">{T("Holdings")}</div>
      {holdings === null ? (
        <div className="loading-state">{T("Loading your coins…")}</div>
      ) : holdings.length === 0 ? (
        <div className="pf-none">
          {T("No coins yet.")}{' '}
          <button className="link-btn" onClick={() => navigate({ name: 'terminal' })}>{T("Find one on the Terminal →")}</button>
        </div>
      ) : holdings.map(h => (
        <div key={h.address} className="pf-row" onClick={() => navigate({ name: 'argus', address: h.address, pool: h.pool ?? '' })}>
          {h.image
            ? <img src={h.image} alt="" width={38} height={38} className="pf-logo" onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
            : <span className="pf-logo pf-logo-blank">{h.symbol.slice(0, 2)}</span>}
          <div className="pf-coin">
            <b>{h.symbol}</b>
            <span className="mono">{amt(h.amount)} {h.symbol}</span>
          </div>
          <div className="pf-value">
            <b className="mono sensitive">{h.priceUsd > 0 ? usd(h.valueUsd) : '—'}</b>
            {h.change24h !== null && <span style={{ color: h.change24h >= 0 ? 'var(--green)' : 'var(--red)' }}>{h.change24h >= 0 ? '+' : ''}{h.change24h.toFixed(1)}%</span>}
          </div>
          <button className="pf-sell" onClick={e => { e.stopPropagation(); setSelling(h) }}>{T("Sell")}</button>
        </div>
      ))}

      <Sheet open={!!selling} onClose={() => setSelling(null)} title={selling ? T('Sell {symbol} for USDC', { symbol: selling.symbol }) : undefined}>
        {selling && <TokenSwap key={selling.address} address={selling.address} pool={selling.pool ?? undefined} initialMode="sell" onTraded={afterTrade} />}
      </Sheet>
      {modal === 'deposit' && <DepositModal trader={trader} navigate={navigate} onClose={() => { setModal(null); refreshCash() }} />}
      {modal === 'withdraw' && <WithdrawModal trader={trader} onClose={() => { setModal(null); refreshCash() }} />}
    </div>
  )
}
