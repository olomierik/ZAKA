// The safety rating on every buy path (src/arcdex/lib/buyRisk.tsx, the build pack's Phase 5: "risk label shown on every
// buy path"). What the label shows and holds up, rendered; then the source: every trade form shows the label above Buy
// and waits on it, every page with a trade form gives it the coin's rating, and Portfolio's Sell sheets have no Buy.
//   bun scripts/test-buy-risk.tsx
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { BuyRiskProvider, BuyRiskLabel, buyGate, useBuyRisk, type BuyRisk, type ProvidedRisk } from '../src/arcdex/lib/buyRisk'
import { arcSafety, rhSafety, type SafetyView } from '../src/arcdex/lib/safety'
import { riskOf } from '../src/arcdex/lib/risk'
import type { CoinSafety } from '../api/_marketProtocol'
import { flag } from '../src/arcdex/lib/flags'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

console.log('the gate')
check(buyGate('danger') === 'confirm', 'Danger: a buy waits for a tick')
for (const l of ['safe', 'risky', 'checking'] as const) check(buyGate(l) === 'go', `${l}: a buy goes ahead`)

check(flag('buyRisk', {}) === true && flag('buyRisk', { VITE_FLAG_BUY_RISK: 'off' }) === false, 'the flag: on by default; only VITE_FLAG_BUY_RISK=off turns it off')
check(flag('buyRisk', {}, { buyRisk: false }) === true, 'a protective flag: never turned off from /admin')

console.log('the label, rendered')
function render(view: ProvidedRisk | undefined, buying: boolean): { html: string; risk: BuyRisk } {
  let got: BuyRisk | null = null
  function Form() { const r = useBuyRisk(buying); got = r; return <div>{r.node}</div> }
  const html = renderToStaticMarkup(view === undefined ? <Form /> : <BuyRiskProvider view={view}><Form /></BuyRiskProvider>)
  return { html, risk: got! }
}
const view = (level: SafetyView['level'], reasons: string[] = []): SafetyView => ({ level, reasons, source: 'chain' })
const danger = render(view('danger', ['Can’t be sold back, or a heavy sell tax', 'Bundled launch']), true)
check(danger.risk.blocks, 'Danger: the buy is held until the tick')
check(danger.html.includes('data-buy-risk="danger"') && danger.html.includes('type="checkbox"') && danger.html.includes('role="alert"'), 'Danger: the label, a tick box and an alert')
check(danger.html.includes('Can’t be sold back') && danger.html.includes('Bundled launch'), 'Danger: its reasons')
const risky = render(view('risky', ['Thin liquidity']), true)
check(!risky.risk.blocks && risky.html.includes('data-buy-risk="risky"') && !risky.html.includes('checkbox') && risky.html.includes('Thin liquidity'), 'Risky: the label and why, no tick needed')
const safe = render(view('safe', ['Sold back fine in a test trade']), true)
check(!safe.risk.blocks && safe.html.includes('data-buy-risk="safe"'), 'Safe: the label')
const checking = render(view('checking'), true)
check(!checking.risk.blocks && checking.html.includes('data-buy-risk="checking"'), 'Checking: the label, the buy goes ahead')
const none = render(undefined, true)
check(!none.risk.blocks && !none.risk.rated && none.html.includes('data-buy-risk="unrated"') && none.html.includes('Open the coin’s page'), 'no page rated it: says so, never nothing')
const failed = render(null, true)
check(failed.html.includes('data-buy-risk="unrated"'), 'a page that couldn’t rate it: says so')
const official = render('official', true)
check(official.risk.official && !official.risk.blocks && official.html.includes('data-buy-risk="official"') && !official.html.includes('Danger'), '$ARCDEX: Official, no rating (the owner’s rule)')
const selling = render(view('danger'), false)
check(selling.html === '<div></div>' && !selling.risk.blocks, 'selling a Danger coin: nothing shown, never held up')
check(renderToStaticMarkup(<BuyRiskLabel view={view('safe', ['On AVNU’s list'])} />).includes('data-buy-risk="safe"'), 'the label alone (Starknet)')

console.log('ratings')
const t = { symbol: 'PEPE', address: '0x1111111111111111111111111111111111111111' }
const low = riskOf({ liquidityUsd: 50_000, marketCapUsd: 200_000, launchedAt: Date.now() - 3 * 86_400_000, holders: 400, txns24h: 300, buys24h: 150, sells24h: 150, change24h: 5 })
const honeypot = riskOf({ honeypot: true })
const scan = (o: Partial<CoinSafety>): CoinSafety => ({ at: Date.now(), sellable: true, fails: [], risks: [], score: 90, launcher: null, creator: null, ...o } as CoinSafety)
check(arcSafety(t, honeypot, null, false).level === 'danger', 'GeckoTerminal’s honeypot flag, no scan: Danger (it was Risky)')
check(arcSafety(t, honeypot, scan({}), false).level === 'danger', 'GeckoTerminal’s honeypot flag over a clean scan: Danger')
check(arcSafety(t, low, scan({}), false).level === 'safe', 'a clean scan and a low market risk: still Safe')
check(arcSafety(t, low, scan({ fails: [{ id: 'honeypot', detail: '' }], sellable: false }), false).level === 'danger', 'the engine’s sell test failing: Danger')
const rh = { address: t.address, symbol: 'X', name: 'X', image: null, pool: '', dex: '', quote: '', quoteSymbol: '', priceUsd: 1, change5m: 0, change1h: 0, change24h: 0, volume24h: 0, liquidity: 0, marketCap: 0, fdv: 0, buys24h: 0, sells24h: 0, buyers24h: 0, sellers24h: 0, createdAt: '', stock: false, launchpad: null } as unknown as Parameters<typeof rhSafety>[0]
check(rhSafety({ ...rh, stock: true }).level === 'safe', 'a Robinhood stock token Robinhood issued: Safe')
check(rhSafety({ ...rh, liquidity: 50 }).level !== 'safe', 'a thin Robinhood Chain coin: not Safe')

