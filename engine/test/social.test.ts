// The social layer (engine/src/social): verified PnL from the routers' own trades (exact, average cost, chain order),
// checked against an independent recomputation; the wash-trade filter on test wallets; the trade book's reading and
// nightly check against the chain; comments, reports, mutes and moderation; the routes.
import { describe, expect, test } from 'bun:test'
import { verifyMessage, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_USDC, T_SWAPPED, decodeTrades, statsOf, usd6, walk, type BookTrade, type RouterLog } from '../src/social/pnl'
import { mirrors, roundTrips, washFlags } from '../src/social/wash'
import { SocialBoards } from '../src/social/boards'
import { MemorySocialTradeStore, TradeBook, type IndexRow } from '../src/social/book'
import { Moderation, MemoryModerationStore } from '../src/social/moderation'
import { SocialApi } from '../src/social/api'
import { ControlVerifier } from '../src/bot/control'
import { MemoryBotStore, PostgresBotStore } from '../src/bot/store'
import { BOARD_MIN, SOCIAL_LIMITS, cleanText, moderationMessage, parseCommentTarget, parseReportTarget, type SocialBoard, type SocialTrader } from '../../api/_socialProtocol'
import { setLogLevel } from '../src/log'

setLogLevel('error')

const V1 = '0xc519b929981f5375d67ab3930ffb100f0a606088'
const V2 = '0xd07583f7db671521aacfda2b4612ad187aa2924e'
const CURVE = '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441'
const COIN = '0x00000000000000000000000000000000000c0101'
const COIN2 = '0x00000000000000000000000000000000000c0102'
const COIN3 = '0x00000000000000000000000000000000000c0103'
const A = '0x000000000000000000000000000000000000aaaa'
const B = '0x000000000000000000000000000000000000bbbb'
const T0 = Date.parse('2026-10-10T12:00:00Z')
const usd = (n: number) => BigInt(Math.round(n * 1e6))

let seq = 0
function trade(o: Partial<BookTrade> & { trader: string; side: 'buy' | 'sell'; usdc: bigint; tokens: bigint }): BookTrade {
  const n = ++seq
  const block = o.block ?? 1_000 + n
  const tx = o.tx ?? `0x${n.toString(16).padStart(64, '0')}`
  return { id: `${tx}:${o.logIndex ?? 0}`, router: V2, tx, block, logIndex: o.logIndex ?? 0, at: o.at ?? T0 + n * 1_000, token: COIN, fee: 0n, ...o }
}

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
const w = (n: bigint) => n.toString(16).padStart(64, '0')
function swapLog(o: { router?: string; tx: string; li?: number; block: number; at?: number | null; trader: string; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; feeToken?: string; fee?: bigint }): RouterLog {
  return {
    address: o.router ?? V2,
    topics: [T_SWAPPED, pad(o.trader), pad(o.tokenIn), pad(o.tokenOut)],
    data: `0x${w(o.amountIn)}${w(o.amountOut)}${w(BigInt(o.feeToken ?? ARC_USDC))}${w(o.fee ?? 0n)}`,
    transactionHash: o.tx, blockNumber: `0x${o.block.toString(16)}`, logIndex: `0x${(o.li ?? 0).toString(16)}`,
    ...(o.at === null ? {} : { blockTimestamp: `0x${Math.floor((o.at ?? T0) / 1000).toString(16)}` }),
  }
}

/** The independent recomputation: exact fractions, no rounding until the end. */
function independentPnl(trades: BookTrade[]): number {
  type Frac = { n: bigint; d: bigint }
  const add = (a: Frac, b: Frac): Frac => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })
  const pos = new Map<string, { tokens: bigint; cost: Frac }>()
  let total: Frac = { n: 0n, d: 1n }
  for (const t of [...trades].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    const p = pos.get(t.token) ?? { tokens: 0n, cost: { n: 0n, d: 1n } }
    pos.set(t.token, p)
    if (t.side === 'buy') { p.tokens += t.tokens; p.cost = add(p.cost, { n: t.usdc, d: 1n }); continue }
    if (t.tokens === 0n || p.tokens === 0n) continue
    const m = t.tokens < p.tokens ? t.tokens : p.tokens
    const proceeds: Frac = { n: t.usdc * m, d: t.tokens }
    const cost: Frac = { n: p.cost.n * m, d: p.cost.d * p.tokens }
    p.cost = { n: p.cost.n * (p.tokens - m), d: p.cost.d * p.tokens }
    p.tokens -= m
    total = add(total, add(proceeds, { n: -cost.n, d: cost.d }))
  }
  return Number(total.n) / Number(total.d) / 1e6
}

