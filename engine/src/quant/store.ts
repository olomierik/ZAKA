// Where the signal engine keeps its records: the engine's own Postgres
// (DATABASE_URL; tables created on start, safe to re-run), else memory (dev,
// tests, backtests). Trades, swaps and tokens are not copied: they are the
// market engine's arcdex_mkt_trades and arcdex_mkt_tokens (store/
// postgresHistory.ts), which this reads for backtests.
//
//   arcdex_sig_signals              every signal: score, components, strategy, decision and why
//   arcdex_sig_signal_features      its feature vector and every feature value (for models)
//   arcdex_sig_signal_outcomes      what the price did after it (labels: quant/labels.ts)
//   arcdex_sig_snapshots            token market snapshots (each scored coin, once a minute)
//   arcdex_sig_positions            paper, live and backtest positions with every fill
//   arcdex_sig_orders               each order and its result
//   arcdex_sig_execution_events     submitted / filled / failed / retried / timed out
//   arcdex_sig_risk_events          refusals by the risk governor, kill switch, gate changes
//   arcdex_sig_wallets              wallet performance and class (smart money …)
//   arcdex_sig_wallet_positions     wallets' open positions by coin
//   arcdex_sig_strategy_results     each strategy's results by day and book
//   arcdex_sig_strategy_parameters  every version of the settings, who changed them and why
//   arcdex_sig_backtest_runs        backtests and walk-forward runs with their reports
//   arcdex_sig_market_regimes       the market regime over time
//
// The same SQL is in engine/sql/20261002000000_signal_engine.sql for review.
// Writes never block the engine: they are queued and sent in batches.

import { SQL } from 'bun'
import { log, errMsg } from '../log'
import type { QPosition } from './positions'
import type { RegimeView } from './regime'
import type { RiskEvent } from './risk'
import type { ExecutionEvent } from './execution'
import type { WalletPosition, WalletStats } from './wallets'

export interface StoredSignal {
  id: string
  at: number
  token: string
  symbol: string
  launchpad: string | null
  strategy: string
  signal_score: number
  band: string
  decision: 'traded' | 'rejected' | 'watch'
  mode: 'paper' | 'live' | 'backtest'
  [k: string]: unknown
}

export interface SignalFeaturesRow { signalId: string; at: number; token: string; strategy: string; vector: Record<string, number | null>; features: Record<string, unknown> }
export interface OutcomeRow { signalId: string; at: number; token: string; strategy: string; data: Record<string, unknown> }
export interface OrderRow { key: string; positionId: string; token: string; side: 'BUY' | 'SELL'; mode: string; status: string; at: number; data: Record<string, unknown> }
export interface StrategyResultRow { strategy: string; mode: string; day: string; data: Record<string, unknown> }
export interface BacktestRun { id: string; at: number; kind: 'backtest' | 'walkforward'; data: Record<string, unknown> }
export interface ParamsVersion { version: number; at: number; by: string; note: string; config: unknown }

export interface QuantStore {
  readonly kind: 'memory' | 'postgres'
  saveSignal(s: StoredSignal, f: SignalFeaturesRow | null): void
  saveOutcome(o: OutcomeRow): void
  saveSnapshot(token: string, at: number, data: Record<string, unknown>): void
  savePosition(p: QPosition): void
  saveOrder(o: OrderRow): void
  saveExecutionEvent(e: ExecutionEvent): void
  saveRiskEvent(e: RiskEvent): void
  saveRegime(r: RegimeView): void
  saveWallets(rows: WalletStats[]): void
  saveWalletPositions(rows: (WalletPosition & { wallet: string })[]): void
  saveStrategyResult(r: StrategyResultRow): void
  saveParams(p: Omit<ParamsVersion, 'version'>): Promise<number>
  saveBacktest(r: BacktestRun): void
  positions(days: number): Promise<QPosition[]>
  signals(limit: number, sinceTs?: number): Promise<StoredSignal[]>
  backtests(limit: number): Promise<BacktestRun[]>
  latestParams(): Promise<ParamsVersion | null>
  /** Feature vectors with their outcome labels, oldest first (the model dataset). */
  dataset(sinceTs: number, limit: number): Promise<{ signal_id: string; at: number; token: string; strategy: string; vector: Record<string, number | null>; outcome: Record<string, unknown> | null }[]>
  riskEvents(limit: number): Promise<RiskEvent[]>
  executionEvents(limit: number): Promise<ExecutionEvent[]>
  cleanup(): Promise<void>
  flush(): Promise<void>
}

