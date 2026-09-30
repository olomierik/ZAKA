// The live bot's pre-flight check (owner's request, 2026-09-30: "by default
// all swaps of the BOT to be successful on-chain"). Before every live buy,
// the bot runs, in one eth_call as its own wallet (the BotRoundTrip harness
// put at its address by a state override, with its real USDC):
//
//   1  the exact buy it is about to send (same router, pool, amount, minimum)
//   2  the coin's approval to Permit2, and 3  Permit2's to the router
//   4  the sale of everything the buy delivered, as the exit will send it
//
// The buy is sent only if all four go through and the sale brings USDC back.
// A coin that could be bought but not sold (a honeypot, a hook that blocks
// this wallet or the router, a tax that eats the sale) is never bought, and
// the gas each step used sets the real transactions' limits. The trader
// then decides whether the round trip's cost leaves the trade worth taking
// (bot/liveTrader.ts). Nothing is signed or sent here.

import { decodeFunctionResult, encodeFunctionData, maxUint256, parseAbi, type Address, type Hex } from 'viem'
import { ROUNDTRIP_ABI, ROUNDTRIP_RUNTIME } from './roundTripBuild'

/** The sale is encoded with this amount; the harness writes the wallet's balance of the coin over it. */
export const SENTINEL = 0x5e11a11c0115e11a11c0115e11a11c01n
const SENTINEL_WORD = SENTINEL.toString(16).padStart(64, '0')
/** Used as the caller only if a node won't take a call from an address that has code (EIP-3607). */
export const PREFLIGHT_CALLER = '0x00000000000000000000000000000000c0ffee02' as Address
const MAX_UINT160 = (1n << 160n) - 1n

const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)'])

export interface Step { to: Address; value: bigint; data: Hex; patches: bigint[] }
export interface StepResult { ok: boolean; gasUsed: bigint; usdc: bigint; tokens: bigint; ret: Hex }

/** Byte offsets of every SENTINEL word in `data` (where the harness writes the balance). */
export function patchesOf(data: Hex): bigint[] {
  const h = data.slice(2), out: bigint[] = []
  for (let i = h.indexOf(SENTINEL_WORD); i !== -1; i = h.indexOf(SENTINEL_WORD, i + 1)) if (i % 2 === 0) out.push(BigInt(i / 2))
  return out
}

/** The four steps: the buy as it will be sent, the two approvals, and the sale of the whole balance (`sell` is encoded with SENTINEL as its amount). */
export function roundTripSteps(o: { buy: { to: Address; value: bigint; data: Hex }; token: Address; router: Address; permit2: Address; sell: { to: Address; data: Hex }; now?: number }): Step[] {
  const patches = patchesOf(o.sell.data)
  if (!patches.length) throw new Error('the sale must carry SENTINEL as its amount')
  const until = Math.floor((o.now ?? Date.now()) / 1000) + 30 * 86_400
  return [
    { to: o.buy.to, value: o.buy.value, data: o.buy.data, patches: [] },
    { to: o.token, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [o.permit2, maxUint256] }), patches: [] },
    { to: o.permit2, value: 0n, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [o.token, o.router, MAX_UINT160, until] }), patches: [] },
    { to: o.sell.to, value: 0n, data: o.sell.data, patches },
  ]
}

/** The eth_call: the harness's `run`, from and to the wallet, with the harness's code at the wallet (and, for dry runs, a balance). */
export function roundTripCall(wallet: Address, token: Address, steps: Step[], from: Address = wallet, balance?: bigint) {
  return {
    account: from, to: wallet, gas: 30_000_000n,
    data: encodeFunctionData({ abi: ROUNDTRIP_ABI, functionName: 'run', args: [token, steps] }),
    stateOverride: [{ address: wallet, code: ROUNDTRIP_RUNTIME as Hex, ...(balance !== undefined ? { balance } : {}) }],
  }
}

export function decodeRoundTrip(raw: Hex): { usdc0: bigint; tokens0: bigint; steps: StepResult[] } {
  const [usdc0, tokens0, steps] = decodeFunctionResult({ abi: ROUNDTRIP_ABI, functionName: 'run', data: raw }) as unknown as [bigint, bigint, StepResult[]]
  return { usdc0, tokens0, steps }
}

export interface RoundTrip {
  ok: boolean
  /** Why not, in words. */
  why: string | null
  /** USDC that left the wallet for the buy (what the router swept back is not counted). */
  paidUsd: number
  /** The coins the buy delivered (smallest units). */
  tokens: bigint
  /** USDC the sale brought back. */
  backUsd: number
  /** What buying and selling straight back costs, as a share of what was paid: pool fees, hook and token taxes, price impact both ways. */
  lossPct: number | null
  /** Gas each real transaction used in the simulation. */
  gas: { buy: bigint; approve: bigint; sell: bigint }
}

const usd18 = (x: bigint) => Number(x) / 1e18

/** Judges the harness's answer. `why` names the first thing that failed; `reason` turns revert data into words. */
export function judgeRoundTrip(r: { usdc0: bigint; tokens0: bigint; steps: StepResult[] }, reason: (ret: Hex) => string): RoundTrip {
  const [buy, a1, a2, sell] = r.steps
  const gas = { buy: buy?.gasUsed ?? 0n, approve: (a1?.gasUsed ?? 0n) + (a2?.gasUsed ?? 0n), sell: sell?.gasUsed ?? 0n }
  const got = buy ? buy.tokens - r.tokens0 : 0n
  const paid = buy && buy.ok ? r.usdc0 - buy.usdc : 0n
  const fail = (why: string, back = 0n): RoundTrip => ({ ok: false, why, paidUsd: usd18(paid), tokens: got > 0n ? got : 0n, backUsd: usd18(back), lossPct: null, gas })
  if (!buy?.ok) return fail(`the buy would fail (${buy ? reason(buy.ret) : 'not run'})`)
  if (got <= 0n) return fail('the buy would deliver no coins')
  if (!a1?.ok || !a2?.ok) return fail(`approving the sale would fail (${reason((a1?.ok ? a2 : a1)?.ret ?? '0x')})`)
  if (!sell?.ok) return fail(`the coins couldn't be sold back (${reason(sell?.ret ?? '0x')})`)
  const back = sell.usdc - a2.usdc
  if (back <= 0n) return fail('selling the coins back would bring nothing')
  const lossPct = paid > 0n ? Math.round((1 - Number(back) / Number(paid)) * 10_000) / 100 : null
  return { ok: true, why: null, paidUsd: usd18(paid), tokens: got, backUsd: usd18(back), lossPct, gas }
}

/** A gas limit from what a step used in the simulation: headroom for a pool that moved, plus the transaction's own cost. */
export const gasLimitOf = (used: bigint) => (used * 14n) / 10n + 60_000n
