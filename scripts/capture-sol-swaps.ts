// Records real Solana transactions as fixtures for scripts/test-solana.ts (2026-10-05): the newest successful
// transactions of a busy PumpSwap pool and of a pump.fun curve from the engine's Solana list, read as the coin
// page reads them (jsonParsed). Reads only; nothing is sent.
// Run: bun scripts/capture-sol-swaps.ts

import { writeFileSync } from 'node:fs'

const RPC = 'https://solana-rpc.publicnode.com'
async function rpc<T>(body: unknown): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json() as Promise<T>
}
const rows = await fetch('https://arcdex-engine-production.up.railway.app/api/solmarket', { headers: { origin: 'https://www.arcsense.site' } })
  .then(r => r.json()).then((j: { rows: { symbol: string; address: string; pool: string; dex: string; quote: string; buys24h: number; sells24h: number; graduated?: boolean }[] }) => j.rows)
const busy = (dex: string, curve?: boolean) => rows.filter(c => c.dex === dex && (curve === undefined || !c.graduated === curve)).sort((a, b) => b.buys24h + b.sells24h - a.buys24h - a.sells24h)[0]
const pools = [busy('pumpswap'), busy('pump-fun', true)].filter(Boolean)
const out: Record<string, unknown>[] = []
for (const c of pools) {
  const sigs = await rpc<{ result: { signature: string; err: unknown }[] }>({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [c.pool, { limit: 30, commitment: 'confirmed' }] })
  const ok = sigs.result.filter(s => !s.err).slice(0, 10).map(s => s.signature)
  // One getTransaction a request (publicnode's limit).
  const txs = await Promise.all(ok.map(s => rpc<{ result: unknown }>({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] })))
  out.push({ symbol: c.symbol, dex: c.dex, pool: c.pool, mint: c.address, quoteMint: c.quote, txs: txs.map(t => t.result).filter(Boolean) })
  console.log(c.symbol, c.dex, 'txs', txs.length)
}
writeFileSync('scripts/fixtures/sol-swaps.json', JSON.stringify({ at: new Date().toISOString(), pools: out }))
