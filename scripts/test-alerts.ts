// Price alerts (src/arcdex/hl/alerts.ts): which way an alert points, when it fires live, when the candles say it fired
// while the page was closed, and the limits.
//   bun scripts/test-alerts.ts

import { activeAlerts, addAlert, AlertError, ALERTS, checkAlerts, clearFired, freshAlerts, removeAlert, replayAlerts, saveAlerts, updateAlerts } from '../src/arcdex/hl/alerts'
import type { Bar } from '../src/arcdex/hl/history'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }
const refused = (f: () => unknown, msg: RegExp) => { try { f(); return false } catch (e) { return e instanceof AlertError && msg.test(e.message) } }

const T0 = 1_791_763_200_000
const bar = (coin: string, t: number, o: number, h: number, l: number, c: number): Bar => ({ coin, t, ms: 60_000, o, h, l, c })
const base = () => {
  let s = freshAlerts(T0)
  s = addAlert(s, { id: 'up', coin: 'BTC', label: 'BTC', px: 90_000, from: 85_000, now: T0 })
  s = addAlert(s, { id: 'down', coin: 'BTC', label: 'BTC', px: 80_000, from: 85_000, now: T0 })
  s = addAlert(s, { id: 'nvda', coin: 'xyz:NVDA', label: 'NVDA', px: 240, from: 230, now: T0 + 90_000 })
  return s
}

console.log('setting one')
{
  const s = base()
  const by = (id: string) => s.alerts.find(a => a.id === id)!
  ok(by('up').dir === 'above' && by('down').dir === 'below', 'a level over the price fires on the way up; under it, on the way down')
  ok(s.alerts[0].id === 'nvda' && activeAlerts(s).length === 3, 'newest first, all waiting')
  ok(refused(() => addAlert(s, { id: 'x', coin: 'BTC', label: 'BTC', px: 85_000, from: 85_000, now: T0 }), /price now/), 'a level at the price now is refused')
  ok(refused(() => addAlert(s, { id: 'x', coin: 'BTC', label: 'BTC', px: 0, from: 85_000, now: T0 }), /Enter a price/), 'no level: refused')
  ok(refused(() => addAlert(s, { id: 'x', coin: 'BTC', label: 'BTC', px: 1, from: 0, now: T0 }), /no price/), 'no price for the market: refused')
  let many = freshAlerts(T0)
  for (let i = 0; i < ALERTS.maxActive; i++) many = addAlert(many, { id: `a${i}`, coin: 'ETH', label: 'ETH', px: 3000 + i, from: 2000, now: T0 })
  ok(refused(() => addAlert(many, { id: 'over', coin: 'ETH', label: 'ETH', px: 4000, from: 2000, now: T0 }), /50 alerts/), `a ${ALERTS.maxActive + 1}st waiting alert is refused`)
}

console.log('live')
{
  const s = base()
  ok(checkAlerts(s, { BTC: 89_999 }, T0 + 1).fired.length === 0, 'BTC at 89,999: nothing yet')
  const r = checkAlerts(s, { BTC: 90_010, 'xyz:NVDA': 231 }, T0 + 2)
  ok(r.fired.length === 1 && r.fired[0].id === 'up' && r.fired[0].firedPx === 90_010 && r.fired[0].firedAt === T0 + 2 && !r.fired[0].away, 'at 90,010 the 90,000 alert fires, with the price and time')
  ok(r.state.alerts.find(a => a.id === 'up')!.status === 'fired' && activeAlerts(r.state).length === 2, 'and stops waiting; the others still wait')
  ok(checkAlerts(r.state, { BTC: 91_000 }, T0 + 3).fired.length === 0, 'it fires once')
  ok(checkAlerts(s, { BTC: 80_000 }, T0 + 4).fired.map(a => a.id).join() === 'down', 'the one below fires at its level exactly')
  ok(checkAlerts(s, {}, T0 + 5).state === s, 'no prices: nothing changes')
}

console.log('after a gap (candles)')
{
  const s = base()
  const bars = [
    bar('BTC', T0 + 60_000, 85_000, 86_000, 84_500, 85_500),
    bar('BTC', T0 + 120_000, 85_500, 90_500, 85_400, 89_000),
    bar('BTC', T0 + 180_000, 89_000, 89_100, 79_900, 80_100),
    bar('BTC', T0 + 240_000, 80_100, 91_000, 79_000, 90_800),
    bar('xyz:NVDA', T0 + 60_000, 230, 245, 229, 231),
  ]
  const r = replayAlerts(s, bars, T0 + 300_000)
  const by = (id: string) => r.state.alerts.find(a => a.id === id)!
  ok(by('up').status === 'fired' && by('up').firedAt === T0 + 120_000 && by('up').firedPx === 90_000 && by('up').away, 'the candle that reached 90,000 fires it, with that candle’s time and the level, marked as while away')
  ok(by('down').firedAt === T0 + 180_000, 'the one below fires at the later candle that fell through 80,000')
  ok(by('up').firedAt === T0 + 120_000 && by('down').firedAt === T0 + 180_000, 'each at the first candle that reached it, not a later one that did too')
  ok(by('nvda').status === 'active', 'a candle that opened before an alert was set doesn’t fire it')
  ok(r.state.checked === T0 + 300_000 && r.fired.length === 2, 'two fired, and the alerts are checked to the end of the gap')
  ok(replayAlerts(s, [bar('BTC', T0 + 60_000, 85_000, 89_999, 80_001, 85_000)], T0 + 120_000).fired.length === 0, 'a candle short of both levels fires neither')
}

console.log('keeping them')
{
  let s = checkAlerts(base(), { BTC: 95_000 }, T0 + 1).state
  ok(removeAlert(s, 'down').alerts.length === 2, 'delete one')
  ok(clearFired(s).alerts.every(a => a.status === 'active'), 'clear the reached ones')
  for (let i = 0; i < 120; i++) s = checkAlerts(addAlert(s, { id: `f${i}`, coin: 'SOL', label: 'SOL', px: 200 + i, from: 100, now: T0 }), { SOL: 1_000 }, T0 + 2).state
  ok(s.alerts.filter(a => a.status === 'fired').length <= ALERTS.keep + 1 && activeAlerts(s).length === 2, `reached ones are kept to the newest ${ALERTS.keep}; waiting ones always stay`)
  // Stored alerts last checked long ago, none waiting: a new one mustn't replay that old gap.
  saveAlerts({ ...freshAlerts(T0), alerts: [] })
  const next = updateAlerts(st => addAlert(st, { id: 'n', coin: 'BTC', label: 'BTC', px: 1, from: 2, now: Date.now() }))
  ok(Date.now() - next.checked < 1_000, 'the first waiting alert starts the watch from now (no old gap to replay)')
  saveAlerts({ ...next, checked: T0 })
  ok(updateAlerts(st => addAlert(st, { id: 'n2', coin: 'BTC', label: 'BTC', px: 3, from: 2, now: Date.now() })).checked === T0, 'with alerts already waiting, the watch keeps its own time')
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall price-alert checks passed')
