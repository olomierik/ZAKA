import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { DepositModal } from './CashModals'
import { getLeaderboard, getProfiles, type LeaderRow, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { useCash } from '../lib/usdc'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pnl = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(2) + 'K' : Math.abs(n).toFixed(0)}`

/** The top of the phone home, the way fomo's app opens: your cash and a
 * Deposit button (or, with no wallet yet, one tap to get one), then the
 * week's top traders side by side. The coin list follows. */
export default function MobileHome({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const { cash } = useCash(trader.address)
  const [deposit, setDeposit] = useState(false)
  const [top, setTop] = useState<LeaderRow[]>([])
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())

  useEffect(() => {
    let alive = true
    void getLeaderboard('7d', 12).then(async rows => {
      if (!alive) return
      // Winners first (by realized PnL), then the most active by volume.
      const list = [...rows].sort((a, b) => Math.max(0, b.realized_pnl) - Math.max(0, a.realized_pnl) || b.volume_usdc - a.volume_usdc).slice(0, 10)
      setTop(list.length >= 3 ? list : [])
      const p = await getProfiles(list.map(r => r.trader)).catch(() => new Map<string, Profile>())
      if (alive) setProfiles(p)
    }).catch(() => {})
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

      {top.length > 0 && (
        <div className="m-home-traders" aria-label={T('Top traders this week')}>
          {top.map(r => {
            const p = profiles.get(r.trader)
            return (
              <button key={r.trader} className="m-trader-card" onClick={() => navigate({ name: 'trader', address: r.trader })}>
                <span className="m-trader-name">
                  <Avatar address={r.trader} url={p?.avatar_url} size={18} />
                  <span>{p?.username ? p.username : p?.display_name || shortAddr(r.trader)}</span>
                </span>
                {r.realized_pnl > 0
                  ? <span className="m-trader-pnl">{pnl(r.realized_pnl)}</span>
                  : <span className="m-trader-vol">{T('{usd} traded', { usd: pnl(r.volume_usdc).slice(1) })}</span>}
              </button>
            )
          })}
        </div>
      )}

      {deposit && trader.address && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
    </div>
  )
}
