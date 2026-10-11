// Hyperliquid's markets as ARCDEX lists them: perpetuals on the core dex (crypto) and on the builder-deployed dexes
// settled in USDC that carry real volume (xyz: stocks, commodities, indices, FX and SpaceX; io: OpenAI and Anthropic
// before their IPOs), sorted into Liquid's categories, with their live prices, funding and open interest.
//
// Dexes settled in another token (flx, km, cash) need that token and aren't listed; para and mkts are small and repeat
// tickers xyz already has. Delisted markets are left out.

import { hlInfo } from './client'
import { ASSET } from './wire'

export type HlCategory = 'crypto' | 'stocks' | 'preipo' | 'indices' | 'commodities' | 'fx'
export const HL_CATEGORIES: HlCategory[] = ['crypto', 'stocks', 'preipo', 'indices', 'commodities', 'fx']

/** The dexes listed, in display order. '' is Hyperliquid's own (core) dex. */
export const HL_DEXES = ['', 'xyz', 'io'] as const

export interface HlMarket {
  /** The coin as Hyperliquid names it: "BTC", "xyz:TSLA". */
  coin: string
  dex: string
  /** The ticker shown: "BTC", "TSLA". */
  symbol: string
  name: string
  asset: number
  szDecimals: number
  maxLeverage: number
  /** Isolated margin only (most builder-dex markets). */
  onlyIsolated: boolean
  category: HlCategory
  markPx: number
  midPx: number | null
  oraclePx: number
  prevDayPx: number
  change24h: number
  volume24h: number
  /** Open interest in dollars. */
  openInterestUsd: number
  /** The hourly funding rate (0.0001 = 0.01% an hour). */
  funding: number
}

interface MetaUniverse { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean; marginMode?: string }
interface AssetCtx { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; oraclePx: string; markPx: string; midPx: string | null }
type MetaAndCtxs = [{ universe: MetaUniverse[]; collateralToken?: number }, AssetCtx[]]

const COMMODITIES = new Set(['GOLD', 'SILVER', 'CL', 'BRENTOIL', 'COPPER', 'NATGAS', 'URANIUM', 'ALUMINIUM', 'PLATINUM', 'PALLADIUM', 'CORN', 'WHEAT', 'TTF', 'HO'])
const INDICES = new Set(['XYZ100', 'SP500', 'KR200', 'JP225', 'DXY', 'VIX', 'EWY', 'EWJ', 'EWZ', 'EWT', 'XLE', 'SMH', 'SOXL', 'XBI', 'TLT', 'URNM', 'MAGS', 'KORU', 'US500', 'USTECH', 'SMALL2000'])
const FX = new Set(['JPY', 'EUR', 'GBP', 'CHF', 'AUD', 'CAD', 'CNH'])
const PREIPO = new Set(['OAI', 'ANTH', 'SPCX', 'SHEIN', 'CXMT', 'OURA'])

