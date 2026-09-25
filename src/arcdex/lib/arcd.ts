// $ARCD — ARCDEX's official coin (an Argus Portal 8 launch on Arc).
// Platform fees buy it back and burn it: bought $ARCD is sent to the burn
// address 0x…dEaD, which no one can move tokens out of. /api/arcd gathers
// the public numbers (market, burned, fee wallet, recent burns, fees).
//
// No wallet or viem imports here — the landing page uses this and stays
// a small bundle.

export const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
export const ARCD_POOL = '0x87b65f8831a8f3ba17da44003fae5294476b9a5c7ac5da53485a44dd12af9897'
export const FEE_WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
export const ARCD_SUPPLY = 1_000_000_000
export const ARC_EXPLORER = 'https://explorer.arc.io'
/** Where "Buy $ARCD" goes: the coin's page in the app, with its pool. */
export const ARCD_APP_PATH = `/token/${ARCD}?pool=${ARCD_POOL}`

export interface ArcdBurn { tx: string; from: string; amount: number; time: number | null; block: number }
export interface ArcdStats {
  market: { priceUsd: number; fdvUsd: number; liquidityUsd: number; volume24h: number; change24h: number; image: string | null } | null
  burned: number | null
  burnedPct: number | null
  feeWallet: { address: string; usdc: number | null; arcd: number | null }
  burns: ArcdBurn[]
  fees: { feesUsdc: number; fees24h: number; referralPaid: number; trades: number; traders: number } | null
  updatedAt: number
}

let cache: { at: number; data: ArcdStats } | null = null
let inflight: Promise<ArcdStats> | null = null

/** Cached for 30s in the page; the endpoint itself is CDN-cached for 60s. */
export function loadArcd(force = false): Promise<ArcdStats> {
  if (!force && cache && Date.now() - cache.at < 30_000) return Promise.resolve(cache.data)
  inflight ??= fetch('/api/arcd')
    .then(r => { if (!r.ok) throw new Error('arcd ' + r.status); return r.json() as Promise<ArcdStats> })
    .then(d => { cache = { at: Date.now(), data: d }; return d })
    .finally(() => { inflight = null })
  return inflight
}

/** Compact number: 1.23B / 4.5M / 12.3K / 12.34 / 0 */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  if (n >= 1) return n.toFixed(2)
  if (n < 0.01) return '0'
  return n.toFixed(2)
}

/** Micro-cap price with 3 significant digits: $0.00000249 */
export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—'
  return '$' + (n >= 1 ? n.toFixed(4) : Number(n.toPrecision(3)).toFixed(Math.max(2, 2 - Math.floor(Math.log10(n)))))
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
