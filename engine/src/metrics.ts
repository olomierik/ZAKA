// In-process metrics: counters, gauges, per-second rates (10s window) and
// latency percentiles. Exposed on /health (summary) and /metrics (full).

class Rate {
  private buckets = new Array<number>(10).fill(0)
  private at = Math.floor(Date.now() / 1000)
  mark(n = 1) { this.roll(); this.buckets[this.at % 10] += n }
  perSec() { this.roll(); return this.buckets.reduce((a, b) => a + b, 0) / 10 }
  private roll() {
    const now = Math.floor(Date.now() / 1000)
    for (let s = this.at + 1; s <= now && s - this.at <= 10; s++) this.buckets[s % 10] = 0
    if (now - this.at > 10) this.buckets.fill(0)
    this.at = now
  }
}

class Latency {
  private samples: number[] = []
  add(ms: number) { this.samples.push(ms); if (this.samples.length > 2000) this.samples.splice(0, 1000) }
  summary() {
    if (!this.samples.length) return null
    const s = [...this.samples].sort((a, b) => a - b)
    const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))])
    return { p50: q(0.5), p90: q(0.9), p99: q(0.99), n: s.length }
  }
}

export class Metrics {
  readonly startedAt = Date.now()
  counters: Record<string, number> = {}
  gauges: Record<string, number | string | boolean | null> = {}
  private rates: Record<string, Rate> = {}
  private lat: Record<string, Latency> = {}

  inc(name: string, n = 1) { this.counters[name] = (this.counters[name] ?? 0) + n; (this.rates[name] ??= new Rate()).mark(n) }
  set(name: string, v: number | string | boolean | null) { this.gauges[name] = v }
  latency(name: string, ms: number) { (this.lat[name] ??= new Latency()).add(ms) }
  rate(name: string) { return this.rates[name]?.perSec() ?? 0 }

  snapshot() {
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      counters: this.counters,
      gauges: this.gauges,
      perSec: Object.fromEntries(Object.keys(this.rates).map(k => [k, Math.round(this.rate(k) * 100) / 100])),
      latencyMs: Object.fromEntries(Object.entries(this.lat).map(([k, v]) => [k, v.summary()])),
    }
  }
}

export const metrics = new Metrics()
