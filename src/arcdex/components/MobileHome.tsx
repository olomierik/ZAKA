import { useState } from 'react'
import { DepositModal, WithdrawModal } from './CashModals'
import { useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The top of the phone Markets page: one line with your cash, Withdraw and Deposit (or, with no
 * wallet yet, one tap to get one). The coin list follows straight under it. */
export default function MobileHome({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const { cash } = useCash(trader.address)
  const [deposit, setDeposit] = useState(false)
  const [withdraw, setWithdraw] = useState(false)

  // One slim line, so the coins start right under it (Binance's app has no banner above its markets).
  return (
    <div className="m-home m-home-slim">
      {trader.address ? (
        <>
          <div className="m-slim-cash"><b>{cash === null ? '…' : usd(cash)}</b><span>{T('Cash · USDC on Arc')}</span></div>
          <button className="m-slim-btn" onClick={() => setWithdraw(true)}>{T('Withdraw')}</button>
          <button className="m-slim-btn primary" onClick={() => setDeposit(true)}>{T('Deposit')}</button>
        </>
      ) : (
        <>
          <div className="m-slim-cash"><b>{T('Trade Arc coins in one tap')}</b><span>{T('No app needed — your trading wallet lives in this browser.')}</span></div>
          <button className="m-slim-btn primary" onClick={openTradingWallet}>{T('Get started')}</button>
        </>
      )}

      {deposit && trader.address && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
      {withdraw && trader.address && <WithdrawModal trader={trader} onClose={() => setWithdraw(false)} />}
    </div>
  )
}
