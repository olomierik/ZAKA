// The top bar's search on the other chains (api/chainsearch.ts, 2026-10-05), offline: matches ranked as the
// Launchpad ranks them, by chain, with the three stored lists read once.
// Run: bun scripts/test-search.ts

const { searchChainRows, chainRows } = await import('../api/chainsearch')
import type { ChainHit } from '../api/chainsearch'

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const hit = (chain: ChainHit['chain'], address: string, symbol: string, name: string, marketCapUsd: number): ChainHit =>
  ({ chain, address, symbol, name, image: null, pool: `${address}-pool`, launchpad: 'x', priceUsd: 1, marketCapUsd, liquidityUsd: 10_000, change24h: 0 })
const SOL = 'DoVAVzViX8Bjy3r15nwikSaSbzE6dV4ovd28aWpJpump'
const rows = [
  hit('solana', SOL, 'HIGGS', 'Higgs boson', 900_000),
  hit('bsc', '0xeccbb861c0dda7efd964010085488b69317e4444', '龙虾', 'Lobster', 42_000_000),
  hit('robinhood', '0x1111111111111111111111111111111111111111', 'NVDA', 'NVIDIA • Robinhood Token', 1e12),
  hit('bsc', '0x2222222222222222222222222222222222224444', 'HIGGSX', 'Higgs copy', 20_000),
  hit('solana', 'Fake11111111111111111111111111111111111pump', 'HIG', 'Hig coin', 5_000_000),
]

console.log('ranking')
ok(searchChainRows(rows, 'higgs').map(h => h.symbol).join() === 'HIGGS,HIGGSX', 'the exact ticker first, then the ticker that starts with it')
ok(searchChainRows(rows, 'hig').map(h => h.symbol).join() === 'HIG,HIGGS,HIGGSX', 'an exact ticker beats prefixes; among prefixes the bigger coin first')
ok(searchChainRows(rows, SOL.toLowerCase())[0]?.chain === 'solana' && searchChainRows(rows, SOL.toLowerCase())[0]?.address === SOL, 'a Solana address, typed in any case, finds its coin (its case kept)')
ok(searchChainRows(rows, '0xeccbb861c0dda7efd964010085488b69317e4444')[0]?.chain === 'bsc', 'a BNB Chain address')
ok(searchChainRows(rows, 'nvidia')[0]?.chain === 'robinhood', 'a name: Robinhood’s stock token')
ok(searchChainRows(rows, 'h').length === 0, 'one character: nothing')
console.log('the stored lists')
let reads = 0
const none = async () => { reads++; return null }
ok((await chainRows(none as never)).length === 0 && reads === 3, 'no stored lists yet: no matches, each list asked for once')
await chainRows(none as never)
ok(reads === 3, 'read again only after 20 seconds')
console.log('\nall search checks passed')
