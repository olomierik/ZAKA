// A bar on every page while the trade switch has trading off anywhere (lib/tradeSwitch.ts): where, and why. Trades
// there are refused before anything is signed; withdrawals and transfers still work.
import { TRADE_VENUE_LABEL, type TradeVenue } from '../../../api/_marketProtocol'
import { t as T } from '../lib/i18n'
import { useTradeSwitch } from '../lib/tradeSwitch'

export function TradePausedBar() {
  const s = useTradeSwitch()
  if (!s) return null
  const venues = Object.entries(s.venues ?? {}) as [TradeVenue, { reason: string }][]
  if (!s.all && !venues.length) return null
  return (
    <div className="net-guard trade-paused" role="status">
      <span style={{ flex: 1, minWidth: 0 }}>
        ⏸ {s.all
          ? T('Trading is paused everywhere: {reason}', { reason: s.all.reason })
          : venues.map(([v, o]) => T('Trading on {venue} is paused: {reason}', { venue: TRADE_VENUE_LABEL[v], reason: o.reason })).join(' · ')}
        {' '}{T('Withdrawals and transfers still work.')}
      </span>
    </div>
  )
}
