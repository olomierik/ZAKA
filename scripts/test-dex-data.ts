// Coin data from DexScreener (lib/dexData.ts), the Trenches' rows with it (lib/useDexData.ts), the Trending lane's
// ranking (components/TrenchTrendLane.tsx) and launchpad icons (lib/launchpadIcon.ts). Offline: a recorded answer
// (scripts/fixtures/dexscreener-sol.json) and stand-in fetches.
//   bun scripts/test-dex-data.ts
import { readFileSync } from 'node:fs'
import { DS, dsAsRow, dsCoin, dsCoins, resetDs, type DsPair } from '../src/arcdex/lib/dexData'
import { withDs } from '../src/arcdex/lib/useDexData'
import { rankTrend, trendCoin, type TrendCoin } from '../src/arcdex/components/TrenchTrendLane'
import { launchpadIcon, launchpadSite } from '../src/arcdex/lib/launchpadIcon'
import type { TrenchCoin } from '../src/arcdex/lib/trenches'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

const recorded = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-sol.json', import.meta.url), 'utf8')) as DsPair[]
const LMAO = 'ENXpapahJRcGHBDkvPCEsggkQTsyNBxPFmoPGxcipump'

console.log('a coin from its pairs')
const lmao = dsCoin(recorded, LMAO)!
check(!!lmao && lmao.symbol === 'LMAO' && lmao.dexId === 'pumpfun' && lmao.quote === 'SOL', 'the recorded LMAO pair: pump.fun, quoted in SOL')
check(lmao.priceUsd > 0 && lmao.marketCap > 0 && lmao.buys1h + lmao.sells1h > 0, 'its price, market cap and last hour’s trades')
check(dsCoin(recorded, 'So11111111111111111111111111111111111111112') === null, 'a coin with no pairs of its own: null')
const pair = (o: Partial<DsPair>): DsPair => ({
  chainId: 'bsc', dexId: 'pancakeswap', pairAddress: '0xP', baseToken: { address: '0xAbC', name: 'Abc', symbol: 'ABC' }, quoteToken: { address: '0xbb4c', name: 'WBNB', symbol: 'WBNB' },
  priceUsd: '0.5', liquidity: { usd: 1000 }, volume: { h24: 100, h1: 10 }, txns: { h24: { buys: 5, sells: 3 }, h1: { buys: 2, sells: 1 } }, marketCap: 50_000, ...o,
})
const two = dsCoin([
  pair({ pairAddress: '0xSmall', liquidity: { usd: 100 }, volume: { h24: 40, h1: 4 }, info: { websites: [{ url: 'https://abc.xyz' }], socials: [{ type: 'twitter', url: 'https://x.com/abc' }, { type: 'telegram', url: 'https://t.me/abc' }], imageUrl: 'https://cdn.dexscreener.com/abc.png' } }),
  pair({ pairAddress: '0xDeep', dexId: 'fourmeme', liquidity: { usd: 9000 } }),
], '0xabc')!
check(two.pair === '0xDeep' && two.dexId === 'fourmeme', 'its numbers come from the deepest pair (address case ignored)')
check(two.volume24h === 140 && two.volume1h === 14 && two.buys24h === 10 && two.buys1h === 4, 'volume and trades summed over every pair')
check(two.website === 'https://abc.xyz' && two.twitter === 'https://x.com/abc' && two.telegram === 'https://t.me/abc' && two.image === 'https://cdn.dexscreener.com/abc.png', 'website, X, Telegram and logo from whichever pair carries them')
check(dsCoin([pair({ info: { websites: [{ url: 'javascript:alert(1)' }], socials: [{ type: 'twitter', url: 'http://x.com/a' }] } })], '0xabc')!.website === null, 'only https links are kept (no javascript:, no plain http)')
const row = dsAsRow(two, 'bnb')
check(row.address === '0xabc' && row.launchpad === 'four.meme' && row.dex === 'four-meme' && row.pool === '0xdeep', 'as a BNB Chain row: lower case, four.meme named as the lists name it')
check(dsAsRow(lmao, 'sol').address === LMAO && dsAsRow(lmao, 'sol').launchpad === 'pump.fun' && dsAsRow(lmao, 'sol').dex === 'pump-fun', 'a Solana row keeps its case; pumpfun is pump.fun')

