import DiscoveryPanel from '../components/DiscoveryPanel'
import type { Page } from '../App'

// /alerts — on phones the discovery panel lives in the drawer, so this
// gives Alerts (and the other discovery tabs) a full page of their own.

export default function AlertsPage({ navigate }: { navigate: (p: Page) => void }) {
  return (
    <div className="token-page" style={{ maxWidth: 520, height: 'calc(100vh - 120px)' }}>
      <DiscoveryPanel navigate={navigate} initialTab="alerts" />
    </div>
  )
}
