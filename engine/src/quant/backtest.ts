// The backtester: historical Arc trades replayed in chronological order
// through the very same SignalEngine that runs live. At each event the engine
// sees only what came before it: features from the tape so far, wallet
// records from trades already closed, the regime from coins so far. Orders
// fill at the first price after the configured latency (simulated slippage
// from the pool's depth, the pool fee, taxes and gas), positions are managed
// tick by tick, and every closed trade is reported.
//
// What a replay can't know: the scanner's on-chain checks (code, hook,
// honeypot probe, funding clusters). The coin's own trades stand in where
// they can (bundles, wash trading, the creator's selling, holders); coins of
// the scored launchpads are assumed to be the launchpad's standard code with
// no probe tax, and their funding independent. Live, those checks run for
// real, so a replay is, if anything, kinder than live on safety.

import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { RugWatch } from '../bot/rugGuard'
import { computeFlow, RecentTapes, Tapes, tapeTrade } from '../intel/flow'
import { assess, type SafetyReport } from '../intel/scanner'
import { DEFAULT_CONFIG, mergeConfig, type QuantConfig } from './config'
import { PoolPicker, SignalEngine } from './engine'
import { bookStats, type BookStats, type QPosition } from './positions'
import { MemoryQuantStore, type StoredSignal } from './store'

export interface ReplayData {
  launches: LaunchInfo[]
  /** Every trade, in chain order (block, log index); a replay sorts them again to be sure. */
  trades: Trade[]
}

export interface BacktestOptions {
  config?: QuantConfig
  /** Trading starts here; earlier events only build the engine's state (warm-up: tapes, wallets, regime). */
  from: number
  to: number
  /** Simulated clock step for time-based work (time exits, the regime, labels). */
  tickMs?: number
  /** Called every ~25k events so long replays can yield (the engine keeps serving). */
  onProgress?: (done: number, total: number) => Promise<void> | void
}

export interface Breakdown { key: string; stats: BookStats }

export interface BacktestReport {
  from: number
  to: number
  events: number
  coins: number
  signals: number
  traded: number
  rejected: number
  rejectReasons: Record<string, number>
  totals: BookStats
  byStrategy: Breakdown[]
  byScore: Breakdown[]
  byAge: Breakdown[]
  byLiquidity: Breakdown[]
  byRegime: Breakdown[]
  config: QuantConfig
  ms: number
}

/** Replay-time safety: the scanner's own assessment, with the facts a replay can't read filled in as described above. */
export class ReplaySafety {
  private early = new Tapes(2_000)
  private launchesByCreator = new Map<string, number[]>()
  private cache = new Map<string, { at: number; r: SafetyReport }>()

  constructor(private meta: (token: string) => LaunchInfo | null, private liquidity: (token: string) => number | null) {}

  onLaunch(l: LaunchInfo) {
    if (!l.creator) return
    const list = this.launchesByCreator.get(l.creator.toLowerCase()) ?? []
    list.push(l.timestamp); this.launchesByCreator.set(l.creator.toLowerCase(), list)
  }
  onTrade(t: Trade) { this.early.add(t.token, tapeTrade(t)) }