describe('decoding the routers’ Swapped events', () => {
  test('buys and sales with a USDC leg, on every router; anything else left out', () => {
    const logs = [
      swapLog({ tx: '0xaa', block: 10, trader: A, tokenIn: ARC_USDC, tokenOut: COIN, amountIn: usd(10), amountOut: 1000n, fee: usd(0.2) }),
      swapLog({ router: CURVE, tx: '0xab', block: 11, trader: A, tokenIn: COIN, tokenOut: ARC_USDC, amountIn: 400n, amountOut: usd(6) }),
      swapLog({ router: V1, tx: '0xac', block: 12, trader: B, tokenIn: ARC_USDC, tokenOut: COIN2, amountIn: usd(5), amountOut: 50n }),
      swapLog({ tx: '0xad', block: 13, trader: B, tokenIn: COIN, tokenOut: COIN2, amountIn: 1n, amountOut: 1n }), // no USDC leg
      swapLog({ router: '0x0000000000000000000000000000000000000bad', tx: '0xae', block: 14, trader: B, tokenIn: ARC_USDC, tokenOut: COIN, amountIn: 1n, amountOut: 1n }), // not ours
      swapLog({ tx: '0xaa', block: 10, trader: A, tokenIn: ARC_USDC, tokenOut: COIN, amountIn: usd(10), amountOut: 1000n }), // seen twice
    ]
    const t = decodeTrades(logs)
    expect(t.map(x => [x.side, x.router, x.token, x.usdc, x.tokens])).toEqual([
      ['buy', V2, COIN, usd(10), 1000n], ['sell', CURVE, COIN, usd(6), 400n], ['buy', V1, COIN2, usd(5), 50n],
    ])
    expect(t[0].fee).toBe(usd(0.2))
    expect(t[0].id).toBe('0xaa:0')
  })
  test('a log without its block time uses the block’s, and one with none is left out', () => {
    const logs = [swapLog({ tx: '0xba', block: 20, at: null, trader: A, tokenIn: ARC_USDC, tokenOut: COIN, amountIn: 1n, amountOut: 1n })]
    expect(decodeTrades(logs, b => (b === 20 ? T0 + 5 : null))[0].at).toBe(T0 + 5)
    expect(decodeTrades(logs)).toEqual([])
  })
})

describe('verified PnL', () => {
  test('average cost per coin, in chain order', () => {
    const t = [
      trade({ trader: A, side: 'buy', usdc: usd(100), tokens: 1000n }),
      trade({ trader: A, side: 'buy', usdc: usd(300), tokens: 1000n }), // avg cost 0.2 a token
      trade({ trader: A, side: 'sell', usdc: usd(150), tokens: 500n }), // cost 100 → +50
      trade({ trader: A, side: 'sell', usdc: usd(200), tokens: 1500n }), // cost 300 → -100
    ]
    const s = statsOf(t, 0)
    expect(s.realized).toBe('-50.000000')
    expect(s).toMatchObject({ volume: '750.000000', trades: 4, buys: 2, sells: 2, wins: 1, counted: 2, coins: 1, unmatched: '0.000000' })
    expect(walk(t).holds.get(COIN)!).toMatchObject({ tokens: 0n, cost: 0n })
  })
  test('a sale before a later buy keeps the profit it made (order matters, unlike summing a window)', () => {
    const t = [
      trade({ trader: A, side: 'buy', usdc: usd(100), tokens: 100n }),
      trade({ trader: A, side: 'sell', usdc: usd(150), tokens: 100n }),
      trade({ trader: A, side: 'buy', usdc: usd(300), tokens: 100n }),
    ]
    expect(statsOf(t, 0).realized).toBe('50.000000')
  })
  test('tokens sold beyond what was bought here have no cost: their proceeds aren’t PnL', () => {
    const t = [
      trade({ trader: A, side: 'buy', usdc: usd(10), tokens: 100n }),
      trade({ trader: A, side: 'sell', usdc: usd(1010), tokens: 10_100n }), // 10,000 tokens came from elsewhere
    ]
    const s = statsOf(t, 0)
    expect(s.realized).toBe('0.000000') // 100 tokens sold for $10.00, bought for $10
    expect(s.unmatched).toBe('1000.000000')
    const none = statsOf([trade({ trader: A, side: 'sell', usdc: usd(500), tokens: 5n })], 0)
    expect(none).toMatchObject({ realized: '0.000000', unmatched: '500.000000', counted: 0 })
  })
  test('a window realizes its sales against costs from before it', () => {
    const t = [
      trade({ trader: A, side: 'buy', usdc: usd(100), tokens: 100n, at: T0 - 10 * 86_400_000 }),
      trade({ trader: A, side: 'sell', usdc: usd(160), tokens: 100n, at: T0 }),
    ]
    const day = statsOf(t, T0 - 86_400_000)
    expect(day).toMatchObject({ realized: '60.000000', trades: 1, volume: '160.000000' })
  })
  test('micro-USDC to the unit: thirds add back up, nothing lost when a position closes', () => {
    const t = [
      trade({ trader: A, side: 'buy', usdc: 1_000_000n, tokens: 3n }),
      trade({ trader: A, side: 'sell', usdc: 400_000n, tokens: 1n }),
      trade({ trader: A, side: 'sell', usdc: 400_000n, tokens: 1n }),
      trade({ trader: A, side: 'sell', usdc: 400_000n, tokens: 1n }),
    ]
    const sales = walk(t).sales
    expect(sales.reduce((s, x) => s + x.cost, 0n)).toBe(1_000_000n)
    expect(statsOf(t, 0).realized).toBe('0.200000')
  })
  test('matches an independent recomputation (exact fractions) on 300 random histories', () => {
    let rng = 7
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % n }
    for (let k = 0; k < 300; k++) {
      const trades: BookTrade[] = []
      const tokens = [COIN, COIN2, COIN3]
      for (let i = 0; i < 2 + rand(40); i++) {
        const side = rand(3) === 0 ? 'sell' : 'buy'
        trades.push(trade({ trader: A, token: tokens[rand(3)], side, usdc: BigInt(1 + rand(5_000_000_000)), tokens: BigInt(1 + rand(1_000_000_000_000)), block: 1 + rand(1000), logIndex: rand(5) }))
      }
      const mine = Number(statsOf(trades, 0).realized)
      const sales = trades.filter(t => t.side === 'sell').length
      // Each sale floors two divisions in micro-USDC: within 2 micro-USDC a sale of the exact answer.
      expect(Math.abs(mine - independentPnl(trades))).toBeLessThanOrEqual((2 * sales + 1) / 1e6)
    }
  })
  test('usd6 writes exact decimals', () => {
    expect([usd6(0n), usd6(1n), usd6(-1_500_000n), usd6(123_456_789n)]).toEqual(['0.000000', '0.000001', '-1.500000', '123.456789'])
  })
})

