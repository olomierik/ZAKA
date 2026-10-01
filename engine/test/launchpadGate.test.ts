// Launchpad coins only (owner, 2026-10-01: "making sure all coins come from
// Arc launchpads, to avoid smart-contract coins").
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo, ServerMessage, Trade } from '../../api/_marketProtocol'
import { Bot } from '../src/bot/bot'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import { knownLaunchpad, launchpadGate, LAUNCHPAD_TEMPLATES } from '../src/intel/launchpadGate'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'
import { openPosition, STRATEGIES } from '../src/trading/paper'

describe('the gate', () => {
  test('the known Arc launchpads, by the names the engine gives them; "Other" isn\'t one', () => {
    expect(Object.keys(LAUNCHPAD_TEMPLATES)).toEqual(['ARGUS', 'ARCDEX', 'Mercuri', 'SolonPad', 'Peach', 'Faze', 'Aka.fun', 'o1', 'Minara', 'Long.supply'])
    expect(knownLaunchpad({ launchpad: 'argus' })?.name).toBe('ARGUS')
    expect(knownLaunchpad({ launchpad: 'Other' })).toBeNull()
    expect(knownLaunchpad({ launchpad: '' })).toBeNull()
  })
  test('strict: a known launchpad, and its standard code where that has been learned', () => {
    expect(launchpadGate('strict', { launchpad: 'Other', entry: '0xabc' })).toMatch(/not launched by a known Arc launchpad \(Other, via 0xabc\)/)
    expect(launchpadGate('strict', { launchpad: 'ARGUS' }, 'Argus P8 token')).toBeNull()
    expect(launchpadGate('strict', { launchpad: 'ARGUS' }, 'Argus P7 token')).toBeNull()
    expect(launchpadGate('strict', { launchpad: 'ARGUS' }, null)).toMatch(/isn't ARGUS's standard coin: a custom contract/)
    expect(launchpadGate('strict', { launchpad: 'ARGUS' }, 'Mercuri token')).toMatch(/it matches Mercuri token/)
    expect(launchpadGate('strict', { launchpad: 'ARGUS' })).toBeNull() // its code not read yet: the scanner's own check decides later
    expect(launchpadGate('strict', { launchpad: 'ARCDEX' }, null)).toBeNull() // no template learned yet: trusted by origin
  })
  test('origin: a known launchpad is enough; off: anything', () => {
    expect(launchpadGate('origin', { launchpad: 'ARGUS' }, null)).toBeNull()
    expect(launchpadGate('origin', { launchpad: 'Other' })).toMatch(/not launched by a known Arc launchpad/)
    expect(launchpadGate('off', { launchpad: 'Other' })).toBeNull()
  })
})

// ── the bot ──────────────────────────────────────────────────────────

const C = '0x' + 'f1'.repeat(20), DEV = '0x' + 'de'.repeat(20)

class StubBot extends Bot {
  verdict: SafetyReport['verdict'] = 'pass'
  failing: string[] = []
  override async report(token: string): Promise<SafetyReport> {
    return { token, launchpad: 'X', at: Date.now(), verdict: this.verdict, score: 90, checks: this.failing.map(id => ({ id, ok: false, hard: true, detail: `${id} failed` })), template: null, honeypot: { verdict: 'ok', roundTripLossPct: 2 } as never }
  }
}

function setup(launchpad: string) {
  const meta: LaunchInfo = { token: C, name: 'Coin', symbol: 'COIN', decimals: 18, creator: DEV, txHash: '0x', blockNumber: 1, timestamp: Date.now() - 120_000, pool: null, quote: null, launchpad, chain: 'ARC', status: 'LIVE', entry: '0x' + 'ee'.repeat(20) }
  const st = new TokenState(C)
  Object.assign(st, { priceUsd: 1, mainPool: 'pool1', liquidityUsd: 20_000, supply: 1e9 })
  const engine = { metas: new Map([[C, meta]]), tokens: new Map([[C, st]]) } as unknown as MarketEngine
  const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
  const sent: ServerMessage[] = []
  const bot = new StubBot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: (_t, m) => sent.push(m), mode: 'paper', speed: null, launchpadOnly: 'strict' })
  let i = 0
  const buy = (at: number) => {
    i++
    const t: Trade = {
      tradeId: `0x${i}:0`, chain: 'ARC', token: C, pair: `${C}/usdc`, pool: 'pool1', quote: '0x3600000000000000000000000000000000000000', side: 'BUY',
      baseAmount: 100, quoteAmount: 60, tokenAmount: 100, price: 1 + i * 0.008, priceUsd: 1 + i * 0.008, usdValue: 60, wallet: '0x' + (0x200 + i).toString(16).padStart(40, '0'),
      txHash: `0x${i}`, blockNumber: 10 + i, logIndex: 0, timestamp: at, dex: 'uniswap-v4', launchpad, liquidity: 20_000,
    }
    st.priceUsd = t.priceUsd!
    bot.onTrade(t, { replay: false })
  }
  const settle = () => new Promise(r => setTimeout(r, 25))
  const crowd = async () => { const t0 = Date.now(); for (let k = 0; k < 16; k++) buy(t0 - 60_000 + k * 3_000); await settle(); bot.sweep(Date.now() + 3_000); await settle() }
  const signals = () => sent.filter(m => m.t === 'SIGNAL')
  return { bot, crowd, signals, buy, settle }
}

describe('the bot: launchpad coins only', () => {
  test('a crowd on an "Other" coin is never a signal; the scanner says why, without a safety scan', async () => {
    const { bot, crowd, signals } = setup('Other')
    await crowd()
    expect(signals()).toEqual([])
    expect(bot.scan.get(C)).toMatchObject({ status: 'rejected', stage: 'safety', keys: ['safety:launchpad'], reasons: [expect.stringMatching(/✗ launchpad: not launched by a known Arc launchpad \(Other, via 0x/)] })
  })
  test('the same crowd on an Argus coin is a signal', async () => {
    const { crowd, signals } = setup('ARGUS')
    await crowd()
    expect(signals()).toHaveLength(1)
  })
  test('a coin held from before the rule isn\'t sold for it; a real safety failure still closes it', async () => {
    const { bot, buy, settle } = setup('Other')
    const p = { ...openPosition({ id: 'held', strategy: 'scalp', token: C, symbol: 'COIN', launchpad: 'Other', signalId: 'old', price: 1, cost: 0, now: Date.now() - 60_000, params: STRATEGIES.scalp }), mode: 'paper' as const }
    bot.positions.push(p)
    bot.verdict = 'fail'; bot.failing = ['launchpad']
    buy(Date.now()); await settle()
    expect(p.status).toBe('open')
    bot.failing = ['launchpad', 'honeypot']
    ;(bot as unknown as { lastRecheck: Map<string, number> }).lastRecheck.clear()
    buy(Date.now()); bot.sweep(Date.now() + 3_000); await settle() // evaluated again (at most every 2s)
    expect(p).toMatchObject({ status: 'closed', exitReason: 'safety' })
  })
})