/** Readable names for the tickers people search for. Anything else shows its ticker. */
export const HL_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', HYPE: 'Hyperliquid', XRP: 'XRP', DOGE: 'Dogecoin', BNB: 'BNB', SUI: 'Sui',
  LINK: 'Chainlink', AVAX: 'Avalanche', ADA: 'Cardano', ZEC: 'Zcash', LTC: 'Litecoin', TRX: 'Tron', TON: 'Toncoin', ENA: 'Ethena',
  PUMP: 'Pump.fun', kPEPE: 'Pepe', FARTCOIN: 'Fartcoin', WLD: 'Worldcoin', AAVE: 'Aave', UNI: 'Uniswap', DOT: 'Polkadot',
  NEAR: 'Near', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', TAO: 'Bittensor', XMR: 'Monero', BCH: 'Bitcoin Cash',
  kBONK: 'Bonk', WIF: 'dogwifhat', TRUMP: 'Official Trump', VIRTUAL: 'Virtuals', ONDO: 'Ondo', LDO: 'Lido', PENDLE: 'Pendle',
  XYZ100: 'Nasdaq 100', SP500: 'S&P 500', KR200: 'KOSPI 200', JP225: 'Nikkei 225', DXY: 'US Dollar Index', VIX: 'Volatility Index',
  GOLD: 'Gold', SILVER: 'Silver', CL: 'Crude Oil (WTI)', BRENTOIL: 'Brent Oil', COPPER: 'Copper', NATGAS: 'Natural Gas',
  URANIUM: 'Uranium', ALUMINIUM: 'Aluminium', PLATINUM: 'Platinum', PALLADIUM: 'Palladium', CORN: 'Corn', WHEAT: 'Wheat',
  TTF: 'Dutch TTF Gas', HO: 'Heating Oil', JPY: 'USD / JPY', EUR: 'EUR / USD', GBP: 'GBP / USD',
  TSLA: 'Tesla', NVDA: 'Nvidia', AAPL: 'Apple', MSFT: 'Microsoft', GOOGL: 'Alphabet', AMZN: 'Amazon', META: 'Meta',
  NFLX: 'Netflix', AMD: 'AMD', INTC: 'Intel', PLTR: 'Palantir', COIN: 'Coinbase', HOOD: 'Robinhood', MSTR: 'Strategy',
  CRCL: 'Circle', ORCL: 'Oracle', MU: 'Micron', SNDK: 'SanDisk', TSM: 'TSMC', BABA: 'Alibaba', LLY: 'Eli Lilly', COST: 'Costco',
  RIVN: 'Rivian', SMSN: 'Samsung', SKHX: 'SK Hynix', SKHY: 'SK Hynix', CRWV: 'CoreWeave', GME: 'GameStop', HIMS: 'Hims & Hers',
  DKNG: 'DraftKings', AVGO: 'Broadcom', ASML: 'ASML', ARM: 'Arm', DELL: 'Dell', IBM: 'IBM', QCOM: 'Qualcomm',
  AMAT: 'Applied Materials', MRVL: 'Marvell', RKLB: 'Rocket Lab', NBIS: 'Nebius', RDDT: 'Reddit', NET: 'Cloudflare',
  CRWD: 'CrowdStrike', CVX: 'Chevron', BX: 'Blackstone', EBAY: 'eBay', ZM: 'Zoom', NOW: 'ServiceNow', NOK: 'Nokia',
  MRNA: 'Moderna', LITE: 'Lumentum', GEV: 'GE Vernova', BE: 'Bloom Energy', WDC: 'Western Digital', LRCX: 'Lam Research',
  GLW: 'Corning', HYUNDAI: 'Hyundai', SOFTBANK: 'SoftBank', KIOXIA: 'Kioxia', IONQ: 'IonQ', GPRO: 'GoPro', TCNT: 'Tencent',
  OAI: 'OpenAI', ANTH: 'Anthropic', SPCX: 'SpaceX', SHEIN: 'Shein', OURA: 'Oura', CXMT: 'CXMT',
  EWY: 'South Korea ETF', EWJ: 'Japan ETF', EWZ: 'Brazil ETF', EWT: 'Taiwan ETF', XLE: 'Energy ETF', SMH: 'Semiconductor ETF',
  SOXL: 'Semiconductor 3× ETF', XBI: 'Biotech ETF', TLT: '20+ Year Treasury ETF', URNM: 'Uranium Miners ETF',
}

export function categoryOf(dex: string, symbol: string): HlCategory {
  if (!dex) return 'crypto'
  if (PREIPO.has(symbol)) return 'preipo'
  if (COMMODITIES.has(symbol)) return 'commodities'
  if (INDICES.has(symbol)) return 'indices'
  if (FX.has(symbol)) return 'fx'
  return 'stocks'
}

export const symbolOf = (coin: string) => (coin.includes(':') ? coin.split(':')[1] : coin)
export const dexOf = (coin: string) => (coin.includes(':') ? coin.split(':')[0] : '')

/** The coin's icon, as Hyperliquid's own app serves it (shown through the site's image cache, lib/logo.ts). */
export const hlIcon = (coin: string) => `https://app.hyperliquid.xyz/coins/${coin}.svg`

let dexIndexCache: Promise<Map<string, number>> | null = null

