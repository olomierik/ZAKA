// Arc's established coins from the engine's own trades (market/established.ts), and how the site's list takes them
// (api/_argusCore.ts withArcExtra).
import { afterEach, describe, expect, test } from 'bun:test'
import { encodeAbiParameters } from 'viem'
import type { Trade } from '../../api/_marketProtocol'
import { setArcExtra, withArcExtra, type ArgusPool } from '../../api/_argusCore'
import type { Rpc } from '../src/chain/http'
import { setLogLevel } from '../src/log'
import { EstablishedBook } from '../src/market/established'
import { TokenState } from '../src/market/tokenState'

setLogLevel('error')
const DAY = 86_400_000
const now = Date.UTC(2026, 9, 6, 12)
const addr = (c: string) => '0x' + c.repeat(40)
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s])

/** A coin with `trades` trades in the last hour, in `pool` with `liq` of liquidity, priced so its cap is `mc`. */
function coin(token: string, o: { trades: number; liq: number; mc: number; pool?: string }): TokenState {
  const st = new TokenState(token)
  st.supply = 1_000_000
  for (let i = 0; i < o.trades; i++) {
    const t: Trade = {
      tradeId: `${token}:${i}`, chain: 'ARC', token, pair: `${token}/usdc`, pool: o.pool ?? `pool-${token}`, quote: '0x3600000000000000000000000000000000000000', side: i % 3 ? 'BUY' : 'SELL',
      baseAmount: 10, quoteAmount: 100, tokenAmount: 10, price: o.mc / 1e6, priceUsd: o.mc / 1e6, usdValue: 100,
      wallet: null, txHash: `tx${i}`, blockNumber: 100 + i, logIndex: 1, timestamp: now - 3_600_000 + i * 1_000, dex: 'uniswap-v4', launchpad: null, liquidity: o.liq,
    }
    st.add(t, i + 1, now)
  }
  return st
}

/** An RPC that answers name()/symbol()/decimals() for the tokens named, and counts the reads. */
function rpcFor(names: Record<string, [string, string]>) {
  let reads = 0
  const rpc: Rpc = {
    async call<T>(method: string): Promise<T> {
      if (method === 'eth_blockNumber') return '0x1000000' as T
      throw new Error(method)
    },
    async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
      reads++
      const to = ((calls[0].params[0] as { to: string }).to).toLowerCase()
      const n = names[to]
      if (!n) return [null, null, null]
      return [str(n[0]), str(n[1]), '0x12'] as T[]
    },
  }
  return { rpc, reads: () => reads }
}

const TOLLY = addr('1'), FRESH = addr('2'), THIN = addr('3'), LAUNCH = addr('4'), STABLE = addr('5'), FEW = addr('6')

function book(o: { created?: Record<string, number | null>; save?: (j: string) => Promise<void>; load?: () => Promise<string | null> } = {}) {
  const tokens = new Map<string, TokenState>([
    [TOLLY, coin(TOLLY, { trades: 60, liq: 285_000, mc: 2_100_000, pool: 'v3pool' })],
    [FRESH, coin(FRESH, { trades: 60, liq: 90_000, mc: 400_000 })],
    [THIN, coin(THIN, { trades: 60, liq: 5_000, mc: 400_000 })],
    [LAUNCH, coin(LAUNCH, { trades: 60, liq: 90_000, mc: 400_000 })],
    [STABLE, coin(STABLE, { trades: 60, liq: 900_000, mc: 5_000_000 })],
    [FEW, coin(FEW, { trades: 5, liq: 900_000, mc: 5_000_000 })],
  ])
  const net = rpcFor({ [TOLLY]: ['Tolly', 'TOLLY'], [FRESH]: ['Fresh', 'FRESH'], [STABLE]: ['Tether', 'USDT'], [THIN]: ['Thin', 'THIN'] })
  const created = o.created ?? { [TOLLY]: 1_000, [FRESH]: 2_000, [STABLE]: 1_000 }
  const b = new EstablishedBook({
    tokens, hasMeta: t => t === LAUNCH, rpc: net.rpc,
    pool: p => (p === 'v3pool' ? { dex: 'uniswap-v3', quote: '0x3600000000000000000000000000000000000000' } : { dex: 'uniswap-v4', quote: '0x3600000000000000000000000000000000000000' }),
    createdBlock: async t => (t in created ? created[t] : null),
    blockTime: async block => (block === 1_000 ? now - 60 * DAY : now - DAY),
    save: o.save, load: o.load,
  })
  return { b, reads: net.reads }
}

