import { RISK_COLOR, riskLabel, riskReasons, riskText, type Risk } from '../lib/risk'
import { t as T } from '../lib/i18n'

/** A coin's risk: "12 LOW" in green, "48 MEDIUM" in amber, "81 HIGH" in
 * red, with the reasons on hover. `quick`: scored from market data alone
 * (Terminal rows). `compact`: "Low risk", no number (phone cards). */
export default function RiskBadge({ risk, quick = false, compact = false }: { risk: Risk; quick?: boolean; compact?: boolean }) {
  const c = RISK_COLOR[risk.level]
  const reasons = riskReasons(risk)
  const title = [
    T('Risk {score}/100 · {level}', { score: risk.score, level: riskLabel(risk.level) }),
    ...(reasons.length ? reasons.map(r => '• ' + r) : [T('No red flags found')]),
    quick ? T('A quick check from market data. Open the coin for its full safety check.') : T('From public on-chain and market data. Not financial advice.'),
  ].join('\n')
  return (
    <span className="risk-badge" title={title} style={{ color: c, borderColor: c + '66', background: c + '1a' }}>
      {compact ? riskText(risk.level) : <><b>{risk.score}</b>{riskLabel(risk.level)}</>}
    </span>
  )
}