const cap = <T>(a: T[], n: number) => { if (a.length > n) a.splice(0, a.length - n) }

export class MemoryQuantStore implements QuantStore {
  readonly kind = 'memory' as const
  readonly signalRows = new Map<string, StoredSignal>()
  readonly features = new Map<string, SignalFeaturesRow>()
  readonly outcomes = new Map<string, OutcomeRow>()
  readonly snapshots: { token: string; at: number; data: Record<string, unknown> }[] = []
  readonly positionRows = new Map<string, QPosition>()
  readonly orders = new Map<string, OrderRow>()
  readonly execEvents: ExecutionEvent[] = []
  readonly riskRows: RiskEvent[] = []
  readonly regimes: RegimeView[] = []
  readonly wallets = new Map<string, WalletStats>()
  readonly walletPositions = new Map<string, WalletPosition & { wallet: string }>()
  readonly results = new Map<string, StrategyResultRow>()
  readonly params: ParamsVersion[] = []
  readonly runs: BacktestRun[] = []
  saveSignal(s: StoredSignal, f: SignalFeaturesRow | null) { this.signalRows.set(s.id, s); if (f) this.features.set(f.signalId, f); if (this.signalRows.size > 20_000) { const k = this.signalRows.keys().next().value; if (k) { this.signalRows.delete(k); this.features.delete(k) } } }
  saveOutcome(o: OutcomeRow) { this.outcomes.set(o.signalId, o) }
  saveSnapshot(token: string, at: number, data: Record<string, unknown>) { this.snapshots.push({ token, at, data }); cap(this.snapshots, 20_000) }
  savePosition(p: QPosition) { this.positionRows.set(p.id, structuredClone(p)) }
  saveOrder(o: OrderRow) { this.orders.set(o.key, o) }
  saveExecutionEvent(e: ExecutionEvent) { this.execEvents.push(e); cap(this.execEvents, 5_000) }
  saveRiskEvent(e: RiskEvent) { this.riskRows.push(e); cap(this.riskRows, 5_000) }
  saveRegime(r: RegimeView) { this.regimes.push(r); cap(this.regimes, 5_000) }
  saveWallets(rows: WalletStats[]) { for (const r of rows) this.wallets.set(r.wallet, r) }
  saveWalletPositions(rows: (WalletPosition & { wallet: string })[]) { for (const r of rows) this.walletPositions.set(`${r.wallet}:${r.token}`, r) }
  saveStrategyResult(r: StrategyResultRow) { this.results.set(`${r.strategy}:${r.mode}:${r.day}`, r) }
  async saveParams(p: Omit<ParamsVersion, 'version'>) { const version = this.params.length + 1; this.params.push({ ...p, version }); return version }
  saveBacktest(r: BacktestRun) { this.runs.push(r); cap(this.runs, 200) }
  async positions(days: number) { const since = Date.now() - days * 86_400_000; return [...this.positionRows.values()].filter(p => p.status === 'open' || p.status === 'pending' || (p.closedAt ?? 0) >= since).map(p => structuredClone(p)) }
  async signals(limit: number, sinceTs?: number) { return [...this.signalRows.values()].filter(s => sinceTs === undefined || s.at >= sinceTs).sort((a, b) => b.at - a.at).slice(0, limit) }
  async backtests(limit: number) { return [...this.runs].sort((a, b) => b.at - a.at).slice(0, limit) }
  async latestParams() { return this.params[this.params.length - 1] ?? null }
  async dataset(sinceTs: number, limit: number) {
    return [...this.features.values()].filter(f => f.at >= sinceTs).sort((a, b) => a.at - b.at).slice(0, limit)
      .map(f => ({ signal_id: f.signalId, at: f.at, token: f.token, strategy: f.strategy, vector: f.vector, outcome: this.outcomes.get(f.signalId)?.data ?? null }))
  }
  async riskEvents(limit: number) { return this.riskRows.slice(-limit).reverse() }
  async executionEvents(limit: number) { return this.execEvents.slice(-limit).reverse() }
  async cleanup() {}
  async flush() {}
}

