// Paper trading's engine (src/arcdex/hl/paper.ts): fills against the book, positions and margin, closes and flips,
// limit orders with their margin held back, take-profits and stop-losses, liquidations, Hyperliquid's hourly funding,
// the price path between two checks, the candle replay after a gap, and what it refuses.
//   bun scripts/test-paper.ts

import { readFileSync } from 'fs'
import {
  applyFill, available, cancelPaper, freshPaper, fundedThrough, intervalFor, liqPrice, PAPER, PaperError, paperFees, placeLimit, placeMarket,
  replay, reserved, setTpSl, step, summarize, tick, walkBook, type Bar, type PaperBook, type PaperState,
} from '../src/arcdex/hl/paper'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b))
const refused = (f: () => unknown, msg?: RegExp) => { try { f(); return false } catch (e) { return e instanceof PaperError && (!msg || msg.test(e.message)) } }

const book: PaperBook = { bids: [{ px: 99, sz: 1 }, { px: 98, sz: 2 }, { px: 97, sz: 5 }], asks: [{ px: 101, sz: 1 }, { px: 102, sz: 2 }, { px: 103, sz: 5 }] }
const deep: PaperBook = { bids: [{ px: 99.9, sz: 1e6 }], asks: [{ px: 100.1, sz: 1e6 }] }
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000) // on the hour
const fees = paperFees(0)
const noFees = { taker: 0, maker: 0 }
const open = (s: PaperState, isBuy: boolean, sz: number, px: number, lev: number, time = T0) => applyFill(s, { coin: 'X', isBuy, sz, px, feeRate: 0, lev, maxLev: 20, time }).state

console.log('fees')
{
  const access = readFileSync('src/arcdex/hl/access.ts', 'utf8')
  ok(/perpF: tenthsBps\(env\.VITE_HL_BUILDER_PERP, 50\)/.test(access), 'ARCDEX’s builder fee on perps defaults to 0.05% (hl/access.ts BUILDER.perpF)')
  const f = paperFees(50 / 100_000)
  ok(near(f.taker, 0.00095) && near(f.maker, 0.00065), 'paper pays Hyperliquid’s 0.045% / 0.015% plus it: 0.095% taker, 0.065% maker')
}

console.log('the book')
{
  ok(near(walkBook(book.asks, 2)!.avg, 101.5) && walkBook(book.asks, 2)!.worst === 102, '2 bought across two levels: average 101.5, worst 102')
  ok(walkBook(book.asks, 9) === null, 'more than the book holds: no fill')
}

console.log('opening, adding, closing')
{
  let s = freshPaper(T0)
  const r = placeMarket(s, { coin: 'X', isBuy: true, sz: 2, lev: 5, maxLev: 20, reduceOnly: false, slippage: 0.03, mid: 100, book, time: T0, fees })
  s = r.state
  const p = s.positions[0]
  ok(near(r.avg, 101.5) && near(p.szi, 2) && near(p.entryPx, 101.5), 'a market buy of 2 fills at the book’s average, 101.5')
  ok(near(p.margin, (2 * 101.5) / 5), 'margin is the value over the leverage (40.6)')
  ok(near(s.cash, PAPER.start - 40.6 - 2 * 101.5 * PAPER.taker), 'cash pays the margin and the taker fee')
  ok(s.fills[0].dir === 'Open Long', 'its fill reads Open Long')
  s = applyFill(s, { coin: 'X', isBuy: true, sz: 2, px: 104.5, feeRate: PAPER.taker, lev: 10, maxLev: 20, time: T0 + 1 }).state
  ok(near(s.positions[0].entryPx, 103) && s.positions[0].lev === 5, 'adding averages the entry (103) and keeps the position’s leverage')
  const before = s.cash
  const part = applyFill(s, { coin: 'X', isBuy: false, sz: 1, px: 113, feeRate: PAPER.taker, lev: 5, maxLev: 20, time: T0 + 2 })
  s = part.state
  ok(near(s.positions[0].szi, 3), 'selling 1 of 4 leaves 3')
  ok(near(s.cash - before, 103 / 5 + 10 - 113 * PAPER.taker), 'and pays back that quarter’s margin plus its profit (10), less the fee')
  ok(part.fills[0].dir === 'Close Long' && near(part.fills[0].closedPnl, 10), 'its fill reads Close Long, +10')
  const r2 = applyFill(s, { coin: 'X', isBuy: false, sz: 5, px: 100, feeRate: PAPER.taker, lev: 4, maxLev: 20, time: T0 + 3 })
  s = r2.state
  ok(r2.fills.length === 2 && r2.fills[0].dir === 'Close Long' && r2.fills[1].dir === 'Open Short', 'selling 5 against 3 long closes the long and opens 2 short')
  ok(near(s.positions[0].szi, -2) && s.positions[0].lev === 4 && near(s.positions[0].entryPx, 100), 'the short: 2 at 100, at the order’s leverage')
}

