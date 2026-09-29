// Generic v4 launch detection (src/launchpads/v4Launches.ts) on recorded
// Arc mainnet data (engine/scripts/capture-v4-launches.ts): real launches on
// Aka.fun, o1 and Minara are found and named; an Argus launch is left to
// its adapter; a new pool for an existing coin is not a launch.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { RawLog } from '../../api/_arcLogs'
import type { LaunchInfo } from '../../api/_marketProtocol'
import { PoolRegistry } from '../src/dex/pools'
import { V4LaunchDetector } from '../src/launchpads/v4Launches'
import { MarketEngine } from '../src/market/engine'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { ReplayRpc } from './helpers/recordRpc'

const fx = JSON.parse(readFileSync(new URL('./fixtures/v4-launches.json', import.meta.url), 'utf8')) as {
  cases: { label: string; expect: string | null; log: RawLog }[]
  rpc: Record<string, unknown>
}

describe('v4 launches', () => {
  const rpc = new ReplayRpc(fx.rpc)
  const pools = new PoolRegistry(rpc)
  const detector = new V4LaunchDetector(rpc, () => false)

  for (const c of fx.cases) {
    test(`${c.label}: ${c.expect ?? 'not a launch'}`, async () => {
      const info = await pools.fromInitialize(c.log)
      expect(info).not.toBeNull()
      const got = await detector.detect(c.log, info!)
      if (c.expect === null) { expect(got).toBeNull(); return }
      expect(got).not.toBeNull()
      expect(got!.launchpad).toBe(c.expect)
      expect(got!.generic).toBe(true)
      expect(got!.token).toBe(info!.base)
      expect(got!.pool).toBe(info!.pool)
      expect(got!.creator).toMatch(/^0x[0-9a-f]{40}$/)
      expect(got!.entry).toMatch(/^0x[0-9a-f]{40}$/)
      expect(got!.symbol).not.toBe('???')
      expect(got!.blockNumber).toBe(parseInt(c.log.blockNumber, 16))
    })
  }

  test('a coin the engine already knows is not looked up again', async () => {
    const quiet = new V4LaunchDetector(new ReplayRpc({}), () => true)
    const c = fx.cases.find(x => x.expect)!
    const info = await pools.fromInitialize(c.log)
    expect(await quiet.detect(c.log, info!)).toBeNull()
  })

  test('recorded answers cover every call', () => { expect(rpc.missed).toEqual([]) })
})

describe('an adapter replaces a generic launch', () => {
  const out = { publish: () => {}, wants: () => false }
  const base: LaunchInfo = {
    token: '0x' + '1'.repeat(40), name: 'Coin', symbol: 'C', decimals: 18, creator: null, txHash: '0x' + '2'.repeat(64),
    blockNumber: 1, timestamp: 1, pool: '0x' + '3'.repeat(64), quote: '0x3600000000000000000000000000000000000000',
    launchpad: 'Other', chain: 'ARC', status: 'LIVE', entry: '0x' + '4'.repeat(40), generic: true,
  }
  test('adapter over generic: replaced, pool kept', () => {
    const eng = new MarketEngine(out, new MemoryHotStore(), new NullHistoryStore(), null)
    eng.onLaunch(base, { replay: true })
    eng.onLaunch({ ...base, launchpad: 'ARGUS', portal: 7, pool: null, generic: undefined }, { replay: true })
    expect(eng.metas.get(base.token)?.launchpad).toBe('ARGUS')
    expect(eng.metas.get(base.token)?.pool).toBe(base.pool)
  })
  test('generic over adapter: ignored', () => {
    const eng = new MarketEngine(out, new MemoryHotStore(), new NullHistoryStore(), null)
    eng.onLaunch({ ...base, launchpad: 'ARGUS', generic: undefined }, { replay: true })
    eng.onLaunch(base, { replay: true })
    expect(eng.metas.get(base.token)?.launchpad).toBe('ARGUS')
  })
})
