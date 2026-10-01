// The bot end to end, with a stand-in engine: trades come in, the sweep and
// the momentum rule fire a fast scalp, a visitor's bot buys it at its own
// size, and a liquidity pull makes the rug guard close every position.
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo, ServerMessage, Trade } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { PaperAccounts, type PaperAccount } from '../src/bot/paperAccounts'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'
import { STRATEGIES } from '../src/trading/paper'

const T = '0x' + 'e7'.repeat(20)
const settle = () => new Promise(r => setTimeout(r, 25))

/** The bot, with its safety scan answered at once (the scan's own tests cover it). */
class TestBot extends Bot {
  verdict: SafetyReport['verdict'] = 'pass'
  override async report(token: string): Promise<SafetyReport> {
    return { token, launchpad: 'ARGUS', at: Date.now(), verdict: this.verdict, score: 88, checks: [{ id: 'holders', ok: this.verdict === 'pass', hard: false, risk: true, detail: 'top 10 hold 30%' }], template: null, honeypot: { verdict: 'ok', roundTripLossPct: 3 } as never }
  }
}

function setup(o: { liveSignals?: 'all' | 'proven' } = {}) {
  const launched = Date.now() - 20 * 60_000 // past the snipe window
  const meta: LaunchInfo = { token: T, name: 'Coin', symbol: 'COIN', decimals: 18, creator: '0x' + 'cc'.repeat(20), txHash: '0x', blockNumber: 1, timestamp: launched, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
  const st = new TokenState(T)
  Object.assign(st, { priceUsd: 1, mainPool: 'pool1', liquidityUsd: 20_000, supply: 1e9 })
  const engine = { metas: new Map([[T, meta]]), tokens: new Map([[T, st]]) } as unknown as MarketEngine
  const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
  const pools = { get: () => null } as unknown as PoolRegistry
  const store = new MemoryBotStore()
  const sent: ServerMessage[] = []
  const accounts = new PaperAccounts({ speed: null, store, priceOf: () => st.priceUsd, params: s => STRATEGIES[s] })
  const made = accounts.create(Date.now(), { name: 'Tester', strategies: ['scalp'] }) as { account: PaperAccount }
  accounts.act(made.account, { action: 'deposit', amount: 500 })
  accounts.act(made.account, { action: 'start' })
  const bot = new TestBot({ rpc, engine, pools, store, publish: (_t, m) => sent.push(m), mode: 'paper', accounts, speed: null, liveSignals: o.liveSignals })
  let i = 0
  /** A trade, as the engine would apply it: the coin's price and liquidity first, then the observers. */
  const trade = (o: { side?: 'BUY' | 'SELL'; price: number; usd?: number; liquidity?: number; wallet?: string; at?: number }) => {
    i++
    st.priceUsd = o.price
    if (o.liquidity !== undefined) st.liquidityUsd = o.liquidity
    const t: Trade = {
      tradeId: `0x${i}:0`, chain: 'ARC', token: T, pair: `${T}/usdc`, pool: 'pool1', quote: '0x3600000000000000000000000000000000000000', side: o.side ?? 'BUY',
      baseAmount: 100, quoteAmount: o.usd ?? 60, tokenAmount: 100, price: o.price, priceUsd: o.price, usdValue: o.usd ?? 60, wallet: o.wallet ?? `0x${String(i).padStart(40, '0')}`,
      txHash: `0x${i}`, blockNumber: 1_000 + i, logIndex: 0, timestamp: o.at ?? Date.now(), dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: o.liquidity ?? st.liquidityUsd,
    }
    bot.onTrade(t, { replay: false })
  }
  return { bot, st, sent, accounts, account: made.account, trade }
}

describe('the bot, end to end', () => {
  test('a momentum burst becomes a fast-scalp signal with the coin\'s numbers; a visitor\'s bot buys it at its own size', async () => {
    const { bot, sent, account, trade } = setup()
    const t0 = Date.now() - 80_000 // thirteen buyers in two minutes, the last few in the last 30 seconds
    for (let k = 0; k < 13; k++) trade({ price: 1 + k * 0.01, at: t0 + k * 6_000 })
    await settle()
    bot.sweep(Date.now() + 5_000) // every coin trading now is evaluated, not only on its own trades
    await settle()
    const sig = sent.find(m => m.t === 'SIGNAL')
    expect(sig?.t === 'SIGNAL' && sig.d).toMatchObject({ strategy: 'scalp', rule: 'momentum', features: { buyers: 13, score: 88, flags: [] } })
    const pos = account.positions[0]
    expect(pos).toMatchObject({ status: 'open', strategy: 'scalp', tuningVersion: 1 })
    // Sized from the bot's capital: 20% of its $500 on a tier-A signal, 10% on B (the first signals rank by score alone).
    // Ranked live-grade, but paper only until this kind of signal makes money at live speed (no replays yet): paper bots take it.
    expect(sig?.t === 'SIGNAL' && sig.d.quality).toMatchObject({ grade: 'paper', rank: null, liveSpeed: { trades: 0, ok: false } })
    expect(sig?.t === 'SIGNAL' && sig.d.reasons.join(' ')).toMatch(/not traded live until it proves itself at live speed \(0 of 10 replays/)
    expect([50, 100]).toContain(pos.sizeUsd)
    expect(bot.positions.filter(p => p.status === 'open')).toHaveLength(1) // the bot's own paper book too
    expect(bot.scan.get(T)).toMatchObject({ status: 'signal', stage: 'scalp', strategy: 'scalp' })
  })

  test('live bots take every signal not on probation (the owner’s setting), even before it proves itself at live speed', async () => {
    const { bot, sent, trade } = setup({ liveSignals: 'all' })
    const t0 = Date.now() - 80_000
    for (let k = 0; k < 13; k++) trade({ price: 1 + k * 0.01, at: t0 + k * 6_000 })
    await settle(); bot.sweep(Date.now() + 5_000); await settle()
    const sig = sent.find(m => m.t === 'SIGNAL')
    expect(sig?.t === 'SIGNAL' && sig.d.quality).toMatchObject({ grade: 'live', liveSpeed: { trades: 0, ok: false } })
    expect(bot.stats().routing).toEqual({ liveSignals: 'all', paperSignals: true, launchpadOnly: 'off' })
  })

  test('liquidity pulled: the rug guard closes every position at once and quarantines the coin', async () => {
    const { bot, account, trade, sent } = setup()
    const t0 = Date.now() - 80_000 // thirteen buyers in two minutes, the last few in the last 30 seconds
    for (let k = 0; k < 13; k++) trade({ price: 1 + k * 0.01, at: t0 + k * 6_000 })
    await settle(); bot.sweep(Date.now() + 5_000); await settle()
    expect(account.positions[0].status).toBe('open')
    trade({ side: 'SELL', price: 1.02, usd: 20, liquidity: 9_000 })
    expect(account.positions[0]).toMatchObject({ status: 'closed', exitReason: 'rug' })
    expect(account.positions[0].note).toMatch(/Rug guard: liquidity fell 55%/)
    expect(bot.positions[0]).toMatchObject({ status: 'closed', exitReason: 'rug' })
    expect(sent.some(m => m.t === 'BOT_POSITION' && m.d.exitReason === 'rug')).toBe(true)
    // A new burst on the same coin isn't bought while it's quarantined.
    const t1 = Date.now() - 50_000
    for (let k = 0; k < 13; k++) trade({ price: 1.05 + k * 0.01, at: t1 + k * 5_000, liquidity: 9_000 })
    await settle(); bot.sweep(Date.now() + 5_000); await settle()
    expect(account.positions).toHaveLength(1)
    expect(bot.positions).toHaveLength(1)
  })

  test('a coin that raised a rug alarm is rejected with the reason while quarantined', async () => {
    const { bot, trade } = setup()
    trade({ price: 1, liquidity: 20_000, at: Date.now() - 60_000 })
    trade({ side: 'SELL', price: 0.99, usd: 10, liquidity: 10_000, at: Date.now() - 50_000 }) // −50%: an alarm
    const t0 = Date.now() - 45_000
    for (let k = 0; k < 13; k++) trade({ price: 1 + k * 0.01, at: t0 + k * 5_000, liquidity: 10_000 })
    await settle(); bot.sweep(Date.now() + 5_000); await settle()
    expect(bot.scan.get(T)).toMatchObject({ status: 'rejected', stage: 'safety' })
    expect(bot.scan.get(T)!.reasons[0]).toMatch(/^✗ rug guard .* liquidity fell 50%/)
  })

  test('the sweep only evaluates coins that traded in the last 3 minutes, each at most every 2s', async () => {
    const { bot, trade } = setup()
    trade({ price: 1, at: Date.now() - 10_000 })
    expect(bot.sweep(Date.now())).toBe(0) // its own trade just evaluated it
    await settle()
    expect(bot.sweep(Date.now() + 3_000)).toBe(1)
    await settle()
    expect(bot.sweep(Date.now() + 10 * 60_000)).toBe(0) // gone quiet
  })
})

describe('after a restart', () => {
  test('every launch of the last 48 hours is back on the scanner at once, with the trades the engine kept', () => {
    const now = Date.now()
    const coin = (n: number, ageMin: number): LaunchInfo => ({ token: '0x' + String(n).padStart(40, '0'), name: `C${n}`, symbol: `C${n}`, decimals: 18, creator: null, txHash: '0x', blockNumber: 1, timestamp: now - ageMin * 60_000, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' })
    const fresh = coin(1, 30), old = coin(2, 3 * 24 * 60)
    const st = new TokenState(fresh.token)
    Object.assign(st, { priceUsd: 1.1, mainPool: 'pool1' })
    // The engine's buffer: newest first, as the engine keeps it.
    const kept = [0, 1, 2].map(k => ({ id: `t${k}`, k: fresh.token, pl: 'pool1', q: '0x36', s: 'B', ba: 100, qa: 60, p: 1 + k / 20, pu: 1 + k / 20, u: 60, w: `0x${'a'.repeat(39)}${k}`, tx: `0x${k}`, b: 10 + k, li: 0, ts: now - (3 - k) * 30_000, dx: 'uniswap-v4', lp: 'ARGUS', lq: 20_000 })).reverse()
    const engine = { metas: new Map([[fresh.token, fresh], [old.token, old]]), tokens: new Map([[fresh.token, st]]), recentTrades: (t: string) => (t === fresh.token ? kept : []) } as unknown as MarketEngine
    const bot = new Bot({ rpc: {} as Rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: () => {}, mode: 'paper', speed: null })
    expect(bot.seed(now)).toBe(1) // the 3-day-old launch stays off the list
    expect(bot.scan.get(fresh.token)).toMatchObject({ status: 'new' })
    expect(bot.scan.get(old.token)).toBeUndefined()
    expect(bot.tapes.get(fresh.token).map(t => t.price)).toEqual([1, 1.05, 1.1]) // oldest first
    expect(bot.recent.window(fresh.token, now, 120_000)).toHaveLength(3)
  })
})