export const SCHEMA = `
create table if not exists arcdex_sig_signals (
  id text primary key, at timestamptz not null, token text not null, symbol text, launchpad text, strategy text not null,
  score double precision not null, band text not null, decision text not null, mode text not null, data jsonb not null
);
create index if not exists arcdex_sig_signals_at on arcdex_sig_signals (at desc);
create index if not exists arcdex_sig_signals_token on arcdex_sig_signals (token, at desc);
create table if not exists arcdex_sig_signal_features (
  signal_id text primary key, at timestamptz not null, token text not null, strategy text not null, vector jsonb not null, features jsonb not null
);
create index if not exists arcdex_sig_signal_features_at on arcdex_sig_signal_features (at);
create table if not exists arcdex_sig_signal_outcomes (signal_id text primary key, at timestamptz not null, token text not null, strategy text not null, data jsonb not null);
create table if not exists arcdex_sig_snapshots (token text not null, at timestamptz not null, data jsonb not null, primary key (token, at));
create index if not exists arcdex_sig_snapshots_at on arcdex_sig_snapshots (at);
create table if not exists arcdex_sig_positions (
  id text primary key, token text not null, strategy text not null, mode text not null, status text not null,
  opened_at timestamptz not null, closed_at timestamptz, pnl_usd double precision, data jsonb not null
);
create index if not exists arcdex_sig_positions_open on arcdex_sig_positions (mode, status, closed_at desc);
create table if not exists arcdex_sig_orders (
  key text primary key, position_id text not null, token text not null, side text not null, mode text not null, status text not null, at timestamptz not null, data jsonb not null
);
create table if not exists arcdex_sig_execution_events (
  id bigserial primary key, at timestamptz not null, key text not null, position_id text not null, token text not null, mode text not null, kind text not null, data jsonb not null
);
create index if not exists arcdex_sig_execution_events_at on arcdex_sig_execution_events (at desc);
create table if not exists arcdex_sig_risk_events (
  id bigserial primary key, at timestamptz not null, mode text not null, kind text not null, token text, detail text not null
);
create index if not exists arcdex_sig_risk_events_at on arcdex_sig_risk_events (at desc);
create table if not exists arcdex_sig_wallets (
  wallet text primary key, class text not null, quality double precision not null, trades int not null, win_rate double precision not null,
  profit_factor double precision, realized_profit double precision not null, realized_loss double precision not null, updated_at timestamptz not null, data jsonb not null
);
create index if not exists arcdex_sig_wallets_class on arcdex_sig_wallets (class, quality desc);
create table if not exists arcdex_sig_wallet_positions (wallet text not null, token text not null, updated_at timestamptz not null, data jsonb not null, primary key (wallet, token));
create table if not exists arcdex_sig_strategy_results (strategy text not null, mode text not null, day date not null, data jsonb not null, updated_at timestamptz not null default now(), primary key (strategy, mode, day));
create table if not exists arcdex_sig_strategy_parameters (version serial primary key, at timestamptz not null, changed_by text not null, note text not null, config jsonb not null);
create table if not exists arcdex_sig_backtest_runs (id text primary key, at timestamptz not null, kind text not null, data jsonb not null);
create table if not exists arcdex_sig_market_regimes (at timestamptz primary key, regime text not null, data jsonb not null);
`

const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : typeof x === 'number' && !Number.isFinite(x) ? null : x))
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T