  report(token: string, now: number): SafetyReport | null {
    const meta = this.meta(token)
    if (!meta) return null
    const c = this.cache.get(token)
    if (c && now - c.at < 15_000) return c.r
    const tape = this.early.get(token)
    if (!tape.length) return null
    const flow = computeFlow(tape.filter(t => t.ts <= now), { launchBlock: meta.blockNumber, creator: meta.creator, supply: meta.launchpad === 'ARGUS' ? 1e9 : null })
    // Holders from the coin's own trades (Transfer logs aren't in a replay).
    const net = new Map<string, number>()
    for (const t of tape) if (t.ts <= now && t.wallet) net.set(t.wallet, (net.get(t.wallet) ?? 0) + (t.side === 'BUY' ? t.tokens : -t.tokens))
    const supply = 1e9
    const rows = [...net.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    const creator = meta.creator?.toLowerCase() ?? null
    const others = (this.launchesByCreator.get(creator ?? '') ?? []).filter(t => t < now && now - t < 86_400_000 && t !== meta.timestamp).length
    const r = assess(
      { template: `${meta.launchpad} standard token (assumed in a replay)`, facts: null, owner: null, ownerless: true, proxy: false, hook: null },
      {
        meta, pool: null, liquidityUsd: this.liquidity(token), onCurve: false, flow,
        honeypot: { verdict: 'ok', buyTaxPct: 0, transferTaxPct: 0, roundTripLossPct: null, error: null },
        holders: { holders: rows.length, top10Pct: (rows.slice(0, 10).reduce((s, [, v]) => s + v, 0) / supply) * 100, creatorPct: creator ? ((net.get(creator) ?? 0) / supply) * 100 : 0, top: [] },
        clusters: { groups: [], creatorFunded: [], sameSourceAsCreator: [], unknown: 0 },
        biggerSameTicker: [], creatorLaunches24h: others,
      },
    )
    this.cache.set(token, { at: now, r })
    return r
  }
}

const bucket = <T>(items: T[], keyOf: (x: T) => string) => {
  const m = new Map<string, T[]>()
  for (const x of items) { const k = keyOf(x); m.set(k, [...(m.get(k) ?? []), x]) }
  return m
}

/** Replays `data` and trades it from `from` to `to`. */
export async function runBacktest(data: ReplayData, o: BacktestOptions): Promise<{ report: BacktestReport; positions: QPosition[]; signals: StoredSignal[]; engine: SignalEngine }> {
  const t0 = Date.now()
  const config = o.config ?? DEFAULT_CONFIG
  const metas = new Map(data.launches.map(l => [l.token, l]))
  const liq = new Map<string, number>()
  const store = new MemoryQuantStore()
  const recent = new RecentTapes(300_000, 2_000)
  const rug = new RugWatch(recent)
  const safety = new ReplaySafety(t => metas.get(t) ?? null, t => liq.get(t) ?? null)
  for (const l of [...data.launches].sort((a, b) => a.timestamp - b.timestamp)) safety.onLaunch(l)
  const engine = new SignalEngine({
    store, mode: 'backtest', config,
    meta: t => metas.get(t) ?? null,
    token: () => null,
    safety: t => safety.report(t, engine.marketNow),
    rugAlarm: (t, now) => rug.recentAlarm(t, now)?.text ?? null,
  })
  const trades = [...data.trades].sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  const tick = o.tickMs ?? 1_000
  let nextTick = 0
  const coins = new Set<string>()
  const pools = new PoolPicker()
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]
    if (t.timestamp > o.to) break
    const now = t.timestamp
    // The clock first: time exits and the regime up to this event.
    if (!nextTick) nextTick = now + tick
    while (nextTick <= now) { engine.tick(nextTick); nextTick += tick }
    if (t.liquidity !== null) liq.set(t.token, t.liquidity)
    safety.onTrade(t)
    // The rug guard reads the main pool's price and depth only, as live (bot/bot.ts).
    const priced = pools.main(t)
    const tt = { ...tapeTrade(t), price: priced ? t.priceUsd : null }
    recent.add(t.token, tt, now)
    rug.onTrade(t.token, tt, priced ? t.liquidity : null, priced, now)
    const live = now >= o.from
    engine.ingest(t, { replay: !live, now })
    if (live) { coins.add(t.token); engine.evaluateDue(now) }
    if (o.onProgress && i % 25_000 === 0) await o.onProgress(i, trades.length)
  }
  // Positions still open at the end are sold at the last price.
  engine.tick(o.to)
  engine.emergencyCloseAll('end of the backtest')
  for (let k = 0; k < 3; k++) engine.tick(o.to + (k + 1) * 30_000)
  const positions = [...engine.closed.filter(p => p.mode === 'backtest'), ...engine.positions.filter(p => p.mode === 'backtest')]
  const signals = [...store.signalRows.values()].sort((a, b) => a.at - b.at)
  const sig = new Map(signals.map(s => [s.id, s]))
  const closed = positions.filter(p => p.status === 'closed')
  const summaryOf = (p: QPosition) => (sig.get(p.signalId)?.summary ?? {}) as Record<string, number | string | null>
  const eq = config.sizing.paperEquityUsd
  const breakdown = (keyOf: (p: QPosition) => string): Breakdown[] => [...bucket(closed, keyOf).entries()].map(([key, ps]) => ({ key, stats: bookStats(ps, eq) })).sort((a, b) => a.key.localeCompare(b.key))
  const reasons: Record<string, number> = {}
  for (const s of signals) if (s.decision === 'rejected') for (const r of ((s as unknown as { why_trade_rejected: string[] }).why_trade_rejected ?? [])) { const k = r.split(':')[0]; reasons[k] = (reasons[k] ?? 0) + 1 }
  const report: BacktestReport = {
    from: o.from, to: o.to, events: trades.length, coins: coins.size,
    signals: signals.length, traded: signals.filter(s => s.decision === 'traded').length, rejected: signals.filter(s => s.decision === 'rejected').length, rejectReasons: reasons,
    totals: bookStats(closed, eq),
    byStrategy: breakdown(p => p.strategy),
    byScore: breakdown(p => { const s = Number(summaryOf(p).score ?? 0); const lo = Math.min(90, Math.max(50, Math.floor(s / 5) * 5)); return s < 50 ? '<50' : lo >= 90 ? '90-100' : `${lo}-${lo + 5}` }),
    byAge: breakdown(p => { const a = Number(summaryOf(p).age_min ?? 0); return a < 10 ? 'a <10m' : a < 30 ? 'b 10-30m' : a < 120 ? 'c 30m-2h' : 'd >2h' }),
    byLiquidity: breakdown(p => { const l = Number(summaryOf(p).liquidity ?? 0); return l < 10_000 ? 'a <$10k' : l < 25_000 ? 'b $10-25k' : l < 50_000 ? 'c $25-50k' : 'd >$50k' }),
    byRegime: breakdown(p => String(summaryOf(p).regime ?? 'NEUTRAL')),
    config, ms: Date.now() - t0,
  }
  return { report, positions, signals, engine }
}

/** A config with a patch laid over it (the walk-forward grid). */
export const withPatch = (c: QuantConfig, patch: unknown) => mergeConfig(c, patch)
