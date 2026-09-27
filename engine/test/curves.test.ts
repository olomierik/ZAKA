// The Mercuri and SolonPad adapters: launches from their factories, trades
// from each launch's own curve (any address, trusted only once the factory
// names it). The logs are encoded from the launchpads' published ABIs
// (api/_curves.ts), and the RPC is an in-memory double: no recorded mainnet
// data exists for these launchpads yet.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters } from 'viem'
import { RpcError, type RawLog } from '../../api/_arcLogs'
import { MERCURI_BUY, MERCURI_FACTORY, MERCURI_SELL, MERCURI_TOKEN_CREATED, SEL, SOLONPAD_FACTORY, SOLON_BUY, SOLON_SELL, SOLON_TOKEN_LAUNCHED } from '../../api/_curves'
import type { Rpc } from '../src/chain/http'
import { AdapterRegistry, type AdapterContext } from '../src/launchpads/adapter'
import { ArcLaunchpadAdapter } from '../src/launchpads/arcLaunchpad'
import { ArgusAdapter } from '../src/launchpads/argus'
import { MercuriAdapter } from '../src/launchpads/mercuri'
import { SolonPadAdapter } from '../src/launchpads/solonpad'

const E18 = 10n ** 18n
const NATIVE = '0x0000000000000000000000000000000000000000'
const a = (b: string) => '0x' + b.repeat(20)
const TOKEN = a('b1'), CURVE = a('c1'), CREATOR = a('d1'), TRADER = a('e1'), SENDER = a('f1')
const topic = (x: string) => '0x' + x.slice(2).padStart(64, '0')
const pad = (x: string) => x.slice(2).padStart(64, '0')
const u = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
const addr = (x: string) => encodeAbiParameters([{ type: 'address' }], [x as `0x${string}`])
let n = 0
const log = (address: string, topics: string[], data: string): RawLog => ({
  address, topics, data, blockNumber: '0x100', blockTimestamp: '0x66f5a000', transactionHash: '0x' + (++n).toString(16).padStart(64, '0'), logIndex: '0x1',
})

/** eth_call answers keyed by `to|data`; an unknown call reverts, like a contract without that function. */
class FakeRpc implements Rpc {
  readonly seen: string[] = []
  down = false
  constructor(readonly answers = new Map<string, string>()) {}
  set(to: string, data: string, result: string) { this.answers.set(`${to.toLowerCase()}|${data}`, result); return this }
  call<T>(method: string, params: unknown[]): Promise<T> {
    try { return Promise.resolve(this.answer(method, params) as T) } catch (e) { return Promise.reject(e instanceof Error ? e : new Error(String(e))) }
  }
  private answer(method: string, params: unknown[]): string {
    if (this.down) throw new TypeError('fetch failed') // the network, not the contract
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string }
      this.seen.push(`${to.toLowerCase()}|${data}`)
      const r = this.answers.get(`${to.toLowerCase()}|${data}`)
      if (r === undefined) throw new RpcError('execution reverted', 3)
      return r
    }
    throw new RpcError(`unexpected ${method}`)
  }
  async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
    return Promise.all(calls.map(c => this.call<T>(c.method, c.params).catch(() => null)))
  }
}
const ctxOf = (rpc: Rpc, sender?: string): AdapterContext => ({ rpc, pools: null as never, sender: sender ? () => Promise.resolve(sender) : undefined })

// Mercuri's LaunchConfig at deployment: $6,000 virtual USDC, 1,066,666,666 virtual tokens, 1% fee, 99% snipe tax over 120 blocks.
const CONFIG = [6_000n * E18, 1_066_666_666n * E18, 800_000_000n * E18, 200_000_000n * E18, E18, 50_000_000n * E18, 100, 5_000, 2_000, 9_900, 120] as const
const LAUNCH_CONFIG = { type: 'tuple', components: [
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint32' }] } as const
const tokenCreated = (token = TOKEN, curve = CURVE) => log(MERCURI_FACTORY, [MERCURI_TOKEN_CREATED, topic(token), topic(curve), topic(CREATOR)],
  encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }, LAUNCH_CONFIG],
    [a('99') as `0x${string}`, 'Mercury Frog', 'MFROG', 'ipfs://bafy/meta.json', ('0x' + 'ab'.repeat(32)) as `0x${string}`, CONFIG]))
