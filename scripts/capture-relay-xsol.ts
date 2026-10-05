// Records Relay's quotes for trades between Solana and the EVM chains ARCDEX lists (2026-10-05, owner: "Solana
// wallets connect, transact, swap and bridge; buy other chains' coins with SOL and USDC on Solana"), as fixtures for
// scripts/test-xsol.ts: SOL or Solana USDC into a coin on Arc, BNB Chain and Robinhood Chain (signed in the Solana
// wallet, delivered to the trader's ARCDEX account), the coin sold back for SOL (signed by that account), and USDC
// bridged both ways between Solana and Arc. Quotes only: nothing is signed or sent.
// Run: bun scripts/capture-relay-xsol.ts

import { writeFileSync } from 'node:fs'

const SOL_USER = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa'
const EVM = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const FEE = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const SOL = '11111111111111111111111111111111', SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
const LOBSTER = '0xeccbb861c0dda7efd964010085488b69317e4444'
const E = 'https://arcdex-engine-production.up.railway.app'
const rh = (await fetch(`${E}/api/rhmarket`, { headers: { origin: 'https://www.arcsense.site' } }).then(r => r.json()) as { rows: { address: string; symbol: string; launchpad: string | null; stock: boolean; volume24h: number }[] }).rows
const rhMeme = rh.filter(c => !c.stock && c.launchpad).sort((a, b) => b.volume24h - a.volume24h)[0]

const q = (user: string, recipient: string, origin: number, dest: number, inCur: string, outCur: string, amount: string, fee: number, gasUsd = 0) => ({
  user, recipient, originChainId: origin, destinationChainId: dest, originCurrency: inCur, destinationCurrency: outCur, amount, tradeType: 'EXACT_INPUT',
  ...(fee ? { appFees: [{ recipient: FEE, fee: String(fee) }] } : {}),
  ...(gasUsd ? { topupGas: true, topupGasAmount: String(Math.round(gasUsd * 1e6)) } : {}),
})
const cases: Record<string, ReturnType<typeof q>> = {
  'sol-arc': q(SOL_USER, EVM, 792703809, 5042, SOL, ARCD, '50000000', 200),
  'usdc-arc': q(SOL_USER, EVM, 792703809, 5042, SOL_USDC, ARCD, '5000000', 200),
  'sol-arc-gas': q(SOL_USER, EVM, 792703809, 5042, SOL, ARCD, '50000000', 200, 0.5),
  'sol-bsc': q(SOL_USER, EVM, 792703809, 56, SOL, LOBSTER, '50000000', 200),
  'sol-bsc-gas': q(SOL_USER, EVM, 792703809, 56, SOL, LOBSTER, '50000000', 200, 0.5),
  'sol-rh': q(SOL_USER, EVM, 792703809, 4663, SOL, rhMeme.address, '50000000', 200),
  'arc-sol': q(EVM, SOL_USER, 5042, 792703809, ARCD, SOL, '1000000000000000000000000', 200),
  'bsc-sol': q(EVM, SOL_USER, 56, 792703809, LOBSTER, SOL, '100000000000000000000', 200),
  'rh-sol': q(EVM, SOL_USER, 4663, 792703809, rhMeme.address, SOL, '10000000000000000000', 200),
  'bridge-in': q(SOL_USER, EVM, 792703809, 5042, SOL_USDC, ARC_USDC, '10000000', 50),
  'bridge-out': q(EVM, SOL_USER, 5042, 792703809, ARC_USDC, SOL_USDC, '10000000', 50),
}
const out: Record<string, unknown> = { at: new Date().toISOString(), rhMeme: rhMeme.address }
for (const [name, body] of Object.entries(cases)) {
  const r = await fetch('https://api.relay.link/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json() as Record<string, any>
  if (!r.ok) { console.log(name, 'refused:', JSON.stringify(j).slice(0, 160)); continue }
  out[name] = { body, quote: j }
  const steps = (j.steps ?? []).map((s: any) => `${s.id}${s.items?.[0]?.data?.to ? '→' + s.items[0].data.to.slice(0, 10) : ''}${s.items?.[0]?.data?.instructions ? `(${s.items[0].data.instructions.length} ins)` : ''}`)
  console.log(name.padEnd(11), 'out', j.details?.currencyOut?.amountFormatted, j.details?.currencyOut?.currency?.symbol, '· fee', j.fees?.app?.amountUsd, '· steps', steps.join(' '))
}
writeFileSync('scripts/fixtures/relay-xsol.json', JSON.stringify(out, null, 1))
