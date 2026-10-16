// Records Relay's quotes for paying from Ethereum, Base or Arbitrum (2026-10-16, owner: "the limitation of having to be
// on Arc to trade"), as fixtures for scripts/test-xevm.ts: USDC or ETH there into $ARCDEX on Arc (one with a gas
// top-up), and Base USDC into a BNB Chain coin. Quotes only: nothing is signed or sent.
// Run: bun scripts/capture-relay-xevm.ts

import { writeFileSync } from 'node:fs'

const EVM = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const FEE = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const NATIVE = '0x0000000000000000000000000000000000000000'
const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
const LOBSTER = '0xeccbb861c0dda7efd964010085488b69317e4444'
const USDC: Record<number, string> = { 8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }

const q = (origin: number, dest: number, inCur: string, outCur: string, amount: string, fee: number, gasUsd = 0) => ({
  user: EVM, recipient: EVM, originChainId: origin, destinationChainId: dest, originCurrency: inCur, destinationCurrency: outCur, amount, tradeType: 'EXACT_INPUT',
  ...(fee ? { appFees: [{ recipient: FEE, fee: String(fee) }] } : {}),
  ...(gasUsd ? { topupGas: true, topupGasAmount: String(Math.round(gasUsd * 1e6)) } : {}),
})
const cases: Record<string, ReturnType<typeof q>> = {
  'base-usdc-arc': q(8453, 5042, USDC[8453], ARCD, '5000000', 50),
  'base-eth-arc': q(8453, 5042, NATIVE, ARCD, '2000000000000000', 50),
  'arb-usdc-arc': q(42161, 5042, USDC[42161], ARCD, '5000000', 50),
  'eth-usdc-arc': q(1, 5042, USDC[1], ARCD, '5000000', 50),
  'base-usdc-arc-gas': q(8453, 5042, USDC[8453], ARCD, '5000000', 50, 0.5),
  'base-usdc-bsc': q(8453, 56, USDC[8453], LOBSTER, '5000000', 50),
}
const out: Record<string, unknown> = { at: new Date().toISOString() }
for (const [name, body] of Object.entries(cases)) {
  const r = await fetch('https://api.relay.link/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json() as Record<string, any>
  if (!r.ok) { console.log(name, 'refused:', JSON.stringify(j).slice(0, 160)); continue }
  out[name] = { body, quote: j }
  const steps = (j.steps ?? []).map((s: any) => `${s.id}→${String(s.items?.[0]?.data?.to ?? '').slice(0, 10)}`)
  console.log(name.padEnd(18), 'out', j.details?.currencyOut?.amountFormatted, j.details?.currencyOut?.currency?.symbol, '· fee', j.fees?.app?.amountUsd, '· steps', steps.join(' '))
}
writeFileSync('scripts/fixtures/relay-xevm.json', JSON.stringify(out, null, 1))
