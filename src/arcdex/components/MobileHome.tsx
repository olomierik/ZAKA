import { useEffect, useState } from 'react'
import type { TradeSignal } from '../../../api/_marketProtocol'
import { DepositModal, WithdrawModal } from './CashModals'
import { AgoText } from './Ago'
import { engineEnabled, getBotStatus, getSignals } from '../api/marketStream'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const STRATEGY: Record<TradeSignal['strategy'], string> = { snipe: 'Snipe', scalp: 'Fast scalp', 'second-leg': 'Second leg' }

/** The top of the phone home: only what matters. Your cash with Deposit
 * and Withdraw (or, with no wallet yet, one tap to get one), and the signal
 * bot's latest pick. The coin list follows. */
export default function MobileHome({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const { cash } = useCash(trader.address)
  const [deposit, setDeposit] = useState(false)
  const [withdraw, setWithdraw] = useState(false)
  const [latest, setLatest] = useState<TradeSignal | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!engineEnabled) return
    let alive = true
    void getSignals(1).then(s => { if (alive) setLatest(s[0] ?? null) }).catch(() => {})
    void getBotStatus().then(s => { if (alive) setLive(s.mode === 'live') }).catch(() => {})
    return () => { alive = false }
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
        <button className="m-home-signal" onClick={() => navigate({ name: 'signals' })}>
          <span className="m-home-signal-icon">⚡</span>
          <span className="m-home-signal-text">
            {latest
              ? <>{T('Latest signal')} <b>${latest.symbol}</b> · {T(STRATEGY[latest.strategy] ?? latest.strategy)} · <AgoText ts={latest.at} /></>
              : T("Signals: the bot's picks and results")}
          </span>
          {live && <span className="m-home-live">{T('LIVE')}</span>}
          <span aria-hidden>›</span>
        </button>
      )}

      {deposit && trader.address && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
      {withdraw && trader.address && <WithdrawModal trader={trader} onClose={() => setWithdraw(false)} />}
    </div>
  )
}
