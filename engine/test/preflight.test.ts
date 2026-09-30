// Every live swap is meant to go through on-chain (owner's request,
// 2026-09-30): the pre-flight (trading/preflight.ts: the exact buy and the
// sale of all it delivers, as the bot's wallet, in one eth_call), how the
// executor sends (trading/live.ts: simulated first, gas and fees with room,
// signed here, nonces corrected, resent while unconfirmed), and what the
// trader does with each outcome (bot/liveTrader.ts). The harness itself ran
// in a local EVM against stand-in router, Permit2 and coin contracts that
// decode these same calls (engine/README.md); here the chain is a stand-in.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, keccak256, pad, parseAbi, parseTransaction, toHex, type Address, type Hex } from 'viem'
import { DEFAULT_LIMITS, LiveTrader, roundTripVerdict } from '../src/bot/liveTrader'
import type { PoolInfo } from '../src/dex/pools'
import { encodeSell, LiveError, LiveExecutor, PERMIT2, revertReason, ROUTERS, USDC20, type Reader } from '../src/trading/live'
import { decodeRoundTrip, gasLimitOf, judgeRoundTrip, patchesOf, PREFLIGHT_CALLER, roundTripSteps, SENTINEL, type RoundTrip, type StepResult } from '../src/trading/preflight'
import { ROUNDTRIP_ABI, ROUNDTRIP_RUNTIME } from '../src/trading/roundTripBuild'
import { STRATEGIES, type Position } from '../src/trading/paper'

const T = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1' as Address
const E18 = 10n ** 18n
const POOL: PoolInfo = { pool: '0xpool', dex: 'uniswap-v4', currency0: USDC20, currency1: T, fee: 10_000, tickSpacing: 200, hooks: null, base: T, quote: USDC20, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 }
const KEY = { currency0: USDC20, currency1: T, fee: 10_000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' as Address }
const ERRS = parseAbi(['error Error(string)', 'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)', 'error ExecutionFailed(uint256 commandIndex, bytes message)', 'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)', 'error UnexpectedRevertBytes(bytes revertData)', 'error NotEnoughLiquidity(bytes32 poolId)', 'error Panic(uint256 code)'])
const tooLittle = encodeErrorResult({ abi: ERRS, errorName: 'V4TooLittleReceived', args: [10n, 5n] })
const errorString = (s: string) => encodeErrorResult({ abi: ERRS, errorName: 'Error', args: [s] })
const step = (o: Partial<StepResult>): StepResult => ({ ok: true, gasUsed: 100_000n, usdc: 0n, tokens: 0n, ret: '0x', ...o })

describe('the pre-flight: what runs', () => {
  const router = ROUTERS[0]
  const sell = encodeSell(router, KEY, T, USDC20, SENTINEL, 0n, 1_800_000_000n)
  test('the sale carries its amount twice (the swap and SETTLE_ALL); both are overwritten with the balance', () => {
    const at = patchesOf(sell.data)
    expect(at.length).toBe(2)
    for (const o of at) expect(sell.data.slice(2 + Number(o) * 2, 2 + Number(o) * 2 + 64)).toBe(SENTINEL.toString(16).padStart(64, '0'))
  })
  test('four steps: the exact buy, the two approvals, and the sale (only it is patched)', () => {
    const buy = { to: router, value: 5n * E18, data: '0x1234' as Hex }
    const steps = roundTripSteps({ buy, token: T, router, permit2: PERMIT2, sell, now: 0 })
    expect(steps.map(s => [s.to, s.patches.length])).toEqual([[router, 0], [T, 0], [PERMIT2, 0], [router, 2]])
    expect(steps[0]).toMatchObject({ value: 5n * E18, data: '0x1234' })
    const ap = decodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), data: steps[1].data })
    expect(String(ap.args[0]).toLowerCase()).toBe(PERMIT2.toLowerCase())
    const p2 = decodeFunctionData({ abi: parseAbi(['function approve(address,address,uint160,uint48)']), data: steps[2].data })
    expect(p2.args.slice(0, 2).map(a => String(a).toLowerCase())).toEqual([T, router.toLowerCase()])
    expect(() => roundTripSteps({ buy, token: T, router, permit2: PERMIT2, sell: { to: router, data: '0x00' }, now: 0 })).toThrow(/SENTINEL/)
  })
  test('the harness answer decodes', () => {
    const steps = [step({ usdc: 95n * E18, tokens: 5_000n * E18 }), step({}), step({}), step({ usdc: 99n * E18, ret: '0xabcd' })]
    const raw = encodeFunctionResult({ abi: ROUNDTRIP_ABI, functionName: 'run', result: [100n * E18, 0n, steps] })
    const d = decodeRoundTrip(raw)
    expect(d.usdc0).toBe(100n * E18)
    expect(d.steps[3]).toMatchObject({ ok: true, usdc: 99n * E18, ret: '0xabcd' })
  })
})

