// Faze (src/launchpads/faze.ts) on recorded Arc mainnet data
// (engine/scripts/capture-faze.ts). Expected sides come from each trade's
// own token transfer, and "priced in native USDC" from native USDC moving
// to or from Faze in the transaction: independent of the adapter.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { RawLog } from '../../api/_arcLogs'
import { NATIVE } from '../../api/_arcSwaps'
import { FAZE_BOUGHT, FazeAdapter, decodeFazeTrade } from '../src/launchpads/faze'
import { ReplayRpc } from './helpers/recordRpc'

const fx = JSON.parse(readFileSync(new URL('./fixtures/faze.json', import.meta.url), 'utf8')) as {
  launches: RawLog[]
  trades: { log: RawLog; side: 'BUY' | 'SELL'; nativeQuoted: boolean; usdc: number }[]
  rpc: Record<string, unknown>
}

describe('Faze', () => {
  const rpc = new ReplayRpc(fx.rpc)
  const ctx = { rpc, pools: null as never }

  test('the recording has native-USDC buys and sells, and coins quoted in another token', () => {
    const n = fx.trades.filter(t => t.nativeQuoted)
    expect(n.some(t => t.side === 'BUY') && n.some(t => t.side === 'SELL')).toBe(true)
    expect(fx.trades.some(t => !t.nativeQuoted)).toBe(true)
  })

  test('launches of native-USDC coins', async () => {
    for (const l of fx.launches) {
      const got = await new FazeAdapter().parseLaunch(l, ctx)
      if (!got) continue // a coin quoted in another token
      expect(got.launchpad).toBe('Faze')
      expect(got.token).toBe('0x' + l.topics[1].slice(26))
      expect(got.creator).toBe('0x' + l.topics[2].slice(26))
      expect(got.quote).toBe(NATIVE)
      expect(got.pool).toBe(got.token)
    }
  })

  for (const [i, t] of fx.trades.entries()) {
    test(`trade ${i + 1}: ${t.nativeQuoted ? t.side : 'quoted in another token: skipped'}`, async () => {
      const got = await new FazeAdapter().parseTrade(t.log, ctx)
      if (!t.nativeQuoted) { expect(got).toBeNull(); return }
      expect(got).not.toBeNull()
      expect(got!.side).toBe(t.side)
      expect(got!.launchpad).toBe('Faze')
      expect(got!.pool).toBe(got!.token) // each coin its own "pool"
      // What moved on-chain, within 0.1% (a buy can carry a sliver more than the event's amount).
      expect(Math.abs(got!.usdValue! - t.usdc) <= t.usdc * 0.001).toBe(true)
      expect(got!.priceUsd! > 0).toBe(true)
      expect(got!.liquidity! >= 0).toBe(true)
    })
  }

  test('an event from another contract is ignored', async () => {
    const l = fx.trades.find(t => t.nativeQuoted)!.log
    expect(await new FazeAdapter().parseTrade({ ...l, address: '0x' + '9'.repeat(40) }, ctx)).toBeNull()
  })

  test('malformed events decode to nothing', () => {
    const l = fx.trades[0].log
    expect(decodeFazeTrade({ ...l, data: '0x' })).toBeNull()
    expect(decodeFazeTrade({ topics: [FAZE_BOUGHT, l.topics[1]], data: l.data })).toBeNull()
  })

  test('recorded answers cover every call', () => { expect(rpc.missed).toEqual([]) })
})
