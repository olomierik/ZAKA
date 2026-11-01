import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/polymarket-updown.json'
import { fairUp, tcdf4, unitT4, kelly } from '../src/updown/fair'
import { SpotModel } from '../src/updown/feeds'
import { Books, parsePrice, parseWindow } from '../src/updown/markets'
import { RULES, decide, exitDecision, fillFak, sellFak, sizeUsd } from '../src/updown/strategy'
import { PaperBook, freshPaper, heldShares } from '../src/updown/paper'
import { UpdownService, TAKER_DELAY_MS } from '../src/updown/service'
import { takerFee, updownSlug } from '../../api/_updownProtocol'

describe('fair value', () => {
  test('Student-t(4) CDF: symmetric, its density at 0, the tails', () => {
    expect(tcdf4(0)).toBe(0.5)
    expect(tcdf4(1) + tcdf4(-1)).toBeCloseTo(1, 12)
    expect((tcdf4(1e-4) - tcdf4(-1e-4)) / 2e-4).toBeCloseTo(0.375, 4)
    expect(tcdf4(2.132)).toBeCloseTo(0.95, 3) // the t table's 95% point for 4 degrees of freedom
    expect(unitT4(10)).toBeGreaterThan(0.999)
  })

  test('at the price to beat with time left, about even; ahead means more likely', () => {
    const base = { open: 77_000, sigma: 1e-4, basisSd: 1.5e-4 }
    expect(fairUp({ ...base, now: 77_000, secondsLeft: 600 })).toBeCloseTo(0.5, 6)
    const ahead = fairUp({ ...base, now: 77_000 * 1.0013, secondsLeft: 600 })
    expect(ahead).toBeGreaterThan(0.6)
    expect(fairUp({ ...base, now: 77_000 / 1.0013, secondsLeft: 600 })).toBeCloseTo(1 - ahead, 9)
    // The same lead is worth more with less time left.
    expect(fairUp({ ...base, now: 77_000 * 1.0013, secondsLeft: 120 })).toBeGreaterThan(ahead)
  })

  test('the last minute: an observed TWAP well above the open locks Up in, even if the price just dipped below', () => {
    const p = fairUp({ open: 77_000, now: 76_990, secondsLeft: 8, sigma: 1e-4, observedAvg: 77_120, basisSd: 1.5e-4 })
    expect(p).toBeGreaterThan(0.97)
    // A spot-only model would call it Down.
    expect(fairUp({ open: 77_000, now: 76_990, secondsLeft: 8, sigma: 1e-4, basisSd: 1.5e-4 })).toBeLessThan(0.5)
  })

  test('Kelly: nothing without an edge', () => {
    expect(kelly(0.5, 0.52)).toBe(0)
    expect(kelly(0.7, 0.5)).toBeCloseTo(0.4, 9)
  })
})

describe('the Chainlink estimate', () => {
  test('a source is used only once its basis is learned from two prices to beat', () => {
    const m = new SpotModel(['coinbase', 'binance'])
    const t0 = 1_800_000_000
    const feed = (from: number, to: number, cb: number, bn: number) => { for (let s = from; s < to; s++) { m.onTick('coinbase', cb, s * 1000); m.onTick('binance', bn, s * 1000); m.tick(s * 1000 + 999) } }
    feed(t0 - 60, t0, 77_000, 77_154) // Binance's USDT price ~20 bp over USD
    expect(m.estimate(t0 * 1000)).toBeNull()
    m.learnBasis(t0, 77_000)
    expect(m.estimate(t0 * 1000)).toBeNull() // one observation isn't enough
    feed(t0 + 240, t0 + 300, 77_050, 77_204)
    m.learnBasis(t0 + 300, 77_050)
    const e = m.estimate((t0 + 300) * 1000 - 500)!
    expect(e.sources).toBe(2)
    expect(e.price).toBeCloseTo(77_050, 0)
    expect(e.spreadBp).toBeLessThan(1)
  })

  test('a stale source drops out', () => {
    const m = new SpotModel(['coinbase'])
    for (let s = 0; s < 60; s++) m.onTick('coinbase', 100, s * 1000)
    m.learnBasis(60, 100); m.learnBasis(60, 100)
    expect(m.estimate(59_500)).not.toBeNull()
    expect(m.estimate(70_000)).toBeNull()
  })
})

