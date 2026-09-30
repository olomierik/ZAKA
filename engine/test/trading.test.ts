// Signal rules (signals/rules.ts) and paper trading (trading/paper.ts).
import { describe, expect, test } from 'bun:test'
import { computeFlow, type TapeTrade } from '../src/intel/flow'
import { PricePath, RULES, secondLegReady, snipeReady } from '../src/signals/rules'
import { canOpen, closeNow, costPerSide, onPrice, openPosition, RISK, stats, STRATEGIES, type Position } from '../src/trading/paper'

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
    expect(snipeReady(computeFlow(buys.slice(0, 3), { launchBlock: 100, creator: null, supply: 1e9 }), 90).ok).toBe(false)
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
  test('stop loss at −10%', () => {
    const p = open()
    expect(onPrice(p, 0.91, now + 1)).toEqual([])
    const f = onPrice(p, 0.89, now + 2)
    expect(f[0].reason).toBe('stop')
    expect(p.status).toBe('closed')
    expect(p.pnlUsd!).toBeLessThan(-3)
  })
  test('half at +10%, then the rest trails 25% under the peak', () => {
    const p = open()
    expect(onPrice(p, 1.09, now + 1)).toEqual([])
    expect(onPrice(p, 1.11, now + 2)[0].reason).toBe('tp1')
    expect(p.remaining).toBeCloseTo(p.qty / 2, 9)
    expect(p.status).toBe('open')
    onPrice(p, 2, now + 3)
    expect(onPrice(p, 1.6, now + 4)).toEqual([]) // 20% under the peak: holds
    expect(onPrice(p, 1.49, now + 5)[0].reason).toBe('trail')
    expect(p.pnlUsd!).toBeGreaterThan(5) // half near +10%, half near +49%
  })
  test('once half is sold, the stop is at break-even after costs: the rest can\'t make it a loss', () => {
    const p = open(1, 0.02)
    onPrice(p, 1.11, now + 1)
    const even = 1.02 / 0.98 // paid 2% on the way in, 2% on the way out
    expect(onPrice(p, even + 0.005, now + 2)).toEqual([]) // above −10%, and above break-even: holds
    expect(onPrice(p, even - 0.001, now + 3)[0].reason).toBe('stop')
    expect(p.status).toBe('closed')
    expect(p.pnlUsd!).toBeGreaterThan(0)
  })
  test('without the take-profit, the stop stays at −10%', () => {
    const p = open()
    expect(onPrice(p, 0.95, now + 1)).toEqual([])
  })
  test('time stop after 3 minutes when not up 3%; never held past an hour', () => {
    const p = open()
    expect(onPrice(p, 1.02, now + 2 * 60_000)).toEqual([])
    expect(onPrice(p, 1.02, now + 3 * 60_000 + 1)[0].reason).toBe('time')
    const up = open()
    expect(onPrice(up, 1.05, now + 59 * 60_000)).toEqual([])
    expect(onPrice(up, 1.05, now + 60 * 60_000)[0].reason).toBe('time')
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
    expect(STRATEGIES.snipe).toMatchObject({ sizeUsd: 25, stopLoss: 0.9, tp1Multiple: 1.1, tp1SellPct: 0.5, trailFromPeak: 0.25, breakevenAfterTp1: true, maxHoldMin: 60 })
    expect(STRATEGIES['second-leg'].breakevenAfterTp1).toBeUndefined()
  })
})

describe('fast scalp: small, half at +10%, out fast', () => {
  const now = Date.UTC(2026, 8, 30, 12)
  const scalp = (price = 1) => openPosition({ id: 'p', strategy: 'scalp', token: A(1), symbol: 'C', launchpad: 'ARGUS', signalId: 's', price, cost: 0.02, now })
  const P = STRATEGIES.scalp

  test('a fifth of a snipe', () => {
    expect(scalp().sizeUsd).toBe(5)
    expect(P.sizeUsd).toBe(STRATEGIES.snipe.sizeUsd / 5)
  })
  test('sells half at +10%; the rest can\'t turn the trade into a loss', () => {
    const p = scalp()
    expect(onPrice(p, 1.09, now + 1, P)).toEqual([])
    const f = onPrice(p, 1.11, now + 2, P)
    expect(f.map(x => x.reason)).toEqual(['tp1'])
    expect(p.status).toBe('open')
    expect(p.remaining).toBeCloseTo(p.qty / 2, 9)
    expect(onPrice(p, 1.04, now + 3, P)[0].reason).toBe('stop') // under break-even after costs
    expect(p).toMatchObject({ status: 'closed', remaining: 0 })
    expect(p.pnlUsd!).toBeGreaterThan(0)
  })
  test('stop at −10%', () => {
    const p = scalp()
    expect(onPrice(p, 0.91, now + 1, P)).toEqual([])
    expect(onPrice(p, 0.89, now + 2, P)[0].reason).toBe('stop')
  })
  test('out after 3 minutes unless up 3%', () => {
    const p = scalp()
    expect(onPrice(p, 1.02, now + 2 * 60_000, P)).toEqual([])
    expect(onPrice(p, 1.02, now + 3 * 60_000 + 1, P)[0].reason).toBe('time')
    const up = scalp()
    expect(onPrice(up, 1.05, now + 4 * 60_000, P)).toEqual([])
  })
  test('never held past an hour', () => {
    const p = scalp()
    expect(onPrice(p, 1.05, now + 59 * 60_000, P)).toEqual([])
    expect(onPrice(p, 1.05, now + 60 * 60_000, P)[0].reason).toBe('time')
    expect(p.status).toBe('closed')
  })
  test('a position trades with its own exits when it has them (a visitor\'s learned tuning)', () => {
    const p = scalp()
    p.exits = { ...P, tp1Multiple: 1.08 }
    expect(onPrice(p, 1.09, now + 1, P)[0].reason).toBe('tp1')
  })
  test('scalps may come back to a coin after 30 minutes; other strategies after 6 hours', () => {
    const done = { ...scalp(), status: 'closed' as const, closedAt: now }
    expect(canOpen([done], done.token, now + 31 * 60_000, RISK, 'scalp').ok).toBe(true)
    expect(canOpen([done], done.token, now + 31 * 60_000, RISK, 'snipe').ok).toBe(false)
  })
  test('the creator selling closes it (the bot calls closeNow on their sale)', () => {
    expect(P.exitOnCreatorSell).toBe(true)
    expect(STRATEGIES.snipe.exitOnCreatorSell).toBe(true)
    expect(STRATEGIES['second-leg'].exitOnCreatorSell).toBeUndefined()
    const p = scalp()
    expect(closeNow(p, 0.3, now + 1, 'creator')[0].reason).toBe('creator')
    expect(p.pnlUsd!).toBeGreaterThan(-5) // at most the $5 it put in
  })
  test('at most 3 scalps open, within the 5 overall', () => {
    const scalps = Array.from({ length: 3 }, (_, i) => ({ ...scalp(), token: A(i + 10) }))
    expect(canOpen(scalps, A(99), now, RISK, 'scalp').why).toMatch(/scalps open/)
    expect(canOpen(scalps, A(99), now, RISK, 'snipe').ok).toBe(true)
  })
})