/** Rows waiting for the next batch, per table. */
export interface Queues {
  signals: unknown[][]; features: unknown[][]; outcomes: unknown[][]; snapshots: unknown[][]; positions: unknown[][]; orders: unknown[][]
  exec: unknown[][]; risk: unknown[][]; regimes: unknown[][]; wallets: unknown[][]; walletPositions: unknown[][]; results: unknown[][]; runs: unknown[][]
}
const TABLES: Record<keyof Queues, { table: string; cols: string[]; conflict: string | null; update: string[] }> = {
  signals: { table: 'arcdex_sig_signals', cols: ['id', 'at', 'token', 'symbol', 'launchpad', 'strategy', 'score', 'band', 'decision', 'mode', 'data'], conflict: 'id', update: ['decision', 'data'] },
  features: { table: 'arcdex_sig_signal_features', cols: ['signal_id', 'at', 'token', 'strategy', 'vector', 'features'], conflict: 'signal_id', update: [] },
  outcomes: { table: 'arcdex_sig_signal_outcomes', cols: ['signal_id', 'at', 'token', 'strategy', 'data'], conflict: 'signal_id', update: ['data'] },
  snapshots: { table: 'arcdex_sig_snapshots', cols: ['token', 'at', 'data'], conflict: 'token, at', update: [] },
  positions: { table: 'arcdex_sig_positions', cols: ['id', 'token', 'strategy', 'mode', 'status', 'opened_at', 'closed_at', 'pnl_usd', 'data'], conflict: 'id', update: ['status', 'closed_at', 'pnl_usd', 'data'] },
  orders: { table: 'arcdex_sig_orders', cols: ['key', 'position_id', 'token', 'side', 'mode', 'status', 'at', 'data'], conflict: 'key', update: ['status', 'data'] },
  exec: { table: 'arcdex_sig_execution_events', cols: ['at', 'key', 'position_id', 'token', 'mode', 'kind', 'data'], conflict: null, update: [] },
  risk: { table: 'arcdex_sig_risk_events', cols: ['at', 'mode', 'kind', 'token', 'detail'], conflict: null, update: [] },
  regimes: { table: 'arcdex_sig_market_regimes', cols: ['at', 'regime', 'data'], conflict: 'at', update: ['regime', 'data'] },
  wallets: { table: 'arcdex_sig_wallets', cols: ['wallet', 'class', 'quality', 'trades', 'win_rate', 'profit_factor', 'realized_profit', 'realized_loss', 'updated_at', 'data'], conflict: 'wallet', update: ['class', 'quality', 'trades', 'win_rate', 'profit_factor', 'realized_profit', 'realized_loss', 'updated_at', 'data'] },
  walletPositions: { table: 'arcdex_sig_wallet_positions', cols: ['wallet', 'token', 'updated_at', 'data'], conflict: 'wallet, token', update: ['updated_at', 'data'] },
  results: { table: 'arcdex_sig_strategy_results', cols: ['strategy', 'mode', 'day', 'data'], conflict: 'strategy, mode, day', update: ['data'] },
  runs: { table: 'arcdex_sig_backtest_runs', cols: ['id', 'at', 'kind', 'data'], conflict: 'id', update: ['data'] },
}
const MAX_QUEUED = 50_000

/** The batched upserts for a table's queued rows: 500 rows a statement, the last row for a key winning (Postgres refuses one statement touching a row twice). Exported for tests. */
export function insertStatements(k: keyof Queues, rows: unknown[][]): { text: string; values: unknown[]; rows: number }[] {
  const t = TABLES[k]
  const keyN = t.conflict ? t.conflict.split(',').length : 0
  const unique = keyN ? [...new Map(rows.map(r => [j(r.slice(0, keyN)), r])).values()] : rows
  const out: { text: string; values: unknown[]; rows: number }[] = []
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500)
    const values: unknown[] = []
    const tuples = chunk.map(r => `(${r.map(v => { values.push(v); return `$${values.length}` }).join(',')})`)
    const onConflict = !t.conflict ? '' : t.update.length ? `on conflict (${t.conflict}) do update set ${t.update.map(c => `${c} = excluded.${c}`).join(', ')}` : `on conflict (${t.conflict}) do nothing`
    out.push({ text: `insert into ${t.table} (${t.cols.join(',')}) values ${tuples.join(',')} ${onConflict}`, values, rows: chunk.length })
  }
  return out
}