/** Each dex's place in perpDexs, which builder-dex asset ids are built from (the core dex is 0). */
export function dexIndexes(): Promise<Map<string, number>> {
  dexIndexCache ??= hlInfo<({ name: string } | null)[]>({ type: 'perpDexs' }).then(list => {
    const m = new Map<string, number>([['', 0]])
    list.forEach((d, i) => { if (d) m.set(d.name, i) })
    return m
  }).catch(e => { dexIndexCache = null; throw e })
  return dexIndexCache
}

export function marketsFrom(dex: string, dexIndex: number, [meta, ctxs]: MetaAndCtxs): HlMarket[] {
  if ((meta.collateralToken ?? 0) !== 0) return [] // settled in a token other than USDC
  const out: HlMarket[] = []
  meta.universe.forEach((u, i) => {
    const c = ctxs[i]
    if (!c || u.isDelisted) return
    const symbol = symbolOf(u.name)
    const markPx = Number(c.markPx)
    const prev = Number(c.prevDayPx)
    out.push({
      coin: u.name, dex, symbol, name: HL_NAMES[symbol] ?? symbol,
      asset: dex ? ASSET.hip3(dexIndex, i) : i,
      szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, onlyIsolated: !!u.onlyIsolated,
      category: categoryOf(dex, symbol),
      markPx, midPx: c.midPx === null ? null : Number(c.midPx), oraclePx: Number(c.oraclePx), prevDayPx: prev,
      change24h: prev > 0 ? (markPx / prev - 1) * 100 : 0,
      volume24h: Number(c.dayNtlVlm), openInterestUsd: Number(c.openInterest) * markPx, funding: Number(c.funding),
    })
  })
  return out
}

/** Every listed market with its live numbers. A dex that doesn't answer is left out of this read, not fatal. */
export async function loadPerpMarkets(signal?: AbortSignal): Promise<HlMarket[]> {
  const idx = await dexIndexes()
  const parts = await Promise.all(HL_DEXES.map(dex =>
    hlInfo<MetaAndCtxs>(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, { signal })
      .then(r => marketsFrom(dex, idx.get(dex) ?? -1, r))
      .catch(() => [] as HlMarket[])))
  return parts.flat().filter(m => m.asset >= 0)
}

// ── outcome (prediction) markets, HIP-4 ─────────────────────────────────

export type OutcomeCategory = 'crypto' | 'stocks' | 'indices' | 'commodities' | 'fx' | 'sports' | 'economics' | 'companies' | 'culture' | 'other'

export interface RawOutcome { outcome: number; name: string; description: string; sideSpecs: { name: string }[]; quoteToken?: string; venue?: string | null }
export interface RawQuestion { question: number; name: string; description: string; fallbackOutcome: number; namedOutcomes: number[]; settledNamedOutcomes: number[] }

export interface OutcomeSide { name: string; coin: string; asset: number }
export interface OutcomeMarket {
  outcome: number
  /** One line, as a question ("SILVER above $60.7 at Oct 12, 13:35 UTC?"), or the member's label inside a group. */
  title: string
  /** The member's own label inside a question ("Liverpool", "Draw", "Other"). */
  label: string
  category: OutcomeCategory
  sides: [OutcomeSide, OutcomeSide]
  /** When it resolves or expires, in ms (null when the market doesn't say). */
  endsAt: number | null
  /** The perp its price settles on, for a chart ("BTC", "xyz:SILVER"). */
  underlying: string | null
  /** The fields as the venue wrote them, for the details. */
  fields: Record<string, string>
  template: string
  question: number | null
  venue: string | null
}
export interface OutcomeGroup {
  /** A question's id, or the standalone outcome's id (negated) for a group of one. */
  id: number
  title: string
  category: OutcomeCategory
  endsAt: number | null
  underlying: string | null
  members: OutcomeMarket[]
  multi: boolean
}

/** "k1:v1|k2:v2" → { k1: v1, k2: v2 } (values may contain ':'). */
export function parseFields(desc: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of desc.split('|')) {
    const i = part.indexOf(':')
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

/** "20261012-1335" (UTC) → ms. */
export function parseTime(s: string | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s ?? '')
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtUtc(ms: number | null, withTime = true): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return withTime ? `${day}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` : day
}

function money(v: string | number | undefined): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v ?? '')
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `$${n}`
}