describe('the pre-flight: the verdict', () => {
  const r = (steps: StepResult[]) => judgeRoundTrip({ usdc0: 100n * E18, tokens0: 0n, steps }, revertReason)
  const bought = step({ usdc: 95n * E18, tokens: 5_000n * E18, gasUsed: 250_000n })
  test('a coin that sells back: what was paid, what came back, the round trip, the gas', () => {
    const rt = r([bought, step({ usdc: 95n * E18, tokens: 5_000n * E18, gasUsed: 40_000n }), step({ usdc: 95n * E18, tokens: 5_000n * E18, gasUsed: 30_000n }), step({ usdc: 99_700_000_000_000_000_000n, tokens: 0n, gasUsed: 260_000n })])
    expect(rt).toMatchObject({ ok: true, why: null, paidUsd: 5, tokens: 5_000n * E18, lossPct: 6 })
    expect(rt.backUsd).toBeCloseTo(4.7, 9)
    expect(rt.gas).toEqual({ buy: 250_000n, approve: 70_000n, sell: 260_000n })
  })
  test('a honeypot: bought, but the sale reverts', () => {
    const rt = r([bought, step({ usdc: 95n * E18 }), step({ usdc: 95n * E18 }), step({ ok: false, ret: errorString('TRANSFER_FROM_FAILED') })])
    expect(rt.ok).toBe(false)
    expect(rt.why).toBe('the coins couldn\'t be sold back (TRANSFER_FROM_FAILED)')
  })
  test('the buy would fail, or deliver nothing', () => {
    expect(r([step({ ok: false, ret: tooLittle })]).why).toBe('the buy would fail (V4TooLittleReceived)')
    expect(r([step({ usdc: 95n * E18, tokens: 0n })]).why).toBe('the buy would deliver no coins')
  })
  test('an approval fails, or the sale brings nothing back', () => {
    expect(r([bought, step({ ok: false, ret: errorString('BLOCKED') })]).why).toBe('approving the sale would fail (BLOCKED)')
    expect(r([bought, step({ usdc: 95n * E18 }), step({ usdc: 95n * E18 }), step({ usdc: 95n * E18 })]).why).toBe('selling the coins back would bring nothing')
  })
  test('gas limits: the simulation\'s use with headroom', () => {
    expect(gasLimitOf(300_000n)).toBe(480_000n)
  })
  test('whether the round trip leaves the trade worth taking', () => {
    const rt = (lossPct: number) => ({ ok: true, lossPct } as RoundTrip)
    const scalp = { tpMultiple: 1.15, maxLossPct: 20, sizeUsd: 10 }
    expect(roundTripVerdict(rt(4), scalp)).toBeNull()
    expect(roundTripVerdict(rt(25), scalp)).toMatch(/lose 25%, over the 20% limit/)
    expect(roundTripVerdict(rt(19), { ...scalp, maxLossPct: 30 })).toBeNull() // (1.15)(1 − 0.095) − 1 > 0
    expect(roundTripVerdict(rt(28), { ...scalp, maxLossPct: 30 })).toMatch(/leaves nothing at the \+15% take-profit/)
    expect(roundTripVerdict(rt(16), { ...scalp, targetUsd: 1.5 })).toMatch(/leaves \$0.58 at the take-profit, under half the \$1.5 target/) // $10 × (1.15 × 0.92 − 1)
    expect(roundTripVerdict(rt(10), { ...scalp, targetUsd: 1.5 })).toBeNull() // $0.93: over half of $1.5
  })
})

