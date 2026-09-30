// Signal rules (signals/rules.ts) and paper trading (trading/paper.ts).
import { describe, expect, test } from 'bun:test'
import { computeFlow, type TapeTrade } from '../src/intel/flow'
import { PricePath, RULES, secondLegReady, snipeReady } from '../src/signals/rules'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, stats, STRATEGIES, type Position } from '../src/trading/paper'

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const T = (o: Partial<TapeTrade>): TapeTrade => ({ block: 100, ts: 0, wallet: A(1), side: 'BUY', usd: 60, tokens: 1_000, price: 0.01, ...o })

describe('snipe rule', () => {
  const buys = Array.from({ length: 10 }, (_, i) => T({ wallet: A(i + 1), block: 110 + i, price: 0.01 + i * 0.001 }))
  const f = computeFlow(buys, { launchBlock: 100, creator: null, supply: 1e9 })
  test('ten independent buyers, $600 in, rising, early: ready', () => {
    const r = snipeReady(f, 90)
    expect(r.ok).toBe(true)
    expect(r.reasons.some(x => x.startsWith('✗'))).toBe(false)
  })
  test('too early, too late, too few buyers', () => {
    expect(snipeReady(f, 5).ok).toBe(false)
    expect(snipeReady(f, 900).ok).toBe(false)
    expect(snipeReady(computeFlow(buys.slice(0, 5), { launchBlock: 100, creator: null, supply: 1e9 }), 90).ok).toBe(false)
  })
  test('one wallet doing most of the buying', () => {
    const whale = computeFlow([...buys, T({ wallet: A(99), usd: 5_000, block: 130, price: 0.019 })], { launchBlock: 100, creator: null, supply: 1e9 })
    expect(snipeReady(whale, 90).reasons.some(x => x.includes('one buyer'))).toBe(true)
  })
  test('already ran 5× and more', () => {
    const late = computeFlow([...buys, T({ wallet: A(50), price: 0.06, block: 140 })], { launchBlock: 100, creator: null, supply: 1e9 })
    expect(snipeReady(late, 90).ok).toBe(false)
  })
})

describe('second-leg rule', () => {
  const t0 = Date.UTC(2026, 8, 30, 0, 0)
  const at = (min: number) => t0 + min * 60_000
  // $0.001 → peak $0.02 (20×) → bottom $0.006 (−70%) → higher lows and a bounce with buying.
  const path = () => {
    const p = new PricePath(t0)
    p.add(at(0), 0.001, 'BUY', 50)
    p.add(at(30), 0.02, 'BUY', 500)
    p.add(at(60), 0.006, 'SELL', 400)
    for (let m = 61; m <= 80; m++) p.add(at(m), 0.0068 + (m - 61) * 0.0001, m % 3 ? 'BUY' : 'SELL', m % 3 ? 40 : 10)
    return p
  }
  test('ran 20×, fell 70%, held a higher low, bouncing on buys: ready', () => {
    const r = secondLegReady(path(), at(80))
    expect(r.reasons.filter(x => x.startsWith('✗'))).toEqual([])
    expect(r.ok).toBe(true)
  })
  test('not enough of a run', () => {
    const p = new PricePath(t0)
    p.add(at(0), 0.01, 'BUY', 50); p.add(at(10), 0.05, 'BUY', 50); p.add(at(20), 0.02, 'SELL', 50)
    expect(secondLegReady(p, at(40)).ok).toBe(false)
  })
  test('still falling: no higher low', () => {
    const p = path()
    p.add(at(81), 0.0055, 'SELL', 300) // a new low
    expect(secondLegReady(p, at(81)).ok).toBe(false)
  })
  test('too old', () => {
    expect(secondLegReady(path(), at(RULES.secondLeg.maxAgeHours * 60 + 1)).ok).toBe(false)
  })
})

describe('paper trading', () => {
  const now = Date.UTC(2026, 8, 30, 12)
  const open = (price = 1, cost = 0.02) => openPosition({ id: 'p', strategy: 'snipe', token: A(1), symbol: 'C', launchpad: 'Peach', signalId: 's', price, cost, now })

  test('costs: half the measured round trip plus impact', () => {
    expect(costPerSide(2, 25, 10_000)).toBeCloseTo(0.01 + 0.005, 6)
    expect(costPerSide(10, 25, 5_000)).toBeCloseTo(0.05 + 0.01, 6)
    expect(costPerSide(null, 25, null)).toBeCloseTo(0.02 + 0.02, 6)
  })
  test('entry pays the cost', () => {
    const p = open(1, 0.02)
    expect(p.entryPrice).toBeCloseTo(1.02, 9)
    expect(p.qty).toBeCloseTo(25 / 1.02, 9)
  })
  test('stop loss at −35%', () => {
    const p = open()
    expect(onPrice(p, 0.7, now + 1)).toEqual([])
    const f = onPrice(p, 0.64, now + 2)
    expect(f[0].reason).toBe('stop')
    expect(p.status).toBe('closed')
    expect(p.pnlUsd!).toBeLessThan(-8)
  })
  test('half at 2×, then trail 35% under the peak', () => {
    const p = open()
    expect(onPrice(p, 2.1, now + 1)[0].reason).toBe('tp1')
    expect(p.remaining).toBeCloseTo(p.qty / 2, 9)
    onPrice(p, 4, now + 2)
    expect(onPrice(p, 2.7, now + 3)).toEqual([]) // 32.5% under the peak: holds
    expect(onPrice(p, 2.59, now + 4)[0].reason).toBe('trail')
    expect(p.pnlUsd!).toBeGreaterThan(25) // sold half near 2×, half near 2.6×
  })
  test('time stop after 45 minutes when not up 10%', () => {
    const p = open()
    expect(onPrice(p, 1.05, now + 44 * 60_000)).toEqual([])
    expect(onPrice(p, 1.05, now + 46 * 60_000)[0].reason).toBe('time')
  })
  test('a safety failure closes it', () => {
    const p = open()
    expect(closeNow(p, 1.2, now + 1, 'safety')[0].reason).toBe('safety')
    expect(p.status).toBe('closed')
  })
  test('stats: win rate, averages, profit factor, drawdown', () => {
    const mk = (pnl: number, t: number) => ({ ...open(), status: 'closed', closedAt: now + t, pnlUsd: pnl }) as Position
    const s = stats([mk(20, 1), mk(-10, 2), mk(-10, 3), mk(30, 4), { ...open() }])
    expect(s).toMatchObject({ closed: 4, open: 1, wins: 2, losses: 2, winRate: 0.5, avgWinUsd: 25, avgLossUsd: -10, profitFactor: 2.5, expectancyUsd: 7.5, totalPnlUsd: 30, maxDrawdownUsd: 20 })
  })
  test('risk: max open, cooldown per coin, daily loss limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...open(), token: A(i + 10) }))
    expect(canOpen(many, A(99), now).ok).toBe(false)
    const recent = [{ ...open(), status: 'closed', closedAt: now - 60_000, pnlUsd: 5 } as Position]
    expect(canOpen(recent, A(1), now).why).toMatch(/recently/)
    const lost = [{ ...open(), token: A(7), status: 'closed', closedAt: now - 1, pnlUsd: -120 } as Position]
    expect(canOpen(lost, A(2), now).why).toMatch(/limit/)
    expect(canOpen([], A(2), now).ok).toBe(true)
  })
  test('the default snipe size and exits are what the strategy says', () => {
    expect(STRATEGIES.snipe).toMatchObject({ sizeUsd: 25, stopLoss: 0.65, tp1Multiple: 2 })
  })
})
