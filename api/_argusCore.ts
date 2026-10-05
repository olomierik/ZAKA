// The market list — every Argus coin, then every other Arc launchpad's —
// from GeckoTerminal, the same source argus.world uses for live coin data.
// Pure logic over an injected fetcher, shared by:
//   - api/argus.ts (edge): builds it once, CDN-cached for every visitor;
//   - the browser (src/arcdex/api/argusMarket.ts): rebuilds it from the
//     visitor's own IP when the server's copy came back incomplete.
// Why both: GeckoTerminal's free tier is rate-limited per IP, and Vercel's
// server IPs are shared with other projects, so they're often throttled
// (429) while a visitor's own IP is not. (The leading underscore keeps
// Vercel from deploying this file as a function.)

import { KNOWN_LAUNCHPAD_DEXES, isLaunchpadDex, launchpadLabel } from './_launchpads'

export const ARGUS_TOKEN = '0xece5ca8bf9220718e5727754026757512212cb3c'
const INC = 'include=base_token,quote_token,dex'
const VOLUME_PAGES = 4 // 20 pools/page

type Json = Record<string, unknown>
interface GtResource { id: string; type: string; attributes: Json; relationships?: Record<string, { data?: { id: string } }> }
export interface GtList { data?: GtResource[]; included?: GtResource[] }
export type GtFetcher = (path: string) => Promise<GtList | null>

export interface ArgusPool {
  pool: string
  dex: string
  token: { address: string; symbol: string; name: string; image: string | null }
  quote: { address: string; symbol: string }
  priceUsd: number
  change: { m5: number; h1: number; h6: number; h24: number }
  volume24h: number
  liquidityUsd: number
  marketCapUsd: number | null
  fdvUsd: number | null
  txns24h: { buys: number; sells: number }
  createdAt: string | null
  /** Argus launch graduated from its curve (null/absent = unknown or not an Argus launch) */
  bonded?: boolean | null
  /** How far along its Argus launch curve, 0–100 (100 once bonded; null/absent = unknown, or no curve). */
  progress?: number | null
  /** Where the coin launched: "Argus", "Tolly", … (absent on lists from before other launchpads were listed = Argus). */
  launchpad?: string
}

/** A GeckoTerminal dex on Arc. */
export interface GtDex { id: string; name: string }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : 0
}

/** @param scopedTo set when `list` came from /tokens/{scopedTo}/pools —
 * there, GeckoTerminal's fdv_usd/market_cap_usd describe `scopedTo`, not
 * each pool's base token (every ARGUS-quoted launch would show ARGUS's
 * $17M cap), so they're dropped for other bases and refilled later. */
