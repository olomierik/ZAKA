// What the 2026-10-05 DexScreener comparison changed, checked offline:
//   - established coins from any DEX are listed (api/_launchpads.ts isEstablishedCoin), stablecoins aren't;
//   - a launchpad coin keeps its badge when its deepest pool is a plain DEX's (api/_argusCore.ts dedupe);
//   - the home page's trending list: the markets' rules, busiest first, each chain's totals (api/trending.ts);
//   - each coin page's title, description and link preview (netlify/edge-functions/coin-meta.ts), escaped;
//   - sitemap paths (netlify/edge-functions/sitemap.ts) and logo links through the image cache (src/arcdex/lib/logo.ts).
//   bun scripts/test-dex-parity.ts

import { ESTABLISHED, isEstablishedCoin, isLaunchpadCoin } from '../api/_launchpads'
import { dedupe, type ArgusPool } from '../api/_argusCore'
import { arcRows, rankTrending, totalsOf, type TrendRow } from '../api/trending'
import { coinHead, coinOf, rewriteHead, usd } from '../netlify/edge-functions/coin-meta'
import { pagePath } from '../netlify/edge-functions/sitemap'
import { logoSrc } from '../src/arcdex/lib/logo'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }
const DAY = 86_400_000

console.log('established coins')
const tolly = { symbol: 'TOLLY', liquidityUsd: 285_000, ageMs: 60 * DAY, marketCapUsd: 2_100_000, txns24h: 2_980 }
ok(isEstablishedCoin(tolly), 'TOLLY (Uniswap v3, $285K liquidity, 2 months, 2,980 trades) is listed')
ok(!isEstablishedCoin({ ...tolly, ageMs: 2 * DAY }), 'not before three days of trading')
ok(!isEstablishedCoin({ ...tolly, liquidityUsd: ESTABLISHED.minLiquidityUsd - 1 }), `not under $${ESTABLISHED.minLiquidityUsd.toLocaleString()} of liquidity`)
ok(!isEstablishedCoin({ ...tolly, marketCapUsd: 50_000 }), 'not under $100K of market cap')
ok(!isEstablishedCoin({ ...tolly, txns24h: 3 }), 'not with a handful of trades a day')
ok(!isEstablishedCoin({ ...tolly, symbol: 'EURC' }) && !isEstablishedCoin({ ...tolly, symbol: 'usdc' }), 'stablecoins are not markets')
ok(isLaunchpadCoin('Argus') && !isLaunchpadCoin('Uniswap V3') && !isLaunchpadCoin('Other'), 'the launchpad rule is unchanged')

const pool = (over: Partial<ArgusPool> & { addr?: string }): ArgusPool => ({
  pool: over.pool ?? '0xpool', dex: over.dex ?? 'argus',
  token: { address: over.addr ?? '0xaaa', symbol: over.token?.symbol ?? 'AAA', name: 'Aaa', image: null },
  quote: { address: '0x3600', symbol: 'USDC' }, priceUsd: 1, change: { m5: 0, h1: 0, h6: 0, h24: 5 },
  volume24h: 10_000, liquidityUsd: 10_000, marketCapUsd: 500_000, fdvUsd: null, txns24h: { buys: 50, sells: 50 },
  createdAt: new Date(Date.now() - 30 * DAY).toISOString(), launchpad: 'Argus', ...over,
})

console.log('one row per coin, the badge kept')
const merged = dedupe([pool({ pool: '0xcurve', liquidityUsd: 5_000, launchpad: 'Argus' }), pool({ pool: '0xuni', dex: 'uniswap-v4-arc', liquidityUsd: 90_000, launchpad: 'Uniswap V4' })])
ok(merged.length === 1 && merged[0].pool === '0xuni' && merged[0].launchpad === 'Argus', 'the deepest pool trades, the launchpad badge stays (deep pool seen second)')
const merged2 = dedupe([pool({ pool: '0xuni', dex: 'uniswap-v4-arc', liquidityUsd: 90_000, launchpad: 'Uniswap V4' }), pool({ pool: '0xcurve', liquidityUsd: 5_000, launchpad: 'Argus' })])
ok(merged2[0].pool === '0xuni' && merged2[0].launchpad === 'Argus', '… and seen first')