console.log('isolated margin')
{
  const s = open(freshPaper(T0), true, 1, 100, 10)
  const lost = applyFill(s, { coin: 'X', isBuy: false, sz: 1, px: 50, feeRate: 0, lev: 10, maxLev: 20, time: T0 + 1 })
  ok(near(lost.state.cash, s.cash) && near(lost.fills[0].closedPnl, -10) && lost.state.positions.length === 0, 'a close far past the margin loses the margin (10), not more')
  ok(summarize(freshPaper(T0), {}).value === PAPER.start, 'a fresh account is worth $10,000')
  ok(near(summarize(s, { X: 50 }).value, PAPER.start - 10), 'and an open position far under water is worth nothing, not less')
  ok(freshPaper(T0, 1_000).cash === 1_000, 'an account can start with another amount')
}

console.log('margin held back for resting orders')
{
  let s = freshPaper(T0)
  s = placeLimit(s, { coin: 'X', isBuy: true, px: 90, sz: 100, lev: 2, maxLev: 20, reduceOnly: false, postOnly: false, mid: 100, book: deep, time: T0, fees }).state
  ok(near(reserved(s), 4_500 + 9_000 * PAPER.maker), 'a buy of 100 at 90 at 2× holds back $4,500 and its fee')
  ok(near(available(s), PAPER.start - reserved(s)), 'and what’s available drops by as much')
  ok(refused(() => placeLimit(s, { coin: 'X', isBuy: true, px: 80, sz: 150, lev: 2, maxLev: 20, reduceOnly: false, postOnly: false, mid: 100, book: deep, time: T0, fees }), /Not enough/), 'so a second one past what’s left ($6,000 against $5,499) is refused')
  ok(refused(() => placeMarket(s, { coin: 'X', isBuy: true, sz: 60, lev: 1, maxLev: 20, reduceOnly: false, slippage: 0.05, mid: 100, book: deep, time: T0, fees }), /Not enough/), 'and so is a market order that would use it')
  s = open(s, false, 50, 100, 5)
  ok(near(reserved(s), 50 * 90 / 2 + 9_000 * PAPER.maker), 'with 50 held short, only the 50 of the buy that would open long holds margin')
  ok(refused(() => placeMarket(freshPaper(T0), { coin: 'X', isBuy: true, sz: 1, lev: 25, maxLev: 20, reduceOnly: false, slippage: 0.05, mid: 100, book: deep, time: T0, fees }), /leverage/), 'leverage over the market’s maximum is refused')
}

console.log('liquidation')
{
  const pos = { szi: 1, entryPx: 100, margin: 10, maxLev: 20 }
  const lp = liqPrice(pos)
  ok(near(lp, 90 / (1 - 1 / 40)), `a 10× long at 100 liquidates near ${lp.toFixed(2)}`)
  ok(near(liqPrice({ ...pos, szi: -1 }), 110 / (1 + 1 / 40)), 'and a 10× short near 107.32')
  let s = open(freshPaper(T0), true, 1, 100, 10)
  s = setTpSl(s, 'X', 120, null, T0, fees)
  ok(tick(s, { X: lp + 0.5 }, T0 + 1).events.length === 0, 'just above the liquidation price: nothing happens')
  const r = tick(s, { X: lp - 0.5 }, T0 + 2)
  ok(r.events.length === 1 && r.events[0].kind === 'liquidated' && r.state.positions.length === 0, 'just under it: liquidated')
  ok(r.state.orders.length === 0 && near(r.state.cash, s.cash) && r.state.fills[0].dir === 'Liquidation' && near(r.state.fills[0].closedPnl, -10), 'its margin (10) is gone, its take-profit with it')
}

