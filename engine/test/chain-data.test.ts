// Adapter and parser tests on genuine Arc mainnet data, replayed from
// engine/test/fixtures/mainnet.json (recorded by engine/scripts/capture-fixtures.ts).
import { describe, expect, test } from 'bun:test'
import type { RawLog } from '../../api/_arcLogs'
import type { LaunchInfo, Trade } from '../../api/_marketProtocol'
import { PoolRegistry, pickQuote } from '../src/dex/pools'
import { MakerResolver, QuoteOracle, TradeParser } from '../src/dex/trades'
import { abiString, cleanImage, cleanText } from '../src/launchpads/adapter'
import { ArcLaunchpadAdapter, CURVE_TRADE, curvePrice } from '../src/launchpads/arcLaunchpad'
import { ArgusAdapter } from '../src/launchpads/argus'
import { ReplayRpc, type Recording } from './helpers/recordRpc'
import fixture from './fixtures/mainnet.json'

type Launch = { log: RawLog; recording: Recording; expected: LaunchInfo }
const f = fixture as unknown as { p7Launch: Launch; p8Launch: Launch; swaps: { logs: RawLog[]; recording: Recording; expected: (Trade | null)[] } }

describe('ArgusAdapter on real launches', () => {
  for (const name of ['p7Launch', 'p8Launch'] as const) {
    test(`${name}: token, name, symbol, creator, pool and quote`, async () => {
      const { log, recording, expected } = f[name]
      const rpc = new ReplayRpc(recording)
      const pools = new PoolRegistry(rpc)
      const got = await new ArgusAdapter().parseLaunch(log, { rpc, pools })
      expect(rpc.missed).toEqual([])
      expect(got).toEqual(expected)
      expect(got!.token).toMatch(/^0x[0-9a-f]{40}$/)
      expect(got!.launchpad).toBe('ARGUS')
      expect(got!.status).toBe('LIVE')
      expect(got!.symbol.length).toBeGreaterThan(0)
      expect(got!.pool).toMatch(/^0x[0-9a-f]{64}$/)
      // The pool was registered from the launch tx's Initialize, before any trade.
      const p = pools.get(got!.pool!)!
      expect(p.base).toBe(got!.token)
      expect(p.quote).toBe(got!.quote!)
    })
  }

  test('ignores other logs', async () => {
    const other = { ...f.p7Launch.log, topics: ['0x' + '0'.repeat(64), ...f.p7Launch.log.topics.slice(1)] }
    expect(new ArgusAdapter().matches(other)).toBe(false)
  })
})

describe('TradeParser on real swaps', () => {
  test('v3 and v4 swaps normalize exactly as recorded', async () => {
    const rpc = new ReplayRpc(f.swaps.recording)
    const pools = new PoolRegistry(rpc)
    const oracle = new QuoteOracle()
    await oracle.seed(rpc)
    const parser = new TradeParser(pools, oracle, new MakerResolver(rpc, 1), () => null)
    const got = []
    for (const l of f.swaps.logs) got.push(await parser.parse(l))
    expect(got).toEqual(f.swaps.expected)
    expect(got.filter(Boolean).length).toBe(f.swaps.logs.length)
  })

  test('every trade is internally consistent', () => {
    for (const t of f.swaps.expected) {
      if (!t) continue
      expect(t.tradeId).toBe(`${t.txHash}:${t.logIndex}`)
      expect(['BUY', 'SELL']).toContain(t.side)
      expect(t.price).toBeGreaterThan(0)
      expect(t.baseAmount).toBeGreaterThan(0)
      expect(t.wallet).toMatch(/^0x[0-9a-f]{40}$/)
      // Execution price sits within a few % of the pool price (fees/taxes, price impact).
      const exec = t.quoteAmount / t.baseAmount
      expect(Math.abs(exec / t.price - 1)).toBeLessThan(0.15)
      // Sells execute below the post-trade pool price on average only with fees; buys pay up.
      if (t.side === 'BUY') expect(exec).toBeGreaterThanOrEqual(t.price * 0.97)
    }
  })

  test('a Swap-shaped event from a contract that is not a factory pool is rejected', async () => {
    const fake = { ...f.swaps.logs[0], address: '0x' + '9'.repeat(40) }
    const rpc = new ReplayRpc({})
    const parser = new TradeParser(new PoolRegistry(rpc), new QuoteOracle(), new MakerResolver(rpc, 1), () => null)
    expect(await parser.parse(fake)).toBeNull()
  })
})

