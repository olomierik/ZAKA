// Live trading: the Universal Router calls the bot sends (trading/live.ts),
// read against real Arc transactions (fixtures/ur-swaps.json, recorded by
// engine/scripts/capture-ur-swaps.ts) and the site's own encoder; what a
// receipt says the bot paid and got; the owner's signed switch
// (bot/control.ts); and the live trader's limits and exits
// (bot/liveTrader.ts) against a stand-in wallet.
import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { botControlMessage } from '../../api/_marketProtocol'
import { ControlVerifier, parseControl } from '../src/bot/control'
import { DEFAULT_LIMITS, LiveTrader } from '../src/bot/liveTrader'
import type { PoolInfo } from '../src/dex/pools'
import { deltasOf, encodeBuy, encodeSell, gasUsdOf, keyOf, minOutOf, NATIVE, ROUTERS, USDC20, usdcSide, usdcUnits, type LiveExecutor, type PoolKey } from '../src/trading/live'
import { STRATEGIES, type Position } from '../src/trading/paper'
import fixtures from './fixtures/ur-swaps.json'

const UR = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const decode = (data: Hex) => {
  const { args } = decodeFunctionData({ abi: UR, data })
  const [commands, inputs] = args as unknown as [Hex, Hex[]]
  return { commands, inputs }
}
const actionsOf = (input: Hex) => decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], input) as unknown as [Hex, Hex[]]
const ROUTER = ROUTERS[1]
const BOT = '0x9999999999999999999999999999999999999999' as Address
const DEADLINE = 1_800_000_000n

describe('the calls', () => {
  test('a swap is encoded exactly as a real Arc buy in an ERC-20 USDC pool', () => {
    // That buy (through Permit2): 1.7 USDC into the pool below, its minimum out as sent.
    const real = decode(fixtures.erc20Buy.input as Hex)
    const [, realParams] = actionsOf(real.inputs[0])
    const words = realParams[0].slice(2).match(/.{64}/g)!
    const key: PoolKey = { currency0: USDC20, currency1: ('0x' + words[2].slice(24)) as Address, fee: parseInt(words[3], 16), tickSpacing: parseInt(words[4], 16), hooks: ('0x' + words[5].slice(24)) as Address }
    const amountIn = BigInt('0x' + words[7]), minOut = BigInt('0x' + words[8])
    const ours = decode(encodeBuy(ROUTER, key, key.currency1, USDC20, amountIn, minOut, BOT, DEADLINE).data)
    const [acts, params] = actionsOf(ours.inputs[0])
    expect(params[0]).toBe(realParams[0]) // pool key, direction, amounts, minHopPriceX36, hook data: byte for byte
    expect(acts).toBe('0x060b0f') // swap, SETTLE (the router pays), TAKE_ALL
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], params[1])).toEqual([USDC20 as never, 0n, false])
    expect(ours.commands).toBe('0x1004') // V4_SWAP, then SWEEP what the pool didn't take
  })
  test('an ERC-20 USDC pool buy sends the USDC as msg.value (18 decimals)', () => {
    const key: PoolKey = { currency0: USDC20, currency1: '0x4dfc1fbe5367ef41659945aaa57ccccbe3fdaa08', fee: 10_000, tickSpacing: 200, hooks: NATIVE }
    expect(encodeBuy(ROUTER, key, key.currency1, USDC20, 1_700_000n, 1n, BOT, DEADLINE).value).toBe(1_700_000n * 10n ** 12n)
  })
  test('a native-USDC pool buy matches the site\'s (already checked) buy without fees', async () => {
    const site = await import('../../src/arcdex/api/universalRouter')
    const key: PoolKey = { currency0: NATIVE, currency1: '0x2764a16a039b450cd61837da395b735fdda528fb', fee: 0, tickSpacing: 25, hooks: '0xb6a65950534f061618b4ae102fbcbb8541a8e0cc' }
    const value = 7_300_000_000_000_000_000n, minOut = 123_456n
    const theirs = site.encodeNativeBuy(key, value, [], minOut, BOT)
    const ours = encodeBuy(ROUTER, key, key.currency1, NATIVE, value, minOut, BOT, DEADLINE)
    expect(decode(ours.data)).toEqual({ commands: theirs.commands, inputs: theirs.inputs })
    expect(ours.value).toBe(value)
  }, 30_000) // loading the site's module takes a few seconds
  test('a sell: the coin through Permit2 (SETTLE_ALL), the USDC to the bot (TAKE_ALL); direction from the key', () => {
    const tokenLow = '0x1111111111111111111111111111111111111111' as Address // sorts before USDC: currency0
    const key: PoolKey = { currency0: tokenLow, currency1: USDC20, fee: 10_000, tickSpacing: 200, hooks: NATIVE }
    const { commands, inputs } = decode(encodeSell(ROUTER, key, tokenLow, USDC20, 5_000n, 90n, DEADLINE).data)
    expect(commands).toBe('0x10')
    const [acts, params] = actionsOf(inputs[0])
    expect(acts).toBe('0x060c0f')
    const zeroForOne = BigInt('0x' + params[0].slice(2).match(/.{64}/g)![6])
    expect(zeroForOne).toBe(1n)
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1])).toEqual([tokenLow as never, 5_000n])
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2])).toEqual([USDC20 as never, 90n])
  })
  test('pools the bot can trade: v4, USDC (ERC-20 or native) against the coin', () => {
    const pool = (c0: string, c1: string, dex: PoolInfo['dex'] = 'uniswap-v4'): PoolInfo => ({ pool: '0x', dex, currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: null, base: c1, quote: c0, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 })
    const T = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'
    expect(usdcSide(keyOf(pool(USDC20, T))!, T)).toBe(USDC20)
    expect(usdcSide(keyOf(pool(NATIVE, T))!, T)).toBe(NATIVE)
    expect(usdcSide(keyOf(pool('0x' + 'a'.repeat(40), T))!, T)).toBeNull() // quoted in another coin
    expect(keyOf(pool(USDC20, T, 'uniswap-v3'))).toBeNull()
    expect(keyOf(null)).toBeNull()
  })
  test('amounts and slippage', () => {
    expect(usdcUnits(USDC20, 5)).toBe(5_000_000n)
    expect(usdcUnits(NATIVE, 5)).toBe(5n * 10n ** 18n)
    expect(minOutOf(1_000n, 1_000)).toBe(900n)
    expect(minOutOf(1_000n, 20_000)).toBe(10n) // never below 1% of the quote
  })
})