console.log('limit orders')
{
  let s = freshPaper(T0)
  ok(refused(() => placeLimit(s, { coin: 'X', isBuy: true, px: 102, sz: 1, lev: 5, maxLev: 20, reduceOnly: false, postOnly: true, mid: 100, book, time: T0, fees }), /Post only/), 'post-only at a price that would fill now: refused')
  const crossing = placeLimit(s, { coin: 'X', isBuy: true, px: 102, sz: 2, lev: 5, maxLev: 20, reduceOnly: false, postOnly: false, mid: 100, book, time: T0, fees })
  ok(!crossing.resting && near(crossing.state.positions[0].entryPx, 101.5), 'a buy at 102 for 2 fills now against the asks up to 102')
  ok(refused(() => placeLimit(s, { coin: 'X', isBuy: true, px: 102, sz: 4, lev: 5, maxLev: 20, reduceOnly: false, postOnly: false, mid: 100, book, time: T0, fees }), /all of this/), 'one the book can’t fill at its price: refused, not left to fill later at a better one')
  const r = placeLimit(s, { coin: 'X', isBuy: true, px: 95, sz: 1, lev: 5, maxLev: 20, reduceOnly: false, postOnly: true, mid: 100, book, time: T0, fees, tp: 110, sl: 90 })
  ok(r.resting && r.state.orders.length === 1, 'a buy at 95: waits')
  s = r.state
  ok(tick(s, { X: 96 }, T0 + 1).events.length === 0, 'the mid at 96: still waiting')
  const f = tick(s, { X: 95 }, T0 + 2)
  ok(f.events[0]?.kind === 'filled' && near(f.state.positions[0].entryPx, 95), 'the mid at 95: filled at 95')
  ok(near(f.state.fills[0].fee, 95 * PAPER.maker), 'at the maker fee')
  ok(f.state.orders.length === 2 && f.state.orders.some(o => o.kind === 'tp' && o.px === 110) && f.state.orders.some(o => o.kind === 'sl' && o.px === 90), 'its take-profit and stop-loss are set once it fills')
  const gap = tick(s, { X: 92 }, T0 + 3)
  ok(gap.events[0]?.kind === 'filled' && near(gap.state.positions[0].entryPx, 95), 'a price that gaps through it (to 92) fills it at its own price, 95')
  const c = cancelPaper(r.state, [r.state.orders[0].oid])
  ok(c.orders.length === 0, 'cancelled: gone')
  ok(refused(() => placeLimit(freshPaper(T0), { coin: 'X', isBuy: false, px: 110, sz: 1, lev: 5, maxLev: 20, reduceOnly: true, postOnly: false, mid: 100, book, time: T0, fees }), /Reduce only/), 'reduce-only with nothing to reduce: refused')
}

console.log('take-profit and stop-loss')
{
  let s = open(freshPaper(T0), false, 2, 100, 5)
  s = setTpSl(s, 'X', 90, 105, T0, noFees)
  ok(tick(s, { X: 95 }, T0 + 1).events.length === 0, 'a short with TP 90 and SL 105: nothing at 95')
  const t = tick(s, { X: 89 }, T0 + 2)
  ok(t.events[0]?.kind === 'triggered' && t.state.positions.length === 0 && t.state.orders.length === 0, 'at 89 the take-profit closes it all, and the stop goes too')
  ok(near(t.state.fills[0].closedPnl, 22), 'for +22 (the price was already past it)')
  const moved = tick(s, { X: 89 }, T0 + 2, { X: 95 })
  ok(moved.events[0]?.kind === 'triggered' && near(moved.state.fills[0].px, 90) && near(moved.state.fills[0].closedPnl, 20), 'watched from 95 to 89, it closes at its price, 90: +20')
  const st = tick(s, { X: 106 }, T0 + 3)
  ok(st.events[0]?.kind === 'triggered' && (st.events[0] as { order: { kind: string } }).order.kind === 'sl', 'at 106 the stop-loss does')
}

