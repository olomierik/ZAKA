// The native coins' dollar prices the Trenches feed values trades with (SOL, BNB, ETH): Hyperliquid's mid prices,
// read every 10 seconds (its public API, no key). A price older than five minutes isn't used: trades are then left
// unpriced rather than priced wrong.

import { errMsg, log } from '../log'

export type NativeSym = 'SOL' | 'BNB' | 'ETH'
const HL_INFO = 'https://api.hyperliquid.xyz/info'
const STALE_MS = 5 * 60_000

export class NativePrices {
  private px: Record<NativeSym, number> = { SOL: 0, BNB: 0, ETH: 0 }
  private at = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private fetcher: typeof fetch = fetch) {}

  /** Dollars per coin, or null while unknown or stale. */
  usd(sym: NativeSym, now = Date.now()): number | null {
    const p = this.px[sym]
    return p > 0 && now - this.at < STALE_MS ? p : null
  }

  set(prices: Partial<Record<NativeSym, number>>, now = Date.now()) {
    for (const [k, v] of Object.entries(prices) as [NativeSym, number][]) if (Number.isFinite(v) && v > 0) this.px[k] = v
    this.at = now
  }

  async refresh() {
    const r = await this.fetcher(HL_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }), signal: AbortSignal.timeout(8_000) })
    if (!r.ok) throw new Error(`hyperliquid allMids ${r.status}`)
    const j = (await r.json()) as Record<string, string>
    this.set({ SOL: Number(j.SOL), BNB: Number(j.BNB), ETH: Number(j.ETH) })
  }

  start() {
    const go = () => void this.refresh().catch(e => log.debug('trench: native prices failed', { error: errMsg(e) }))
    go()
    this.timer = setInterval(go, 10_000)
  }
  stop() { if (this.timer) clearInterval(this.timer) }
}
