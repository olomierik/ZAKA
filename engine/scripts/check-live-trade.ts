// Dry run of live trading against Arc mainnet: the exact buy and sell calls
// the bot sends (engine/src/trading/live.ts), simulated with eth_call from a
// throwaway address, in pools that traded in the last few minutes: one
// quoted in the USDC ERC-20 and one in native USDC when both are active.
// Nothing is signed or sent; no key or funds are needed.
//
//   buy    the address holds 100 USDC (a balance override); the call must go
//          through with a minimum of 90% of the quote, and must be refused
//          with a minimum of twice the quote (the minimum really binds)
//   sell   the address holds the coins and has approved Permit2, which has
//          approved the router (storage overrides; the slots are found by
//          reading them back); the same two checks
//   pre-flight  what the bot runs before every live buy (trading/preflight.ts):
//          the harness's code at the address, which then buys, approves and
//          sells everything back through the real router and pool; it must
//          pass, and must refuse the buy with a minimum of twice the quote
//
//   bun engine/scripts/check-live-trade.ts
import { createPublicClient, encodeAbiParameters, fallback, http, keccak256, maxUint256, numberToHex, pad, parseAbi, type Address, type Hex } from 'viem'
import { HttpRpc } from '../src/chain/http'
import { PoolRegistry, type PoolInfo } from '../src/dex/pools'
import { ARC, encodeBuy, encodeSell, keyOf, minOutOf, NATIVE, PERMIT2, reason, revertReason, ROUTERS, usdcSide, usdcUnits, type Call } from '../src/trading/live'
import { decodeRoundTrip, judgeRoundTrip, PREFLIGHT_CALLER, roundTripCall, roundTripSteps, SENTINEL, type RoundTrip } from '../src/trading/preflight'

const READ = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io']
const client = createPublicClient({ chain: ARC, transport: fallback(READ.map(u => http(u))) })
const rpc = new HttpRpc(READ)
const ME = '0x00000000000000000000000000000000c0ffee01' as Address
const SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as Address
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)'])
const P2 = parseAbi(['function allowance(address, address, address) view returns (uint160, uint48, uint48)'])
const QUOTER_ABI = [{ name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] }] as const

let failures = 0
const ok = (c: boolean, m: string) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures++ }
const slotOf = (key: Hex, slot: Hex) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [key, slot]))
const addrKey = (a: Address) => pad(a, { size: 32 })

async function router(): Promise<Address> {
  for (const r of ROUTERS) {
    const pm = await client.readContract({ address: r, abi: parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' }).catch(() => null)
    if (pm?.toLowerCase() === PM) return r
  }
  throw new Error('no router')
}

/** Busy v4 pools of the last few minutes, up to four per USDC kind. */
async function busyPools(): Promise<PoolInfo[]> {
  const head = Number(await client.getBlockNumber())
  const logs = await rpc.call<{ topics: string[] }[]>('eth_getLogs', [{ address: PM, topics: [SWAP], fromBlock: numberToHex(head - 600), toBlock: numberToHex(head) }])
  const count = new Map<string, number>()
  for (const l of logs) count.set(l.topics[1], (count.get(l.topics[1]) ?? 0) + 1)
  const reg = new PoolRegistry(rpc)
  const out: PoolInfo[] = []
  for (const [id] of [...count].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const p = await reg.resolve(id).catch(() => null)
    if (!p) continue
    const key = keyOf(p), token = p.base as Address, usdc = key && usdcSide(key, token)
    if (!usdc || out.filter(o => usdcSide(keyOf(o)!, o.base) === usdc).length >= 4) continue
    out.push(p)
  }
  return out
}

async function quote(p: PoolInfo, zeroForOne: boolean, amount: bigint) {
  const { result } = await client.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: keyOf(p)!, zeroForOne, exactAmount: amount, hookData: '0x' }] })
  return result[0]
}

const goesThrough = (to: Address, data: Hex, value: bigint, stateOverride: Parameters<typeof client.call>[0]['stateOverride']) =>
  client.call({ account: ME, to, data, value, stateOverride }).then(() => ({ ok: true, why: '' }), (e: Error) => ({ ok: false, why: (e.message.split('\n').find(l => /revert|error/i.test(l)) ?? e.message).slice(0, 140) }))

/** The token's balance and allowance slots for ME (common layouts, checked by reading them back). */
async function tokenSlots(token: Address, amount: bigint): Promise<{ balance: Hex; allowance: Hex } | null> {
  const OZ5 = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00' as Hex // ERC-7201 ERC20 storage
  const bases: Hex[] = [...Array.from({ length: 12 }, (_, i) => numberToHex(i, { size: 32 })), OZ5]
  for (const b of bases) {
    const bal = slotOf(addrKey(ME), b)
    const got = await client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [ME], stateOverride: [{ address: token, stateDiff: [{ slot: bal, value: numberToHex(amount, { size: 32 }) }] }] }).catch(() => 0n)
    if (got !== amount) continue
    const allowBase = b === OZ5 ? numberToHex(BigInt(OZ5) + 1n, { size: 32 }) : numberToHex(BigInt(b) + 1n, { size: 32 })
    for (const ab of [allowBase, ...bases]) {
      const allow = slotOf(addrKey(PERMIT2), slotOf(addrKey(ME), ab))
      const a = await client.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [ME, PERMIT2], stateOverride: [{ address: token, stateDiff: [{ slot: allow, value: numberToHex(maxUint256, { size: 32 }) }] }] }).catch(() => 0n)
      if (a === maxUint256) return { balance: bal, allowance: allow }
    }
  }
  return null
}