console.log('the path between two prices')
{
  // Long 1 at 100, 10× (liquidation ≈ 92.31), stop at 95, and a resting buy at 97 that adds to it.
  let s = open(freshPaper(T0), true, 1, 100, 10)
  s = setTpSl(s, 'X', null, 95, T0, noFees)
  s = placeLimit(s, { coin: 'X', isBuy: true, px: 97, sz: 1, lev: 10, maxLev: 20, reduceOnly: false, postOnly: false, mid: 100, book: deep, time: T0, fees: noFees }).state
  const r = step(s, 'X', 100, 90, T0 + 1)
  ok(r.events.map(e => e.kind).join(',') === 'filled,triggered', 'falling from 100 to 90: the buy at 97 fills first, then the stop at 95 closes it all')
  ok(r.state.positions.length === 0 && near(r.state.fills[0].px, 95) && near(r.state.fills[0].sz, 2), 'both coins, at 95: never down to the liquidation price')
  const up = step(s, 'X', 100, 110, T0 + 1)
  ok(up.events.length === 0, 'rising instead: nothing fires')
}

console.log('funding')
{
  let s = open(freshPaper(T0), true, 10, 100, 5)
  const funding = [{ coin: 'X', time: T0 + 3_600_000, rate: 0.0001 }, { coin: 'X', time: T0 + 7_200_000, rate: -0.0002 }]
  const r = replay(s, { bars: [], funding, until: T0 + 7_300_000, fundThrough: T0 + 7_200_000, prices: { X: 100 } })
  ok(near(r.state.positions[0].funding, 0.1 - 0.2) && near(r.state.positions[0].margin, 200 + 0.1), 'a long of $1,000 pays 0.01% for one hour and receives 0.02% the next (net −$0.10 paid)')
  ok(near(r.state.fundingPaid, -0.1) && r.state.fundedTo === T0 + 7_200_000, 'counted on the account, and both hours marked paid')
  const again = replay(r.state, { bars: [], funding, until: T0 + 7_300_000, fundThrough: T0 + 7_200_000, prices: { X: 100 } })
  ok(near(again.state.positions[0].funding, -0.1), 'the same hours again: not paid twice')
  s = open(freshPaper(T0), false, 10, 100, 5)
  const late = replay(s, { bars: [], funding: [{ coin: 'X', time: T0 + 3_600_000, rate: 0.0001 }, { coin: 'X', time: T0 + 7_200_000, rate: 0.0001 }], until: T0 + 7_300_000, fundThrough: T0 + 3_600_000, prices: { X: 100 } })
  ok(near(late.state.positions[0].funding, -0.1) && late.state.fundedTo === T0 + 3_600_000, 'a short receives; an hour past `fundThrough` waits')
  ok(fundedThrough([{ coin: 'X', time: T0 + 3_600_000, rate: 0 }, { coin: 'Y', time: T0, rate: 0 }], ['X', 'Y'], T0 + 3_600_000 + 60_000, T0) === T0, 'an hour one market hasn’t published yet waits for it…')
  ok(fundedThrough([{ coin: 'X', time: T0 + 3_600_000, rate: 0 }], ['X', 'Y'], T0 + 3_600_000 + 20 * 60_000, T0) === T0 + 3_600_000, '…for 15 minutes at most')
  const opened = open(freshPaper(T0), true, 10, 100, 5, T0 + 3_700_000)
  ok(near(replay(opened, { bars: [], funding, until: T0 + 7_300_000, fundThrough: T0 + 7_200_000, prices: { X: 100 } }).state.positions[0].funding, -0.2), 'a position opened after an hour doesn’t pay for it')
}

