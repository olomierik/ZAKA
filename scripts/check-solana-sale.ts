// Checks a Solana sale end to end without sending anything (2026-10-04): a Relay sell quote for a wallet that holds
// the coin, ARCDEX's checks on it (lib/relayQuote.ts), the transaction built the way lib/relay.ts builds it, and
// Solana's simulation of it. Then a buy quote's checks for the same coin. Nothing is signed.
// Run: bun scripts/check-solana-sale.ts [mint]

import { Buffer } from 'buffer'
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { checkRelayQuote, quoteBody, RELAY_API, type RelayRequest } from '../src/arcdex/lib/relayQuote'
import { FEE_WALLET } from '../src/arcdex/lib/platform'

const RPC = process.env.SOL_RPC ?? 'https://solana-rpc.publicnode.com'
const mint = process.argv[2] ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' // BONK
const conn = new Connection(RPC, 'confirmed')
/** Fetch JSON, a few tries apart: GeckoTerminal's free API and Relay throttle bursts. */
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, init); if (r.ok) return await r.json() as T; if (i >= 4) return await r.json() as T } catch (e) { if (i >= 4) throw e }
    await new Promise(r => setTimeout(r, 2_500))
  }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

// A wallet holding the coin: a recent buyer (GeckoTerminal's trades of its busiest pool) that still holds some, with SOL
// for fees.
const pools = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`) as { data: { attributes: { address: string } }[] }
const trades = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pools.data[0].attributes.address}/trades`) as { data: { attributes: { kind: string; tx_from_address: string } }[] }
let seller = '', held = 0n
for (const who of [...new Set(trades.data.filter(t => t.attributes.kind === 'buy').map(t => t.attributes.tx_from_address))].slice(0, 15)) {
  const accts = await conn.getParsedTokenAccountsByOwner(new PublicKey(who), { mint: new PublicKey(mint) }).catch(() => null)
  const amt = accts?.value.reduce((s, a) => s + BigInt((a.account.data.parsed.info.tokenAmount as { amount: string }).amount), 0n) ?? 0n
  const lamports = await conn.getBalance(new PublicKey(who)).catch(() => 0)
  await new Promise(r => setTimeout(r, 400))
  if (amt > 0n && lamports > 5_000_000) { seller = who; held = amt; break }
}
ok(seller, `a wallet holding it: ${seller}`)

const amount = held / 10_000n > 0n ? held / 10_000n : held
const req: RelayRequest = { side: 'sell', mint, amount, evm: FEE_WALLET, sol: seller, feeBps: 200 }
const j = await getJson<any>(`${RELAY_API}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteBody(req)) })
ok(j.steps, `Relay quoted the sale (${j.details?.currencyIn?.amountUsd} → $${j.details?.currencyOut?.amountUsd})`)
const q = checkRelayQuote(req, j)
ok(q.solTx && q.solTx.instructions.length > 0, `the quote passed ARCDEX's checks (${q.solTx!.instructions.length} instructions, request ${q.id.slice(0, 10)}…)`)

const tables = await Promise.all(q.solTx!.lookupTables.map(a => conn.getAddressLookupTable(new PublicKey(a)).then(r => r.value)))
ok(tables.every(Boolean), `its ${tables.length} lookup tables load`)
const { blockhash } = await conn.getLatestBlockhash('confirmed')
const ins = q.solTx!.instructions.map(i => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: i.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(i.data, 'hex'),
}))
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(seller), recentBlockhash: blockhash, instructions: ins }).compileToV0Message(tables.filter(t => t !== null)))
ok(tx.serialize().length <= 1232, `the transaction fits (${tx.serialize().length} bytes)`)
const before = await conn.getBalance(new PublicKey(seller))
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [seller] } })
if (sim.value.err) console.log(sim.value.logs?.slice(-8).join('\n'))
ok(!sim.value.err, 'Solana simulates it without an error')
const after = sim.value.accounts?.[0]?.lamports ?? before
ok(before - after < 10_000_000, `it costs the seller ${(before - after) / 1e9} SOL in fees`)

// A buy of the same coin from Arc, delivered to the same address.
const buy: RelayRequest = { side: 'buy', mint, amount: 5_000_000n, evm: FEE_WALLET, sol: seller, feeBps: 200 }
const b = await getJson<any>(`${RELAY_API}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteBody(buy)) })
const bq = checkRelayQuote(buy, b)
ok(bq.evmTx?.deposit, `a $5 buy passes the checks (deposit to Relay's depository, fee $${bq.appFeeUsd})`)
console.log('\nsale checks passed')
