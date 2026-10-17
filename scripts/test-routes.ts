// The supported-route registry (src/arcdex/lib/routes.ts, shown on /routes): every route complete, every provider one
// the page checks, every page one the router knows, and Hyperliquid's routes switched off while trading is.
//   bun scripts/test-routes.ts

import { readFileSync } from 'fs'
import { NOT_SUPPORTED, ROUTES, GROUP_LABEL } from '../src/arcdex/lib/routes'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }

const page = readFileSync('src/arcdex/pages/RoutesPage.tsx', 'utf8')
const checked = new Set([...page.matchAll(/\{ id: '([a-z]+)', name:/g)].map(m => m[1]))
// The app's pages: the Page type in App.tsx.
const app = readFileSync('src/arcdex/App.tsx', 'utf8')
const start = app.indexOf('export type Page =')
const pageType = app.slice(start, app.indexOf('\n\n', start))
const knownPages = new Set([...pageType.matchAll(/\{ name: '([a-z-]+)'/g)].map(m => m[1]))

console.log('the registry')
ok(ROUTES.length >= 10, `${ROUTES.length} routes`)
ok(new Set(ROUTES.map(r => r.id)).size === ROUTES.length, 'every id once')
for (const r of ROUTES) {
  const blank = (['from', 'to', 'provider', 'fee', 'time', 'notes'] as const).filter(k => !String(r[k] ?? '').trim())
  ok(!blank.length, `${r.id}: nothing blank${blank.length ? ` (${blank.join(', ')})` : ''}`)
  ok(r.providers.length > 0 && r.providers.every(p => checked.has(p)), `${r.id}: its providers are checked on the page (${r.providers.join(', ')})`)
  ok(!r.page || knownPages.has(r.page.name), `${r.id}: opens a page the router knows (${r.page?.name ?? 'none'})`)
  ok(GROUP_LABEL[r.group] !== undefined, `${r.id}: a known group`)
}
console.log('what is live')
const hl = ROUTES.filter(r => r.providers.includes('hyperliquid'))
ok(hl.length === 3 && hl.every(r => r.status === 'off'), 'Hyperliquid funding, futures and predictions: switched off (no VITE_HL_TRADING)')
ok(ROUTES.find(r => r.id === 'testnet')?.status === 'testnet', 'the Arc futures are marked testnet')
ok(NOT_SUPPORTED.length > 0, 'what is not supported is said')

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall route checks passed')
