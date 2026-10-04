// $SENSE, ARCSENSE's coin: an Argus launch (name ARCSENSE, symbol SENSE, 1B supply) and its v4 pool.
// One shared poller of the market engine's numbers for it (GET /v1/tokens/<SENSE>), read by the
// top bar's ticker, the Markets page, the spot page and the home page. No wallet libraries, so the
// home page's small bundle can use it too.

import { useSyncExternalStore } from 'react'

export const SENSE = '0x91402b32C4Ab7915132b8B24e0d084E0428667ED'
export const SENSE_LC = SENSE.toLowerCase()
export const SENSE_POOL = '0x879394cd067942b06d9e15aa58420729b30944901bf107b5f7779a8c5c9de047'
/** $SENSE's logo: ARCSENSE's mark, served by the site (its IPFS image loads slowly or not at all). */
export const SENSE_IMAGE = '/arcsense-mark.png'
/** The app's address for $SENSE's trading page. */
export const SENSE_PATH = `/token/${SENSE_LC}?pool=${SENSE_POOL}`

const WS_URL = (import.meta.env.VITE_ARCDEX_WS_URL as string | undefined) || ''
/** The market engine's REST base ('' without an engine). */
export const ENGINE_API = ((import.meta.env.VITE_ARCDEX_API_URL as string | undefined) || WS_URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '')).replace(/\/$/, '')

export interface SenseQuote {
  priceUsd: number | null
  change24h: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  volume24h: number | null
  buys24h: number
  sells24h: number
  image: string
  at: number
}

let quote: SenseQuote | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  if (!ENGINE_API) return
  try {
    const r = await fetch(`${ENGINE_API}/v1/tokens/${SENSE_LC}`, { signal: AbortSignal.timeout(8_000) })
    if (!r.ok) return
    const j = await r.json() as { stats?: { priceUsd: number | null; marketCapUsd: number | null; liquidityUsd: number | null; vol24: number; buys24: number; sells24: number; chg: { h24: number | null } } | null }
    const s = j.stats
    if (!s) return
    quote = {
      priceUsd: s.priceUsd, change24h: s.chg?.h24 ?? null, marketCapUsd: s.marketCapUsd, liquidityUsd: s.liquidityUsd,
      volume24h: s.vol24, buys24h: s.buys24, sells24h: s.sells24, image: SENSE_IMAGE, at: Date.now(),
    }
    listeners.forEach(f => f())
  } catch { /* keep the last quote */ }
}

function subscribe(f: () => void) {
  listeners.add(f)
  if (!timer) {
    void load()
    timer = setInterval(() => { if (!document.hidden) void load() }, 15_000)
  }
  return () => {
    listeners.delete(f)
    if (!listeners.size && timer) { clearInterval(timer); timer = null }
  }
}

/** $SENSE's live numbers from the market engine (null until the first answer). */
export function useSense(): SenseQuote | null {
  return useSyncExternalStore(subscribe, () => quote, () => null)
}

/** A small price, readable: $0.000002548 → "$0.0₅2548" style is hard to scan, so 4 significant digits. */
export function fmtSmallUsd(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—'
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (p >= 1) return `$${p.toFixed(4)}`
  return `$${p.toPrecision(4)}`
}

export function fmtCompactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

export const fmtPct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