/** The perp an outcome's price settles on, and the category that perp sits in. */
function underlyingOf(f: Record<string, string>): { coin: string | null; category: OutcomeCategory } {
  const perp = f.perp ?? f.underlying ?? null
  if (!perp) return { coin: null, category: 'other' }
  const coin = perp
  const c = categoryOf(dexOf(coin), symbolOf(coin))
  return { coin, category: (c === 'preipo' ? 'stocks' : c) as OutcomeCategory }
}

const sideLabel = (raw: string, f: Record<string, string>) =>
  raw.replace(/^template:/, '').replace(/\{(\w+)\}/g, (_, k) => f[k] ?? k)

/** A standalone outcome or a question's member, made readable. Unknown templates fall back to the venue's words. */
export function describeOutcome(o: RawOutcome, q: RawQuestion | null): OutcomeMarket {
  const f = { ...(q ? parseFields(q.description) : {}), ...parseFields(o.description) }
  // "template:binaryPrice", "template fallback", "Recurring"…
  const t = o.name.replace(/^template[:\s]/, '').trim()
  const u = underlyingOf(f)
  // Crypto by its ticker ("BTC"), the rest by name where it has one ("Nasdaq 100", "Silver").
  const sym = u.coin ? (dexOf(u.coin) ? (HL_NAMES[symbolOf(u.coin)] ?? symbolOf(u.coin)) : symbolOf(u.coin)) : ''
  let title = ''
  let label = ''
  let category: OutcomeCategory = u.category
  let endsAt = parseTime(f.time ?? f.expiry ?? f.resolutionDeadline ?? f.dateTime ?? f.listingDeadline ?? f.decisionDeadline)
  const a = f.shortNameA ?? f.participantA
  const b = f.shortNameB ?? f.participantB
  switch (t) {
    case 'binaryPrice':
      title = `${sym} above ${money(f.threshold)} at ${fmtUtc(endsAt)}?`
      break
    case 'binaryPriceExternal':
      title = `${f.shortName ?? f.instrument} above ${money(f.threshold)} at ${fmtUtc(endsAt)}?`
      category = 'stocks'
      break
    case 'priceTouch':
      title = `${sym} touches ${money(f.target)} by ${fmtUtc(endsAt, false)}?`
      break
    case 'Recurring':
      if (f.class === 'priceBinary') title = `${f.underlying} above ${money(f.targetPrice)} at ${fmtUtc(endsAt)}?`
      break
    case 'sportsContestWinner':
      title = `${f.participantA} vs ${f.participantB}`
      label = `${a} or ${b}`
      category = 'sports'
      break
    case 'sportsTotal':
      title = `${f.participantA} vs ${f.participantB}: over ${f.line} ${f.measure ?? 'points'}?`
      category = 'sports'
      break
    case 'sportsSpread':
      title = `${f.shortNameA ?? f.participantA} ${f.spread} vs ${f.participantB}?`
      category = 'sports'
      break
    case 'companyIpoConfirmed':
      title = `${f.company} IPO by ${fmtUtc(endsAt, false)}?`
      category = 'companies'
      break
    case 'companyIpoFirstDayMarketCap': {
      const bn = Number(f.marketCapThresholdB)
      title = `${f.company} first-day market cap above ${bn >= 1000 ? `$${bn / 1000}T` : `$${bn}B`}?`
      category = 'companies'
      break
    }
    case 'sportsContestParticipant2':
    case 'sportsTournamentParticipant':
      label = f.participant ?? ''
      category = 'sports'
      break
    case 'sportsContestDraw2':
      label = 'Draw'
      category = 'sports'
      break
    case 'awardCandidate':
      label = f.candidate ?? f.subject ?? ''
      category = 'culture'
      break
    case 'awardOther':
    case 'fallback':
    case 'Recurring Fallback':
      label = 'Other'
      break
    case 'policyRateDecrease': label = 'Decrease'; category = 'economics'; break
    case 'policyRateIncrease': label = 'Increase'; category = 'economics'; break
    case 'policyRateNoChange': label = 'No change'; category = 'economics'; break
    case 'Recurring Named Outcome': {
      const thr = (f.priceThresholds ?? '').split(',').map(Number).filter(Number.isFinite)
      const i = Number(f.index)
      if (thr.length && Number.isInteger(i)) label = i === 0 ? `Under ${money(thr[0])}` : i >= thr.length ? `${money(thr[thr.length - 1])} or more` : `${money(thr[i - 1])} – ${money(thr[i])}`
      break
    }
  }
  if (q) category = category === 'other' ? questionCategory(q) : category
  if (!label) label = title
  if (!title) title = label || o.description || `Outcome ${o.outcome}`
  const sides = o.sideSpecs.slice(0, 2).map((s, i) => ({
    name: sideLabel(s.name, f) || (i === 0 ? 'Yes' : 'No'),
    coin: `#${10 * o.outcome + i}`,
    asset: 100_000_000 + 10 * o.outcome + i,
  })) as [OutcomeSide, OutcomeSide]
  if (endsAt === null && q) endsAt = parseTime(parseFields(q.description).resolutionDeadline ?? parseFields(q.description).expiry ?? parseFields(q.description).decisionDeadline)
  return { outcome: o.outcome, title, label, category, sides, endsAt, underlying: u.coin, fields: f, template: t, question: q?.question ?? null, venue: o.venue ?? null }
}

