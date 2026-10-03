// RedStone's signed prices, read from its public gateways and checked here exactly as
// SenseOracle checks them on-chain (contracts/SensePerps.sol): each feed's data packages from
// RedStone's authorised signers, one timestamp, at least `threshold` distinct signers, median.
//
// The gateway answers with every feed RedStone publishes (~1,000; ~430 KB gzipped), refreshed
// every 10 seconds; it can't be filtered. Polled every few seconds, a new timestamp is kept as a
// snapshot (the last few minutes of them), so the keeper can execute a request with the first
// prices signed after it, and the chart gets every price.

import { encodePacked, keccak256, recoverAddress, type Hex } from 'viem'
import { feedIdOf } from './shared'
import { errMsg, log } from '../log'

export interface SignedPkg {
  feedId: Hex
  value: bigint
  timestampMs: bigint
  signature: Hex
  signer: string
}

export interface FeedPrice {
  feed: string
  ts: number
  /** The signers' median, 8 decimals, as SenseOracle computes it. */
  median: bigint
  price: number
  pkgs: SignedPkg[]
}

export interface Snapshot {
  ts: number
  fetchedAt: number
  feeds: Record<string, FeedPrice>
}

interface RawPkg {
  timestampMilliseconds: number
  signature: string
  signerAddress: string
  dataPoints: { dataFeedId: string; value: number | string }[]
}

