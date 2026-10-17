// Robinhood Chain's launches read from the chain (src/trench/hoodLaunches.ts, hood.ts), on events recorded from mainnet on
// 2026-10-17: a Pons launch (KEL) and its curve's buy and sale, and v4 pools opened with Clanker's and Bankr's hooks.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters } from 'viem'
import { V4_INITIALIZE } from '../../api/_arcSwaps'
import { NATIVE, WETH } from '../../api/_rhCore'
import { TrenchBook } from '../src/trench/book'
import type { RawLog } from '../src/trench/bsc'
import { HoodFeed } from '../src/trench/hood'
import { HOOD_HOOKS, PONS_BUY, PONS_LAUNCH, PONS_LAUNCHER, PONS_SELL, decodeHoodInit, decodePonsLaunch, decodePonsTrade, decodeString, initPrice } from '../src/trench/hoodLaunches'
import type { NativePrices } from '../src/trench/prices'
import type { TrenchMessage } from '../../api/_trenchProtocol'

const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const w = (n: bigint) => n.toString(16).padStart(64, '0')
const KEL = '0xa4c59ce3cdaf83b4cb964202741e0f86920bb958', CURVE = '0xaf4bc84657c11bb88eda515c074abf749b5ec67c', CREATOR = '0x5877c52a469cf93e474a404d1541d17e38bae23c'
const ROUTER = '0xe33e9e479df8802cb0866d5d05258bec4cf62948'
const log = (o: Partial<RawLog>): RawLog => ({ address: '0x', topics: [], data: '0x', blockNumber: '0x567d000', transactionHash: '0x' + '11'.repeat(32), logIndex: '0x0', ...o })

// Recorded: the launch (block 90700745) and the curve's first buy and a sale.
const LAUNCH = log({ address: PONS_LAUNCHER, topics: [PONS_LAUNCH, pad(KEL), pad(CURVE), pad(CREATOR)], data: '0x' + w(0n) + w(0n) + w(0x3a4965bf58a40000n) })
const BUY = log({ address: CURVE, topics: [PONS_BUY, pad(ROUTER), pad(CREATOR)], data: '0x' + w(21000000000000000n) + w(11979745584784488082005681n) + w(210000000000000n) + w(420000000000000n) })
const SELL = log({ address: CURVE, topics: [PONS_SELL, pad(ROUTER), pad('0x55f309cdb70a83b4e85592bbb9f0c53a3ea6a99b')], data: '0x' + w(2577177136888741239807n) + w(4313619463108n) + w(44470303743n) + w(88940607486n) })

const CLANKER = Object.keys(HOOD_HOOKS).find(h => HOOD_HOOKS[h] === 'Clanker')!
const BANKR = Object.keys(HOOD_HOOKS).find(h => HOOD_HOOKS[h] === 'Bankr')!
const COIN = '0xf2b1143525697175a31f4e20e3ea4b249967b2b8'
const POOL_ID = '0x' + 'ab'.repeat(32)
// A pool at tick -230400 (a coin worth ~1e-10 ETH), as launchpads open them; sqrtPriceX96 = sqrt(1.0001^tick) * 2^96.
const sqrtAt = (tick: number) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96))
const init = (hook: string, c0 = NATIVE, c1 = COIN, tick = 230_400) => log({
  address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', topics: [V4_INITIALIZE, POOL_ID, pad(c0), pad(c1)],
  // fee, tickSpacing, hooks, sqrtPriceX96, tick: the coin is token1, so its price in ETH is 1/p.
  data: '0x' + w(10000n) + w(200n) + w(BigInt(hook)) + w(sqrtAt(tick)) + w(BigInt(tick)),
})

describe('decoding', () => {
  test('a Pons launch: the coin, its curve, its creator, the graduation threshold', () => {
    expect(decodePonsLaunch(LAUNCH)).toEqual({ token: KEL, curve: CURVE, creator: CREATOR, thresholdEth: 4.2 })
    expect(decodePonsLaunch({ ...LAUNCH, address: '0x' + '22'.repeat(20) })).toBeNull()
    expect(decodePonsLaunch({ ...LAUNCH, removed: true })).toBeNull()
  })
  test('a Pons curve’s buy and sale: ETH, coins and the trader', () => {
    const b = decodePonsTrade(BUY)!
    expect(b.buy).toBe(true)
    expect(b.trader).toBe(CREATOR)
    expect(b.eth).toBeCloseTo(0.021, 9)
    expect(b.tokens).toBeCloseTo(11_979_745.58, 1)
    const s = decodePonsTrade(SELL)!
    expect(s.buy).toBe(false)
    expect(s.tokens).toBeCloseTo(2577.18, 1)
    expect(s.eth).toBeCloseTo(0.0000043136, 9)
    // The same price either way, give or take the curve's move.
    expect(s.price / b.price).toBeGreaterThan(0.9)
    expect(s.price / b.price).toBeLessThan(1.1)
  })
  test('v4 pools: only a known launchpad’s hook, and only against ETH, WETH or USDG', () => {
    const c = decodeHoodInit(init(CLANKER))!
    expect(c).toMatchObject({ coin: COIN, quote: NATIVE, launchpad: 'Clanker', coinIs0: false, poolId: POOL_ID })
    expect(decodeHoodInit(init(BANKR))!.launchpad).toBe('Bankr')
    expect(decodeHoodInit(init('0x' + '00'.repeat(20)))).toBeNull()
    expect(decodeHoodInit(init(CLANKER, '0x1111111111111111111111111111111111111111', COIN))).toBeNull()
    // The coin can sort first (token0) against WETH.
    const lo = '0x0000000000000000000000000000000000000abc'
    expect(decodeHoodInit(init(CLANKER, lo, WETH))).toMatchObject({ coin: lo, quote: WETH, coinIs0: true })
  })
  test('the opening price from the pool’s starting price', () => {
    // tick 230400 with the coin as token1: token1 per token0 = 1.0001^230400 ≈ 1.0e10, so ~1e-10 ETH per coin.
    expect(initPrice(decodeHoodInit(init(CLANKER))!)).toBeCloseTo(1 / 1.0001 ** 230_400, 15)
  })
  test('ERC-20 names: ABI strings, and bytes32 from old tokens', () => {
    expect(decodeString(encodeAbiParameters([{ type: 'string' }], ['Kelly']))).toBe('Kelly')
    expect(decodeString('0x' + Buffer.from('OLD').toString('hex').padEnd(64, '0'))).toBe('OLD')
    expect(decodeString('0x')).toBe('')
  })
})

