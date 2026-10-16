// The coin pages' trade forms (the build pack's Phase 3: "single-field Buy/Sell, collapsed Details drawer"): one amount
// field and what it gets, with the route, fees, slippage and notes in a Details drawer (components/TradeDetails.tsx)
// collapsed until opened. What needs the trader's attention is never in the drawer: a high price impact or cost, a
// snipe tax, the ticks that confirm them, the safety rating and errors.
//   bun scripts/test-trade-details.tsx
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
const D = await import('../src/arcdex/components/TradeDetails')

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

console.log('the drawer')
{
  const closed = renderToStaticMarkup(<D.default hint="0.5% fee · 3% slippage"><div>Platform fee</div></D.default>)
  check(closed.includes('aria-expanded="false"') && closed.includes('0.5% fee · 3% slippage') && !closed.includes('Platform fee'), 'collapsed by default: the hint shows, what’s inside doesn’t')
  D.setDetailsOpen(true)
  const open = renderToStaticMarkup(<D.default hint="0.5% fee · 3% slippage"><div>Platform fee</div></D.default>)
  check(open.includes('aria-expanded="true"') && open.includes('Platform fee') && !open.includes('trade-details-hint'), 'opened: what’s inside shows, the hint goes')
  check(store.get('arcdex:trade-details') === 'open', 'remembered in this browser')
  D.setDetailsOpen(false)
  check(store.get('arcdex:trade-details') === 'closed', '…and closed again')
  check(D.HOT.impactPct === 5 && D.HOT.costPct === 6, 'price impact from 5% and total cost from 6% stay outside (the forms’ amber levels)')
}

const FORMS: Record<string, { warn: RegExp[]; inside: RegExp[] }> = {
  'src/arcdex/components/ArgusSwapWidget.tsx': { warn: [/impact >= WARN_IMPACT/, /needsSnipeTick && <Row label=\{T\("Snipe tax"\)\}/], inside: [/T\("Route"\)/, /T\("Platform fee"\)/, /T\("Max slippage"\)/, /T\("Creator tax"\)/, /impact < WARN_IMPACT/] },
  'src/arcdex/components/CurveSwapWidget.tsx': { warn: [], inside: [/T\("Max slippage"\)/, /T\("Fee \(1% \+"\)/] },
  'src/arcdex/components/SolanaTrade.tsx': { warn: [/value && impactHot/, /costHot && <Row/], inside: [/T\('Minimum received'\)/, /T\('Platform fee'\)/, /T\('Arrives'\)/, /value && !impactHot/, /!costHot && <Row/] },
  'src/arcdex/components/BscTrade.tsx': { warn: [/value && impactHot/, /costHot && <Row/], inside: [/T\('Minimum received'\)/, /T\('Platform fee'\)/, /T\('Arrives'\)/, /value && !impactHot/, /!costHot && <Row/] },
  'src/arcdex/components/RobinhoodTrade.tsx': { warn: [/value && impactHot/, /costHot && <Row/], inside: [/T\('Minimum received'\)/, /T\('Platform fee'\)/, /T\('Arrives'\)/, /value && !impactHot/, /!costHot && <Row/] },
  'src/arcdex/components/SolanaCross.tsx': { warn: [/value && impactHot/], inside: [/T\('Minimum received'\)/, /T\('Platform fee'\)/, /T\('Arrives'\)/, /value && !impactHot/] },
}

console.log('every coin-page trade form')
for (const [file, want] of Object.entries(FORMS)) {
  const s = readFileSync(file, 'utf8')
  const name = file.split('/').pop()
  const box = s.indexOf('<div className="swap-info">')
  const open = s.indexOf('<TradeDetails', box), close = s.indexOf('</TradeDetails>', open)
  check(box > 0 && open > box && close > open && (s.match(/<TradeDetails/g) ?? []).length === 1, `${name}: one Details drawer, in the info box`)
  const before = s.slice(box, open), inside = s.slice(open, close), after = s.slice(close)
  check(/You receive/.test(before), `${name}: what the trade gets is outside it`)
  check(!/T\(["'](Route|Platform fee|Minimum received|Max slippage)["']\)/.test(before), `${name}: no route, fee, minimum or slippage row outside it`)
  for (const r of want.inside) check(r.test(inside), `${name}: ${r.source.replace(/\\/g, '')} is inside it`)
  for (const r of want.warn) check(r.test(before), `${name}: ${r.source.replace(/\\/g, '')} stays outside it`)
  check(!/buyRisk\.node|rh-tick|role="alert"|needsRiskTick|needsCostTick|needsSnipeTick && \(/.test(inside), `${name}: no rating, tick or error inside it`)
  check(/buyRisk\.node/.test(after), `${name}: the safety rating is after it, above the button`)
  check((s.match(/className="swap-input"/g) ?? []).length === 1, `${name}: one amount field`)
}

if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
