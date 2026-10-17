// Coin data from DexScreener, straight from the browser (2026-10-17, owner: "is it a must that we use Gecko for coin
// data? I see it lagging everything"). GeckoTerminal's free API lets one address make about 30 calls a minute, so the
// engine's lists and every visitor's coin page queued behind each other. DexScreener's tokens endpoint answers any
// origin (CORS *), takes 30 coins a call and allows 300 calls a minute per visitor: the Trenches' rows and a coin page's
// header read it first, in ~0.2 s. It also carries what GeckoTerminal doesn't: each coin's logo, website and socials.
//
// What it doesn't cover stays where it was: candles (DexScreener has no public OHLCV API) and coins it hasn't indexed
// (a Pons curve on Robinhood Chain, a launch seconds old): those keep GeckoTerminal, the engine and the chain.

import type { TChain } from './chains'
import type { RhCoin } from '../../../api/_rhCore'

/** DexScreener's id for each chain the Trenches show. */
export const DS_CHAIN: Record<TChain, string> = { arc: 'arc', hood: 'robinhood', sol: 'solana', bnb: 'bsc' }

export interface DsPair {
  chainId: string
  dexId: string
  pairAddress: string
  labels?: string[]
  baseToken: { address: string; name: string; symbol: string }
  quoteToken: { address: string; name: string; symbol: string }
  priceUsd?: string
  txns?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>>
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  liquidity?: { usd?: number }
  fdv?: number
  marketCap?: number
  pairCreatedAt?: number
  info?: { imageUrl?: string; websites?: { url: string; label?: string }[]; socials?: { type: string; url: string }[] }
}