describe('the feed', () => {
  /** A stand-in RPC: one batch of logs, a coin's metadata, receipts and mint logs. */
  function rpcWith(logs: RawLog[], opts: { minted?: string[] } = {}) {
    const calls: string[] = []
    const meta: Record<string, string> = {
      '0x06fdde03': encodeAbiParameters([{ type: 'string' }], ['Coin']), '0x95d89b41': encodeAbiParameters([{ type: 'string' }], ['COIN']),
      '0x313ce567': '0x' + w(18n), '0x18160ddd': '0x' + w(100_000_000_000n * 10n ** 18n), '0x4f1f58fd': '0x' + w(21n * 10n ** 16n),
    }
    let served = false
    return {
      calls,
      rpc: {
        async call<T>(method: string, params: unknown[]): Promise<T> {
          calls.push(method)
          if (method === 'eth_blockNumber') return '0x567d010' as T
          if (method === 'eth_getLogs') {
            const f = params[0] as { address?: string | string[] }
            if (typeof f.address === 'string') return ((opts.minted ?? []).includes(f.address) ? [log({ address: f.address })] : []) as T
            if (served) return [] as T
            served = true
            return logs as T
          }
          if (method === 'eth_call') return (meta[(params[0] as { data: string }).data] ?? '0x') as T
          if (method === 'eth_getTransactionReceipt') return { logs: [] } as T
          if (method === 'eth_getTransactionByHash') return { from: CREATOR } as T
          return null as T
        },
        async batch() { return [] },
      },
    }
  }
  const prices = { usd: () => 2400 } as unknown as NativePrices

  test('a Pons launch shows at once, with its first trades and progress', async () => {
    const book = new TrenchBook('hood', undefined, () => false)
    const out: TrenchMessage[] = []
    const { rpc } = rpcWith([LAUNCH, BUY, SELL])
    const feed = new HoodFeed({ book, prices, pools: () => [], rpc: rpc as never, publish: m => out.push(m) })
    await feed.poll(Date.now())
    const l = out.find(m => m.t === 'TLAUNCH')
    expect(l?.t === 'TLAUNCH' && l.d).toMatchObject({ a: KEL, s: 'COIN', lp: 'Pons', q: 'ETH', pool: CURVE, cr: CREATOR })
    const [c] = book.recentLaunches(5)
    expect(c.b).toBe(1)
    expect(c.x).toBe(1)
    expect(c.p).toBeGreaterThan(0)
  })

  test('a Bankr pool for a coin minted minutes ago is a launch; one for an old coin isn’t; an unknown hook is ignored', async () => {
    const fresh = '0x0000000000000000000000000000000000000f01', old = '0x0000000000000000000000000000000000000f02', other = '0x0000000000000000000000000000000000000f03'
    const logs = [
      { ...init(BANKR, NATIVE, fresh), topics: [V4_INITIALIZE, '0x' + '01'.repeat(32), pad(NATIVE), pad(fresh)] },
      { ...init(BANKR, NATIVE, old), topics: [V4_INITIALIZE, '0x' + '02'.repeat(32), pad(NATIVE), pad(old)] },
      { ...init('0x' + '99'.repeat(20), NATIVE, other), topics: [V4_INITIALIZE, '0x' + '03'.repeat(32), pad(NATIVE), pad(other)] },
    ]
    const book = new TrenchBook('hood', undefined, () => false)
    const out: TrenchMessage[] = []
    const { rpc } = rpcWith(logs, { minted: [fresh] })
    await new HoodFeed({ book, prices, pools: () => [], rpc: rpc as never, publish: m => out.push(m) }).poll(Date.now())
    const launched = out.filter(m => m.t === 'TLAUNCH').map(m => (m.t === 'TLAUNCH' ? m.d.a : ''))
    expect(launched).toEqual([fresh])
    // The opening price gives the 100B coin ~$24K of market cap at ~1e-10 ETH and ETH at $2,400.
    expect(book.recentLaunches(5)[0].m).toBeGreaterThan(10_000)
    expect(book.recentLaunches(5)[0].m).toBeLessThan(50_000)
  })
})