afterEach(() => setArcExtra(null))

describe('established coins from the engine', () => {
  test('busy coins with depth, a cap and real trades are read once; launches, thin pools and quiet coins are not', async () => {
    const { b } = book()
    const c = b.candidates(now).map(x => x.token)
    expect(c).toContain(TOLLY)
    expect(c).toContain(FRESH)
    expect(c).not.toContain(THIN)   // $5K of liquidity
    expect(c).not.toContain(LAUNCH) // a launch adapter reported it: the site lists it from its launch
    expect(c).not.toContain(FEW)    // 5 trades in a day
    expect(await b.refresh(now)).toBe(3)
    expect(await b.refresh(now)).toBe(0) // nothing left to read
  })
  test('rows: only coins meeting the site\'s rule, in the market list\'s shape', async () => {
    const { b } = book()
    await b.refresh(now)
    const rows = b.rows(now)
    expect(rows.map(r => r.token.symbol)).toEqual(['TOLLY']) // FRESH is a day old, USDT a stablecoin
    const t = rows[0]
    expect(t).toMatchObject({ pool: 'v3pool', dex: 'uniswap-v3-arc', launchpad: 'Uniswap V3', token: { address: TOLLY, symbol: 'TOLLY', name: 'Tolly', image: null }, quote: { symbol: 'USDC' } })
    expect(Math.round(t.marketCapUsd!)).toBe(2_100_000)
    expect(t.liquidityUsd).toBe(285_000)
    expect(t.txns24h.buys + t.txns24h.sells).toBe(60)
    expect(Date.parse(t.createdAt!)).toBe(now - 60 * DAY)
  })
  test('a coin older than the holder index\'s window counts as old', async () => {
    const { b } = book({ created: { [TOLLY]: null, [FRESH]: 2_000, [STABLE]: 1_000 } })
    await b.refresh(now)
    expect(b.rows(now).map(r => r.token.symbol)).toEqual(['TOLLY'])
  })
  test('what it read is kept: a restart reads nothing again', async () => {
    let saved = ''
    const first = book({ save: async j => { saved = j } })
    await first.b.refresh(now)
    const reads = first.reads()
    expect(saved).toContain('TOLLY')
    const second = book({ load: async () => saved })
    expect(await second.b.refresh(now)).toBe(0)
    expect(second.reads()).toBe(0)
    expect(reads).toBeGreaterThan(0)
    expect(second.b.rows(now).map(r => r.token.symbol)).toEqual(['TOLLY'])
  })
})

describe('the list takes them', () => {
  const gt = (address: string, symbol: string, over: Partial<ArgusPool> = {}): ArgusPool => ({
    pool: `gt-${symbol}`, dex: 'argus', token: { address, symbol, name: symbol, image: 'https://img/x.png' }, quote: { address: addr('9'), symbol: 'USDC' },
    priceUsd: 1, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, volume24h: 1, liquidityUsd: 1, marketCapUsd: null, fdvUsd: null,
    txns24h: { buys: 1, sells: 1 }, createdAt: null, launchpad: 'Argus', ...over,
  })
  test('the engine\'s coins the stored list lacks are added; a coin it lists keeps its own row, with a cap filled in', async () => {
    const { b } = book()
    await b.refresh(now)
    setArcExtra({ rows: () => b.rows(now), capOf: t => b.capOf(t, now) })
    const out = withArcExtra([gt(FRESH, 'FRESH'), gt(addr('8'), 'OTHER', { marketCapUsd: 50_000 })])
    expect(out.map(p => p.token.symbol)).toEqual(['FRESH', 'OTHER', 'TOLLY'])
    expect(out[0].token.image).toBe('https://img/x.png') // GeckoTerminal's row, with its logo
    expect(Math.round(out[0].marketCapUsd!)).toBe(400_000) // its missing cap from the engine
    expect(out[1].marketCapUsd).toBe(50_000) // a cap it had is left alone
    // A coin in both is listed once.
    expect(withArcExtra([gt(TOLLY, 'TOLLY')]).filter(p => p.token.address === TOLLY)).toHaveLength(1)
  })
  test('where no engine runs, the list is as stored', () => {
    const list = [gt(FRESH, 'FRESH')]
    expect(withArcExtra(list)).toBe(list)
  })
})