export class PostgresQuantStore implements QuantStore {
  readonly kind = 'postgres' as const
  private sql: SQL
  private ready: Promise<void>
  private q: Queues = { signals: [], features: [], outcomes: [], snapshots: [], positions: [], orders: [], exec: [], risk: [], regimes: [], wallets: [], walletPositions: [], results: [], runs: [] }
  private timer: ReturnType<typeof setInterval>
  private flushing: Promise<void> | null = null
  dropped = 0

  constructor(url: string) {
    this.sql = new SQL(url, { max: 3, idleTimeout: 30, connectionTimeout: 15 })
    this.ready = this.sql.unsafe(SCHEMA).then(() => { log.info('signal engine schema ready') }, e => log.error('signal engine: schema failed', { error: errMsg(e) }))
    this.timer = setInterval(() => void this.flush(), 2_000)
  }

  private push(k: keyof Queues, row: unknown[]) {
    const q = this.q[k]
    if (q.length >= MAX_QUEUED) { q.shift(); this.dropped++ }
    q.push(row)
  }

  saveSignal(s: StoredSignal, f: SignalFeaturesRow | null) {
    this.push('signals', [s.id, new Date(s.at), s.token, s.symbol, s.launchpad, s.strategy, s.signal_score, s.band, s.decision, s.mode, j(s)])
    if (f) this.push('features', [f.signalId, new Date(f.at), f.token, f.strategy, j(f.vector), j(f.features)])
  }
  saveOutcome(o: OutcomeRow) { this.push('outcomes', [o.signalId, new Date(o.at), o.token, o.strategy, j(o.data)]) }
  saveSnapshot(token: string, at: number, data: Record<string, unknown>) { this.push('snapshots', [token, new Date(at), j(data)]) }
  savePosition(p: QPosition) { this.push('positions', [p.id, p.token, p.strategy, p.mode, p.status, new Date(p.openedAt), p.closedAt ? new Date(p.closedAt) : null, p.pnlUsd, j(p)]) }
  saveOrder(o: OrderRow) { this.push('orders', [o.key, o.positionId, o.token, o.side, o.mode, o.status, new Date(o.at), j(o.data)]) }
  saveExecutionEvent(e: ExecutionEvent) { this.push('exec', [new Date(e.at), e.key, e.positionId, e.token, e.mode, e.kind, j(e)]) }
  saveRiskEvent(e: RiskEvent) { this.push('risk', [new Date(e.at), e.mode, e.kind, e.token ?? null, e.detail.slice(0, 500)]) }
  saveRegime(r: RegimeView) { this.push('regimes', [new Date(r.at), r.regime, j(r)]) }
  saveWallets(rows: WalletStats[]) { for (const r of rows) this.push('wallets', [r.wallet, r.class, r.quality, r.trade_count, r.win_rate, r.profit_factor, r.realized_profit, r.realized_loss, new Date(r.updated_at), j(r)]) }
  saveWalletPositions(rows: (WalletPosition & { wallet: string })[]) { for (const r of rows) this.push('walletPositions', [r.wallet, r.token, new Date(r.lastAt), j(r)]) }
  saveStrategyResult(r: StrategyResultRow) { this.push('results', [r.strategy, r.mode, r.day, j(r.data)]) }
  saveBacktest(r: BacktestRun) { this.push('runs', [r.id, new Date(r.at), r.kind, j(r.data)]) }
  async saveParams(p: Omit<ParamsVersion, 'version'>) {
    await this.ready
    const rows = await this.sql`insert into arcdex_sig_strategy_parameters (at, changed_by, note, config) values (${new Date(p.at)}, ${p.by}, ${p.note}, ${j(p.config)}::jsonb) returning version`
    return Number((rows[0] as { version: number }).version)
  }

