// Simulates the exact transactions ARCSENSE sends for a Robinhood Chain trade
// (src/arcdex/lib/across.ts), on mainnet, from a throwaway address with state
// overrides: nothing is signed or sent, no funds or keys.
//
//  • buy:  a fresh Across quote ($5 of USDC on Arc → MOW, and → NVDA), checked by
//          checkQuote, then its deposit run on Arc as the address, holding USDC
//          and having approved exactly the amount (and refused with less).
//  • gas:  $0.50 of USDC on Arc → ETH on Robinhood Chain, the same way.
//  • sell: 10 MOW on Robinhood Chain → USDC on Arc, run there as the address
//          holding MOW and ETH for gas, having approved exactly the amount.
//
// Run: bun scripts/sim-robinhood.ts

import { createPublicClient, encodeAbiParameters, http, keccak256, maxUint256, numberToHex, pad, parseAbi, type Address, type Hex } from 'viem'
import { robinhood } from 'viem/chains'

const { getAcrossQuote, ACROSS_TARGETS, ARC_USDC } = await import('../src/arcdex/lib/acrossQuote')

const arc = createPublicClient({ transport: http('https://rpc.mainnet.arc.io') })
const rh = createPublicClient({ chain: robinhood, transport: http() })
const ME = '0x00000000000000000000000000000000c0ffee01' as Address
const MOW = '0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa' as Address
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as Address
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)'])
type Client = typeof arc | typeof rh
type Overrides = { address: Address; balance?: bigint; stateDiff?: { slot: Hex; value: Hex }[] }[]

let failures = 0
const ok = (c: boolean, m: string) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures++ }
const slotOf = (key: Hex, slot: Hex) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [key, slot]))
const OZ5 = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00' as Hex
const BASES: Hex[] = [...Array.from({ length: 12 }, (_, i) => numberToHex(i, { size: 32 })), OZ5]

/** A token's storage slot for allowance(ME, spender) (common layouts, read back to be sure). */
async function allowanceSlot(c: Client, token: Address, spender: Address): Promise<Hex | null> {
  for (const b of [...BASES, numberToHex(BigInt(OZ5) + 1n, { size: 32 })]) {
    const slot = slotOf(pad(spender, { size: 32 }), slotOf(pad(ME, { size: 32 }), b))
    const a = await c.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [ME, spender], stateOverride: [{ address: token, stateDiff: [{ slot, value: numberToHex(maxUint256, { size: 32 }) }] }] } as never).catch(() => 0n)
    if (a === maxUint256) return slot
  }
  return null
}
async function balanceSlot(c: Client, token: Address, amount: bigint): Promise<Hex | null> {
  for (const b of BASES) {
    const slot = slotOf(pad(ME, { size: 32 }), b)
    const got = await c.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [ME], stateOverride: [{ address: token, stateDiff: [{ slot, value: numberToHex(amount, { size: 32 }) }] }] } as never).catch(() => 0n)
    if (got === amount) return slot
  }
  return null
}
const runs = (c: Client, to: Address, data: Hex, stateOverride: Overrides) =>
  c.call({ account: ME, to, data, stateOverride } as never).then(() => ({ ok: true, why: '' }), (e: Error) => ({ ok: false, why: (e.message.split('\n').find(l => /revert|error/i.test(l)) ?? e.message).slice(0, 160) }))

console.log('buys and the gas top-up, signed on Arc')
// Arc's USDC is its native balance (18 decimals); the 0x3600 token reads it.
const usdcAllow = await allowanceSlot(arc, ARC_USDC as Address, ACROSS_TARGETS[5042] as Address)
ok(usdcAllow !== null, 'found Arc USDC’s allowance slot (read back)')
for (const [label, req] of [
  ['$5 → MOW', { side: 'buy' as const, token: MOW, amount: 5_000_000n, trader: ME, feeBps: 200 }],
  ['$5 → NVDA (stock token)', { side: 'buy' as const, token: NVDA, amount: 5_000_000n, trader: ME, feeBps: 200 }],
  ['$0.50 → ETH for gas', { side: 'gas' as const, token: '', amount: 500_000n, trader: ME, feeBps: 0 }],
] as const) {
  const q = await getAcrossQuote(req)
  ok(true, `${label}: Across’s quote passed ARCSENSE’s checks (min ${q.minOut} out)`)
  if (!usdcAllow) continue
  const exact = numberToHex(q.inputAmount, { size: 32 })
  const funded = { address: ME, balance: 100n * 10n ** 18n }
  const approved = { address: ARC_USDC as Address, stateDiff: [{ slot: usdcAllow, value: exact }] }
  const r = await runs(arc, q.tx.to, q.tx.data, [funded, approved])
  ok(r.ok, `${label}: the deposit goes through with exactly ${q.inputAmount} approved${r.ok ? '' : ` (${r.why})`}`)
  const short = await runs(arc, q.tx.to, q.tx.data, [funded, { ...approved, stateDiff: [{ slot: usdcAllow, value: numberToHex(q.inputAmount - 1n, { size: 32 }) }] }])
  ok(!short.ok, `${label}: and is refused with one unit less approved`)
}

console.log('a sale, signed on Robinhood Chain')
const amount = 10n ** 19n // 10 MOW
const q = await getAcrossQuote({ side: 'sell', token: MOW, amount, trader: ME, feeBps: 200 })
ok(q.chainId === 4663 && q.minOut > 0n, `10 MOW → USDC on Arc: the quote passed ARCSENSE’s checks (min $${(Number(q.minOut) / 1e6).toFixed(2)})`)
const mowBal = await balanceSlot(rh, MOW, amount)
const mowAllow = await allowanceSlot(rh, MOW, ACROSS_TARGETS[4663] as Address)
ok(mowBal !== null && mowAllow !== null, 'found MOW’s balance and allowance slots (read back)')
if (mowBal && mowAllow) {
  const state: Overrides = [{ address: ME, balance: 10n ** 16n }, { address: MOW, stateDiff: [{ slot: mowBal, value: numberToHex(amount, { size: 32 }) }, { slot: mowAllow, value: numberToHex(amount, { size: 32 }) }] }]
  const r = await runs(rh, q.tx.to, q.tx.data, state)
  ok(r.ok, `the sale goes through with exactly 10 MOW approved${r.ok ? '' : ` (${r.why})`}`)
  const none = await runs(rh, q.tx.to, q.tx.data, [state[0], { address: MOW, stateDiff: [{ slot: mowBal, value: numberToHex(amount, { size: 32 }) }] }])
  ok(!none.ok, 'and is refused without the approval')
}

console.log(failures ? `\n${failures} failed` : '\nevery transaction goes through as sent')
process.exit(failures ? 1 : 0)