/** A gateway value (a JSON number like 84679.90298849) as an 8-decimal integer, exactly. */
export function toUnits8(v: number | string): bigint | null {
  let s = typeof v === 'number' ? String(v) : v.trim()
  if (/e/i.test(s)) {
    if (typeof v !== 'number') return null
    s = v.toFixed(8)
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const frac = (m[2] ?? '').padEnd(8, '0')
  if (frac.length > 8 && /[1-9]/.test(frac.slice(8))) return null
  return BigInt(m[1] + frac.slice(0, 8))
}

/** What a RedStone signer signs for a one-data-point package. */
export function packageHash(feedId: Hex, value: bigint, timestampMs: bigint): Hex {
  return keccak256(encodePacked(['bytes32', 'uint256', 'uint48', 'uint32', 'uint24'], [feedId, value, Number(timestampMs), 32, 1]))
}

export function median(values: bigint[]): bigint {
  const a = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  const n = a.length
  return n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2n
}

const b64ToHex = (b64: string): Hex => `0x${Buffer.from(b64, 'base64').toString('hex')}`

/** One feed's packages: the latest timestamp's, from distinct authorised signers whose
 * signatures check out. Null when fewer than `threshold` remain. */
export async function verifyFeed(feed: string, raw: RawPkg[] | undefined, signers: readonly string[], threshold: number): Promise<FeedPrice | null> {
  if (!raw?.length) return null
  const ts = Math.max(...raw.map(p => Number(p.timestampMilliseconds) || 0))
  if (!ts) return null
  const allowed = new Set(signers.map(s => s.toLowerCase()))
  const id = feedIdOf(feed)
  const seen = new Set<string>()
  const pkgs: SignedPkg[] = []
  for (const p of raw) {
    if (Number(p.timestampMilliseconds) !== ts) continue
    const dp = p.dataPoints?.[0]
    if (!dp || p.dataPoints.length !== 1 || dp.dataFeedId !== feed) continue
    const value = toUnits8(dp.value)
    if (value === null || value === 0n) continue
    const signature = b64ToHex(p.signature)
    if (signature.length !== 132) continue
    const v = parseInt(signature.slice(130), 16)
    if (v !== 27 && v !== 28) continue
    let signer: string
    try {
      signer = (await recoverAddress({ hash: packageHash(id, value, BigInt(ts)), signature })).toLowerCase()
    } catch { continue }
    if (!allowed.has(signer) || signer !== p.signerAddress?.toLowerCase() || seen.has(signer)) continue
    seen.add(signer)
    pkgs.push({ feedId: id, value, timestampMs: BigInt(ts), signature, signer })
  }
  if (pkgs.length < threshold) return null
  const med = median(pkgs.map(p => p.value))
  return { feed, ts, median: med, price: Number(med) / 1e8, pkgs }
}

export interface RedstoneOptions {
  feeds: readonly string[]
  signers: readonly string[]
  threshold: number
  gateways: readonly string[]
  dataService: string
  everyMs?: number
  /** Snapshots kept (one per 10-second timestamp): 60 is ten minutes. */
  keep?: number
  fetch?: typeof fetch
  now?: () => number
}

/** Polls the gateways and keeps the recent snapshots. */
export class RedstoneFeed {
  private snaps: Snapshot[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private gw = 0
  private listeners: ((s: Snapshot) => void)[] = []
  errors = 0
  lastError: string | null = null
  fetchedAt: number | null = null

  constructor(private o: RedstoneOptions) {}

  start() {
    if (this.timer) return
    void this.poll()
    // Every 4 seconds: a new 10-second package is seen within 4s of the gateway having it, at
    // ~100 KB/s of (gzipped) download.
    this.timer = setInterval(() => void this.poll(), this.o.everyMs ?? 4_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  onSnapshot(cb: (s: Snapshot) => void) {
    this.listeners.push(cb)
  }

  latest(): Snapshot | null {
    return this.snaps[this.snaps.length - 1] ?? null
  }

  history(): readonly Snapshot[] {
    return this.snaps
  }

  gateway(): string {
    return this.o.gateways[this.gw % this.o.gateways.length]
  }

  /** The first snapshot signed at or after `tsMs` that has every feed in `feeds`. */
  firstFrom(tsMs: number, feeds: readonly string[]): Snapshot | null {
    for (const s of this.snaps) {
      if (s.ts >= tsMs && feeds.every(f => s.feeds[f]?.ts === s.ts)) return s
    }
    return null
  }

  /** Takes one gateway answer (exposed for tests). */
  async ingest(raw: Record<string, RawPkg[]>, fetchedAt: number): Promise<Snapshot | null> {
    const probe = raw[this.o.feeds[0]]
    const probeTs = probe?.length ? Math.max(...probe.map(p => Number(p.timestampMilliseconds) || 0)) : 0
    const last = this.latest()
    if (last && probeTs && probeTs <= last.ts) return null
    const feeds: Record<string, FeedPrice> = {}
    for (const f of this.o.feeds) {
      const fp = await verifyFeed(f, raw[f], this.o.signers, this.o.threshold)
      if (fp) feeds[f] = fp
    }
    const tss = Object.values(feeds).map(f => f.ts)
    if (!tss.length) return null
    const ts = Math.max(...tss)
    if (last && ts <= last.ts) return null
    const snap: Snapshot = { ts, fetchedAt, feeds }
    this.snaps.push(snap)
    const keep = this.o.keep ?? 60
    if (this.snaps.length > keep) this.snaps.splice(0, this.snaps.length - keep)
    for (const l of this.listeners) {
      try { l(snap) } catch (e) { log.warn('perps: snapshot listener failed', { error: errMsg(e) }) }
    }
    return snap
  }

  private async poll() {
    if (this.busy) return
    this.busy = true
    const now = this.o.now ?? Date.now
    const url = `${this.gateway()}/data-packages/latest/${this.o.dataService}`
    try {
      const r = await (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`gateway answered ${r.status}`)
      const raw = await r.json() as Record<string, RawPkg[]>
      this.fetchedAt = now()
      await this.ingest(raw, this.fetchedAt)
    } catch (e) {
      this.errors++
      this.lastError = errMsg(e)
      this.gw++ // the other gateway next time
      if (this.errors % 20 === 1) log.warn('perps: RedStone gateway failed', { gateway: url, error: this.lastError })
    } finally {
      this.busy = false
    }
  }
}
