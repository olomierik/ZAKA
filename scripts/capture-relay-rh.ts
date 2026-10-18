// Records Relay's quotes for swaps on Robinhood Chain (2026-10-18) as fixtures for scripts/test-robinhood.ts: a coin
// bought with ETH and with USDG held on Robinhood Chain, and sold for each. The requests are built exactly as the app
// builds them (lib/relayQuote.ts `quoteBody`, chain 'robinhood'). Quotes only: nothing is signed or sent.
// Run: bun scripts/capture-relay-rh.ts [coin]

import { writeFileSync } from 'node:fs'
import { parseEther, parseUnits } from 'viem'

const { quoteBody, checkRelayQuote, RELAY_API, EVM_NATIVE, RH_USDG } = await import('../src/arcdex/lib/relayQuote')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')

const { WETH } = await import('../api/_rhCore')

/** A busy coin on Robinhood Chain: the base token of the deepest pool GeckoTerminal lists that isn't WETH or USDG. */
async function busyCoin(): Promise<string> {
  if (process.argv[2]) return process.argv[2].toLowerCase()
  const r = await fetch('https://api.geckoterminal.com/api/v2/networks/robinhood/pools?sort=h24_volume_usd_desc', { headers: { accept: 'application/json' } })
  const d = await r.json() as { data: { attributes: { reserve_in_usd: string }; relationships: { base_token: { data: { id: string } } } }[] }
  // Robinhood Chain has a second token named USDG ("USDG Robinhood", 0x5fc5dc8e…d168) beside Paxos's Global Dollar.
  const skip = new Set([WETH, RH_USDG, '0x5fc5dc8e93bb982f633101f78d8f679b5ba6d168'])
  const coin = d.data.filter(p => Number(p.attributes.reserve_in_usd) > 20_000)
    .map(p => p.relationships.base_token.data.id.replace('robinhood_', '').toLowerCase()).find(a => !skip.has(a))
  if (!coin) throw new Error('no busy coin found on Robinhood Chain')
  return coin
}

const coin = await busyCoin()
console.log('coin', coin)
const base = { chain: 'robinhood' as const, side: 'swap' as const, mint: coin, evm: FEE_WALLET, sol: '', feeBps: 50 }
const reqs = {
  'rh-eth': { ...base, inToken: EVM_NATIVE, outToken: coin, amount: parseEther('0.001') },
  'rh-usdg': { ...base, inToken: RH_USDG, outToken: coin, amount: parseUnits('2', 6) },
}
const probe = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quoteBody(reqs['rh-eth'])) }).then(r => r.json()) as { details?: { currencyOut?: { amount?: string } } }
const bought = BigInt(probe.details?.currencyOut?.amount ?? String(parseUnits('1', 18)))
// Sales: Relay simulates them from the seller, so they're asked as a wallet that holds the coin (a recent buyer, read
// from the coin's Transfer logs), selling ten times what the ETH buy would get (Relay refuses sales of a few dollars there as too small).
const { createPublicClient, http, erc20Abi, parseAbiItem } = await import('viem')
const { robinhood } = await import('viem/chains')
const rh = createPublicClient({ chain: robinhood, transport: http() })
const head = await rh.getBlockNumber()
const logs: { args: { to?: `0x${string}` } }[] = []
for (let to = head; logs.length < 300 && to > head - 2_000_000n; to -= 50_000n) {
  logs.unshift(...await rh.getLogs({ address: coin as `0x${string}`, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: to - 49_999n, toBlock: to }).catch(() => []))
}
let holder: string | null = null, held = 0n
console.log(logs.length, 'transfers')
for (const l of logs.reverse().slice(0, 200)) {
  const to = l.args.to!
  if (/^0x0{30,}/.test(to) || to.toLowerCase().endsWith('dead')) continue
  const code = await rh.getCode({ address: to })
  if (code && code !== '0x' && !code.startsWith('0xef0100')) continue
  const b = await rh.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [to] })
  if (b >= bought * 10n) { holder = to.toLowerCase(); held = b; break }
}
if (!holder) throw new Error('no holder found')
console.log('holder', holder, String(held))
const sell = bought * 10n
Object.assign(reqs, {
  'rh-out-eth': { ...base, evm: holder, inToken: coin, outToken: EVM_NATIVE, amount: sell },
  'rh-out-usdg': { ...base, evm: holder, inToken: coin, outToken: RH_USDG, amount: sell },
})
const out: Record<string, unknown> = { coin, holder, sell: String(sell), at: new Date().toISOString() }
for (const [name, req] of Object.entries(reqs)) {
  const res = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quoteBody(req)) })
  const j = await res.json()
  if (!res.ok) { console.log(name, 'refused by Relay:', JSON.stringify(j).slice(0, 200)); continue }
  try { checkRelayQuote(req, j); console.log(name, 'passes ARCDEX’s checks') } catch (e) { console.log(name, 'FAILS ARCDEX’s checks:', (e as Error).message) }
  out[name] = j
}
writeFileSync('scripts/fixtures/relay-rh.json', JSON.stringify(out, null, 1))
console.log('saved scripts/fixtures/relay-rh.json')
