// /analytics, public (owner, 2026-10-17: "analytics page should be public, I can't see it"): ARCDEX's users, traders,
// volume and fees, read from the engine's GET /v1/analytics (engine/src/analytics.ts publicReport) with no sign-in.
// Wallets are shortened; the admin panel's Analytics tab shows the same numbers with full addresses.
import AdminAnalytics from '../components/AdminAnalytics'
import { t as T } from '../lib/i18n'

export default function AnalyticsPage() {
  return (
    <div className="content-page" data-testid="analytics-page">
      <h1 className="page-h">{T('Analytics')}</h1>
      <p className="fx-fine" style={{ marginBottom: 12 }}>{T('ARCDEX’s users, traders, volume and fees, live. Every trade is checked on its own chain before it counts.')}</p>
      <AdminAnalytics publicView />
    </div>
  )
}