describe('revert reasons in words', () => {
  test('through the Universal Router\'s, v4\'s and the quoter\'s wrappers', () => {
    expect(revertReason(encodeErrorResult({ abi: ERRS, errorName: 'ExecutionFailed', args: [0n, tooLittle] }))).toBe('V4TooLittleReceived')
    expect(revertReason(encodeErrorResult({ abi: ERRS, errorName: 'WrappedError', args: [T, '0x12345678', errorString('SNIPER'), '0x'] }))).toBe(`refused by ${T.slice(0, 10)}…: SNIPER`)
    const nel = encodeErrorResult({ abi: ERRS, errorName: 'NotEnoughLiquidity', args: [pad('0x01')] })
    expect(revertReason(encodeErrorResult({ abi: ERRS, errorName: 'UnexpectedRevertBytes', args: [nel] }))).toBe('not enough liquidity in the pool for this size')
    expect(revertReason(encodeErrorResult({ abi: ERRS, errorName: 'Panic', args: [0x11n] }))).toBe('panic 0x11')
    expect(revertReason('0x')).toBe('reverted without a reason')
    expect(revertReason('0xdeadbeef')).toBe('reverted 0xdeadbeef')
  })
})

// ── the executor against a stand-in node ─────────────────────────────

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const KEY_HEX = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const transfer = (address: string, from: string, to: string, amount: bigint) => ({ address, topics: [TRANSFER, pad(from as Hex), pad(to as Hex)], data: toHex(amount, { size: 32 }) })

interface NodeOpts {
  /** The pre-flight's steps (the harness answer); null: the call errors. */
  preflight?: StepResult[] | null
  /** The pre-flight errors when called from the wallet itself (EIP-3607). */
  noCodeCaller?: boolean
  /** Simulations that fail, in order, with this revert data. */
  simFails?: Hex[]
  /** What each broadcast says, in order ('ok' after). */
  broadcasts?: (string | null)[]
  /** Receipts: 'ok' | 'reverted' | 'none' per sent hash, in order. */
  receipts?: ('ok' | 'reverted' | 'none')[]
  latest?: number
  pending?: number
}

function node(o: NodeOpts = {}) {
  const sent: Hex[] = [], calls: { from?: string; to?: string; override: boolean }[] = []
  const simFails = [...(o.simFails ?? [])], broadcasts = [...(o.broadcasts ?? [])], outcomes = [...(o.receipts ?? [])]
  const known = new Map<Hex, 'ok' | 'reverted' | 'none'>()
  let quotes = 0
  let me: Address = '0x0000000000000000000000000000000000000000'
  const reader = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'poolManager') return PM
      if (functionName === 'balanceOf') return 0n
      return 0n
    },
    simulateContract: async () => { quotes++; return { result: [5_000n * E18, 0n] } },
    call: async (a: { account?: string; to?: string; stateOverride?: unknown[] }) => {
      const override = Array.isArray(a.stateOverride) && a.stateOverride.length > 0
      calls.push({ from: a.account as string, to: a.to, override })
      if (override) {
        if (o.noCodeCaller && (a.account as string).toLowerCase() === me.toLowerCase()) throw new Error('sender not an eoa')
        if (o.preflight === null) throw new Error('state overrides are not supported')
        const steps = o.preflight ?? [step({ usdc: 95n * E18, tokens: 5_000n * E18, gasUsed: 300_000n }), step({ usdc: 95n * E18, tokens: 5_000n * E18 }), step({ usdc: 95n * E18, tokens: 5_000n * E18 }), step({ usdc: 99_800_000_000_000_000_000n, gasUsed: 280_000n })]
        return { data: encodeFunctionResult({ abi: ROUNDTRIP_ABI, functionName: 'run', result: [100n * E18, 0n, steps] }) }
      }
      const f = simFails.shift()
      if (f) throw Object.assign(new Error('execution reverted'), { data: f })
      return { data: '0x' }
    },
    estimateGas: async () => 200_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 200n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
    getGasPrice: async () => 160n * 10n ** 9n,
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === 'latest' ? o.latest ?? 7 : o.pending ?? o.latest ?? 7),
    getBalance: async () => 100n * E18,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const k = known.get(hash)
      if (!k || k === 'none') throw new Error('receipt not found')
      return { transactionHash: hash, status: k === 'ok' ? 'success' : 'reverted', gasUsed: 200_000n, effectiveGasPrice: 160n * 10n ** 9n, logs: [transfer(LOGGER, me, PM, 5n * E18), transfer(T, PM, me, 5_000n * E18)] }
    },
  }
  const sendRaw = async (raw: Hex) => {
    sent.push(raw)
    const hash = keccak256(raw)
    if (!known.has(hash)) {
      const b = broadcasts.shift()
      if (b) throw new Error(b)
      known.set(hash, outcomes.shift() ?? 'ok')
    }
    return hash
  }
  const exec = new LiveExecutor({ privateKey: KEY_HEX, readUrls: [], sendUrl: '', clients: { reader: reader as unknown as Reader, sendRaw }, timing: { pollMs: 1, confirmMs: 40, deadlineS: 120, afterDeadlineMs: -119_950, rebroadcastMs: 10, simRetryMs: 1 } })
  me = exec.address
  return { exec, sent, calls, txs: () => sent.map(r => parseTransaction(r)), quotes: () => quotes }
}