describe('the wash-trade filter, on test wallets', () => {
  const farmer = '0x00000000000000000000000000000000000fa4a1'
  const twinA = '0x00000000000000000000000000000000000a0a0a', twinB = '0x00000000000000000000000000000000000b0b0b'
  const honest = '0x000000000000000000000000000000000000c0de'
  const scalper = '0x0000000000000000000000000000000000005ca1'
  function market(): BookTrade[] {
    const t: BookTrade[] = []
    let b = 5_000, at = T0 - 86_400_000
    const step = (s = 1) => { b += s; at += s * 1_000 }
    // The farmer: six buys sold straight back for about the same, a minute later.
    for (let i = 0; i < 6; i++) {
      step(); t.push(trade({ trader: farmer, side: 'buy', usdc: usd(50), tokens: 10_000n, block: b, at }))
      step(60); t.push(trade({ trader: farmer, side: 'sell', usdc: usd(49.6), tokens: 10_000n, block: b, at }))
    }
    // The twins: B sells to A at the bottom and buys back from A at the top, four times; A shows the profit.
    for (let i = 0; i < 4; i++) {
      step(100); t.push(trade({ trader: twinA, token: COIN2, side: 'buy', usdc: usd(100), tokens: 50_000n, block: b, at }))
      step(1); t.push(trade({ trader: twinB, token: COIN2, side: 'sell', usdc: usd(99), tokens: 50_000n, block: b, at }))
      step(50); t.push(trade({ trader: twinB, token: COIN2, side: 'buy', usdc: usd(400), tokens: 49_000n, block: b, at }))
      step(1); t.push(trade({ trader: twinA, token: COIN2, side: 'sell', usdc: usd(395), tokens: 50_000n, block: b, at }))
    }
    // An honest trader: three coins, profits, one quick flip.
    for (const [token, buy, sell] of [[COIN, 20, 35], [COIN2, 50, 41], [COIN3, 10, 30]] as const) {
      step(30); t.push(trade({ trader: honest, token, side: 'buy', usdc: usd(buy), tokens: 7_777n, block: b, at }))
      step(400); t.push(trade({ trader: honest, token, side: 'sell', usdc: usd(sell), tokens: 7_777n, block: b, at }))
    }
    step(10); t.push(trade({ trader: honest, token: COIN3, side: 'buy', usdc: usd(12), tokens: 900n, block: b, at }))
    step(30); t.push(trade({ trader: honest, token: COIN3, side: 'sell', usdc: usd(12.1), tokens: 900n, block: b, at }))
    // A scalper with four flat flips among real trades: under the bar.
    for (let i = 0; i < 4; i++) {
      step(5); t.push(trade({ trader: scalper, token: COIN3, side: 'buy', usdc: usd(20), tokens: 2_000n, block: b, at }))
      step(60); t.push(trade({ trader: scalper, token: COIN3, side: 'sell', usdc: usd(20.2), tokens: 2_000n, block: b, at }))
    }
    step(5); t.push(trade({ trader: scalper, token: COIN, side: 'buy', usdc: usd(500), tokens: 3_000n, block: b, at }))
    step(900); t.push(trade({ trader: scalper, token: COIN, side: 'sell', usdc: usd(650), tokens: 3_000n, block: b, at }))
    // Two strangers who happen to cross once in the same block.
    step(3); t.push(trade({ trader: A, token: COIN3, side: 'buy', usdc: usd(30), tokens: 4_000n, block: b, at }))
    t.push(trade({ trader: B, token: COIN3, side: 'sell', usdc: usd(30), tokens: 4_000n, block: b, at, logIndex: 1 }))
    return t
  }

  test('round trips: the farmer is flagged, the scalper (4 flips among real trades) isn’t', () => {
    const t = market()
    expect(roundTrips(t.filter(x => x.trader === farmer)).pairs).toBe(6)
    expect(roundTrips(t.filter(x => x.trader === scalper)).pairs).toBe(4)
    const flags = washFlags(t, T0)
    expect(flags.get(farmer)?.reasons).toEqual(['round-trips'])
    expect(flags.get(farmer)?.roundTripShare).toBe(1)
    expect(flags.has(scalper)).toBe(false)
  })
  test('mirrors: the twins trading with each other are both flagged; strangers crossing once aren’t', () => {
    const t = market()
    const m = mirrors(t)
    const key = [twinA, twinB].sort().join('|')
    expect(m.get(key)).toBe(8)
    expect(m.get([A, B].sort().join('|'))).toBe(1)
    const flags = washFlags(t, T0)
    expect(flags.get(twinA)?.reasons).toEqual(['mirror'])
    expect(flags.get(twinB)?.mirrors).toEqual([{ with: twinA, count: 8 }])
    expect(flags.has(honest)).toBe(false)
    expect(flags.has(A) || flags.has(B)).toBe(false)
  })
  test('only the last 30 days count', () => {
    expect(washFlags(market(), T0 + 31 * 86_400_000).size).toBe(0)
  })
  test('the board leaves the wash wallets out and says so; the honest trader and the scalper are ranked', async () => {
    const t = market()
    const book = { version: 1, all: () => t, of: (a: string) => t.filter(x => x.trader === a), traders: () => [...new Set(t.map(x => x.trader))], scannedTo: async () => 9_999, checkedTo: async () => 9_000 }
    const boards = new SocialBoards(book)
    const board = await boards.board('30d', 100, T0)
    expect(board.rows.map(r => r.trader)).toEqual([scalper, honest])
    expect(board.rows[0]).toMatchObject({ rank: 1, stats: { realized: '150.800000' } })
    expect(board.excluded.map(e => e.trader).sort()).toEqual([farmer, twinA, twinB].sort())
    expect(board.excluded.find(e => e.trader === twinA)!.realized).toBe('1180.000000') // the fake profit the twins made
    expect(board.thin).toBe(2) // A and B: one trade each
    expect(board).toMatchObject({ scannedTo: 9_999, checkedTo: 9_000, period: '30d' })
    const prof = await boards.trader(twinA, T0)
    expect(prof.wash?.reasons).toEqual(['mirror'])
    expect(prof.ranks['30d']).toBeNull()
    expect((await boards.trader(honest, T0)).ranks['30d']).toBe(2)
    expect(BOARD_MIN.trades).toBe(3)
  })
})