describe('what a receipt says', () => {
  test('the ERC-20 USDC buy: 1.7 USDC out (counted once, not twice), the coins in', () => {
    const d = deltasOf(fixtures.erc20Buy.logs as never, fixtures.erc20Buy.from, '0x4dfc1fbe5367ef41659945aaa57ccccbe3fdaa08')
    expect(d.usdc18).toBe(-1_700_000_000_000_000_000n)
    expect(d.tokens).toBe(69_480_717_379_125_764_982_595n)
  })
  test('the native buy: 7.3 USDC out, the coins in', () => {
    const d = deltasOf(fixtures.nativeBuy.logs as never, fixtures.nativeBuy.from, '0x2764a16a039b450cd61837da395b735fdda528fb')
    expect(d.usdc18).toBe(-7_300_000_000_000_000_000n)
    expect(d.tokens).toBe(1_715_967_489_423_712_348_520_597n)
  })
  test('gas in USD', () => {
    expect(gasUsdOf({ gasUsed: BigInt(fixtures.erc20Buy.gasUsed), effectiveGasPrice: BigInt(fixtures.erc20Buy.effectiveGasPrice) })).toBeCloseTo(0.00313, 5)
  })
})

describe("the owner's switch", () => {
  const OWNER = '0x414b6be4cf906739fbf7d49165beca5f4cec3da0' as Address
  const SIG = ('0x' + 'ab'.repeat(65)) as Hex
  const now = 1_790_730_000_000
  test('the text signed is fixed', () => {
    expect(botControlMessage({ action: 'mode', mode: 'live' }, now)).toBe('ARCDEX signal bot\nSwitch the bot to LIVE trading with real money\nAt: 2026-09-30T01:00:00.000Z')
    expect(botControlMessage({ action: 'close-live' }, now)).toContain('Sell every live position now')
  })
  test('requests are checked for shape', () => {
    expect(parseControl({ action: 'mode', mode: 'live', at: now, signature: SIG })).toEqual({ control: { action: 'mode', mode: 'live' }, at: now, signature: SIG })
    expect(parseControl({ action: 'mode', mode: 'yolo', at: now, signature: SIG })).toBe('unknown action')
    expect(parseControl({ action: 'close-live', at: now, signature: '0x12' })).toMatch(/signature/)
    expect(parseControl(null)).toMatch(/JSON/)
  })
  test("only the owner's signature, fresh, once", async () => {
    let asked: { address: Address; message: string } | null = null
    const v = new ControlVerifier(OWNER, [], async a => { asked = a; return a.signature === SIG })
    const req = { control: { action: 'mode', mode: 'live' } as const, at: now, signature: SIG }
    expect(await v.verify(req, now + 1_000)).toBeNull()
    expect(asked!.address).toBe(OWNER)
    expect(asked!.message).toBe(botControlMessage(req.control, now))
    expect(await v.verify(req, now + 2_000)).toMatch(/already used/)
    expect(await v.verify({ ...req, signature: ('0x' + 'cd'.repeat(65)) as Hex }, now)).toMatch(/owner/)
    expect(await v.verify({ ...req, signature: ('0x' + 'ef'.repeat(65)) as Hex, at: now - 6 * 60_000 }, now)).toMatch(/too old/)
    expect(await new ControlVerifier(null, [], async () => true).verify(req, now)).toMatch(/BOT_OWNER_ADDRESS/)
  })
})

