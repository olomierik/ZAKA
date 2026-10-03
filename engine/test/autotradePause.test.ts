// Autotrade paused (2026-10-03, owner: the platform moves to spot and futures trading; "the auto trade functionality
// will have to be paused for now"): bots open no new trades, open ones are still managed and sold.
import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config'
import { PaperAccounts, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import { STRATEGIES } from '../src/trading/paper'

const T = '0x' + 'b7'.repeat(20)
const now = Date.UTC(2026, 9, 3, 8)
const signal = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T, symbol: 'C', launchpad: 'ARGUS', price: 1, strategy: 'snipe', roundTripPct: 2, liquidityUsd: 100_000, ...o })

describe('Autotrade paused', () => {
  test('paused by default; AUTOTRADE_PAUSED=off resumes it', () => {
    const saved = process.env.AUTOTRADE_PAUSED
    try {
      delete process.env.AUTOTRADE_PAUSED
      expect(loadConfig().autotradePaused).toBe(true)
      process.env.AUTOTRADE_PAUSED = 'off'
      expect(loadConfig().autotradePaused).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.AUTOTRADE_PAUSED; else process.env.AUTOTRADE_PAUSED = saved
    }
  })
  test('a running bot opens nothing and says why; a trade it already held still closes at its take-profit', () => {
    const accts = new PaperAccounts({ speed: null, store: new MemoryBotStore(), priceOf: () => 1, params: s => STRATEGIES[s] })
    const { account: a } = accts.create(now, { name: 'Paused One', strategies: ['snipe'] }) as { account: PaperAccount }
    accts.act(a, { action: 'deposit', amount: 100 }, now)
    accts.act(a, { action: 'start' }, now)
    accts.onSignal(signal(), now) // before the pause
    expect(a.positions).toHaveLength(1)
    Object.assign(accts, { paused: true })
    accts.onSignal(signal({ id: 's2', token: '0x' + 'c8'.repeat(20) }), now + 1_000)
    expect(a.positions).toHaveLength(1)
    expect(a.skips[0].text).toMatch(/Autotrade is paused/)
    accts.onPrice(T, 1.5, now + 2_000, false, true) // far past the take-profit
    expect(a.positions[0].status === 'closed' || (a.positions[0].remaining ?? 0) < (a.positions[0].qty ?? 0)).toBe(true)
  })
})