describe('the trade book', () => {
  function chainOf(logs: RouterLog[]) {
    return {
      logs,
      scan: async (_f: unknown, from: number, to: number) => ({ logs: logs.filter(l => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to }), scannedTo: to }),
    }
  }
  const buyLog = (tx: string, block: number, trader = A, at: number | null = T0) => swapLog({ tx, block, at, trader, tokenIn: ARC_USDC, tokenOut: COIN, amountIn: usd(10), amountOut: 1000n })
  const sellLog = (tx: string, block: number, trader = A) => swapLog({ tx, block, trader, tokenIn: COIN, tokenOut: ARC_USDC, amountIn: 1000n, amountOut: usd(14) })
  const mk = (chain: ReturnType<typeof chainOf>, over: Partial<ConstructorParameters<typeof TradeBook>[0]> = {}, store = new MemoryBotStore()) => {
    const alerts: string[] = []
    const book = new TradeBook({ store, settings: store, scan: chain.scan, head: async () => 1_050 + 50, times: async b => new Map(b.map(x => [x, T0])), alert: s => alerts.push(s), from: 100, ...over })
    return { book, store, alerts }
  }

  test('reads the routers’ trades into the book, keeps them across a restart', async () => {
    const chain = chainOf([buyLog('0x01', 200), sellLog('0x02', 300), buyLog('0x03', 1_100)])
    const { book, store } = mk(chain)
    await book.load()
    await book.tick(T0)
    expect(book.size).toBe(2) // block 1,100 isn't settled yet (50 behind the head)
    expect(await book.scannedTo()).toBe(1_050)
    expect(statsOf(book.of(A), 0).realized).toBe('4.000000')
    const again = mk(chain, {}, store).book
    await again.load()
    expect(again.size).toBe(2)
    expect(await again.scannedTo()).toBe(1_050)
  })
  test('a block whose time can’t be read holds the book back until it can', async () => {
    const chain = chainOf([buyLog('0x01', 200, A, null)])
    let known = false
    const { book } = mk(chain, { times: async b => new Map(b.map(x => [x, known ? T0 : null])) })
    await book.load()
    await book.tick(T0)
    expect(book.size).toBe(0)
    expect(await book.scannedTo()).toBe(99)
    known = true
    await book.tick(T0)
    expect(book.size).toBe(1)
  })
  test('the nightly check: clean once a day after 00:50 UTC, and only then', async () => {
    const chain = chainOf([buyLog('0x01', 200), sellLog('0x02', 300)])
    const { book } = mk(chain)
    await book.load()
    await book.tick(Date.parse('2026-10-11T00:49:00Z'))
    expect(await book.checks()).toEqual([])
    await book.tick(Date.parse('2026-10-11T00:51:00Z'))
    expect((await book.checks())[0]).toMatchObject({ ok: true, from: 100, to: 1_050, trades: 2 })
    expect(await book.checkedTo()).toBe(1_050)
    await book.tick(Date.parse('2026-10-11T05:00:00Z'))
    expect((await book.checks()).length).toBe(1)
  })
  test('a trade the book missed, one it shouldn’t have, and one that changed are found and alerted', async () => {
    const logs = [buyLog('0x01', 200), sellLog('0x02', 300)]
    const chain = chainOf(logs)
    const store = new MemoryBotStore()
    // The book was told of a trade that isn't on the chain, and of 0x02 with another amount.
    await store.appendSocialTrades([
      { id: '0xff:0', router: V2, tx: '0xff', block: 250, logIndex: 0, at: T0, trader: A, token: COIN, side: 'buy', usdc: 1n, tokens: 1n, fee: 0n },
      { ...decodeTrades([sellLog('0x02', 300)])[0], usdc: usd(99) },
    ])
    await store.setSetting('social-book', JSON.stringify({ to: 1_050, checked: 99 }))
    const { book, alerts } = mk(chain, {}, store)
    await book.load()
    const r = (await book.check(T0))!
    expect(r).toMatchObject({ ok: false, missing: ['0x01:0'], extra: ['0xff:0'], changed: ['0x02:0'] })
    expect(alerts[0]).toContain('1 missing, 1 extra, 1 changed')
    expect(await book.checkedTo()).toBe(99) // not checked past the mismatch
    expect(book.of(A).some(t => t.id === '0x01:0')).toBe(true) // the missed trade is in now
  })
  test('the Supabase index is compared over the same blocks', async () => {
    const chain = chainOf([buyLog('0x01', 200), sellLog('0x02', 300), buyLog('0x03', 400)])
    const rows: IndexRow[] = [
      { tx_hash: '0x01', log_index: 0, trader: A, token: COIN, side: 'buy', usdc: '10.000000', token_amount: '1000', block_number: 200 },
      { tx_hash: '0x02', log_index: 0, trader: A, token: COIN, side: 'sell', usdc: '14.000001', token_amount: '1000', block_number: 300 },
      { tx_hash: '0x09', log_index: 0, trader: A, token: COIN, side: 'buy', usdc: '1', token_amount: '1', block_number: 350 },
    ]
    const { book } = mk(chain, { indexRows: async () => rows })
    await book.load()
    await book.tick(Date.parse('2026-10-10T00:10:00Z')) // before 00:50: reads, no check
    const r = (await book.check(T0))!
    expect(r.ok).toBe(true)
    expect(r.supabase).toEqual({ rows: 3, missing: ['0x03:0'], extra: ['0x09:0'], changed: ['0x02:0'] })
  })
})