function questionCategory(q: RawQuestion): OutcomeCategory {
  const t = q.name.replace(/^template:/, '')
  if (t.startsWith('sports')) return 'sports'
  if (t.startsWith('policy')) return 'economics'
  if (t.startsWith('award')) return 'culture'
  if (t.startsWith('company')) return 'companies'
  const f = parseFields(q.description)
  if (f.underlying) return categoryOf(dexOf(f.underlying), symbolOf(f.underlying)) as OutcomeCategory
  return 'other'
}

export function questionTitle(q: RawQuestion): string {
  const f = parseFields(q.description)
  const t = q.name.replace(/^template:/, '')
  switch (t) {
    case 'sportsContestResult': return `${f.participantA} vs ${f.participantB}`
    case 'sportsTournamentWinner': return `${f.competition} ${f.season ?? ''} winner`.replace(/\s+/g, ' ').trim()
    case 'awardWinner': return `${f.award} ${f.period ?? ''} winner`.replace(/\s+/g, ' ').trim()
    case 'policyRateDecision': return `${f.institution ?? 'Policy rate'} decision, ${f.decisionLabel ?? ''}`.replace(/,\s*$/, '')
    case 'Recurring':
      if (f.class === 'priceBucket') return `${f.underlying} price at ${fmtUtc(parseTime(f.expiry))}`
      return q.description
    default: return f.title ?? q.description.split('|')[0] ?? `Question ${q.question}`
  }
}

/** Every live outcome market, grouped: a question's members together, a standalone outcome alone. */
export function groupOutcomes(outcomes: RawOutcome[], questions: RawQuestion[]): OutcomeGroup[] {
  const byId = new Map(outcomes.map(o => [o.outcome, o]))
  const inQuestion = new Set<number>()
  const groups: OutcomeGroup[] = []
  for (const q of questions) {
    const ids = [...q.namedOutcomes.filter(n => !q.settledNamedOutcomes.includes(n)), q.fallbackOutcome]
    const members = ids.map(id => byId.get(id)).filter((o): o is RawOutcome => !!o).map(o => describeOutcome(o, q))
    ids.forEach(id => inQuestion.add(id))
    if (!members.length) continue
    groups.push({
      id: q.question, title: questionTitle(q), category: members.find(m => m.category !== 'other')?.category ?? questionCategory(q),
      endsAt: members.map(m => m.endsAt).filter((x): x is number => x !== null).sort((x, y) => x - y)[0] ?? null,
      underlying: members[0].underlying, members, multi: true,
    })
  }
  for (const o of outcomes) {
    if (inQuestion.has(o.outcome)) continue
    const m = describeOutcome(o, null)
    groups.push({ id: -o.outcome, title: m.title, category: m.category, endsAt: m.endsAt, underlying: m.underlying, members: [m], multi: false })
  }
  return groups
}

export async function loadOutcomes(signal?: AbortSignal): Promise<OutcomeGroup[]> {
  const r = await hlInfo<{ outcomes: RawOutcome[]; questions: RawQuestion[] }>({ type: 'outcomeMeta' }, { signal })
  return groupOutcomes(r.outcomes ?? [], r.questions ?? [])
}