console.log('trending on the home page')
const now = Date.now()
const rows = arcRows([
  pool({ addr: '0x1', token: { address: '0x1', symbol: 'TOLLY', name: 'Tolly', image: null }, dex: 'uniswap-v3-arc', launchpad: 'Uniswap V3', liquidityUsd: 285_000, marketCapUsd: 2_100_000, volume24h: 165_000 }),
  pool({ addr: '0x2', token: { address: '0x2', symbol: 'TINY', name: 'Tiny', image: null }, marketCapUsd: 9_000 }),
  pool({ addr: '0x3', token: { address: '0x3', symbol: 'RUG', name: 'Rug', image: null }, change: { m5: 0, h1: 0, h6: 0, h24: -95 } }),
  pool({ addr: '0x4', token: { address: '0x4', symbol: 'EURC', name: 'Euro Coin', image: null }, dex: 'uniswap-v3-arc', launchpad: 'Uniswap V3', liquidityUsd: 900_000, marketCapUsd: 5_000_000 }),
  pool({ addr: '0x5', token: { address: '0x5', symbol: 'FRESH', name: 'Fresh', image: null }, dex: 'uniswap-v4-arc', launchpad: 'Uniswap V4', liquidityUsd: 80_000, marketCapUsd: 300_000, createdAt: new Date(now - DAY).toISOString() }),
  pool({ addr: '0x6', token: { address: '0x6', symbol: 'MEME', name: 'Meme', image: null } }),
], now)
const syms = rows.map(r => r.symbol)
ok(syms.includes('TOLLY') && syms.includes('MEME'), 'an established coin and a launchpad coin are listed')
ok(!syms.includes('TINY') && !syms.includes('RUG') && !syms.includes('EURC') && !syms.includes('FRESH'), 'under $15K, rugged, a stablecoin and a day-old plain-DEX coin are not')
const r = (chain: TrendRow['chain'], symbol: string, volume24h: number, txns24h: number): TrendRow => ({ chain, address: symbol, pool: '', symbol, name: symbol, image: null, launchpad: null, priceUsd: 1, change24h: 0, volume24h, marketCapUsd: 1e6, liquidityUsd: 1e5, txns24h })
const ranked = rankTrending([r('arc', 'A', 1_000, 10), r('solana', 'B', 900_000, 5_000), r('bsc', 'C', 50_000, 800)])
ok(ranked.map(x => x.symbol).join() === 'B,C,A', 'busiest first, across chains')
const totals = totalsOf([r('arc', 'A', 1_000, 10), r('arc', 'D', 2_000, 20), r('solana', 'B', 900_000, 5_000)])
ok(totals.find(t => t.chain === 'arc')?.coins === 2 && totals.find(t => t.chain === 'arc')?.volume24h === 3_000, 'each chain\'s totals')

console.log('each coin page\'s head')
ok(JSON.stringify(coinOf('/token/0xece5ca8bf9220718e5727754026757512212cb3c')) === JSON.stringify({ chain: 'arc', address: '0xece5ca8bf9220718e5727754026757512212cb3c' }), '/token/0x… is an Arc coin')
ok(coinOf('/solana/token/7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr')?.chain === 'solana', '/solana/token/… keeps its base58 address')
ok(coinOf('/bnb/token/0xeccbb861c0dda7efd964010085488b69317e4444')?.chain === 'bsc' && coinOf('/robinhood/token/0x2e8c31162b855a2ffa90f6f8634643ad6f111e18')?.chain === 'robinhood', 'BNB Chain and Robinhood Chain pages')
ok(coinOf('/spot')?.address === '0x4b93446882d29e094181b2fae14b126577a2676c', '/spot is $ARCDEX')
ok(coinOf('/token/not-an-address') === null && coinOf('/app') === null && coinOf('/solana/token/0x12') === null, 'anything else is left alone')
const argus = { chain: 'arc' as const, address: '0xece5', symbol: 'ARGUS', name: 'Argus', image: 'ipfs://bafyabc/logo.png', launchpad: 'Argus', quote: 'USDC', priceUsd: 0.01403, marketCapUsd: 13_020_000, change24h: -4.44 }
const head = coinHead(argus, 'https://arcsense.site/token/0xece5')
ok(head.title === 'ARGUS $13.02M | Argus · ARGUS / USDC on Arc | ARCDEX', `title: ${head.title}`)
ok(head.description.includes('price $0.01403') && head.description.includes('-4.4% in 24h') && head.description.includes('launched on Argus'), 'description: price, change, launchpad')
ok(head.image.startsWith('https://wsrv.nl/') && head.image.includes(encodeURIComponent('https://dweb.link/ipfs/bafyabc/logo.png')), 'the logo, from IPFS through the image cache')
const page = '<html><head><title>ARCDEX</title><meta name="description" content="x" /><meta property="og:title" content="x" /><meta property="og:image" content="x" /><meta name="twitter:card" content="summary_large_image" /></head><body></body></html>'
const out = rewriteHead(page, { ...argus, name: 'Ev<il> "Coin" & co' }, 'https://arcsense.site/token/0xece5')
ok((out.match(/<title>/g) ?? []).length === 1 && (out.match(/og:title/g) ?? []).length === 1 && (out.match(/twitter:card/g) ?? []).length === 1, 'each tag once (the generic ones replaced)')
ok(out.includes('Ev&lt;il&gt; &quot;Coin&quot; &amp; co') && !out.includes('<il>'), 'names are escaped')
ok(out.includes('<link rel="canonical" href="https://arcsense.site/token/0xece5" />'), 'a canonical link')
ok(usd(0.000005251) === '$0.000005251' && usd(85_385.1) === '$85.4K' && usd(null) === '—', 'prices and caps in words')

console.log('sitemap and logos')
ok(pagePath({ chain: 'bsc', address: '0xabc', pool: '0xpool' }) === '/bnb/token/0xabc?pool=0xpool' && pagePath({ chain: 'arc', address: '0xabc', pool: null }) === '/token/0xabc', 'coin page paths')
ok(logoSrc('https://ipfs.io/ipfs/bafkreif2f4/x.png', 28)!.includes(encodeURIComponent('https://dweb.link/ipfs/bafkreif2f4/x.png')) && logoSrc('https://ipfs.io/ipfs/bafk', 28)!.includes('w=56'), 'an ipfs.io logo: the faster gateway, at twice its drawn size')
ok(logoSrc('/arcdex-mark.png') === '/arcdex-mark.png' && logoSrc('data:image/png;base64,AA') === 'data:image/png;base64,AA' && logoSrc(null) === null && logoSrc('javascript:alert(1)') === null, 'local, inline and bad links')

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall DexScreener-parity checks passed')