// Anvil's published test keys: never funded on any real chain.
const admin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const stranger = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a3d4cb8e6dc8fb8e6d0' as Hex)
const ME = '0x00000000000000000000000000000000000000e1', YOU = '0x00000000000000000000000000000000000000e2'
const R = ['0x00000000000000000000000000000000000000f1', '0x00000000000000000000000000000000000000f2', '0x00000000000000000000000000000000000000f3', '0x00000000000000000000000000000000000000f4']

function mod(theses: Record<number, { author: string; body: string }> = { 7: { author: YOU, body: 'up only' } }) {
  const store = new MemoryBotStore()
  const v = new ControlVerifier(null, [], a => verifyMessage(a))
  const m = new Moderation({
    store, settings: store, audit: store,
    verify: (msg, at, sig, now) => v.verifyAnyOf([admin.address.toLowerCase()], msg, at, sig, now),
    thesis: async id => theses[id] ?? null,
  })
  return { m, store }
}
const signed = async (action: 'hide' | 'restore' | 'dismiss' | 'ban' | 'unban', target: string, at = Date.now(), who = admin, reason = 'looked at it') =>
  ({ action, target, reason, at, signature: await who.signMessage({ message: moderationMessage(action, target, reason, at) }) })

describe('comments', () => {
  test('targets and text are checked and cleaned; text is kept as text', async () => {
    expect(parseCommentTarget('thesis:7')).toBe('thesis:7')
    expect(parseCommentTarget(`coin:arc:${COIN.toUpperCase().replace('0X', '0x')}`)).toBe(`coin:arc:${COIN}`)
    expect(parseCommentTarget('coin:solana:So11111111111111111111111111111111111111112')).toBe('coin:solana:So11111111111111111111111111111111111111112')
    for (const bad of ['thesis:0', 'thesis:-1', 'coin:eth:0x1', 'coin:solana:0xabc', 'javascript:alert(1)', 'profile:0x1', 7, null]) expect(parseCommentTarget(bad)).toBeNull()
    expect(cleanText(' a​\u0000b\r\n\n\n\nc ', 280)).toBe('ab\n\nc')
    expect(cleanText('‮​ ', 280)).toBeNull()
    expect(cleanText('x'.repeat(281), 280)).toBeNull()
    const { m } = mod()
    const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    const r = await m.comment(ME, 'thesis:7', xss, T0)
    expect(r.ok && r.value.body).toBe(xss) // stored as text; the site renders text (scripts/test-social.tsx checks it escapes)
    expect(await m.comment(ME, 'thesis:8', 'hi', T0 + 20_000)).toEqual({ ok: false, status: 404, error: 'No such thesis' })
    expect((await m.comment(ME, 'thesis:7', '', T0 + 40_000)).ok).toBe(false)
  })
  test('30 a day, one every 10 seconds; the author can delete theirs, nobody else can', async () => {
    const { m } = mod()
    expect((await m.comment(ME, `coin:arc:${COIN}`, 'one', T0)).ok).toBe(true)
    expect(await m.comment(ME, `coin:arc:${COIN}`, 'two', T0 + 5_000)).toEqual({ ok: false, status: 429, error: 'Wait a few seconds between comments' })
    for (let i = 1; i < SOCIAL_LIMITS.commentsPerDay; i++) expect((await m.comment(ME, `coin:arc:${COIN}`, `n${i}`, T0 + i * 11_000)).ok).toBe(true)
    expect((await m.comment(ME, `coin:arc:${COIN}`, 'too many', T0 + 1_000_000)) as { status: number }).toMatchObject({ status: 429 })
    expect((await m.comment(ME, `coin:arc:${COIN}`, 'next day', T0 + 86_400_001)).ok).toBe(true)
    const list = m.list(`coin:arc:${COIN}`)
    const id = list.ok ? list.value[0].id : ''
    expect(await m.deleteComment(YOU, id, T0)).toEqual({ ok: false, status: 403, error: 'Only its author can delete a comment' })
    const d = await m.deleteComment(ME, id, T0)
    expect(d.ok && d.value).toMatchObject({ deleted: true, body: '' })
    expect(m.counts([`coin:arc:${COIN}`])[`coin:arc:${COIN}`]).toBe(SOCIAL_LIMITS.commentsPerDay)
  })
  test('comments survive a restart', async () => {
    const { m, store } = mod()
    await m.comment(ME, 'thesis:7', 'kept', T0)
    const again = new Moderation({ store, settings: store, audit: store, verify: async () => 'x' })
    await again.load()
    const l = again.list('thesis:7')
    expect(l.ok && l.value.map(c => c.body)).toEqual(['kept'])
  })
})