describe('the live trader (stand-in wallet)', () => {
  const T = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1' as Address
  const pool: PoolInfo = { pool: '0xpool', dex: 'uniswap-v4', currency0: USDC20, currency1: T, fee: 10_000, tickSpacing: 200, hooks: null, base: T, quote: USDC20, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 }
  const E18 = 10n ** 18n
  const setup = (o: { balance?: number; sellFails?: number } = {}) => {
    const calls: string[] = []
    let held = 0n, fails = o.sellFails ?? 0
    const exec = {
      address: BOT,
      balanceUsd: async () => o.balance ?? 100,
      buy: async (_p: PoolInfo, _t: Address, usd: number) => { calls.push(`buy ${usd}`); held = BigInt(usd) * 1000n * E18; return { hash: '0xb' as Hex, tokens: held, usd, gasUsd: 0.01, at: Date.now() } },
      approveForSale: async () => { calls.push('approve'); return [] },
      tokenBalance: async () => held,
      sell: async (_p: PoolInfo, _t: Address, amount: bigint, bps: number) => {
        if (fails > 0) { fails--; calls.push(`sell failed ${bps}`); throw new Error('would fail') }
        calls.push(`sell ${Number(amount / E18)} @${bps}`); held -= amount
        return { hash: '0xs' as Hex, tokens: amount, usd: Number(amount / E18) / 1000 * 1.3, gasUsd: 0.01, at: Date.now() }
      },
    } as unknown as LiveExecutor
    const positions: Position[] = []
    const lt = new LiveTrader({ exec, limits: DEFAULT_LIMITS, positions: () => positions, params: s => STRATEGIES[s], save: () => {} })
    lt.setPools(() => pool)
    const meta = { token: T, symbol: 'C', launchpad: 'ARGUS' } as never
    const signal = (id: string) => ({ id, token: T, strategy: 'scalp' } as never)
    return { lt, calls, positions, meta, signal }
  }
  const settle = () => new Promise(r => setTimeout(r, 10))

  test('buys the strategy size (capped at the limit), approves the sale right away', async () => {
    const { lt, calls, positions, meta, signal } = setup({ balance: 1_000 })
    await lt.open(signal('s1'), 'snipe', pool, meta)
    expect(calls).toEqual(['buy 25', 'approve'])
    expect(positions[0]).toMatchObject({ mode: 'live', strategy: 'snipe', sizeUsd: 25, status: 'open' })
    expect(positions[0].qty).toBeCloseTo(25_000, 6)
  })
  test('reads the balance before every buy: no trade over 20% of what the wallet is worth, and the target shrinks with it', async () => {
    const { lt, calls, positions, meta, signal } = setup({ balance: 30 })
    await lt.open(signal('s1'), 'snipe', pool, meta, { sizeUsd: 10, extra: { targetUsd: 3 } })
    expect(calls).toEqual(['buy 6', 'approve']) // 20% of $30
    expect(positions[0]).toMatchObject({ sizeUsd: 6, targetUsd: 1.8 })
  })
  test('open trades count toward what the wallet is worth', async () => {
    const { lt, calls, positions, meta, signal } = setup({ balance: 30 })
    positions.push({ mode: 'live', status: 'open', token: '0x' + 'c3'.repeat(20), strategy: 'snipe', sizeUsd: 20, qty: 1, remaining: 1 } as Position)
    await lt.open(signal('s1'), 'scalp', pool, meta, { sizeUsd: 12 })
    expect(calls).toEqual(['buy 10', 'approve']) // 20% of $30 + $20 open
  })
  test('a wallet too small for a $1 trade waits (a $10 wallet trades)', async () => {
    const { lt, calls, positions, meta, signal } = setup({ balance: 4 })
    await lt.open(signal('s1'), 'scalp', pool, meta, { sizeUsd: 5 })
    expect(calls).toEqual([])
    expect(positions).toEqual([])
    expect(lt.events[0].text).toMatch(/at most 20% of it, under the \$1 minimum/)
  })
  test('a $10 wallet trades: 20% of it, $2', async () => {
    const { lt, calls, meta, signal } = setup({ balance: 10 })
    await lt.open(signal('s1'), 'scalp', pool, meta, { sizeUsd: 5 })
    expect(calls[0]).toBe('buy 2')
  })
  test('never trades below the reserve', async () => {
    const { lt, calls, positions, meta, signal } = setup({ balance: 6 })
    positions.push({ mode: 'live', status: 'open', token: '0x' + 'c3'.repeat(20), strategy: 'snipe', sizeUsd: 40, qty: 1, remaining: 1 } as Position)
    await lt.open(signal('s1'), 'scalp', pool, meta) // 20% of $46 allows $5, but $5 + $2 reserve > $6
    expect(calls).toEqual([])
    expect(positions).toHaveLength(1)
    expect(lt.events[0].text).toMatch(/keeps \$2 back/)
  })
  test('a venue it can\'t reach stays paper', async () => {
    const { lt, calls, meta, signal } = setup()
    await lt.open(signal('s1'), 'scalp', null, meta)
    expect(calls).toEqual([])
    expect(lt.events[0].text).toMatch(/paper only/)
  })
  test('a scalp\'s take-profit sells the whole balance: the profit is secured and the trade closed', async () => {
    const { lt, calls, positions, meta, signal } = setup()
    await lt.open(signal('s1'), 'scalp', pool, meta)
    const p = positions[0]
    lt.onPrice(p, p.marketEntry * 1.1, Date.now(), false) // short of +15%
    await settle()
    expect(calls.slice(2)).toEqual([])
    lt.onPrice(p, p.marketEntry * 1.16, Date.now(), false)
    await settle()
    expect(calls.slice(2)).toEqual(['sell 5000 @1500'])
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    expect(p.pnlUsd!).toBeCloseTo(5 * 1.3 - 5 - 0.02, 6) // proceeds − size − gas (buy + sell)
  })
  test('the creator selling, or a rug alarm, sells everything at once', async () => {
    for (const how of ['creator', 'rug'] as const) {
      const { lt, calls, positions, meta, signal } = setup()
      await lt.open(signal('s1'), 'scalp', pool, meta)
      const p = positions[0]
      if (how === 'creator') lt.onPrice(p, p.marketEntry * 1.05, Date.now(), true)
      else lt.closeNow(p, 'rug')
      await settle()
      expect(calls.slice(2)).toEqual(['sell 5000 @1500'])
      expect(p).toMatchObject({ status: 'closed', exitReason: how })
    }
  })
  test('a failing sale is retried with more slippage, then marked stuck', async () => {
    const { lt, calls, positions, meta, signal } = setup({ sellFails: 3 })
    await lt.open(signal('s1'), 'scalp', pool, meta)
    const p = positions[0]
    lt.closeNow(p, 'manual')
    await settle()
    expect(calls.slice(2)).toEqual(['sell failed 1500', 'sell failed 3500', 'sell failed 6000'])
    expect(p.status).toBe('open')
    expect(p.stuck).toMatch(/would fail/)
    lt.closeNow(p, 'manual') // the next try goes through
    await settle()
    expect(p).toMatchObject({ status: 'closed', exitReason: 'manual', stuck: null })
  })
  test('no new position after the day\'s loss limit', async () => {
    const { lt, calls, positions, meta, signal } = setup()
    positions.push({ mode: 'live', token: '0xother', status: 'closed', closedAt: Date.now(), pnlUsd: -DEFAULT_LIMITS.dailyLossUsd, strategy: 'snipe' } as Position)
    await lt.open(signal('s2'), 'snipe', pool, meta)
    expect(calls).toEqual([])
    expect(lt.events[0].text).toMatch(/limit/)
  })
})