export function normalize(list: GtList | null, onlyDex?: string | Set<string>, scopedTo?: string): ArgusPool[] {
  if (!list?.data) return []
  const tokens = new Map<string, Json>()
  const dexNames = new Map<string, string>()
  for (const inc of list.included ?? []) {
    if (inc.type === 'token') tokens.set(inc.id, inc.attributes)
    else if (inc.type === 'dex') dexNames.set(inc.id, str(inc.attributes.name))
  }
  const wanted = (dex: string) => !onlyDex || (typeof onlyDex === 'string' ? dex === onlyDex : onlyDex.has(dex))

  const out: ArgusPool[] = []
  for (const p of list.data) {
    const dex = p.relationships?.dex?.data?.id ?? ''
    if (!wanted(dex)) continue
    const a = p.attributes
    const base = tokens.get(p.relationships?.base_token?.data?.id ?? '')
    const quote = tokens.get(p.relationships?.quote_token?.data?.id ?? '')
    if (!base || !quote) continue
    const pc = (a.price_change_percentage ?? {}) as Json
    const tx = ((a.transactions ?? {}) as Record<string, Json>).h24 ?? {}
    const img = base.image_url as string | undefined
    const capsValid = !scopedTo || String(base.address).toLowerCase() === scopedTo
    out.push({
      pool: String(a.address).toLowerCase(),
      dex,
      token: {
        address: String(base.address).toLowerCase(),
        symbol: String(base.symbol ?? ''),
        name: String(base.name ?? ''),
        image: img && !img.includes('missing') ? img : null,
      },
      quote: { address: String(quote.address).toLowerCase(), symbol: String(quote.symbol ?? '') },
      priceUsd: num(a.base_token_price_usd),
      change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      volume24h: num((a.volume_usd as Json | undefined)?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      marketCapUsd: capsValid && a.market_cap_usd ? num(a.market_cap_usd) : null,
      fdvUsd: capsValid && a.fdv_usd ? num(a.fdv_usd) : null,
      txns24h: { buys: num(tx.buys), sells: num(tx.sells) },
      createdAt: (a.pool_created_at as string) ?? null,
      launchpad: launchpadLabel(dex, dexNames.get(dex)),
    })
  }
  return out
}

/** The launch venues among GeckoTerminal's dexes on Arc (/networks/arc/dexes),
 * Argus aside (it's listed first, its own way). */
export function discoverLaunchpads(list: GtList | null): GtDex[] {
  return (list?.data ?? [])
    .filter(d => d.type === 'dex' && d.id !== 'argus')
    .map(d => ({ id: d.id, name: str(d.attributes.name) }))
    .filter(d => isLaunchpadDex(d.id, d.name))
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => { while (next < items.length) await fn(items[next++]) }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

/** Fill in market cap / FDV for pools that lack them, from the tokens'
 * own records — one call covers up to 30 tokens. */
async function fillCaps(pools: ArgusPool[], gt: GtFetcher) {
  const missing = [...new Set(pools.filter(p => p.fdvUsd == null && p.marketCapUsd == null).map(p => p.token.address))].slice(0, 30)
  if (missing.length === 0) return
  const res = await gt(`/networks/arc/tokens/multi/${missing.join(',')}`)
  const caps = new Map<string, Json>()
  for (const t of res?.data ?? []) caps.set(String(t.attributes.address).toLowerCase(), t.attributes)
  for (const p of pools) {
    const c = caps.get(p.token.address)
    if (!c) continue
    if (p.fdvUsd == null && c.fdv_usd) p.fdvUsd = num(c.fdv_usd)
    if (p.marketCapUsd == null && c.market_cap_usd) p.marketCapUsd = num(c.market_cap_usd)
  }
}

/** One row per token: its deepest pool (the one a buy routes through),
 * sorted by 24h volume. A coin keeps its launchpad's badge when its deepest
 * pool is a plain DEX's (a graduated launch, or one listed through Arc's top
 * pools as well as its launchpad's). */
export function dedupe(all: ArgusPool[]): ArgusPool[] {
  const hasCaps = (x: ArgusPool) => x.fdvUsd != null || x.marketCapUsd != null
  const isPad = (x: ArgusPool) => !!x.launchpad && isLaunchpadDex(x.launchpad, x.launchpad)
  const best = new Map<string, ArgusPool>()
  for (const p of all) {
    const cur = best.get(p.token.address)
    if (!cur || p.liquidityUsd > cur.liquidityUsd || (p.liquidityUsd === cur.liquidityUsd && hasCaps(p) && !hasCaps(cur))) {
      best.set(p.token.address, cur && isPad(cur) && !isPad(p) ? { ...p, launchpad: cur.launchpad, bonded: p.bonded ?? cur.bonded, progress: p.progress ?? cur.progress } : p)
    } else if (isPad(p) && !isPad(cur)) best.set(p.token.address, { ...cur, launchpad: p.launchpad })
  }
  return [...best.values()].sort((a, b) => b.volume24h - a.volume24h)
}

export interface MarketOptions {
  /** Other launchpads' dexes to list after Argus (see discoverLaunchpads). */
  launchpads?: GtDex[]
  /** How many launchpads to fetch at once: 1 on the free API, which throttles bursts. */
  concurrency?: number
}

/** Argus first, then every other launchpad. Sequential unless told
 * otherwise: GeckoTerminal throttles bursts, and a partial list beats a
 * failed one. Most important first, and `onPartial` gets the list so far
 * after each step — so a slow (throttled) build still shows the top coins
 * within a call or two. */
export async function buildMarket(gt: GtFetcher, onPartial?: (pools: ArgusPool[]) => void, opts: MarketOptions = {}): Promise<ArgusPool[]> {
  const launchpads = opts.launchpads ?? KNOWN_LAUNCHPAD_DEXES
  const rows: ArgusPool[] = []
  const emit = () => { if (onPartial && rows.length > 0) onPartial(dedupe(rows)) }
  const volumePage = async (page: number) => {
    rows.push(...normalize(await gt(`/networks/arc/dexes/argus/pools?page=${page}&sort=h24_volume_usd_desc&${INC}`)))
    emit()
  }

  // $ARGUS itself trades on plain Uniswap pools, not under GeckoTerminal's
  // "argus" dex — fetch its pools explicitly, and FIRST, so the platform
  // token is never the slice a rate limit drops. The same listing carries
  // the launches quoted in ARGUS rather than USDC, which rarely make the
  // volume pages.
  const argusSide = (p: ArgusPool) => p.token.address === ARGUS_TOKEN || (p.dex === 'argus' && p.quote.address === ARGUS_TOKEN)
  const argusRows: ArgusPool[] = []
  const argusPage = async (page: number) => {
    const r = normalize(await gt(`/networks/arc/tokens/${ARGUS_TOKEN}/pools?page=${page}&${INC}`), undefined, ARGUS_TOKEN).filter(argusSide)
    for (const p of r) p.launchpad = 'Argus'
    argusRows.push(...r)
    rows.push(...r)
  }

  await argusPage(1)
  emit()
  // Arc's most-traded coins on every DEX, second (2026-10-05): the coins DexScreener lists first (TOLLY, ARCMAN,
  // KAIRO…) trade on plain Uniswap pools, under no launchpad, and GeckoTerminal throttles a build long before its last
  // calls. The site lists the established ones (isEstablishedCoin).
  rows.push(...normalize(await gt(`/networks/arc/pools?page=1&sort=h24_volume_usd_desc&${INC}`)))
  emit()
  await volumePage(1) // the top 20 by volume — the Terminal's first screen
  // Every other launchpad's top 20 by volume, so each shows up early.
  await inBatches(launchpads, opts.concurrency ?? 1, async d => {
    rows.push(...normalize(await gt(`/networks/arc/dexes/${d.id}/pools?page=1&sort=h24_volume_usd_desc&${INC}`), d.id))
    emit()
  })
  await argusPage(2)
  // Refill the ARGUS-listing rows' caps — they're the only rows whose caps
  // GeckoTerminal reported for ARGUS instead of the coin itself. (Mutates
  // the row objects in place, so rows already emitted pick it up too.)
  await fillCaps(argusRows, gt)
  emit()
  rows.push(...normalize(await gt(`/networks/arc/trending_pools?page=1&${INC}`)))
  emit()
  for (let page = 2; page <= VOLUME_PAGES; page++) await volumePage(page)
  // New pools on any listed launchpad.
  rows.push(...normalize(await gt(`/networks/arc/new_pools?page=1&${INC}`), new Set(['argus', ...launchpads.map(d => d.id)])))
  // Caps GeckoTerminal left out elsewhere (young pools often lack them).
  await fillCaps(rows, gt)
  emit()
  return dedupe(rows)
}