console.log('every trade form shows the label above Buy and waits on it')
const src = (p: string) => readFileSync(new URL(`../src/arcdex/${p}`, import.meta.url), 'utf8')
const FORMS = ['components/ArgusSwapWidget.tsx', 'components/CurveSwapWidget.tsx', 'components/SolanaTrade.tsx', 'components/BscTrade.tsx', 'components/RobinhoodTrade.tsx', 'components/SolanaCross.tsx']
for (const f of FORMS) {
  const s = src(f)
  const submit = s.slice(s.indexOf('async function submit()'), s.indexOf('async function submit()') + 400)
  const button = /disabled=\{[^}]*buyRisk\.blocks[^}]*\}|const blocked = [^\n]*buyRisk\.blocks/.test(s)
  check(/useBuyRisk\(mode === 'buy'\)/.test(s) && s.includes('{buyRisk.node}') && /buyRisk\.blocks\) return/.test(submit) && button,
    `${f}: label rendered, button disabled and submit refused while it holds`)
}

console.log('every page with a trade form rates its coin')
const TAGS = /<(ArgusSwapWidget|CurveSwapWidget|TokenSwap|SolanaTrade|BscTrade|RobinhoodTrade|SolanaPayCard)\b/
const PAGES: Record<string, string> = {
  'pages/ArgusTokenPage.tsx': 'arcSafety', 'pages/CurveTokenPage.tsx': 'arcSafety', 'pages/TokenPage.tsx': 'arcSafety', 'pages/Swap.tsx': 'arcSafety',
  'pages/SolanaTokenPage.tsx': 'solSafety', 'pages/BscTokenPage.tsx': 'bscSafety', 'pages/RobinhoodTokenPage.tsx': 'rhSafety',
}
for (const [p, fn] of Object.entries(PAGES)) {
  const s = src(p)
  const opens = s.split('<BuyRiskProvider').length - 1, closes = s.split('</BuyRiskProvider>').length - 1
  // Each layout a page returns (phones and desktop) with a trade form in it sits inside a provider.
  const bare = (s.match(/\n  (if \(mobile\) )?return \(\n    <(?!BuyRiskProvider)[A-Za-z]/g) ?? []).length
  check(TAGS.test(s) && s.includes(`${fn}(`) && opens >= 1 && opens === closes && bare <= (p === 'pages/Swap.tsx' ? 1 : 0), `${p}: rated with ${fn}, every layout wrapped (${opens})`)
}
check(src('pages/StarknetPage.tsx').includes('<BuyRiskLabel'), 'pages/StarknetPage.tsx: the token bought is labelled')

console.log('Portfolio’s Sell sheets have no Buy (no buy path without the coin’s rating)')
for (const f of ['pages/Portfolio.tsx', 'components/SolanaHoldings.tsx', 'components/BscHoldings.tsx', 'components/RobinhoodHoldings.tsx']) {
  const s = src(f)
  const sheet = s.slice(s.indexOf('<Sheet open={!!sell}'))
  check(/side="sell"/.test(sheet) && !/initialMode="sell"/.test(sheet), `${f}: sell only`)
}
check(/side=\{side\}/.test(src('components/TokenSwap.tsx')) && /\{!side && <div/.test(src('components/CurveSwapWidget.tsx')), 'TokenSwap passes the side through; the curve widget hides its switch')

console.log('nothing else on the site buys a coin without a form')
// Every place a trade is signed calls assertTradingOn (lib/tradeSwitch.ts). The forms above are covered; the rest:
//   hl/exec.ts         Hyperliquid futures and predictions: no coin to rate
//   lib/across, relay, fourMeme, jupiter   the forms' own senders (gas top-ups included)
//   starknet/avnu.ts   the Starknet form, labelled above
//   lib/quickTrade.ts, pages/Launchpad.tsx  the old launchpad page's quick buy: not routed (App.tsx has no Launchpad page)
check(!/import\('\.\/pages\/Launchpad'\)|from '\.\/pages\/Launchpad'/.test(src('App.tsx')), 'the old launchpad page (and its one-tap Buy $5) isn’t routed')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
