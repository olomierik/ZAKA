import { SAFETY_COLOR, SAFETY_ICON, SAFETY_LABEL, type SafetyView } from '../lib/safety'
import { t as T } from '../lib/i18n'

/** A coin's safety rating (lib/safety.ts): "✅ Safe", "⚠ Risky", "⛔ Danger" or "◌ Checking", with the reasons on hover.
 * `icon`: the icon alone (board cards, phone rows). */
export default function SafetyBadge({ view, icon = false }: { view: SafetyView; icon?: boolean }) {
  const c = SAFETY_COLOR[view.level]
  const title = [
    `${SAFETY_ICON[view.level]} ${T(SAFETY_LABEL[view.level])}`,
    ...view.reasons.map(r => '• ' + r),
    view.source === 'chain' ? T('From ARCDEX’s on-chain safety scan. Not financial advice.') : T('From its market data only: not scanned on-chain. Not financial advice.'),
  ].join('\n')
  return (
    <span className={`safety-badge safety-${view.level}${icon ? ' icon' : ''}`} title={title} style={{ color: c, borderColor: c + '66', background: c + '1a' }}>
      <i aria-hidden>{SAFETY_ICON[view.level]}</i>{!icon && T(SAFETY_LABEL[view.level])}
    </span>
  )
}