  /** Sends every queued row: one multi-row statement per table (500 rows each), duplicates in a batch collapsed. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      await this.ready
      for (const k of Object.keys(this.q) as (keyof Queues)[]) {
        const rows = this.q[k].splice(0)
        if (!rows.length) continue
        for (const q of insertStatements(k, rows)) {
          try { await this.sql.unsafe(q.text, q.values) }
          catch (e) { log.warn('signal engine: write failed', { table: TABLES[k].table, rows: q.rows, error: errMsg(e) }) }
        }
      }
    })().finally(() => { this.flushing = null })
    return this.flushing
  }

  async positions(days: number) {
    await this.ready
    const rows = await this.sql`select data from arcdex_sig_positions where status in ('open', 'pending') or closed_at >= ${new Date(Date.now() - days * 86_400_000)} order by opened_at`
    return rows.map((r: { data: unknown }) => parse<QPosition>(r.data))
  }
  async signals(limit: number, sinceTs?: number) {
    await this.ready
    const rows = sinceTs === undefined
      ? await this.sql`select data from arcdex_sig_signals order by at desc limit ${limit}`
      : await this.sql`select data from arcdex_sig_signals where at >= ${new Date(sinceTs)} order by at desc limit ${limit}`
    return rows.map((r: { data: unknown }) => parse<StoredSignal>(r.data))
  }
  async backtests(limit: number) {
    await this.ready
    const rows = await this.sql`select id, at, kind, data from arcdex_sig_backtest_runs order by at desc limit ${limit}`
    return rows.map((r: { id: string; at: Date; kind: BacktestRun['kind']; data: unknown }) => ({ id: r.id, at: new Date(r.at).getTime(), kind: r.kind, data: parse<Record<string, unknown>>(r.data) }))
  }
  async latestParams() {
    await this.ready
    const rows = await this.sql`select version, at, changed_by, note, config from arcdex_sig_strategy_parameters order by version desc limit 1`
    const r = rows[0] as { version: number; at: Date; changed_by: string; note: string; config: unknown } | undefined
    return r ? { version: Number(r.version), at: new Date(r.at).getTime(), by: r.changed_by, note: r.note, config: parse(r.config) } : null
  }
  async dataset(sinceTs: number, limit: number) {
    await this.ready
    const rows = await this.sql`select f.signal_id, f.at, f.token, f.strategy, f.vector, o.data as outcome from arcdex_sig_signal_features f
      left join arcdex_sig_signal_outcomes o on o.signal_id = f.signal_id where f.at >= ${new Date(sinceTs)} order by f.at limit ${limit}`
    return rows.map((r: { signal_id: string; at: Date; token: string; strategy: string; vector: unknown; outcome: unknown }) =>
      ({ signal_id: r.signal_id, at: new Date(r.at).getTime(), token: r.token, strategy: r.strategy, vector: parse<Record<string, number | null>>(r.vector), outcome: r.outcome ? parse<Record<string, unknown>>(r.outcome) : null }))
  }
  async riskEvents(limit: number) {
    await this.ready
    const rows = await this.sql`select at, mode, kind, token, detail from arcdex_sig_risk_events order by at desc limit ${limit}`
    return rows.map((r: { at: Date; mode: RiskEvent['mode']; kind: string; token: string | null; detail: string }) => ({ at: new Date(r.at).getTime(), mode: r.mode, kind: r.kind, token: r.token ?? undefined, detail: r.detail }))
  }
  async executionEvents(limit: number) {
    await this.ready
    const rows = await this.sql`select data from arcdex_sig_execution_events order by at desc limit ${limit}`
    return rows.map((r: { data: unknown }) => parse<ExecutionEvent>(r.data))
  }
  /** Snapshots 14 days, execution and risk events 30 days; signals, features, outcomes, positions and runs are kept. */
  async cleanup() {
    try {
      await this.ready
      await this.sql`delete from arcdex_sig_snapshots where at < now() - interval '14 days'`
      await this.sql`delete from arcdex_sig_execution_events where at < now() - interval '30 days'`
      await this.sql`delete from arcdex_sig_risk_events where at < now() - interval '30 days'`
      await this.sql`delete from arcdex_sig_market_regimes where at < now() - interval '60 days'`
    } catch (e) { log.warn('signal engine: cleanup failed', { error: errMsg(e) }) }
  }
  close() { clearInterval(this.timer); void this.flush().finally(() => this.sql.close({ timeout: 5 })) }
}