// Buy: 9.9 net USDC in, 1.3M tokens out, 0.1 fee, 0.5 snipe tax; after it 1,000 real USDC, 100M sold.
const mBuy = (curve = CURVE) => log(curve, [MERCURI_BUY, topic(TRADER)], encodeAbiParameters(Array(6).fill({ type: 'uint256' }), [99n * E18 / 10n, 1_300_000n * E18, E18 / 10n, E18 / 2n, 1_000n * E18, 100_000_000n * E18]))
const mSell = (curve = CURVE) => log(curve, [MERCURI_SELL, topic(TRADER)], encodeAbiParameters(Array(5).fill({ type: 'uint256' }), [400_000n * E18, 27n * E18 / 10n, 3n * E18 / 100n, 997n * E18, 99_600_000n * E18]))
/** A curve launched before the engine's window: the chain says who it is. */
const mercuriChain = (rpc = new FakeRpc()) => rpc
  .set(CURVE, SEL.token, addr(TOKEN))
  .set(MERCURI_FACTORY, SEL.curveOf + pad(TOKEN), addr(CURVE))
  .set(CURVE, SEL.virtualUsdc, u(CONFIG[0]))
  .set(CURVE, SEL.virtualTokens, u(CONFIG[1]))

describe('Mercuri', () => {
  test('a launch: token, its curve as the pool, name, symbol, creator and opening price', async () => {
    const m = new MercuriAdapter()
    const l = await m.parseLaunch(tokenCreated())
    expect(l).toMatchObject({ token: TOKEN, pool: CURVE, quote: NATIVE, name: 'Mercury Frog', symbol: 'MFROG', creator: CREATOR, launchpad: 'Mercuri', decimals: 18 })
    expect(l!.priceUsd).toBeCloseTo(6_000 / 1_066_666_666, 15)
    expect(m.curves.get(CURVE)?.token).toBe(TOKEN)
  })

  test('the curve\'s trades, priced from the reserves in each event; no RPC for a curve seen launching', async () => {
    const m = new MercuriAdapter(), rpc = new FakeRpc()
    await m.parseLaunch(tokenCreated())
    const buy = await m.parseTrade(mBuy(), ctxOf(rpc))
    expect(buy).toMatchObject({ token: TOKEN, pool: CURVE, quote: NATIVE, side: 'BUY', dex: 'mercuri-curve', launchpad: 'Mercuri', wallet: TRADER })
    expect(buy!.tokenAmount).toBeCloseTo(1_300_000, 6)
    expect(buy!.usdValue).toBeCloseTo(10.5, 9) // net + fee + tax: what the buyer paid
    expect(buy!.priceUsd).toBeCloseTo(7_000 / 966_666_666, 15)
    expect(buy!.liquidity).toBeCloseTo(1_000, 9)
    const sell = await m.parseTrade(mSell(), ctxOf(rpc))
    expect(sell!.side).toBe('SELL')
    expect(sell!.usdValue).toBeCloseTo(2.7, 9)
    expect(sell!.priceUsd).toBeCloseTo(6_997 / 967_066_666, 15)
    expect(rpc.seen).toEqual([])
  })

  test('the wallet is the transaction\'s sender when known (a router in between names itself)', async () => {
    const m = new MercuriAdapter()
    await m.parseLaunch(tokenCreated())
    expect((await m.parseTrade(mBuy(), ctxOf(new FakeRpc(), SENDER)))!.wallet).toBe(SENDER)
  })

  test('a curve from before the engine\'s window: verified once through the factory, however many trades arrive together', async () => {
    const m = new MercuriAdapter(), rpc = mercuriChain()
    const trades = await Promise.all([mBuy(), mSell(), mBuy()].map(l => m.parseTrade(l, ctxOf(rpc))))
    expect(trades.every(t => t?.token === TOKEN)).toBe(true)
    expect(rpc.seen.filter(k => k.endsWith(SEL.token))).toHaveLength(1)
    expect(m.curves.get(CURVE)?.virtual.usdc).toBe(CONFIG[0])
  })

  test('a Buy-shaped event from a contract the factory doesn\'t name is refused, and remembered', async () => {
    const m = new MercuriAdapter()
    const fake = a('66')
    // A convincing copy: claims the real token and answers every curve view, but the factory names another curve.
    const rpc = mercuriChain().set(fake, SEL.token, addr(TOKEN)).set(fake, SEL.virtualUsdc, u(CONFIG[0])).set(fake, SEL.virtualTokens, u(CONFIG[1]))
    expect(await m.parseTrade(mBuy(fake), ctxOf(rpc))).toBeNull()
    const before = rpc.seen.length
    expect(await m.parseTrade(mBuy(fake), ctxOf(rpc))).toBeNull()
    expect(rpc.seen.length).toBe(before)
    // No token() at all (reverts): refused too.
    expect(await m.parseTrade(mBuy(a('67')), ctxOf(rpc))).toBeNull()
  })

  test('a check the network couldn\'t answer isn\'t remembered: the next trade retries', async () => {
    const m = new MercuriAdapter(), rpc = mercuriChain()
    rpc.down = true
    expect(await m.parseTrade(mBuy(), ctxOf(rpc))).toBeNull()
    rpc.down = false
    expect((await m.parseTrade(mBuy(), ctxOf(rpc)))?.token).toBe(TOKEN)
  })

  test('launch events count only from the factory; malformed ones are refused', async () => {
    const m = new MercuriAdapter()
    const l = tokenCreated()
    expect(m.matches({ ...l, address: a('77') })).toBe(false)
    expect(await m.parseLaunch({ ...l, address: a('77') })).toBeNull()
    expect(await m.parseLaunch({ ...l, data: l.data.slice(0, 200) })).toBeNull()
  })
})

