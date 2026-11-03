// Live BTC Up/Down autotrade's rules for small accounts (src/arcdex/lib/updownLive.ts): sizes, every guard, the day's
// loss stop, the losing-streak pause and the drawdown stop. Run: bun scripts/test-updown-live.ts
import { LIVE_RULES, type UpdownSignal } from '../api/_updownProtocol'

const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
;(globalThis as Record<string, unknown>).window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} }
const { liveBuy, liveCheck, liveStats, lossStreak, todayRisk } = await import('../src/arcdex/lib/updownLive')
type Book = Parameters<typeof liveBuy>[1]
type Settings = Parameters<typeof liveBuy>[0]

let fails = 0
const ok = (c: boolean, msg: string) => { if (!c) { fails++; console.log('✕', msg) } else console.log('✓', msg) }

const now = Date.UTC(2026, 10, 3, 12)
const S = (p: Partial<Settings> = {}): Settings => ({ on: true, capital: 50, accepted: true, startedAt: now - 3_600_000, startEquity: 50, halted: null, pauseUntil: 0, ...p })
const sig = (p: Partial<UpdownSignal> = {}): UpdownSignal => ({ id: 'w:up:1', kind: 'buy', slug: 'btc-updown-5m-1', dur: '5m', conditionId: '0xc', side: 'up', asset: 'A', at: now - 500, end: now / 1000 + 120, price: 0.52, tick: 0.01, minSize: 5, p: 0.75, ask: 0.5, edge: 0.2, lane: 'A', ...p })
const empty: Book = { positions: [], events: [] }
const pos = (p: Partial<Book['positions'][number]> = {}): Book['positions'][number] => ({ id: Math.random().toString(), slug: 'other', side: 'up', asset: 'B', conditionId: '0xd', end: now / 1000 - 600, at: now - 60_000, shares: 10, cost: 3, sold: 0, proceeds: 0, status: 'closed', pnl: -3, ...p })

// Sizes
let d = liveBuy(S(), empty, sig(), 50, 50, now)
ok('usd' in d && d.usd === 3, `$50 account, a strong edge: $3 (6%) — got ${JSON.stringify(d)}`)
d = liveBuy(S({ capital: 100, startEquity: 100 }), empty, sig(), 100, 100, now)
ok('usd' in d && d.usd === 6, `$100 account: $6 — got ${JSON.stringify(d)}`)
d = liveBuy(S(), empty, sig({ p: 0.55 }), 50, 50, now)
ok('why' in d, `a thin edge on $50 is under $1 and skipped — got ${JSON.stringify(d)}`)
d = liveBuy(S(), empty, sig(), 1.02, 1.02, now)
ok('why' in d && d.why === 'not enough pUSD', `no money, no order — got ${JSON.stringify(d)}`)
d = liveBuy(S(), empty, sig(), 2.5, 2.5, now)
ok('why' in d, `under Polymarket's 5-share minimum (5 × 52¢ = $2.60) it doesn't trade — got ${JSON.stringify(d)}`)
d = liveBuy(S(), empty, sig({ price: 0.3, ask: 0.28, p: 0.6 }), 2.5, 2.5, now)
ok('usd' in d && d.usd <= 2.45, `never more than the cash on hand — got ${JSON.stringify(d)}`)

// Guards
ok('why' in liveBuy(S({ on: false }), empty, sig(), 50, 50, now), 'off: nothing')
ok('why' in liveBuy(S({ halted: 'down 30%' }), empty, sig(), 50, 50, now), 'halted: nothing')
ok('why' in liveBuy(S({ pauseUntil: now + 1 }), empty, sig(), 50, 50, now), 'paused: nothing')
ok('why' in liveBuy(S(), empty, sig({ at: now - LIVE_RULES.maxSignalAgeMs - 1 }), 50, 50, now), 'a signal over 2 s old: nothing')
ok('why' in liveBuy(S(), empty, sig({ end: now / 1000 + 3 }), 50, 50, now), 'a closing window: nothing')
ok('why' in liveBuy(S(), empty, sig({ kind: 'sell' }), 50, 50, now), 'a sale signal is not a buy')
const twoOpen: Book = { positions: [pos({ status: 'open', pnl: null }), pos({ status: 'open', pnl: null })], events: [] }
ok('why' in liveBuy(S(), twoOpen, sig(), 50, 50, now), 'two positions open: nothing')
const winFull: Book = { positions: [pos({ slug: 'btc-updown-5m-1', cost: 5.6, status: 'open', pnl: null })], events: [] }
ok('why' in liveBuy(S(), winFull, sig(), 50, 50, now), 'this window already holds 12% of $50: nothing')
const winPart: Book = { positions: [pos({ slug: 'btc-updown-5m-1', cost: 4, status: 'open', pnl: null })], events: [] }
d = liveBuy(S(), winPart, sig({ price: 0.3, ask: 0.28, p: 0.6 }), 50, 50, now)
ok('usd' in d && Math.abs(d.usd - 2) < 0.01, `the window's room caps the order ($6 − $4 = $2) — got ${JSON.stringify(d)}`)

// The day's loss stop: 15% of $50 = $7.50, open positions counted as lost
const badDay: Book = { positions: [pos({ at: now - 1000, pnl: -5 }), pos({ at: now - 2000, status: 'open', cost: 2.6, pnl: null })], events: [] }
const r = todayRisk(badDay, now)
ok(r.realized === -5 && r.atRisk === 2.6, `today: −$5 realized, $2.60 at risk — got ${JSON.stringify(r)}`)
ok('why' in liveBuy(S(), badDay, sig(), 50, 50, now), 'the day lost 15%: nothing more today')
const yesterday: Book = { positions: [pos({ at: now - 86_400_000, pnl: -20 })], events: [] }
ok('usd' in liveBuy(S(), yesterday, sig(), 50, 50, now), 'yesterday’s loss doesn’t stop today')

// Streak and drawdown
const four: Book = { positions: [0, 1, 2, 3].map(i => pos({ at: now - 10_000 + i, pnl: -1 })), events: [] }
ok(lossStreak(four) === 4, 'four losses in a row')
const p1 = liveCheck(S(), four, 46, now)
ok(!!p1 && p1.pauseUntil === now + LIVE_RULES.pauseMs, `four losses pause it an hour — got ${JSON.stringify(p1)}`)
ok(liveCheck(S({ pauseUntil: now + LIVE_RULES.pauseMs }), four, 46, now + 1) === null, 'not paused twice for the same streak')
const winBetween: Book = { positions: [...four.positions, pos({ at: now, pnl: 2 })], events: [] }
ok(lossStreak(winBetween) === 0, 'a win ends the streak')
const p2 = liveCheck(S(), empty, 34.9, now)
ok(!!p2 && p2.on === false && !!p2.halted, `30% under the start ($50 → $34.90): stopped — got ${JSON.stringify(p2)}`)
ok(liveCheck(S(), empty, 35.5, now) === null, '29% under: still on')
ok(liveCheck(S({ on: false }), empty, 10, now) === null, 'off: nothing to stop')

// Stats
const st = liveStats({ positions: [pos({ pnl: 2 }), pos({ pnl: -1 }), pos({ status: 'open', pnl: null })], events: [] })
ok(st.trades === 3 && st.closed === 2 && st.won === 1 && Math.abs(st.pnl - 1) < 1e-9, `record — got ${JSON.stringify(st)}`)

console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