describe('reports, auto-hide and mutes', () => {
  test('a report needs a target that exists, a reason, and not yourself; 20 a day', async () => {
    const { m } = mod()
    const c = await m.comment(ME, 'thesis:7', 'buy my bag', T0)
    const id = c.ok ? c.value.id : ''
    expect(parseReportTarget(`comment:${id}`)).toBe(`comment:${id}`)
    expect(await m.report(ME, `comment:${id}`, 'spam', null, T0)).toEqual({ ok: false, status: 400, error: 'You can’t report yourself' })
    expect((await m.report(YOU, `comment:${id}`, 'rude', null, T0)) as { status: number }).toMatchObject({ status: 400 })
    expect(await m.report(YOU, 'comment:c_nosuchcomment', 'spam', null, T0)).toEqual({ ok: false, status: 404, error: 'Nothing to report there' })
    expect(await m.report(YOU, `coin:arc:${COIN}`, 'spam', null, T0)).toEqual({ ok: false, status: 400, error: 'You can report a comment, a thesis or a profile' })
    expect((await m.report(ME, `profile:${YOU}`, 'impersonation', 'pretends to be the team', T0)).ok).toBe(true)
    expect(m.me(ME).reports).toEqual([`profile:${YOU}`])
    const lots = mod().m
    for (let i = 0; i < SOCIAL_LIMITS.reportsPerDay; i++) expect((await lots.report(ME, `profile:0x${(i + 1).toString(16).padStart(40, '0')}`, 'spam', null, T0)).ok).toBe(true)
    expect((await lots.report(ME, `profile:${YOU}`, 'spam', null, T0)) as { status: number }).toMatchObject({ status: 429 })
  })
  test('three different wallets hide a comment or a thesis; its author and banned wallets don’t count', async () => {
    const { m } = mod()
    const c = await m.comment(ME, `coin:arc:${COIN}`, 'scam link here', T0)
    const target = `comment:${c.ok ? c.value.id : ''}`
    expect((await m.report(R[0], target, 'scam', null, T0)).ok && m.list(`coin:arc:${COIN}`)).toMatchObject({ ok: true, value: [{ body: 'scam link here' }] })
    await m.report(R[0], target, 'spam', null, T0 + 1) // again: still one reporter
    await m.report(R[1], target, 'scam', null, T0 + 2)
    expect(m.list(`coin:arc:${COIN}`)).toMatchObject({ value: [{}] })
    const third = await m.report(R[2], target, 'scam', null, T0 + 3)
    expect(third).toEqual({ ok: true, value: { hidden: true } })
    expect(m.list(`coin:arc:${COIN}`)).toEqual({ ok: true, value: [] })
    // A thesis: its author's own report doesn't count.
    await m.report(R[0], 'thesis:7', 'spam', null, T0)
    await m.report(R[1], 'thesis:7', 'spam', null, T0)
    expect((await m.report(YOU, 'thesis:7', 'spam', null, T0)) as { ok: boolean }).toMatchObject({ ok: false }) // can't report yourself
    expect(m.state().theses).toEqual([])
    await m.report(R[2], 'thesis:7', 'abuse', 'insults people', T0)
    expect(m.state().theses).toEqual([7])
    // Commenting under a hidden thesis isn't possible.
    expect((await m.comment(R[3], 'thesis:7', 'hello', T0 + 60_000)) as { status: number }).toMatchObject({ status: 404 })
    const g = m.groups()
    expect(g.find(x => x.target === 'thesis:7')).toMatchObject({ reports: 3, state: 'hidden', snapshot: { author: YOU, body: 'up only' } })
  })
  test('mutes: on and off, never yourself, kept across a restart', async () => {
    const { m, store } = mod()
    expect((await m.mute(ME, YOU, true, T0)).ok && m.me(ME).mutes).toEqual([YOU])
    expect((await m.mute(ME, ME, true, T0)) as { status: number }).toMatchObject({ status: 400 })
    expect((await m.mute(ME, 'nope', true, T0)) as { status: number }).toMatchObject({ status: 400 })
    const again = new Moderation({ store, settings: store, audit: store, verify: async () => 'x' })
    await again.load()
    expect(again.me(ME).mutes).toEqual([YOU])
    await m.mute(ME, YOU, false, T0)
    expect(m.me(ME).mutes).toEqual([])
  })
})