/** The bot's pre-flight for `buy`, as ME holding 100 USDC (from ME, else from another caller, as the executor does). */
async function preflight(buy: Call, key: NonNullable<ReturnType<typeof keyOf>>, token: Address, usdc: Address, deadline: bigint): Promise<RoundTrip | string> {
  const steps = roundTripSteps({ buy, token, router: buy.to, permit2: PERMIT2, sell: encodeSell(buy.to, key, token, usdc, SENTINEL, 0n, deadline) })
  let last = ''
  for (const from of [ME, PREFLIGHT_CALLER]) {
    try {
      const { data } = await client.call(roundTripCall(ME, token, steps, from, 100n * 10n ** 18n))
      if (data) return judgeRoundTrip(decodeRoundTrip(data), revertReason)
    } catch (e) { last = reason(e) }
  }
  return `the pre-flight couldn't run: ${last}`
}

const ur = await router()
console.log('Universal Router', ur)
const candidates = await busyPools()
const tested = new Set<string>()
for (const p of candidates) {
  const key = keyOf(p)!, token = p.base as Address, usdc = usdcSide(key, token)!
  if (tested.has(usdc)) continue
  // Buy $1 (a pool that can't take $1 is skipped: the executor refuses it the same way)
  const amountIn = usdcUnits(usdc, 1)
  const q = await quote(p, key.currency0.toLowerCase() === usdc.toLowerCase(), amountIn).catch(e => { console.log(`  (skipped ${p.pool.slice(0, 12)}…: ${reason(e)})`); return 0n })
  if (q === 0n) continue
  tested.add(usdc)
  console.log(`\n${usdc === NATIVE ? 'native-USDC' : 'ERC-20 USDC'} pool ${p.pool.slice(0, 12)}…, coin ${token}`)
  ok(q > 0n, `quote for $1: ${q} (smallest units)`)
  const funded = [{ address: ME, balance: 100n * 10n ** 18n }]
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  const buy = encodeBuy(ur, key, token, usdc, amountIn, minOutOf(q, 1_000), ME, deadline)
  const b1 = await goesThrough(buy.to, buy.data, buy.value, funded)
  ok(b1.ok, `buy goes through with a 10% minimum${b1.ok ? '' : `: ${b1.why}`}`)
  const tooMuch = encodeBuy(ur, key, token, usdc, amountIn, q * 2n, ME, deadline)
  ok(!(await goesThrough(tooMuch.to, tooMuch.data, tooMuch.value, funded)).ok, 'buy is refused when the minimum is twice the quote')
  // The pre-flight: the same buy, then selling it all back, as the wallet
  const rt = await preflight(buy, key, token, usdc, deadline)
  ok(typeof rt !== 'string' && rt.ok, typeof rt === 'string' ? rt : rt.ok
    ? `pre-flight passes: $${rt.paidUsd.toFixed(4)} bought ${rt.tokens}, sold straight back for $${rt.backUsd.toFixed(4)} (${rt.lossPct}% round trip); gas: buy ${rt.gas.buy}, approvals ${rt.gas.approve}, sell ${rt.gas.sell}`
    : `pre-flight passes: ${rt.why}`)
  const rtTight = await preflight(tooMuch, key, token, usdc, deadline)
  ok(typeof rtTight !== 'string' && !rtTight.ok && /the buy would fail/.test(rtTight.why ?? ''), `pre-flight refuses a buy with a minimum of twice the quote${typeof rtTight === 'string' ? `: ${rtTight}` : rtTight.why ? ` (${rtTight.why})` : ''}`)
  // Sell what $1 bought
  const slots = await tokenSlots(token, q)
  if (!slots) { ok(false, `found the coin's storage slots (can't simulate its sale)`); continue }
  const p2slot = slotOf(addrKey(ur), slotOf(addrKey(token), slotOf(addrKey(ME), numberToHex(1, { size: 32 }))))
  const packed = ((BigInt(Math.floor(Date.now() / 1000) + 86_400)) << 160n) | ((1n << 160n) - 1n)
  const sellOverride = [
    ...funded,
    { address: token, stateDiff: [{ slot: slots.balance, value: numberToHex(q, { size: 32 }) }, { slot: slots.allowance, value: numberToHex(maxUint256, { size: 32 }) }] },
    { address: PERMIT2, stateDiff: [{ slot: p2slot, value: numberToHex(packed, { size: 32 }) }] },
  ]
  const [p2amount] = await client.readContract({ address: PERMIT2, abi: P2, functionName: 'allowance', args: [ME, token, ur], stateOverride: sellOverride })
  ok(p2amount === (1n << 160n) - 1n, 'Permit2 allowance slot is right (read back)')
  const sq = await quote(p, key.currency0.toLowerCase() === token.toLowerCase(), q)
  ok(sq > 0n, `quote to sell it back: ${sq} (${usdc === NATIVE ? '18' : '6'} decimals)`)
  const sell = encodeSell(ur, key, token, usdc, q, minOutOf(sq, 1_500), deadline)
  const s1 = await goesThrough(sell.to, sell.data, 0n, sellOverride)
  ok(s1.ok, `sell goes through with a 15% minimum${s1.ok ? '' : `: ${s1.why}`}`)
  const sellTooMuch = encodeSell(ur, key, token, usdc, q, sq * 2n, deadline)
  ok(!(await goesThrough(sellTooMuch.to, sellTooMuch.data, 0n, sellOverride)).ok, 'sell is refused when the minimum is twice the quote')
}
if (!tested.size) { console.log('no busy USDC v4 pool could be quoted; try again'); process.exit(1) }
console.log(`\ntested: ${[...tested].map(u => (u === NATIVE ? 'native USDC' : 'ERC-20 USDC')).join(', ')}`)
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