// SolonPad's getLaunchedToken: a static struct, returned inline (15 words).
const launched = (curve: string, pair = NATIVE, exists = true) => encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint24' }, { type: 'int24' }, { type: 'uint16' }, { type: 'bool' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
  [TOKEN as `0x${string}`, curve as `0x${string}`, CREATOR as `0x${string}`, CREATOR as `0x${string}`, pair as `0x${string}`, 10_000n * E18, 0, 200, 0, true, 0, 0n, 0n, 0n, exists])
const tokenLaunched = (pair = NATIVE) => log(SOLONPAD_FACTORY, [SOLON_TOKEN_LAUNCHED, topic(TOKEN), topic(CURVE), topic(CREATOR)],
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [pair as `0x${string}`, 0n, 10_000n * E18]))
// CurveBuy: 10 USDC in, 970,000 tokens, 0.1 fee, 0.2 tax → 9.7 on the curve. To the recipient (the trader).
const sBuy = (curve = CURVE) => log(curve, [SOLON_BUY, topic(a('11')), topic(TRADER)], encodeAbiParameters(Array(4).fill({ type: 'uint256' }), [10n * E18, 970_000n * E18, E18 / 10n, E18 / 5n]))
const sSell = (curve = CURVE) => log(curve, [SOLON_SELL, topic(TRADER), topic(TRADER)], encodeAbiParameters(Array(4).fill({ type: 'uint256' }), [100_000n * E18, 97n * E18 / 100n, E18 / 100n, E18 / 50n]))
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s])