describe('admins moderating', () => {
  test('hide, restore (then reports don’t hide it again), dismiss, ban and unban: signed by the admin signed in, audited', async () => {
    const { m, store } = mod()
    const c = await m.comment(ME, 'thesis:7', 'hello', T0)
    const target = `comment:${c.ok ? c.value.id : ''}`
    const now = Date.now()
    expect((await m.moderate({ action: 'hide', target, reason: 'x', at: now, signature: '0x' }, admin.address)).status).toBe(400)
    expect((await m.moderate(await signed('hide', target, now, stranger), stranger.address)).status).toBe(403)
    expect((await m.moderate(await signed('hide', target, now), stranger.address)).body).toEqual({ error: 'sign with the wallet you signed in with' })
    expect((await m.moderate(await signed('ban', target, now), admin.address)).status).toBe(400) // ban takes a profile
    expect((await m.moderate(await signed('hide', target, now + 1), admin.address)).status).toBe(200)
    expect(m.list('thesis:7')).toEqual({ ok: true, value: [] })
    expect((await m.moderate(await signed('restore', target, now + 2), admin.address)).status).toBe(200)
    for (const r of R.slice(0, 3)) await m.report(r, target, 'spam', null, T0)
    expect(m.list('thesis:7')).toMatchObject({ value: [{ body: 'hello' }] }) // restored: reports don't hide it again
    expect(m.groups()[0]).toMatchObject({ target, state: 'restored', reports: 3 })
    // A ban: the wallet can't post, and what it posted is hidden.
    expect((await m.moderate(await signed('ban', `profile:${ME}`, now + 3), admin.address)).status).toBe(200)
    expect(m.state().banned).toEqual([ME])
    expect(m.isBanned(ME)).toBe(true)
    expect(m.list('thesis:7')).toEqual({ ok: true, value: [] })
    expect(await m.comment(ME, 'thesis:7', 'again', T0 + 100_000)).toEqual({ ok: false, status: 403, error: 'This wallet can’t post on ARCDEX' })
    expect((await m.report(ME, `profile:${YOU}`, 'spam', null, T0)) as { status: number }).toMatchObject({ status: 403 })
    // A signature is used once.
    const reuse = await signed('unban', `profile:${ME}`, now + 4)
    expect((await m.moderate(reuse, admin.address)).status).toBe(200)
    expect((await m.moderate(reuse, admin.address)).status).toBe(403)
    expect(m.isBanned(ME)).toBe(false)
    const audit = await store.audit(10)
    expect(audit.map(a => a.action)).toEqual(['moderation.unban', 'moderation.ban', 'moderation.restore', 'moderation.hide'])
    expect(audit[0]).toMatchObject({ actor: admin.address.toLowerCase(), detail: { target: `profile:${ME}`, reason: 'looked at it' } })
  })
  test('the state survives a restart', async () => {
    const { m, store } = mod()
    await m.moderate(await signed('ban', `profile:${YOU}`, Date.now()), admin.address)
    const again = new Moderation({ store, settings: store, audit: store, verify: async () => 'x' })
    await again.load()
    expect(again.isBanned(YOU)).toBe(true)
    expect(again.state().banned).toEqual([YOU])
  })
})