console.log('catching up after a gap (candles)')
{
  const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ coin: 'X', t, ms: 60_000, o, h, l, c })
  // Long 1 at 100 (10×, liquidation ≈ 92.31) with a stop at 96 and a take-profit at 110; gone for three minutes.
  let s = open(freshPaper(T0), true, 1, 100, 10)
  s = setTpSl(s, 'X', 110, 96, T0, noFees)
  const away = [bar(T0 + 60_000, 100, 101, 99, 100.5), bar(T0 + 120_000, 100.5, 111, 95, 108), bar(T0 + 180_000, 108, 109, 90, 91)]
  const r = replay(s, { bars: away, funding: [], until: T0 + 240_000, fundThrough: T0 })
  ok(r.events.length === 1 && r.events[0].kind === 'triggered' && (r.events[0] as { order: { kind: string } }).order.kind === 'sl', 'a rising bar that dipped to 95 and spiked to 111: its low comes first, so the stop fires')
  ok(near(r.state.fills[0].px, 96) && r.state.positions.length === 0 && r.state.checked === T0 + 240_000, 'at 96, and the account is checked to the end of the gap')
  const falling = [bar(T0 + 60_000, 100, 111, 95, 96.5)]
  const f = replay(s, { bars: falling, funding: [], until: T0 + 120_000, fundThrough: T0 })
  ok((f.events[0] as { order: { kind: string } }).order.kind === 'tp' && near(f.state.fills[0].px, 110), 'a falling bar visits its high first: the take-profit at 110 fires')
  const placedLater = setTpSl(open(freshPaper(T0), true, 1, 100, 10), 'X', null, 96, T0 + 90_000, noFees)
  const early = replay(placedLater, { bars: [bar(T0 + 60_000, 100, 101, 94, 100)], funding: [], until: T0 + 120_000, fundThrough: T0 })
  ok(early.events.length === 0, 'a stop set halfway through a bar isn’t fired by that bar’s earlier low')
  const gapDown = replay(s, { bars: [bar(T0 + 60_000, 100, 100.2, 99.8, 100), bar(T0 + 120_000, 93, 93.5, 92.8, 93.2)], funding: [], until: T0 + 180_000, fundThrough: T0 })
  ok(near(gapDown.state.fills[0].px, 93), 'a gap down past the stop fills it at the price after the gap, 93')
  const liq = replay(open(freshPaper(T0), true, 1, 100, 10), { bars: [bar(T0 + 60_000, 100, 100, 90, 95)], funding: [], until: T0 + 120_000, fundThrough: T0 })
  ok(liq.events[0]?.kind === 'liquidated', 'with no stop, a bar through the liquidation price liquidates it')
  ok(intervalFor(10 * 60_000)[0] === '1m' && intervalFor(5 * 86_400_000)[0] === '5m' && intervalFor(400 * 86_400_000)[0] === '4h' && intervalFor(1_000 * 86_400_000)[0] === '1d', 'gaps use the finest candles that fit one request (1m, 5m, … 1d)')
}

console.log('what it refuses')
{
  const s = freshPaper(T0)
  ok(refused(() => placeMarket(s, { coin: 'X', isBuy: true, sz: 0.05, lev: 5, maxLev: 20, reduceOnly: false, slippage: 0.03, mid: 100, book, time: T0, fees }), /\$10/), 'under $10')
  ok(refused(() => placeMarket(s, { coin: 'X', isBuy: true, sz: 3, lev: 5, maxLev: 20, reduceOnly: false, slippage: 0.01, mid: 100, book, time: T0, fees }), /max price move/), 'a fill past the max price move (3 reaches 102, over 1%)')
  ok(refused(() => placeMarket(s, { coin: 'X', isBuy: true, sz: 9, lev: 5, maxLev: 20, reduceOnly: false, slippage: 0.5, mid: 100, book, time: T0, fees }), /deep enough/), 'more than the book holds')
  ok(refused(() => placeMarket(s, { coin: 'X', isBuy: true, sz: 200, lev: 1, maxLev: 20, reduceOnly: false, slippage: 0.05, mid: 100, book: { bids: [], asks: [{ px: 100, sz: 1e6 }] }, time: T0, fees }), /Not enough paper/), 'more than the account holds ($20,000 at 1×)')
  ok(refused(() => placeMarket(s, { coin: 'X', isBuy: true, sz: 1, lev: 5, maxLev: 20, reduceOnly: false, slippage: 0.03, mid: 0, book, time: T0, fees }), /no price/), 'no price')
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall paper-trading checks passed')
