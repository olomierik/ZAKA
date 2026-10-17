// /analytics, for everyone (owner, 2026-10-17: "what is hindering me to see the analytics page as a normal user; put it
// there for everyone to see the number of users, wallets, volume traded, fees collected and others"). The engine's
// public stats (GET /v1/stats, engine/src/analytics.ts publicStats): users, traders, trades, volume, fees, visitors,
// by chain and day by day, with no wallet address or transaction in it. The admin panel keeps the full view.
import { useEffect } from 'react'
import AdminAnalytics from '../components/AdminAnalytics'
import { t as T } from '../lib/i18n'

export default function StatsPage() {
  useEffect(() => { document.title = `${T('ARCDEX in numbers')} | ARCDEX` }, [])
  return (
    <div className="content-page rt-page" style={{ '--page-w': '1080px' } as React.CSSProperties}>
      <h1 className="page-h" style={{ marginBottom: 4 }}>{T('ARCDEX in numbers')}</h1>
      <p className="rt-sub">{T('How many people use ARCDEX, what they trade and the fees it collects, read again every 30 seconds. A trade counts once its transaction is found on its chain; fees are read from the fee ledger on-chain.')}</p>
      <AdminAnalytics pub />
    </div>
  )
}