describe('the routes', () => {
  const SITE = 'https://arcsense.site'
  function api() {
    const t: BookTrade[] = [
      trade({ trader: A, side: 'buy', usdc: usd(100), tokens: 100n }),
      trade({ trader: A, side: 'buy', usdc: usd(100), tokens: 100n }),
      trade({ trader: A, side: 'sell', usdc: usd(300), tokens: 200n }),
    ]
    const store = new MemorySocialTradeStore()
    const bookStub = { version: 1, all: () => t, of: (a: string) => t.filter(x => x.trader === a.toLowerCase()), traders: () => [A], scannedTo: async () => 5, checkedTo: async () => 4, size: 3, checks: async () => [] }
    const { m } = mod()
    const a = new SocialApi({
      book: bookStub as unknown as TradeBook, boards: new SocialBoards(bookStub), moderation: m, origins: [SITE],
      session: async tok => (tok === 'good' ? { address: ME, iat: 0 } : tok === 'gone' ? { address: YOU, iat: 0 } : null),
      revoked: async who => who === YOU,
    })
    void store
    const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
      const r = await a.handle(new Request(`https://engine.test${path}`, { method, headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`https://engine.test${path}`))
      return r!
    }
    return { call, m }
  }
  test('reads: the board, a trader, flags, checks, comments, counts, moderation', async () => {
    const { call } = api()
    const b = await call('GET', '/v1/social/board?period=all')
    expect(b.status).toBe(200)
    expect((b.body as SocialBoard).rows).toMatchObject([{ rank: 1, trader: A, stats: { realized: '100.000000' } }])
    expect((await call('GET', '/v1/social/board?period=1y')).status).toBe(400)
    const p = await call('GET', `/v1/social/trader/${A.toUpperCase().replace('0X', '0x')}`)
    expect((p.body as SocialTrader)).toMatchObject({ trader: A, tradeCount: 3, ranks: { all: 1 }, periods: { all: { realized: '100.000000' } }, history: [{ pnl: '100.000000', cumulative: '100.000000' }] })
    expect((await call('GET', '/v1/social/flags')).body).toMatchObject({ flags: [] })
    expect((await call('GET', '/v1/social/checks')).body).toMatchObject({ scannedTo: 5, checkedTo: 4, trades: 3 })
    expect((await call('GET', '/v1/social/comments?target=thesis:7')).body).toEqual({ comments: [] })
    expect((await call('GET', '/v1/social/comments?target=bad')).status).toBe(400)
    expect((await call('GET', '/v1/social/moderation')).body).toEqual({ theses: [], banned: [] })
    expect((await call('GET', '/v1/social/nope')).status).toBe(404)
    expect((await call('GET', '/v1/social/me')).status).toBe(401)
  })
  test('writes: from the site, signed in, and not after "sign out of all devices"', async () => {
    const { call } = api()
    expect((await call('POST', '/v1/social/comment', { target: 'thesis:7', body: 'hi' }, { authorization: 'Bearer good' })).status).toBe(403) // no origin
    expect((await call('POST', '/v1/social/comment', { target: 'thesis:7', body: 'hi' }, { origin: 'https://evil.example', authorization: 'Bearer good' })).status).toBe(403)
    expect((await call('POST', '/v1/social/comment', { target: 'thesis:7', body: 'hi' }, { origin: SITE })).status).toBe(401)
    expect((await call('POST', '/v1/social/comment', { target: 'thesis:7', body: 'hi' }, { origin: SITE, authorization: 'Bearer gone' })).status).toBe(401)
    const ok = await call('POST', '/v1/social/comment', { target: 'thesis:7', body: 'hi' }, { origin: SITE, authorization: 'Bearer good' })
    expect(ok).toMatchObject({ status: 200, body: { author: ME, body: 'hi', target: 'thesis:7' } })
    expect((await call('GET', '/v1/social/counts?targets=thesis:7,thesis:8')).body).toEqual({ counts: { 'thesis:7': 1, 'thesis:8': 0 } })
    expect((await call('POST', '/v1/social/mute', { address: YOU, on: true }, { origin: SITE, authorization: 'Bearer good' })).body).toEqual({ mutes: [YOU], reports: [] })
    expect((await call('POST', '/v1/social/report', { target: 'thesis:7', reason: 'spam' }, { origin: SITE, authorization: 'Bearer good' })).body).toEqual({ hidden: false })
    expect((await call('GET', '/v1/social/me', undefined, { authorization: 'Bearer good' })).body).toEqual({ mutes: [YOU], reports: ['thesis:7'] })
    expect((await call('POST', '/v1/social/comment/delete', { id: (ok.body as { id: string }).id }, { origin: SITE, authorization: 'Bearer good' })).body).toMatchObject({ deleted: true })
    expect((await call('POST', '/v1/social/wat', {}, { origin: SITE, authorization: 'Bearer good' })).status).toBe(404)
  })
})

const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('Postgres (PG_TEST_URL)', () => {
  test('the trade book is append-only, and comments, reports and mutes round-trip', async () => {
    const store = new PostgresBotStore(PG!)
    const t = trade({ trader: A, side: 'buy', usdc: 123_456_789_012n, tokens: 98_765_432_109_876_543_210n, fee: 1n, tx: `0x${Date.now().toString(16).padStart(64, '0')}` })
    expect(await store.appendSocialTrades([t, t])).toBe(1)
    expect(await store.appendSocialTrades([t])).toBe(0)
    const back = (await store.socialTrades()).find(x => x.id === t.id)!
    expect(back).toEqual(t)
    const { SQL } = await import('bun')
    const sql = new SQL(PG!)
    const refused = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => 'ran', (e: Error) => e.message)
    expect(await refused(sql`update arcdex_social_trades set usdc = 0 where id = ${t.id}`)).toMatch(/append-only/)
    expect(await refused(sql`delete from arcdex_social_trades where id = ${t.id}`)).toMatch(/append-only/)
    expect(await refused(sql`truncate arcdex_social_trades`)).toMatch(/append-only/)
    await sql.close()
    const m = new Moderation({ store, settings: store, audit: store, verify: async () => 'x' })
    await m.load()
    const c = await m.comment(ME, `coin:arc:${COIN}`, 'from postgres', Date.now())
    await m.report(YOU, `comment:${c.ok ? c.value.id : ''}`, 'spam', 'a note', Date.now())
    await m.mute(ME, YOU, true, Date.now())
    const again = new Moderation({ store, settings: store, audit: store, verify: async () => 'x' })
    await again.load()
    const listed = again.list(`coin:arc:${COIN}`)
    expect(listed.ok && listed.value.some(x => x.body === 'from postgres')).toBe(true)
    expect(again.groups().find(g => g.target === `comment:${c.ok ? c.value.id : ''}`)).toMatchObject({ reports: 1, notes: [{ note: 'a note' }] })
    expect(again.me(ME).mutes).toContain(YOU)
  })
})

// Keep the memory store's moderation half honest too.
test('the memory store keeps comments, reports and mutes', async () => {
  const s = new MemoryModerationStore()
  await s.putComment({ id: 'c_1', target: 'thesis:1', author: ME, body: 'x', at: 1, deletedAt: null })
  await s.setMute({ muter: ME, muted: YOU, at: 1 }, true)
  await s.setMute({ muter: ME, muted: YOU, at: 1 }, false)
  expect(await s.socialComments()).toHaveLength(1)
  expect(await s.socialMutes()).toHaveLength(0)
})