console.log('reading, 30 a call, from cache, within budget')
resetDs()
let calls: string[] = []
const fake = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(recorded), { status: 200 }) }) as unknown as typeof fetch
const addrs = Array.from({ length: 65 }, (_, i) => `M${i}`).concat([LMAO])
const m1 = await dsCoins('sol', addrs, fake, 1_000_000)
check(calls.length === 3 && calls[0].startsWith('https://api.dexscreener.com/tokens/v1/solana/'), '66 coins: three calls of at most 30')
check(m1.get(LMAO)?.symbol === 'LMAO' && m1.get('M0') === null, 'each coin answered (null for one DexScreener doesn’t know)')
await dsCoins('sol', [LMAO], fake, 1_000_000 + DS.ttlMs - 1)
check(calls.length === 3, 'asked again within the cache time: no call')
calls = []
resetDs()
const both = await Promise.all([dsCoins('sol', [LMAO], fake), dsCoins('sol', [LMAO], fake)])
check(calls.length === 1 && both.every(m => m.get(LMAO)?.symbol === 'LMAO'), 'two asks at once share one call')
resetDs()
calls = []
const many = Array.from({ length: DS.batch * (DS.perMinute + 5) }, (_, i) => `X${i}`)
await dsCoins('sol', many, fake, 5_000_000)
check(calls.length === DS.perMinute, `never more than ${DS.perMinute} calls a minute (DexScreener allows 300)`)
resetDs()
const failing = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch
const m2 = await dsCoins('sol', [LMAO], failing)
check(m2.size === 0, 'DexScreener refusing: nothing, and no error thrown')

console.log('the Trenches’ rows with it')
const base: TrenchCoin = {
  key: 'sol:x', chain: 'sol', address: 'x', pool: null, symbol: 'X', name: 'X', image: null, launchpad: 'pump.fun', quote: 'SOL', createdAt: 0,
  marketCap: 10_000, liquidity: 5_000, volume24h: 1, change24h: 1, change1h: null, buys24h: 1, sells24h: 1, holders: null, traders24h: null,
  progress: null, onCurve: false, stage: 'graduated', safety: { level: 'safe', reasons: [], source: 'market' } as unknown as TrenchCoin['safety'], fee: null, twitter: null, page: { name: 'sol-token', address: 'x' },
}
const d = { ...two, marketCap: 80_000, liquidity: 0, change1h: 3 }
const w = withDs(base, d)
check(w.marketCap === 80_000 && w.liquidity === 5_000, 'DexScreener’s market cap; a zero liquidity keeps the list’s')
check(w.twitter === 'https://x.com/abc' && w.website === 'https://abc.xyz' && w.hour?.buys === 4, 'links and the last hour added')
check(withDs({ ...base, chain: 'arc' }, d).marketCap === 10_000 && withDs({ ...base, chain: 'arc' }, d).website === 'https://abc.xyz', 'Arc keeps the engine’s numbers, takes the links')
check(withDs({ ...base, createdAt: Date.now() - 60_000 }, d).marketCap === 10_000, 'a launch under 10 minutes old keeps the engine’s numbers')
check(withDs({ ...base, twitter: 'https://x.com/own' }, d).twitter === 'https://x.com/own', 'a row’s own X link isn’t replaced')
check(withDs(base, null) === base, 'no DexScreener coin: the row as it was')

console.log('Trending now: most buys in the last hour first')
const tr = (sym: string, buys: number | null, vol24 = 0): TrendCoin => ({ chain: 'sol', address: sym, pool: '', symbol: sym, name: sym, image: null, launchpad: null, marketCap: 1, change1h: null, change24h: 0, buys1h: buys, sells1h: 0, volume1h: buys === null ? null : buys * 10, volume24h: vol24 })
check(rankTrend([tr('A', 5), tr('B', 50), tr('C', null, 1e9), tr('D', 20)]).map(c => c.symbol).join() === 'B,D,A,C', 'ranked by buys in the hour; a coin DexScreener doesn’t know goes last')
const tc = trendCoin({ chain: 'bsc', address: '0xabc', pool: '0xp', symbol: 'ABC', name: 'Abc', image: null, launchpad: 'four.meme', priceUsd: 1, change24h: 5, volume24h: 7, marketCapUsd: 20_000, liquidityUsd: 1, txns24h: 1 }, two)
check(tc.chain === 'bnb' && tc.buys1h === 4 && tc.marketCap === 50_000 && tc.image === two.image, 'a list row with DexScreener’s hour, market cap and logo')

console.log('launchpad icons')
check(launchpadSite('pump.fun') === 'pump.fun' && launchpadSite('Argus') === 'argus.world' && launchpadSite('four.meme') === 'four.meme', 'sites for Solana’s, Arc’s and BNB Chain’s launchpads')
check(launchpadIcon('Bankr')!.startsWith('https://www.google.com/s2/favicons?domain=bankr.bot') && launchpadIcon('Nobody') === null && launchpadIcon(null) === null, 'the icon is the site’s favicon; an unknown launchpad keeps its letter')

console.log(fails ? `\n${fails} failed` : '\nall DexScreener checks passed')
process.exit(fails ? 1 : 0)