describe('the executor: a buy', () => {
  const pass = () => null
  test('the pre-flight runs as the wallet (its code override, from and to it); the buy gets its measured gas', async () => {
    const n = node()
    const f = await n.exec.buy(POOL, T, 5, 1_000, pass)
    const pre = n.calls.find(c => c.override)!
    expect(pre).toEqual({ from: n.exec.address, to: n.exec.address, override: true })
    expect(n.sent.length).toBe(1)
    const tx = n.txs()[0]
    expect(tx).toMatchObject({ nonce: 7, gas: gasLimitOf(300_000n), chainId: 5042, type: 'eip1559' })
    expect(tx.maxFeePerGas).toBe(400n * 10n ** 9n + 10n ** 9n) // room for the base fee to double
    expect(f).toMatchObject({ tokens: 5_000n * E18, usd: 5 })
    expect(f.roundTrip).toMatchObject({ ok: true, lossPct: 4 })
  })
  test('a coin that can\'t be sold back is never bought: nothing is signed', async () => {
    const n = node({ preflight: [step({ usdc: 95n * E18, tokens: 5_000n * E18 }), step({}), step({}), step({ ok: false, ret: errorString('HONEYPOT') })] })
    const e = await n.exec.buy(POOL, T, 5, 1_000, pass).catch(x => x)
    expect(e).toBeInstanceOf(LiveError)
    expect(e).toMatchObject({ kind: 'refused', message: 'pre-flight: the coins couldn\'t be sold back (HONEYPOT)' })
    expect(n.sent).toEqual([])
  })
  test('the trader\'s objection to the round trip stops it too', async () => {
    const n = node()
    const e = await n.exec.buy(POOL, T, 5, 1_000, () => 'too costly').catch(x => x)
    expect(e).toMatchObject({ kind: 'refused', message: 'pre-flight: too costly' })
    expect(n.sent).toEqual([])
  })
  test('a node that won\'t take a call from an address with code: the pre-flight asks from another caller', async () => {
    const n = node({ noCodeCaller: true })
    await n.exec.buy(POOL, T, 5, 1_000, pass)
    expect(n.calls.filter(c => c.override).map(c => c.from)).toEqual([n.exec.address, PREFLIGHT_CALLER])
    expect(n.sent.length).toBe(1)
  })
  test('a pre-flight that can\'t run at all: not bought', async () => {
    const n = node({ preflight: null })
    expect(await n.exec.buy(POOL, T, 5, 1_000, pass).catch(x => x)).toMatchObject({ kind: 'refused', message: expect.stringMatching(/pre-flight couldn't run/) })
    expect(n.sent).toEqual([])
  })
  test('a price that moved past the slippage before sending: quoted again, once', async () => {
    const n = node({ simFails: [tooLittle] })
    await n.exec.buy(POOL, T, 5, 1_000, pass)
    expect(n.quotes()).toBe(2)
    expect(n.sent.length).toBe(1)
    const m = node({ simFails: [tooLittle, tooLittle] })
    expect(await m.exec.buy(POOL, T, 5, 1_000, pass).catch(x => x)).toMatchObject({ kind: 'refused', message: 'buy would fail: V4TooLittleReceived' })
    expect(m.sent).toEqual([])
  })
})

describe('the executor: sending', () => {
  const to = '0x2222222222222222222222222222222222222222' as Address
  test('a nonce the node says is used: signed again with the next one', async () => {
    const n = node({ broadcasts: ['nonce too low'] })
    await n.exec.sendUsdc(to, 1)
    expect(n.txs().map(t => t.nonce)).toEqual([7, 8])
  })
  test('a fee the node says is too low: doubled', async () => {
    const n = node({ broadcasts: ['replacement transaction underpriced'] })
    await n.exec.sendUsdc(to, 1)
    const [a, b] = n.txs()
    expect(b.nonce).toBe(a.nonce)
    expect(b.maxFeePerGas).toBe(a.maxFeePerGas! * 2n)
  })
  test('turned away for good (no funds): refused, not retried', async () => {
    const n = node({ broadcasts: ['insufficient funds for gas * price + value'] })
    expect(await n.exec.sendUsdc(to, 1).catch(x => x)).toMatchObject({ kind: 'refused' })
    expect(n.sent.length).toBe(1)
  })
  test('a lost connection while sending: its hash is known, so its receipt is still found', async () => {
    const n = node({ broadcasts: ['fetch failed'] })
    const f = await n.exec.sendUsdc(to, 1)
    expect(f.hash).toBe(keccak256(n.sent[0]))
  })
  test('no receipt yet: sent again while waiting; never confirmed: its nonce goes to the next transaction at a higher fee', async () => {
    const n = node({ receipts: ['none'] })
    const e = await n.exec.sendUsdc(to, 1).catch(x => x)
    expect(e).toMatchObject({ kind: 'unconfirmed', hash: keccak256(n.sent[0]) })
    expect(n.sent.length).toBeGreaterThan(1) // resent while waiting
    expect(new Set(n.sent).size).toBe(1) // the same transaction each time
    await n.exec.sendUsdc(to, 1)
    const last = n.txs().at(-1)!
    expect(last.nonce).toBe(7) // took the stale one's place
    expect(last.maxFeePerGas).toBe(n.txs()[0].maxFeePerGas! * 2n)
  })
  test('once the stale one has landed, the next nonce is used', async () => {
    const n = node({ receipts: ['none'] })
    await n.exec.sendUsdc(to, 1).catch(() => {})
    const o = n.exec as unknown as { reader: { getTransactionCount: () => Promise<number> } }
    o.reader.getTransactionCount = async () => 8
    await n.exec.sendUsdc(to, 1)
    expect(n.txs().at(-1)!.nonce).toBe(8)
  })
  test('a revert on-chain is named as one, with its hash', async () => {
    const n = node({ receipts: ['reverted'] })
    expect(await n.exec.sendUsdc(to, 1).catch(x => x)).toMatchObject({ kind: 'reverted', hash: keccak256(n.sent[0]) })
  })
  test('a simulation that fails is never sent', async () => {
    const n = node({ simFails: [errorString('x'), errorString('x'), errorString('x'), errorString('x')] })
    expect(await n.exec.sendUsdc(to, 1).catch(x => x)).toMatchObject({ kind: 'refused', message: 'transfer would fail: x' })
    expect(n.sent).toEqual([])
  })
})

// ── the trader's side ────────────────────────────────────────────────

describe('the live trader: every outcome handled', () => {
  const setup = (o: { buy?: 'ok' | 'refused' | 'unconfirmed'; roundTrip?: Partial<RoundTrip>; held?: bigint; sell?: ('ok' | 'fail' | 'unconfirmed')[]; late?: boolean } = {}) => {
    const calls: string[] = []
    let held = o.held ?? 0n
    const sells = [...(o.sell ?? [])]
    const exec = {
      address: '0x9999999999999999999999999999999999999999',
      balanceUsd: async () => 100,
      buy: async (_p: PoolInfo, _t: Address, usd: number, _bps: number, check?: (rt: RoundTrip) => string | null) => {
        const rt: RoundTrip = { ok: true, why: null, paidUsd: usd, tokens: 1n, backUsd: usd * 0.96, lossPct: 4, gas: { buy: 1n, approve: 1n, sell: 1n }, ...o.roundTrip }
        const bad = check?.(rt)
        if (bad) throw new LiveError(`pre-flight: ${bad}`, undefined, 'refused')
        if (o.buy === 'refused') throw new LiveError('pre-flight: the coins couldn\'t be sold back (HONEYPOT)', undefined, 'refused')
        if (o.buy === 'unconfirmed') { calls.push('buy sent'); throw new LiveError('buy sent but not confirmed before its deadline', '0xbb', 'unconfirmed') }
        calls.push(`buy ${usd}`); held = BigInt(usd) * 1000n * E18
        return { hash: '0xb' as Hex, tokens: held, usd, gasUsd: 0.01, at: Date.now(), roundTrip: check ? rt : null }
      },
      approveForSale: async () => { calls.push('approve'); return [] },
      tokenBalance: async () => held,
      sell: async (_p: PoolInfo, _t: Address, amount: bigint) => {
        const r = sells.shift() ?? 'ok'
        if (r === 'fail') { calls.push('sell failed'); throw new LiveError('sell would fail: x', undefined, 'refused') }
        if (r === 'unconfirmed') { calls.push('sell sent'); throw new LiveError('sell sent but not confirmed before its deadline', '0x5e', 'unconfirmed') }
        calls.push('sell'); held -= amount
        return { hash: '0xs' as Hex, tokens: amount, usd: 6, gasUsd: 0.01, at: Date.now() }
      },
      lateSale: async () => { calls.push('looked up the sale'); if (o.late) { held = 0n; return { hash: '0x5e' as Hex, tokens: 0n, usd: 5.5, gasUsd: 0.01, at: Date.now() } } return null },
    } as unknown as LiveExecutor
    const positions: Position[] = []
    const lt = new LiveTrader({ exec, limits: { ...DEFAULT_LIMITS }, positions: () => positions, params: s => STRATEGIES[s], save: () => {} })
    lt.setPools(() => POOL)
    const meta = { token: T, symbol: 'C', launchpad: 'ARGUS' } as never
    const signal = { id: 's1', token: T, strategy: 'scalp' } as never
    return { lt, calls, positions, meta, signal }
  }
  const settle = () => new Promise(r => setTimeout(r, 10))

  test('a buy that passed the pre-flight says so', async () => {
    const { lt, positions, meta, signal } = setup()
    await lt.open(signal, 'scalp', POOL, meta)
    expect(positions.length).toBe(1)
    expect(lt.events.find(e => e.kind === 'buy')!.text).toMatch(/checked first: it sells straight back for \$4\.80 \(4% round trip\)/)
  })
  test('refused by the pre-flight: not bought, a skip (not an error), nothing to clean up', async () => {
    const { lt, calls, positions, meta, signal } = setup({ buy: 'refused' })
    await lt.open(signal, 'scalp', POOL, meta)
    expect(positions).toEqual([])
    expect(calls).toEqual([])
    expect(lt.events[0]).toMatchObject({ kind: 'skip', text: '$C: not bought (pre-flight: the coins couldn\'t be sold back (HONEYPOT))' })
  })
  test('a round trip that eats the take-profit: not bought', async () => {
    const { lt, positions, meta, signal } = setup({ roundTrip: { lossPct: 24 } })
    await lt.open(signal, 'scalp', POOL, meta)
    expect(positions).toEqual([])
    expect(lt.events[0].text).toMatch(/lose 24%, over the 20% limit/)
  })
  test('the pre-flight can be switched off (BOT_LIVE_PREFLIGHT=off)', async () => {
    const s = setup({ roundTrip: { lossPct: 24 } })
    s.lt.limits.preflight = false
    await s.lt.open(s.signal, 'scalp', POOL, s.meta)
    expect(s.positions.length).toBe(1)
  })
  test('a buy sent but never confirmed whose coins arrived anyway: managed as a position', async () => {
    const { lt, calls, positions, meta, signal } = setup({ buy: 'unconfirmed', held: 5_000n * E18 })
    await lt.open(signal, 'scalp', POOL, meta)
    expect(calls).toEqual(['buy sent', 'approve'])
    expect(positions[0]).toMatchObject({ status: 'open', sizeUsd: 5, qty: 5_000, note: expect.stringMatching(/receipt wasn't read/) })
    expect(positions[0].txs![0].hash).toBe('0xbb')
  })
  test('…and one that never landed leaves nothing behind', async () => {
    const { lt, positions, meta, signal } = setup({ buy: 'unconfirmed', held: 0n })
    await lt.open(signal, 'scalp', POOL, meta)
    expect(positions).toEqual([])
    expect(lt.events[0].kind).toBe('error')
  })
  test('a forced close that fails is retried at every tick until it goes through, whatever the price', async () => {
    const { lt, calls, positions, meta, signal } = setup({ sell: ['fail', 'fail', 'fail'] })
    await lt.open(signal, 'scalp', POOL, meta)
    const p = positions[0]
    lt.closeNow(p, 'rug')
    await settle()
    expect(p.status).toBe('open')
    lt.tick(Date.now(), () => p.marketEntry) // no price exit would fire at this price
    await settle()
    expect(calls.slice(2)).toEqual(['sell failed', 'sell failed', 'sell failed', 'sell'])
    expect(p).toMatchObject({ status: 'closed', exitReason: 'rug' })
  })
  test('a sale sent but not confirmed is looked up before another is sent: never sold twice', async () => {
    const { lt, calls, positions, meta, signal } = setup({ sell: ['unconfirmed'], late: true })
    await lt.open(signal, 'scalp', POOL, meta)
    const p = positions[0]
    lt.closeNow(p, 'manual')
    await settle()
    expect(p.stuck).toMatch(/not confirmed/)
    lt.tick(Date.now(), () => p.marketEntry)
    await settle()
    expect(calls.slice(2)).toEqual(['sell sent', 'looked up the sale'])
    expect(p).toMatchObject({ status: 'closed', exitReason: 'manual' })
    expect(p.txs!.at(-1)).toMatchObject({ kind: 'sell', hash: '0x5e', usd: 5.5 })
  })
  test('…and if it didn\'t go through, the sale is sent again', async () => {
    const { lt, calls, positions, meta, signal } = setup({ sell: ['unconfirmed'], late: false })
    await lt.open(signal, 'scalp', POOL, meta)
    const p = positions[0]
    lt.closeNow(p, 'manual')
    await settle()
    lt.tick(Date.now(), () => p.marketEntry)
    await settle()
    expect(calls.slice(2)).toEqual(['sell sent', 'looked up the sale', 'sell'])
    expect(p.status).toBe('closed')
  })
})

test('the harness build is the one in contracts/test/sim (runtime code present, ABI has run)', () => {
  expect(ROUNDTRIP_RUNTIME.startsWith('0x6080')).toBe(true)
  expect(ROUNDTRIP_ABI.some(x => x.type === 'function' && x.name === 'run')).toBe(true)
  // the sale's two amount words sit where the harness writes: inside its calldata, 32-byte aligned after the selector
  const data = encodeSell(ROUTERS[0], KEY, T, USDC20, SENTINEL, 0n, 1n).data
  for (const o of patchesOf(data)) expect((Number(o) - 4) % 32).toBe(0)
  expect(encodeAbiParameters([{ type: 'uint256' }], [SENTINEL]).slice(2)).toBe(SENTINEL.toString(16).padStart(64, '0'))
})
