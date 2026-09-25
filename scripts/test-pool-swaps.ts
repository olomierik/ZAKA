// Live check of on-chain swap loading + price decoding against GeckoTerminal.
//   bun scripts/test-pool-swaps.ts
import { loadPoolSwaps, poolMeta, quoteUsd, resolveMakers } from '../src/arcdex/api/poolSwaps'

const POOLS: [string, string, string, string][] = [
  ['CATZ', '0x7f03a7ce670c2eb6f49638b2e434ae114eb9c15206308ce93c5ec6a2129b95c8', '0x36408b924123dcae158257dda6ea6722447db98f', '0x3600000000000000000000000000000000000000'],
  ['ASTOCK', '0x1bb5c22ae4560dc887164d96ebeaa756130948314ce132fee3c8d14e5b95758b', '0x4c9b47dbd5933aa4574b2c27f82419e4dbbd0222', '0x3600000000000000000000000000000000000000'],
  ['ARGUS (v3)', '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02', '0xece5ca8bf9220718e5727754026757512212cb3c', '0x3600000000000000000000000000000000000000'],
  ['ARCD', '0x87b65f8831a8f3ba17da44003fae5294476b9a5c7ac5da53485a44dd12af9897', '0x4b93446882d29e094181b2fae14b126577a2676c', '0x3600000000000000000000000000000000000000'],
]
console.log('ARGUS/USD from pool slot0:', await quoteUsd('0xece5ca8bf9220718e5727754026757512212cb3c'))
for (const [name, pool, token, quote] of POOLS) {
  const t = Date.now()
  const m = poolMeta(pool, token, quote)
  const { swaps, fromBlock, head } = await loadPoolSwaps(m)
  const ms = Date.now() - t
  const gt = await fetch(`https://api.geckoterminal.com/api/v2/networks/arc/pools/${pool}`).then(r => r.json()).then(j => Number(j.data?.attributes?.base_token_price_usd)).catch(() => NaN)
  const last = swaps[0]
  const t2 = Date.now()
  const makers = await resolveMakers(swaps.slice(0, 100).map(s => s.txHash))
  const resolved = swaps.slice(0, 100).filter(s => makers.has(s.txHash)).length
  console.log(`${name}: ${swaps.length} swaps over ${head - fromBlock + 1} blocks in ${ms}ms; last ${last ? `${last.kind} ${last.tokenAmount.toFixed(0)} tok for ${last.quoteAmount.toFixed(4)} @ ${last.price.toPrecision(5)} (${Math.round((Date.now() - last.time) / 1000)}s ago)` : '—'}; GT price ${gt.toPrecision(5)}; makers ${resolved}/${Math.min(100, swaps.length)} in ${Date.now() - t2}ms`)
  if (last) {
    const implied = last.quoteAmount / last.tokenAmount
    console.log(`   trade-implied price ${implied.toPrecision(5)} (should be near pool price), buys ${swaps.filter(s => s.kind === 'buy').length}/${swaps.length}`)
  }
}
