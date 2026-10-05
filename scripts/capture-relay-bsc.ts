// Records Relay's quotes for BNB Chain trades (2026-10-05) as fixtures for scripts/test-bsc.ts: a graduated four.meme
// coin bought with USDC on Arc, sold back to it, bought with BNB and with USDT, sold for BNB, and the BNB top-up. The
// requests are built exactly as the app builds them (lib/relayQuote.ts `quoteBody`). Quotes only: nothing is signed
// or sent.
// Run: bun scripts/capture-relay-bsc.ts [coin]

import { writeFileSync } from 'node:fs'
import { parseEther, parseUnits } from 'viem'
import { readFour, BSC_RPC_SERVER, BSC_USDT } from '../api/_bscCore'

const { quoteBody, checkRelayQuote, RELAY_API, EVM_NATIVE } = await import('../src/arcdex/lib/relayQuote')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')

async function graduatedCoin(): Promise<string> {
  if (process.argv[2]) return process.argv[2].toLowerCase()
  const r = await fetch('https://api.geckoterminal.com/api/v2/networks/bsc/dexes/pancakeswap_v2/pools?sort=h24_volume_usd_desc&include=base_token', { headers: { accept: 'application/json' } })
  const d = await r.json() as { data: { attributes: { reserve_in_usd: string }; relationships: { base_token: { data: { id: string } } } }[] }
  const cands = d.data.filter(p => Number(p.attributes.reserve_in_usd) > 50_000).map(p => p.relationships.base_token.data.id.replace('bsc_', '').toLowerCase()).filter(a => /4444$/.test(a))
  const four = await readFour(cands, BSC_RPC_SERVER)
  const coin = cands.find(a => four.get(a)?.graduated)
  if (!coin) throw new Error('no graduated four.meme coin with a deep pool found')
  return coin
}

const coin = await graduatedCoin()
console.log('coin', coin)
const base = { chain: 'bsc' as const, mint: coin, evm: FEE_WALLET, sol: '', feeBps: 200 }
const reqs = {
  buy: { ...base, side: 'buy' as const, amount: 5_000_000n },
  sell: { ...base, side: 'sell' as const, amount: parseUnits('1000', 18) },
  'swap-bnb': { ...base, side: 'swap' as const, inToken: EVM_NATIVE, outToken: coin, amount: parseEther('0.01') },
  'swap-usdt': { ...base, side: 'swap' as const, inToken: BSC_USDT, outToken: coin, amount: parseUnits('5', 18) },
  'swap-out': { ...base, side: 'swap' as const, inToken: coin, outToken: EVM_NATIVE, amount: parseUnits('1000', 18) },
  gas: { ...base, side: 'gas' as const, mint: '', amount: 500_000n, feeBps: 0 },
}
const out: Record<string, unknown> = { coin, at: new Date().toISOString() }
for (const [name, req] of Object.entries(reqs)) {
  const res = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quoteBody(req)) })
  const j = await res.json()
  if (!res.ok) { console.log(name, 'refused by Relay:', JSON.stringify(j).slice(0, 200)); continue }
  try { checkRelayQuote(req, j); console.log(name, 'passes ARCDEX’s checks') } catch (e) { console.log(name, 'FAILS ARCDEX’s checks:', (e as Error).message) }
  out[name] = j
}
writeFileSync('scripts/fixtures/relay-bsc.json', JSON.stringify(out, null, 1))
console.log('saved scripts/fixtures/relay-bsc.json')