describe('Polymarket', () => {
  const ev = (fixture as { event: { markets: { slug: string }[] } }).event
  const slug = ev.markets[0].slug
  const start = Number(slug.split('-').pop())

  test('a recorded BTC 15m market parses, with its fee schedule and TWAP', () => {
    const w = parseWindow('15m', start, ev)
    if ('error' in w) throw new Error(w.error)
    expect(w.end - w.start).toBe(900)
    expect(w.upToken).not.toBe(w.downToken)
    expect(w.feeRate).toBe(0.07)
    expect(w.twapSec).toBe(60)
    expect(w.tick).toBe(0.01)
    expect(w.minSize).toBe(5)
  })

  test('anything unrecognised isn’t traded', () => {
    const m = ev.markets[0] as Record<string, unknown>
    const with_ = (patch: Record<string, unknown>) => parseWindow('15m', start, { markets: [{ ...m, ...patch }] })
    expect('error' in with_({ outcomes: '["Yes","No"]' })).toBe(true)
    expect('error' in with_({ feeSchedule: { rate: 0.9, exponent: 1, takerOnly: true } })).toBe(true)
    expect('error' in with_({ cryptoMarketConfig: { asset: 'eth', twapEnabled: true } })).toBe(true)
    expect('error' in parseWindow('5m', start, ev)).toBe(true) // another market's slug
  })

  test('the price to beat: the live spot fallback isn’t taken for it', () => {
    expect(parsePrice({ openPrice: 77664.39, closePrice: null, completed: false })).toEqual({ open: 77664.39, close: null, completed: false })
    expect(parsePrice({ openPrice: 77742.02, closePrice: 77778.01, completed: false, incomplete: true })).toBeNull()
    expect(parsePrice({ openPrice: 77602.7, closePrice: 77664.4, completed: true })).toEqual({ open: 77602.7, close: 77664.4, completed: true })
    expect(parsePrice({ openPrice: 0 })).toBeNull()
  })

  test('recorded book messages build each token’s book, asks cheapest first', () => {
    const b = new Books()
    for (const m of (fixture as { ws: unknown[] }).ws) b.apply(m, Date.now())
    const tokens = JSON.parse((ev.markets[0] as unknown as { clobTokenIds: string }).clobTokenIds) as string[]
    for (const t of tokens) {
      expect(b.has(t)).toBe(true)
      const asks = b.askLevels(t)
      for (let i = 1; i < asks.length; i++) expect(asks[i].price).toBeGreaterThan(asks[i - 1].price)
    }
  })

  test('a price change at size 0 removes the level', () => {
    const b = new Books()
    b.apply({ event_type: 'book', asset_id: 'x', bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.45', size: '10' }, { price: '0.5', size: '5' }] }, 1)
    b.apply({ event_type: 'price_change', price_changes: [{ asset_id: 'x', price: '0.45', size: '0', side: 'SELL' }] }, 2)
    expect(b.bestAsk('x')).toEqual({ price: 0.5, size: 5 })
    expect(b.bestBid('x')).toBe(0.4)
  })
})

describe('the strategy', () => {
  const base = { secondsLeft: 400, elapsed: 200, feeRate: 0.07, feeExponent: 1 }

  test('lane A: buys a cheap ask the model beats by the margin, and takes only levels that still clear it', () => {
    const d = decide({ ...base, side: 'up', p: 0.72, asks: [{ price: 0.55 - 0.15, size: 20 }, { price: 0.5, size: 100 }, { price: 0.62, size: 100 }] })
    if (!('lane' in d)) throw new Error(d.why)
    expect(d.lane).toBe('A')
    expect(d.worst).toBe(0.5) // 0.72 − (0.5 + fee 0.0175) ≥ 0.15? no: 0.2025 ≥ 0.15 yes; 0.62 isn't
  })

  test('the 40–60¢ band needs the wider margin', () => {
    expect('why' in decide({ ...base, side: 'up', p: 0.62, asks: [{ price: 0.5, size: 100 }] })).toBe(true)
    expect('lane' in decide({ ...base, side: 'up', p: 0.48, asks: [{ price: 0.35, size: 100 }] })).toBe(true)
  })

  test('lane A leaves longshots and near-certainties alone', () => {
    expect(decide({ ...base, side: 'up', p: 0.3, asks: [{ price: 0.06, size: 100 }] })).toEqual({ why: 'mid-window, ask outside 15–85¢' })
    expect('why' in decide({ ...base, side: 'up', p: 0.99, asks: [{ price: 0.88, size: 100 }] })).toBe(true)
  })

  test('no lane A in the first 20 s or the last minute; lane B only when nearly decided', () => {
    expect(decide({ ...base, elapsed: 5, side: 'up', p: 0.9, asks: [{ price: 0.5, size: 100 }] })).toEqual({ why: 'window just opened' })
    expect(decide({ ...base, secondsLeft: 40, side: 'up', p: 0.9, asks: [{ price: 0.5, size: 100 }] })).toEqual({ why: 'last minute, not decided' })
    const b = decide({ ...base, secondsLeft: 40, side: 'up', p: 0.985, asks: [{ price: 0.94, size: 100 }] })
    expect('lane' in b && b.lane).toBe('B')
    expect('why' in decide({ ...base, secondsLeft: 40, side: 'up', p: 0.985, asks: [{ price: 0.97, size: 100 }] })).toBe(true)
    expect(decide({ ...base, secondsLeft: 2, side: 'up', p: 0.999, asks: [{ price: 0.9, size: 100 }] })).toEqual({ why: 'closing' })
  })

  test('fill-and-kill takes levels up to the worst price and the dollars', () => {
    const f = fillFak([{ price: 0.4, size: 10 }, { price: 0.45, size: 100 }, { price: 0.6, size: 100 }], 0.45, 20, 0.07)
    expect(f.spent + f.fee).toBeCloseTo(20, 9)
    const first = 10 * (0.4 + takerFee(0.4, 0.07))
    expect(f.shares).toBeCloseTo(10 + (20 - first) / (0.45 + takerFee(0.45, 0.07)), 6)
    expect(fillFak([{ price: 0.5, size: 100 }], 0.45, 20, 0.07).shares).toBe(0)
  })

  test('exit: a 15m position is sold once the bid, after the fee, pays the model’s value', () => {
    const base = { dur: '15m' as const, costPerShare: 0.52, secondsLeft: 400, feeRate: 0.07, feeExponent: 1 }
    // Model 70%: a 72¢ bid nets 72 − 1.4 = 70.6¢, enough; the 69¢ level isn't.
    const d = exitDecision({ ...base, p: 0.7, bids: [{ price: 0.72, size: 10 }, { price: 0.71, size: 10 }, { price: 0.69, size: 50 }] })
    expect(d).toEqual({ why: 'scalp', floor: 0.72 })
    expect(exitDecision({ ...base, p: 0.7, bids: [{ price: 0.71, size: 10 }] })).toEqual({ hold: 'holding' })
  })

  test('exit: a 5m position waits for a 5¢ overpayment', () => {
    const base = { dur: '5m' as const, costPerShare: 0.52, secondsLeft: 200, feeRate: 0.07, feeExponent: 1 }
    expect(exitDecision({ ...base, p: 0.7, bids: [{ price: 0.72, size: 10 }] })).toEqual({ hold: 'holding' })
    expect('why' in exitDecision({ ...base, p: 0.7, bids: [{ price: 0.77, size: 10 }] })).toBe(true)
  })

  test('exit: the stop, once the model says the side is worth 15¢ under its cost; nothing in the last seconds', () => {
    const base = { dur: '5m' as const, costPerShare: 0.52, feeRate: 0.07, feeExponent: 1, bids: [{ price: 0.4, size: 10 }] }
    expect(exitDecision({ ...base, p: 0.38, secondsLeft: 200 })).toEqual({ hold: 'holding' })
    expect(exitDecision({ ...base, p: 0.36, secondsLeft: 200 })).toEqual({ why: 'stop', floor: 0.37 })
    expect(exitDecision({ ...base, p: 0.1, secondsLeft: 2 })).toEqual({ hold: 'closing' })
    expect(exitDecision({ ...base, p: 0.1, secondsLeft: 200, bids: [] })).toEqual({ hold: 'no bids' })
  })

  test('a sale takes the bids down to the floor, each share paying its price less the fee', () => {
    const f = sellFak([{ price: 0.7, size: 10 }, { price: 0.69, size: 10 }, { price: 0.6, size: 100 }], 0.69, 15, 0.07)
    expect(f.shares).toBe(15)
    expect(f.gross).toBeCloseTo(10 * 0.7 + 5 * 0.69, 9)
    expect(f.proceeds).toBeCloseTo(f.gross - 10 * takerFee(0.7, 0.07) - 5 * takerFee(0.69, 0.07), 9)
    expect(sellFak([{ price: 0.6, size: 100 }], 0.69, 15, 0.07).shares).toBe(0)
  })

  test('size: fractional Kelly, within the order and window caps', () => {
    expect(sizeUsd(0.75, 0.5, 0.07, 1_000, 100)).toBe(RULES.orderUsd)
    expect(sizeUsd(0.75, 0.5, 0.07, 1_000, 7)).toBe(7)
    expect(sizeUsd(0.5, 0.5, 0.07, 1_000, 100)).toBe(0)
  })
})

describe('the paper book', () => {
  const t = (over: Partial<Parameters<PaperBook['record']>[0]> = {}) => ({ slug: 's1', dur: '5m' as const, lane: 'A' as const, side: 'up' as const, at: 0, filledAt: Date.UTC(2026, 10, 1, 12), shares: 50, price: 0.4, fee: 0.84, cost: 20.84, model: 0.6, edge: 0.18, secondsLeft: 200, ...over })

  test('settles at Polymarket’s result: a win pays $1 a share, a loss nothing', () => {
    const now = Date.UTC(2026, 10, 1, 12)
    const p = new PaperBook(freshPaper(now))
    p.record(t()); p.record(t({ side: 'down', shares: 30, cost: 18.4, fee: 0.4 }))
    const out = p.settle('s1', true)
    expect(out.map(x => x.result)).toEqual(['won', 'lost'])
    expect(out[0].pnl).toBeCloseTo(50 - 20.84, 6)
    expect(out[1].pnl).toBeCloseTo(-18.4, 6)
    expect(p.s.bankroll).toBeCloseTo(1_000 - 20.84 - 18.4 + 50, 6)
    const st = p.stats(now)
    expect(st.won).toBe(1); expect(st.lost).toBe(1); expect(st.pnl).toBeCloseTo(50 - 20.84 - 18.4, 6)
  })

  test('the window cap, the cooldown and the day’s loss stop (open positions count as lost)', () => {
    const now = Date.UTC(2026, 10, 1, 12)
    const p = new PaperBook(freshPaper(now))
    p.sending('s1', now)
    expect(p.blocked('s1', now + 1_000)).toContain('cooling down')
    expect(p.blocked('s1', now + RULES.cooldownMs + 1)).toBeNull()
    p.record(t({ cost: RULES.windowUsd }))
    expect(p.blocked('s1', now + RULES.cooldownMs + 1)).toContain('cap')
    p.record(t({ slug: 's2', cost: RULES.dailyLossUsd }))
    expect(p.blocked('s3', now + 1)).toContain('loss stop')
  })

  test('a sale before the result: part sold, the rest settles; sold out, it closes and frees the window’s cap', () => {
    const now = Date.UTC(2026, 10, 1, 12)
    const p = new PaperBook(freshPaper(now))
    const a = p.record(t())
    p.sell(a.id, { shares: 20, proceeds: 14, fee: 0.3 }, 'scalp', now + 1)
    expect(heldShares(a)).toBe(30)
    expect(a.result).toBe('open')
    expect(p.s.bankroll).toBeCloseTo(1_000 - 20.84 + 14, 6)
    p.settle('s1', false) // the rest loses
    expect(a.pnl).toBeCloseTo(14 - 20.84, 6)
    expect(a.result).toBe('lost')
    const b = p.record(t({ slug: 's2', cost: RULES.windowUsd }))
    expect(p.blocked('s2', now + RULES.cooldownMs + 1)).toContain('cap')
    p.sell(b.id, { shares: 50, proceeds: 120, fee: 1 }, 'scalp', now + 2)
    expect(b.result).toBe('won')
    expect(b.pnl).toBeCloseTo(120 - RULES.windowUsd, 6)
    expect(p.blocked('s2', now + RULES.cooldownMs + 1)).toBeNull()
    expect(p.sell(b.id, { shares: 1, proceeds: 1, fee: 0 }, 'scalp', now + 3)).toBeNull() // already closed
    const st = p.stats(now)
    expect(st.exits).toEqual({ scalp: 1, stop: 0 })
    expect(st.fees).toBeCloseTo(0.84 * 2 + 0.3 + 1, 6)
  })

  test('Brier: the model and the market scored on the same snapshots', () => {
    const p = new PaperBook(freshPaper(0))
    p.snapshot('w', 0.8, 0.6); p.snapshot('w', 0.9, 0.7)
    p.settle('w', true)
    const st = p.stats(0)
    expect(st.brier.model).toBeCloseTo((0.04 + 0.01) / 2, 9)
    expect(st.brier.market).toBeCloseTo((0.16 + 0.09) / 2, 9)
    expect(st.windowsSeen).toBe(1)
  })

  test('readiness: nothing is offered for real money until the whole bar is met', () => {
    const p = new PaperBook(freshPaper(Date.UTC(2026, 10, 1)))
    const r = p.readiness(Date.UTC(2026, 10, 2))
    expect(r.ready).toBe(false)
    expect(r.why.length).toBe(4)
  })
})

// A whole window, end to end: the service finds it on Gamma, reads the price to beat, prices it from the exchange
// feeds, takes a stale Up ask after the delay, and settles it at Polymarket's result.
describe('the service', () => {
  /** These tests are about the trading mechanics: the learner trusts the model fully (learn.test.ts covers learning). */
  const trustModel = (svc: UpdownService) => { for (const k of ['5m:mid', '5m:end', '15m:mid', '15m:end']) svc.learn.s.calib[k] = { s1: 1e9, s2: 1e9, n: 1e12 } }
  class FakeWs {
    static all: FakeWs[] = []
    onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null
    sent: string[] = []
    constructor(public url: string) { FakeWs.all.push(this); queueMicrotask(() => this.onopen?.()) }
    send(d: string) { this.sent.push(d) }
    close() { /* nothing */ }
    emit(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }) }
  }

  for (const skip of [false, true]) test(skip ? 'a kind it learned to skip: filled and settled as a shadow trade, outside the balance' : 'finds, prices, trades on paper after the delay, and settles', async () => {
    const start = 1_900_000_200 // a multiple of 300
    let now = (start - 120) * 1000
    const ev = structuredClone((fixture as { event: { markets: Record<string, unknown>[] } }).event)
    const m = ev.markets[0]
    m.slug = updownSlug('5m', start)
    m.cryptoMarketConfig = { id: 'btc-5m-twap-60', asset: 'btc', duration: '5m', twapEnabled: true, twapLookbackSeconds: 60 }
    m.clobTokenIds = JSON.stringify(['UP', 'DOWN'])
    let completed = false
    const f = async (url: string) => {
      if (url.includes('gamma-api') && url.includes(`btc-updown-5m-${start}`)) return Response.json([ev])
      if (url.includes('gamma-api')) return Response.json([])
      if (url.includes('crypto-price') && url.includes('fiveminute')) {
        if (now < start * 1000) return Response.json({})
        return Response.json(completed ? { openPrice: 77_000, closePrice: 77_200, completed: true } : { openPrice: 77_000, closePrice: null, completed: false })
      }
      return Response.json({ blocked: false, country: 'IE' })
    }
    const settings = new Map<string, string>()
    const svc = new UpdownService({ store: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } }, fetch: f as never, Ws: FakeWs as never, now: () => now })
    trustModel(svc)
    // Feeds: Coinbase at the price to beat for the minute before the start (the basis), then 0.35% higher.
    const feed = (sec: number, px: number) => { svc.model.onTick('coinbase', px, sec * 1000); svc.model.tick(sec * 1000 + 999) }
    for (let s = start - 400; s < start; s++) feed(s, 77_000 + Math.sin(s) * 3)
    void svc.alignTick
    svc.model.learnBasis(start - 300, 77_000) // an earlier window's price to beat
    await svc.discover()
    expect(svc.status().windows.some(w => w.slug === updownSlug('5m', start))).toBe(true)
    now = (start + 5) * 1000
    await svc.prices()
    // The book: Up still offered at 50¢ though BTC has moved up.
    const book = FakeWs.all.filter(x => x.url.includes('ws-subscriptions-clob')).at(-1)!
    book.emit([{ event_type: 'book', asset_id: 'UP', timestamp: String(now), bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.5', size: '200' }] },
               { event_type: 'book', asset_id: 'DOWN', timestamp: String(now), bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.52', size: '200' }] }])
    // BTC sits at the price to beat while the market agrees (about 50%): the engine aligns its estimate with it.
    for (let s = start; s < start + 114; s++) { feed(s, 77_000 + Math.sin(s) * 0.5); now = s * 1000 + 999; svc.alignTick() }
    expect(svc.shiftN).toBeGreaterThanOrEqual(RULES.alignMin)
    expect(Math.abs(svc.shift)).toBeLessThan(5e-4)
    // Then it jumps 0.35% in a few seconds, and the book hasn't moved: a stale quote.
    for (let s = start + 114; s < start + 120; s++) feed(s, 77_270)
    now = (start + 120) * 1000
    book.emit({ event_type: 'last_trade_price', asset_id: 'UP', timestamp: String(now), price: '0.5' })
    const w = svc.status().windows.find(x => x.slug === updownSlug('5m', start))!
    expect(w.model!).toBeGreaterThan(0.8)
    expect(w.waiting).toBeNull()
    if (skip) svc.learn.s.blocked.fav = { since: now, trades: 20, roi: -0.3, pnl: -150 }
    svc.decideAll()
    expect(svc.paper.s.trades.length).toBe(0) // not before the delay
    await new Promise(r => setTimeout(r, 300 + TAKER_DELAY_MS + 100))
    expect(svc.paper.s.trades.length).toBe(1)
    const tr = svc.paper.s.trades[0]
    // What it knew when it bought: the raw model, the market's mid, how far BTC was above the price to beat.
    expect(tr.raw!).toBeGreaterThan(0.8); expect(tr.market).toBe(0.49); expect(tr.awayBp!).toBeCloseTo(35, 0)
    if (skip) {
      expect(tr.shadow).toBe('fav')
      expect(svc.paper.s.bankroll).toBe(1_000)
      expect(svc.status().windows.find(x => x.slug === updownSlug('5m', start))!.waiting).toBe('learned to skip this kind of trade')
      now = (start + 310) * 1000
      completed = true
      await svc.prices()
      expect(svc.paper.s.trades[0].result).toBe('won')
      expect(svc.paper.s.trades[0].lesson!.k).toContain('would have won')
      expect(svc.paper.s.bankroll).toBe(1_000)
      expect(svc.status().stats.shadow!.trades).toBe(1)
      await svc.save()
      expect(JSON.parse(settings.get('updown-paper')!).learn.blocked.fav).toBeDefined()
      svc.stop()
      return
    }
    expect(tr.side).toBe('up'); expect(tr.lane).toBe('A'); expect(tr.price).toBe(0.5)
    expect(tr.cost).toBeCloseTo(RULES.orderUsd, 0)
    svc.decideAll()
    expect(svc.paper.s.trades.length).toBe(1) // the cooldown
    expect(svc.paper.s.trades[0].sold ?? 0).toBe(0) // the bid (48¢) is far under the model's value: held
    now = (start + 310) * 1000
    completed = true
    await svc.prices()
    const done = svc.paper.s.trades[0]
    expect(done.result).toBe('won')
    expect(done.pnl!).toBeGreaterThan(0)
    await svc.save()
    expect(JSON.parse(settings.get('updown-paper')!).paper.trades.length).toBe(1)
    svc.stop()
  })

  test('a scalp: the 15m position is sold at the bid once the market pays its model value, before the result', async () => {
    const start = 1_900_000_800 // a multiple of 900
    let now = (start - 120) * 1000
    const ev = structuredClone((fixture as { event: { markets: Record<string, unknown>[] } }).event)
    const m = ev.markets[0]
    m.slug = updownSlug('15m', start)
    m.cryptoMarketConfig = { id: 'btc-15m-twap-60', asset: 'btc', duration: '15m', twapEnabled: true, twapLookbackSeconds: 60 }
    m.clobTokenIds = JSON.stringify(['UP3', 'DOWN3'])
    const f = async (url: string) => {
      if (url.includes('gamma-api') && url.includes(`btc-updown-15m-${start}`)) return Response.json([ev])
      if (url.includes('gamma-api')) return Response.json([])
      if (url.includes('crypto-price') && url.includes('fifteen')) return Response.json(now < start * 1000 ? {} : { openPrice: 77_000, closePrice: null, completed: false })
      return Response.json({})
    }
    const svc = new UpdownService({ store: { getSetting: async () => null, setSetting: async () => {} }, fetch: f as never, Ws: FakeWs as never, now: () => now })
    trustModel(svc)
    const feed = (sec: number, px: number) => { svc.model.onTick('coinbase', px, sec * 1000); svc.model.tick(sec * 1000 + 999) }
    for (let s = start - 400; s < start; s++) feed(s, 77_000 + Math.sin(s) * 3)
    svc.model.learnBasis(start - 300, 77_000)
    await svc.discover()
    now = (start + 5) * 1000
    await svc.prices()
    const book = FakeWs.all.filter(w => w.url.includes('ws-subscriptions-clob')).at(-1)!
    book.emit([{ event_type: 'book', asset_id: 'UP3', timestamp: String(now), bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.5', size: '200' }] },
               { event_type: 'book', asset_id: 'DOWN3', timestamp: String(now), bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.52', size: '200' }] }])
    for (let s = start; s < start + 114; s++) { feed(s, 77_000 + Math.sin(s) * 0.5); now = s * 1000 + 999; svc.alignTick() }
    for (let s = start + 114; s < start + 120; s++) feed(s, 77_400)
    now = (start + 120) * 1000
    book.emit({ event_type: 'last_trade_price', asset_id: 'UP3', timestamp: String(now), price: '0.5' })
    svc.decideAll()
    await new Promise(r => setTimeout(r, 300 + TAKER_DELAY_MS + 100))
    expect(svc.paper.s.trades.length).toBe(1)
    const tr = svc.paper.s.trades[0]
    const model = svc.status().windows.find(x => x.slug === updownSlug('15m', start))!.model!
    expect(model).toBeLessThan(0.98)
    // The market catches up: Up bid at 99¢.
    now += 1_000
    book.emit({ event_type: 'price_change', timestamp: String(now), price_changes: [{ asset_id: 'UP3', price: '0.99', size: '500', side: 'BUY' }] })
    svc.decideAll()
    expect(tr.sold ?? 0).toBe(0) // not before the delay
    await new Promise(r => setTimeout(r, 300 + TAKER_DELAY_MS + 100))
    expect(tr.exit).toBe('scalp')
    expect(heldShares(tr)).toBeLessThan(0.01)
    expect(tr.result).toBe('won')
    expect(tr.pnl!).toBeCloseTo(tr.shares * (0.99 - takerFee(0.99, 0.07)) - tr.cost, 2)
    expect(svc.status().stats.exits.scalp).toBe(1)
    svc.decideAll()
    await new Promise(r => setTimeout(r, 600))
    expect(svc.paper.s.trades.length).toBe(1) // the cooldown still holds new entries back
    svc.stop()
  })

  test('a gap the market already had (it knows something the model doesn’t) isn’t traded', async () => {
    const start = 1_900_000_500
    let now = (start - 120) * 1000
    const ev = structuredClone((fixture as { event: { markets: Record<string, unknown>[] } }).event)
    const m = ev.markets[0]
    m.slug = updownSlug('5m', start)
    m.cryptoMarketConfig = { id: 'btc-5m-twap-60', asset: 'btc', duration: '5m', twapEnabled: true, twapLookbackSeconds: 60 }
    m.clobTokenIds = JSON.stringify(['UP2', 'DOWN2'])
    const f = async (url: string) => {
      if (url.includes('gamma-api') && url.includes(`btc-updown-5m-${start}`)) return Response.json([ev])
      if (url.includes('gamma-api')) return Response.json([])
      if (url.includes('crypto-price')) return Response.json(now < start * 1000 ? {} : { openPrice: 77_000, closePrice: null, completed: false })
      return Response.json({})
    }
    const svc = new UpdownService({ store: { getSetting: async () => null, setSetting: async () => {} }, fetch: f as never, Ws: FakeWs as never, now: () => now })
    trustModel(svc)
    const feed = (sec: number, px: number) => { svc.model.onTick('coinbase', px, sec * 1000); svc.model.tick(sec * 1000 + 999) }
    for (let s = start - 400; s < start; s++) feed(s, 77_000 + Math.sin(s) * 3)
    svc.model.learnBasis(start - 300, 77_000)
    await svc.discover()
    now = (start + 5) * 1000
    await svc.prices()
    svc.shift = 0; svc.shiftN = RULES.alignMin // aligned earlier
    const book = FakeWs.all.filter(w => w.url.includes('ws-subscriptions-clob')).at(-1)!
    // BTC 0.35% up the whole time, and the market has priced Up at 20% all along.
    book.emit([{ event_type: 'book', asset_id: 'UP2', timestamp: String(now), bids: [{ price: '0.19', size: '100' }], asks: [{ price: '0.21', size: '200' }] },
               { event_type: 'book', asset_id: 'DOWN2', timestamp: String(now), bids: [{ price: '0.79', size: '100' }], asks: [{ price: '0.81', size: '200' }] }])
    for (let s = start; s < start + 120; s++) feed(s, 77_270)
    now = (start + 120) * 1000
    book.emit({ event_type: 'last_trade_price', asset_id: 'UP2', timestamp: String(now), price: '0.2' })
    svc.decideAll()
    await new Promise(r => setTimeout(r, 600))
    expect(svc.paper.s.trades.length).toBe(0)
    expect(svc.status().windows.find(x => x.slug === updownSlug('5m', start))!.waiting).toBe('model and market disagree')
    svc.stop()
  })
})