/** One coin as the app reads it: its busiest pair's numbers, summed volume and trades, and its links. */
export interface DsCoin {
  address: string
  symbol: string
  name: string
  pair: string
  dexId: string
  quote: string
  quoteAddress: string
  priceUsd: number
  marketCap: number
  liquidity: number
  volume24h: number
  volume1h: number
  buys24h: number
  sells24h: number
  buys1h: number
  sells1h: number
  change5m: number
  change1h: number
  change24h: number
  createdAt: number
  image: string | null
  website: string | null
  twitter: string | null
  telegram: string | null
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const https = (u: string | undefined) => (u && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null)

/** A coin's pairs as one coin: numbers from its deepest pair, volume and trades summed over all of them. */
export function dsCoin(pairs: DsPair[], address: string): DsCoin | null {
  const mine = pairs.filter(p => p.baseToken.address.toLowerCase() === address.toLowerCase())
  if (!mine.length) return null
  const best = [...mine].sort((a, b) => n(b.liquidity?.usd) - n(a.liquidity?.usd) || n(b.volume?.h24) - n(a.volume?.h24))[0]
  const sum = (f: (p: DsPair) => number) => mine.reduce((s, p) => s + f(p), 0)
  const info = mine.find(p => p.info?.websites?.length || p.info?.socials?.length || p.info?.imageUrl)?.info ?? best.info
  const social = (type: string) => https(info?.socials?.find(s => s.type === type)?.url)
  return {
    address: best.baseToken.address,
    symbol: best.baseToken.symbol,
    name: best.baseToken.name,
    pair: best.pairAddress.replace(/:.*$/, ''),
    dexId: best.dexId,
    quote: best.quoteToken.symbol,
    quoteAddress: best.quoteToken.address,
    priceUsd: n(best.priceUsd),
    marketCap: n(best.marketCap) || n(best.fdv),
    liquidity: n(best.liquidity?.usd),
    volume24h: sum(p => n(p.volume?.h24)),
    volume1h: sum(p => n(p.volume?.h1)),
    buys24h: sum(p => n(p.txns?.h24?.buys)),
    sells24h: sum(p => n(p.txns?.h24?.sells)),
    buys1h: sum(p => n(p.txns?.h1?.buys)),
    sells1h: sum(p => n(p.txns?.h1?.sells)),
    change5m: n(best.priceChange?.m5),
    change1h: n(best.priceChange?.h1),
    change24h: n(best.priceChange?.h24),
    createdAt: Math.min(...mine.map(p => n(p.pairCreatedAt) || Infinity)) || 0,
    image: https(info?.imageUrl),
    website: https(info?.websites?.[0]?.url),
    twitter: social('twitter'),
    telegram: social('telegram'),
  }
}

// ── reading ─────────────────────────────────────────────────────────────

/** How long an answer is reused, and the calls a minute this page allows itself (DexScreener allows 300). */
export const DS = { ttlMs: 8_000, perMinute: 200, batch: 30, timeoutMs: 6_000 }

const cache = new Map<string, { at: number; v: DsCoin | null }>()
const inflight = new Map<string, Promise<void>>()
let calls: number[] = []

const key = (chain: TChain, a: string) => `${chain}:${chain === 'sol' ? a : a.toLowerCase()}`

function budget(now: number): boolean {
  calls = calls.filter(t => now - t < 60_000)
  if (calls.length >= DS.perMinute) return false
  calls.push(now)
  return true
}

/** For tests: forget everything read. */
export function resetDs() { cache.clear(); inflight.clear(); calls = [] }

/** The coins' DexScreener rows (null: DexScreener doesn't know it), from cache when fresh, else 30 a call. */
export async function dsCoins(chain: TChain, addresses: string[], fetcher: typeof fetch = fetch, now = Date.now()): Promise<Map<string, DsCoin | null>> {
  const out = new Map<string, DsCoin | null>()
  const need: string[] = []
  for (const a of new Set(addresses)) {
    const c = cache.get(key(chain, a))
    if (c && now - c.at < DS.ttlMs) out.set(a, c.v)
    else need.push(a)
  }
  const waits: Promise<void>[] = []
  for (let i = 0; i < need.length; i += DS.batch) {
    const part = need.slice(i, i + DS.batch)
    const id = `${chain}|${part.join(',')}`
    let p = inflight.get(id)
    if (!p) {
      if (!budget(now)) break
      p = (async () => {
        const r = await fetcher(`https://api.dexscreener.com/tokens/v1/${DS_CHAIN[chain]}/${part.join(',')}`, { signal: AbortSignal.timeout(DS.timeoutMs) })
        if (!r.ok) throw new Error(`DexScreener answered ${r.status}`)
        const pairs = (await r.json()) as DsPair[]
        const at = Date.now()
        for (const a of part) cache.set(key(chain, a), { at, v: dsCoin(Array.isArray(pairs) ? pairs : [], a) })
      })().finally(() => inflight.delete(id))
      inflight.set(id, p)
    }
    waits.push(p.catch(() => {}))
  }
  await Promise.all(waits)
  for (const a of need) { const c = cache.get(key(chain, a)); if (c) out.set(a, c.v) }
  return out
}

/** One coin (a coin page's header). */
export async function dsOne(chain: TChain, address: string, fetcher: typeof fetch = fetch): Promise<DsCoin | null> {
  return (await dsCoins(chain, [address], fetcher)).get(address) ?? null
}

/** DexScreener's venue ids for the launchpads the app knows, as the lists name them (GeckoTerminal's dex id and the
 * launchpad's name): a coin page built from DexScreener alone still knows its launchpad and curve. */
const DS_VENUES: Record<string, { dex: string; launchpad: string }> = {
  pumpfun: { dex: 'pump-fun', launchpad: 'pump.fun' },
  pumpswap: { dex: 'pumpswap', launchpad: 'pump.fun' },
  launchlab: { dex: 'raydium-launchlab', launchpad: 'LaunchLab' },
  letsbonk: { dex: 'letsbonk-fun', launchpad: 'LetsBonk' },
  moonshot: { dex: 'moonshot', launchpad: 'Moonshot' },
  moonit: { dex: 'moonit', launchpad: 'Moonit' },
  boop: { dex: 'boop-fun', launchpad: 'Boop' },
  bags: { dex: 'bags-fm', launchpad: 'Bags' },
  heaven: { dex: 'heaven', launchpad: 'Heaven' },
  fourmeme: { dex: 'four-meme', launchpad: 'four.meme' },
  flapsh: { dex: 'flap-sh', launchpad: 'Flap' },
}

/** A DexScreener coin as a list row (the Robinhood, Solana and BNB Chain pages' shape). */
export function dsAsRow(d: DsCoin, chain: Exclude<TChain, 'arc'>): RhCoin {
  const v = DS_VENUES[d.dexId]
  const address = chain === 'sol' ? d.address : d.address.toLowerCase()
  return {
    address, symbol: d.symbol, name: d.name, image: d.image, decimals: null, stock: false,
    pool: chain === 'sol' ? d.pair : d.pair.toLowerCase(), dex: v?.dex ?? d.dexId, quote: chain === 'sol' ? d.quoteAddress : d.quoteAddress.toLowerCase(),
    quoteSymbol: d.quote, priceUsd: d.priceUsd, change5m: d.change5m, change1h: d.change1h, change24h: d.change24h,
    volume24h: d.volume24h, liquidity: d.liquidity, marketCap: d.marketCap, buys24h: d.buys24h, sells24h: d.sells24h,
    traders24h: 0, createdAt: d.createdAt, feePct: null, launchpad: v?.launchpad ?? null,
  }
}