describe('pairs and quotes', () => {
  const USDC = '0x3600000000000000000000000000000000000000', ARGUS = '0xece5ca8bf9220718e5727754026757512212cb3c', NATIVE = '0x' + '0'.repeat(40), X = '0x' + '7'.repeat(40)
  test('the quote is the preferred known asset; the other side is the base', () => {
    expect(pickQuote(ARGUS, USDC)).toEqual({ base: ARGUS, quote: USDC })
    expect(pickQuote(USDC, X)).toEqual({ base: X, quote: USDC })
    expect(pickQuote(NATIVE, X)).toEqual({ base: X, quote: NATIVE })
    expect(pickQuote(X, ARGUS)).toEqual({ base: X, quote: ARGUS })
    expect(pickQuote(X, '0x' + '8'.repeat(40))).toBeNull()
  })
})

describe('ArcLaunchpadAdapter', () => {
  const word = (n: bigint) => n.toString(16).padStart(64, '0')
  const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0')
  test('curve trades normalize with the post-trade curve price', async () => {
    const token = '0x' + '5'.repeat(40), trader = '0x' + '6'.repeat(40)
    const rUsdc = 1_000_000_000n, rToken = 900_000_000n * 10n ** 18n
    const log: RawLog = {
      address: '0xef6a8fdaf0181e19cc2c7575ada4b9c279809a67', topics: [CURVE_TRADE, topic(token), topic(trader)],
      data: '0x' + [1n, 50_000_000n, 10n ** 21n, 500_000n, rUsdc, rToken].map(word).join(''),
      blockNumber: '0x10', blockTimestamp: '0x66000000', transactionHash: '0x' + 'c'.repeat(64), logIndex: '0x3',
    }
    const t = await new ArcLaunchpadAdapter().parseTrade(log)
    expect(t!.side).toBe('BUY')
    expect(t!.usdValue).toBe(50)
    expect(t!.tokenAmount).toBe(1000)
    expect(t!.priceUsd).toBeCloseTo(curvePrice(rUsdc, rToken), 12)
    // $8,000 + $1,000 virtual USDC over 900M + 200M virtual tokens
    expect(t!.priceUsd).toBeCloseTo(9_000 / 1_100_000_000, 12)
    expect(t!.wallet).toBe(trader)
  })
})

describe('untrusted launch metadata', () => {
  test('control and bidi characters are stripped, length capped', () => {
    expect(cleanText('Doge\u0000‮ coin​')).toBe('Doge coin')
    expect(cleanText('x'.repeat(100), 10)).toBe('x'.repeat(10))
  })
  test('only https/ipfs images pass', () => {
    expect(cleanImage('javascript:alert(1)')).toBeNull()
    expect(cleanImage('https://x.io/a.png" onerror="x')).toBeNull()
    expect(cleanImage('ipfs://bafkreiabc')).toBe('https://ipfs.io/ipfs/bafkreiabc')
    expect(cleanImage('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
  })
  test('malformed ABI strings are refused, not read out of bounds', () => {
    expect(abiString('0x' + 'ff'.repeat(32), 0)).toBeNull()               // absurd offset
    expect(abiString('0x' + '0'.repeat(62) + '20' + '0'.repeat(60) + 'ffff', 0)).toBeNull() // length past the end
  })
})
