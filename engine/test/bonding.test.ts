// Argus coins on their curve (market/bonding.ts, GET /v1/bonding): progress by market cap, the coins it follows, a
// graduated coin dropped for good, and a dropped read asked again next round.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem'
import type { LaunchInfo } from '../../api/_marketProtocol'
import type { Rpc } from '../src/chain/http'
import { PORTAL7, PORTAL8 } from '../src/launchpads/argus'
import { BondingBook, mcProgress } from '../src/market/bonding'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'

const P7 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)'])
const P8 = parseAbi(['function launches(address) view returns (address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond, bool tokenIsToken0)'])
const HOOK = parseAbi(['function bonded() view returns (bool)'])
const SV = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'])
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
const Z = '0x0000000000000000000000000000000000000000'
const NOW = 1_800_000_000_000
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const pool = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

describe('progress by market cap', () => {
  test('1.0001^-(ticks to go) of the graduation cap, either direction', () => {
    // Argus Portal 7: start 405,400, bond 376,400 (the price of the coin rises as the tick falls).
    expect(mcProgress(376_400, 405_400, 376_400)).toBe(100)
    expect(mcProgress(370_000, 405_400, 376_400)).toBe(100)
    expect(mcProgress(405_400, 405_400, 376_400)!).toBeCloseTo(100 * Math.pow(1.0001, -29_000), 6) // ~5.5%: $2.5K of $45K
    expect(mcProgress(376_400 + 3_567, 405_400, 376_400)!).toBeCloseTo(70, 0) // near bond
    // The other direction (the coin's price rises with the tick): 1,000 ticks short is 90.5% of the cap.
    expect(mcProgress(9_000, 0, 10_000)!).toBeCloseTo(100 * Math.pow(1.0001, -1_000), 6)
    expect(mcProgress(100, 0, 100)).toBe(100)
    expect(mcProgress(0, 0, 0)).toBeNull()
  })
})

interface Coin { n: number; portal: 7 | 8; tick: number; bonded?: boolean; ageH?: number; lastTradeH?: number; launchpad?: string; price?: number }

function setup(coins: Coin[], o: { drop?: (to: string, data: string) => boolean } = {}) {
  const metas = new Map<string, LaunchInfo>(), tokens = new Map<string, TokenState>()
  const hooks = new Map<string, Coin>(), pools = new Map<string, Coin>(), byToken = new Map<string, Coin>()
  for (const c of coins) {
    const token = addr(0x1000 + c.n)
    metas.set(token, {
      token, name: `Coin ${c.n}`, symbol: `C${c.n}`, decimals: 18, creator: addr(0x9000 + c.n), txHash: '0x', blockNumber: 1,
      timestamp: NOW - (c.ageH ?? 1) * 3_600_000, pool: pool(0x5000 + c.n), quote: null, launchpad: c.launchpad ?? 'ARGUS',
      chain: 'ARC', status: 'LIVE', portal: c.portal,
    })
    const st = new TokenState(token)
    st.priceUsd = c.price ?? 0.00002; st.supply = 1e9; st.liquidityUsd = 5_000; st.lastTradeAt = NOW - (c.lastTradeH ?? 0.1) * 3_600_000
    tokens.set(token, st)
    hooks.set(addr(0x7000 + c.n), c); pools.set(pool(0x5000 + c.n), c); byToken.set(token, c)
  }
  let calls = 0
  const answer = (to: string, data: Hex): Hex | null => {
    if (o.drop?.(to, data)) return null
    if (to === PORTAL7 || to === PORTAL8) {
      const abi = to === PORTAL7 ? P7 : P8
      const token = (decodeFunctionData({ abi, data }).args![0] as string).toLowerCase()
      const c = byToken.get(token)!
      const hook = addr(0x7000 + c.n) as Hex
      return to === PORTAL7
        ? encodeFunctionResult({ abi: P7, functionName: 'launches', result: [addr(1) as Hex, 405_400, false, Z, hook, Z, 0, 0, 0n, 376_400, Z] })
        : encodeFunctionResult({ abi: P8, functionName: 'launches', result: [hook, Z, Z, 0n, 405_400, 376_400, false] })
    }
    if (to === STATE_VIEW) {
      const id = (decodeFunctionData({ abi: SV, data }).args![0] as string).toLowerCase()
      return encodeFunctionResult({ abi: SV, functionName: 'getSlot0', result: [1n, pools.get(id)!.tick, 0, 0] })
    }
    const c = hooks.get(to.toLowerCase())
    return c ? encodeFunctionResult({ abi: HOOK, functionName: 'bonded', result: !!c.bonded }) : null
  }
  const rpc = {
    call: async () => { throw new Error('unused') },
    batch: async <T,>(list: { method: string; params: unknown[] }[]) => {
      calls += list.length
      return list.map(c => { const p = c.params[0] as { to: string; data: Hex }; return answer(p.to.toLowerCase(), p.data) as T | null })
    },
  } as Rpc
  const book = new BondingBook({ rpc, engine: { metas, tokens } as unknown as MarketEngine, now: () => NOW })
  return { book, calls: () => calls }
}

describe('the bonding book', () => {
  test('follows young, trading Argus coins, closest to graduating first', async () => {
    const { book } = setup([
      { n: 1, portal: 7, tick: 405_400 },                         // just launched: ~5.5%
      { n: 2, portal: 8, tick: 376_400 + 3_000 },                  // ~74%: near bond
      { n: 3, portal: 7, tick: 380_000, bonded: true },           // graduated: off its curve
      { n: 4, portal: 7, tick: 390_000, ageH: 60 },               // launched 60h ago: not followed
      { n: 5, portal: 7, tick: 390_000, lastTradeH: 8 },          // no trade for 8h: not followed
      { n: 6, portal: 7, tick: 390_000, launchpad: 'Other' },     // not an Argus launch
      { n: 7, portal: 7, tick: 376_000 },                          // past its bond tick, hook not yet saying so
    ])
    await book.refresh()
    const list = book.list()
    expect(list.map(c => c.symbol)).toEqual(['C2', 'C1'])
    expect(list[0].progress).toBeCloseTo(100 * Math.pow(1.0001, -3_000), 6)
    // $20,000 at 74.08% of the way: it graduates at about $27,000.
    expect(list[0].marketCapUsd).toBeCloseTo(20_000, 6)
    expect(list[0].bondMarketCapUsd).toBeCloseTo(20_000 / (list[0].progress / 100), 3)
    expect(list[0]).toMatchObject({ portal: 8, creator: addr(0x9002), pool: pool(0x5002), liquidityUsd: 5_000 })
  })

  test('a graduated coin is dropped for good, and its record is read once', async () => {
    const { book, calls } = setup([{ n: 1, portal: 7, tick: 400_000 }, { n: 3, portal: 7, tick: 380_000, bonded: true }])
    await book.refresh()
    const first = calls()
    expect(first).toBe(2 + 2 * 2) // two records, then bonded() and getSlot0 for each
    await book.refresh()
    expect(calls() - first).toBe(2) // only the coin still on its curve, its record not read again
    expect(book.list().map(c => c.symbol)).toEqual(['C1'])
  })

  test('a read the RPC dropped is asked again next round', async () => {
    let drop = true
    const { book } = setup([{ n: 1, portal: 7, tick: 400_000 }], { drop: to => drop && to === PORTAL7 })
    await book.refresh()
    expect(book.list()).toEqual([])
    drop = false
    await book.refresh()
    expect(book.list().map(c => c.symbol)).toEqual(['C1'])
  })
})