describe('SolonPad', () => {
  test('a native-USDC curve launch: name and symbol from the token, the opening price from the curve', async () => {
    const s = new SolonPadAdapter()
    const rpc = new FakeRpc()
      .set(TOKEN, '0x06fdde03', str('Solon Frog')).set(TOKEN, '0x95d89b41', str('SFROG')).set(TOKEN, '0x313ce567', u(18n))
      .set(CURVE, SEL.getReserves, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [4_000n * E18, 800_000_000n * E18]))
    const l = await s.parseLaunch(tokenLaunched(), ctxOf(rpc))
    expect(l).toMatchObject({ token: TOKEN, pool: CURVE, quote: NATIVE, name: 'Solon Frog', symbol: 'SFROG', creator: CREATOR, launchpad: 'SolonPad' })
    expect(l!.priceUsd).toBeCloseTo(4_000 / 800_000_000, 15)
    expect(s.curves.get(CURVE)?.token).toBe(TOKEN)
  })

  test('a curve quoted in another ERC-20 (a tokenized stock) isn\'t indexed', async () => {
    const s = new SolonPadAdapter()
    expect(await s.parseLaunch(tokenLaunched(a('2b')), ctxOf(new FakeRpc()))).toBeNull()
  })

  test('trades: the recipient as trader, priced at what the trade paid on the curve', async () => {
    const s = new SolonPadAdapter()
    const rpc = new FakeRpc().set(CURVE, SEL.token, addr(TOKEN)).set(SOLONPAD_FACTORY, SEL.getLaunchedToken + pad(TOKEN), launched(CURVE))
    const buy = await s.parseTrade(sBuy(), ctxOf(rpc))
    expect(buy).toMatchObject({ token: TOKEN, side: 'BUY', wallet: TRADER, dex: 'solonpad-curve', launchpad: 'SolonPad', liquidity: null })
    expect(buy!.usdValue).toBeCloseTo(10, 9)
    expect(buy!.priceUsd).toBeCloseTo(0.00001, 15)
    const sell = await s.parseTrade(sSell(), ctxOf(rpc))
    expect(sell!.side).toBe('SELL')
    expect(sell!.priceUsd).toBeCloseTo(0.00001, 15) // (0.97 received + 0.01 fee + 0.02 tax) / 100,000
  })

  test('refused: a curve the factory names differently, an ERC-20-quoted one, one that doesn\'t exist', async () => {
    for (const answer of [launched(a('c9')), launched(CURVE, a('2b')), launched(CURVE, NATIVE, false)]) {
      const s = new SolonPadAdapter()
      const rpc = new FakeRpc().set(CURVE, SEL.token, addr(TOKEN)).set(SOLONPAD_FACTORY, SEL.getLaunchedToken + pad(TOKEN), answer)
      expect(await s.parseTrade(sBuy(), ctxOf(rpc))).toBeNull()
    }
  })
})

describe('with the other adapters', () => {
  test('each log goes to the adapter it belongs to', () => {
    const reg = new AdapterRegistry([new ArgusAdapter(), new ArcLaunchpadAdapter(), new MercuriAdapter(), new SolonPadAdapter()])
    expect(reg.find(tokenCreated())?.name).toBe('Mercuri')
    expect(reg.find(mBuy())?.name).toBe('Mercuri')
    expect(reg.find(tokenLaunched())?.name).toBe('SolonPad')
    expect(reg.find(sSell())?.name).toBe('SolonPad')
    expect(reg.find(log(a('12'), ['0x' + '12'.repeat(32)], '0x'))).toBeUndefined()
  })
  test('the stream follows both factories and every curve-shaped event', () => {
    const f = [new MercuriAdapter(), new SolonPadAdapter()].flatMap(x => x.filters())
    expect(f).toContainEqual({ address: MERCURI_FACTORY, topics: [MERCURI_TOKEN_CREATED] })
    expect(f).toContainEqual({ topics: [[MERCURI_BUY, MERCURI_SELL]] })
    expect(f).toContainEqual({ address: SOLONPAD_FACTORY, topics: [SOLON_TOKEN_LAUNCHED] })
    expect(f).toContainEqual({ topics: [[SOLON_BUY, SOLON_SELL]] })
  })
})
