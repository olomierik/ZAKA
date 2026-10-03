import { useState } from 'react'
import { DepositModal, WithdrawModal } from './CashModals'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The top of the phone home: only what matters. Your cash with Deposit
 * and Withdraw (or, with no wallet yet, one tap to get one), and perpetual
 * futures, on Arc testnet. The coin list follows. */
export default function MobileHome({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const { cash } = useCash(trader.address)
  const [deposit, setDeposit] = useState(false)
  const [withdraw, setWithdraw] = useState(false)

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

      <button className="m-autotrade" onClick={() => navigate({ name: 'futures' })}>
        <span className="m-autotrade-bolt">📊</span>
        <span className="m-autotrade-text">
          <b>{T('Perpetual futures')}</b>
          <span>{T('BTC, ETH and SOL · up to 10×')}</span>
        </span>
        <span className="m-home-live">{T('Testnet')}</span>
        <span className="m-autotrade-go" aria-hidden>›</span>
      </button>

      {deposit && trader.address && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
      {withdraw && trader.address && <WithdrawModal trader={trader} onClose={() => setWithdraw(false)} />}
    </div>
  )
}
