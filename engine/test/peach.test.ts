// Peach (src/launchpads/peach.ts) on recorded Arc mainnet data
// (engine/scripts/capture-peach.ts). Each trade's expected side comes from
// its transaction's own token transfer, and whether it's USDC-quoted from
// USDC moving to or from its curve: independent of the adapter's decoding.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { RawLog } from '../../api/_arcLogs'
import { USDC } from '../../api/_arcSwaps'
import { PeachAdapter, decodePeachTrade } from '../src/launchpads/peach'
import { ReplayRpc } from './helpers/recordRpc'

const fx = JSON.parse(readFileSync(new URL('./fixtures/peach.json', import.meta.url), 'utf8')) as {
  launches: RawLog[]
  trades: { log: RawLog; side: 'BUY' | 'SELL'; usdcGross: number; usdcQuoted: boolean }[]
  fake: RawLog
  rpc: Record<string, unknown>
}

describe('Peach', () => {
  const rpc = new ReplayRpc(fx.rpc)
  const ctx = { rpc, pools: null as never }

  test('launches: coin, its curve, creator, USDC', async () => {
    const a = new PeachAdapter()
    for (const l of fx.launches) {
      const got = await a.parseLaunch(l, ctx)
      expect(got).not.toBeNull()
      expect(got!.launchpad).toBe('Peach')
      expect(got!.token).toBe('0x' + l.topics[1].slice(26))
      expect(got!.pool).toBe('0x' + l.topics[2].slice(26))
      expect(got!.creator).toBe('0x' + l.topics[3].slice(26))
      expect(got!.quote).toBe(USDC)
      expect(got!.symbol).not.toBe('???')
    }
  })

  test('the recording has USDC-quoted buys and sells, and a curve in another token', () => {
    const q = fx.trades.filter(t => t.usdcQuoted)
    expect(q.some(t => t.side === 'BUY') && q.some(t => t.side === 'SELL')).toBe(true)
    expect(fx.trades.some(t => !t.usdcQuoted)).toBe(true)
  })

  for (const [i, t] of fx.trades.entries()) {
    test(`trade ${i + 1}: ${t.usdcQuoted ? t.side : 'curve quoted in another token: skipped'}`, async () => {
      // A fresh adapter: the curve isn't known from a launch, so it's checked against the template.
      const got = await new PeachAdapter().parseTrade(t.log, ctx)
      if (!t.usdcQuoted) { expect(got).toBeNull(); return }
      expect(got).not.toBeNull()
      expect(got!.side).toBe(t.side)
      expect(got!.launchpad).toBe('Peach')
      expect(got!.quote).toBe(USDC)
      expect(got!.pool).toBe(t.log.address.toLowerCase())
      expect(got!.priceUsd! > 0).toBe(true)
      // A buy's USD is what was paid (gross); a sell's what was received (after fees, never more than gross).
      if (t.side === 'BUY') expect(got!.usdValue).toBeCloseTo(t.usdcGross, 6)
      else expect(got!.usdValue! <= t.usdcGross && got!.usdValue! > t.usdcGross * 0.9).toBe(true)
    })
  }

  test('the same event from a contract that is not a Peach curve is ignored', async () => {
    expect(await new PeachAdapter().parseTrade(fx.fake, ctx)).toBeNull()
  })

  test('malformed events decode to nothing', () => {
    const l = fx.trades[0].log
    expect(decodePeachTrade({ ...l, data: '0x' })).toBeNull()
    expect(decodePeachTrade({ ...l, topics: l.topics.slice(0, 2) })).toBeNull()
    const bad = '0x' + l.data.slice(2, 2 + 128) + (5n).toString(16).padStart(64, '0') + l.data.slice(2 + 192)
    expect(decodePeachTrade({ ...l, data: bad })).toBeNull() // "is buy" must be 0 or 1
  })

  test('recorded answers cover every call', () => { expect(rpc.missed).toEqual([]) })
})
