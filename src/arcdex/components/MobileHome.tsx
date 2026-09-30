import { useEffect, useState } from 'react'
import { DepositModal, WithdrawModal } from './CashModals'
import { botMe, botSession, engineEnabled, getBotStatus, getPaperAccount, getScan, paperKey } from '../api/marketStream'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The top of the phone home: only what matters. Your cash with Deposit
 * and Withdraw (or, with no wallet yet, one tap to get one), and the
 * AUTOTRADE button: your paper account if it's running, else the scanner at
 * work. The coin list follows. */
export default function MobileHome({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const { cash } = useCash(trader.address)
  const [deposit, setDeposit] = useState(false)
  const [withdraw, setWithdraw] = useState(false)
  const [live, setLive] = useState(false)
  const [scanning, setScanning] = useState<number | null>(null)
  const [mine, setMine] = useState<{ running: boolean; equity: number; name: string | null } | null>(null)

  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    const load = () => {
      void getScan(1).then(s => { if (alive) setScanning(s.stats.watching) }).catch(() => {})
      void getBotStatus().then(s => { if (alive) setLive(s.mode === 'live') }).catch(() => {})
      // The signed-in owner's first running bot (else their first), or this browser's older key bot.
      if (botSession()) void botMe().then(m => { const a = m.bots.find(b => b.running) ?? m.bots[0]; if (alive && a) setMine({ running: a.running, equity: a.equity, name: a.name ?? null }) }).catch(() => {})
      else { const key = paperKey(); if (key) void getPaperAccount(key).then(a => { if (alive) setMine({ running: a.running, equity: a.equity, name: a.name ?? null }) }).catch(() => {}) }
    }
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  return (
    <div className="m-home">
      <div className="m-home-cash">
        {trader.address ? (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="m-home-balance">{cash === null ? '…' : usd(cash)}</div>
              <div className="m-home-label">{T('Cash · USDC on Arc')}</div>
            </div>
            <button className="m-home-cta" onClick={() => setDeposit(true)}>{T('Deposit')}</button>
          </>
        ) : (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="m-home-balance small">{T('Trade Arc coins in one tap')}</div>
              <div className="m-home-label">{T('No app needed — your trading wallet lives in this browser.')}</div>
            </div>
            <button className="m-home-cta" onClick={openTradingWallet}>{T('Get started')}</button>
          </>
        )}
      </div>
      {trader.address && (
        <div className="m-home-actions">
          <button onClick={() => setWithdraw(true)}>{T('↑ Withdraw')}</button>
        </div>
      )}

      {engineEnabled && (
        <button className="m-autotrade" onClick={() => navigate({ name: 'signals' })}>
          <span className="m-autotrade-bolt">⚡</span>
          <span className="m-autotrade-text">
            <b>AUTOTRADE</b>
            <span>
              {mine?.running ? <><span className="m-autotrade-dot" />{mine.name ? `${mine.name} · ` : ''}{T('Running · {v} virtual', { v: usd(mine.equity) })}</>
                : scanning !== null ? <><span className="m-autotrade-dot" />{T('Scanning {n} coins · start with virtual USDC', { n: scanning.toLocaleString() })}</>
                : T('Start with virtual USDC')}
            </span>
          </span>
          {live && <span className="m-home-live">{T('LIVE')}</span>}
          <span className="m-autotrade-go" aria-hidden>›</span>
        </button>
      )}

      {deposit && trader.address && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
      {withdraw && trader.address && <WithdrawModal trader={trader} onClose={() => setWithdraw(false)} />}
    </div>
  )
}
