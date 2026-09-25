// History in any Postgres reached by DATABASE_URL (Railway's, a VPS, …),
// through Bun's built-in client. The engine creates its own tables and
// functions on first start (idempotent), so a fresh database just works.
// Same schema as supabase/migrations/20260928000000_arcdex_market_engine.sql,
// without Supabase's roles and row-level security.
//
// All values go in as bound parameters ($1, $2 …) — never spliced into SQL.

import { SQL } from 'bun'
import type { Interval, LaunchInfo, Trade, WireCandle } from '../../../api/_marketProtocol'
import { log, errMsg } from '../log'
import {
  BatchedHistoryStore, CANDLE_COLS, LIQ_COLS, POOL_COLS, TOKEN_COLS, TRADE_COLS,
  iso, rowToCandle, rowToLaunch, rowToTrade, type Batch, type Row,
} from './history'

export const SCHEMA = `
create table if not exists arcdex_mkt_tokens (
  token text primary key, name text, symbol text, decimals int, creator text, launchpad text, portal int,
  launch_tx text, launch_block bigint, launched_at timestamptz, pool text, quote text, image text,
  status text not null default 'LIVE', updated_at timestamptz not null default now()
);
create index if not exists arcdex_mkt_tokens_launched on arcdex_mkt_tokens (launched_at desc);
create table if not exists arcdex_mkt_pools (
  pool text primary key, dex text not null, currency0 text not null, currency1 text not null, fee int, tick_spacing int, hooks text,
  base text not null, quote text not null, base_decimals int not null, quote_decimals int not null, created_at timestamptz not null default now()
);
create index if not exists arcdex_mkt_pools_base on arcdex_mkt_pools (base);
create table if not exists arcdex_mkt_trades (
  trade_id text primary key, token text not null, pool text not null, quote text not null,
  side text not null check (side in ('BUY','SELL','UNKNOWN')),
  token_amount double precision not null, quote_amount double precision not null, price double precision not null,
  price_usd double precision, usd_value double precision, wallet text, tx_hash text not null,
  block_number bigint not null, log_index int not null, ts timestamptz not null, dex text not null, launchpad text, liquidity_usd double precision
);
create index if not exists arcdex_mkt_trades_token_ts on arcdex_mkt_trades (token, ts desc, block_number desc, log_index desc);
create index if not exists arcdex_mkt_trades_wallet_ts on arcdex_mkt_trades (wallet, ts desc) where wallet is not null;
create index if not exists arcdex_mkt_trades_ts on arcdex_mkt_trades (ts);
create table if not exists arcdex_mkt_candles (
  token text not null, interval text not null check (interval in ('1s','5s','15s','1m','5m','15m','1h','4h','1d')),
  bucket timestamptz not null, o double precision not null, h double precision not null, l double precision not null, c double precision not null,
  v double precision not null default 0, n int not null default 0, primary key (token, interval, bucket)
);
create table if not exists arcdex_mkt_liquidity (
  pool text not null, token text not null, block_number bigint not null, ts timestamptz not null, liquidity_usd double precision not null,
  primary key (pool, block_number)
);
create table if not exists arcdex_mkt_cursor (stream text primary key, block bigint not null, updated_at timestamptz not null default now());

create or replace function arcdex_mkt_rebuild_candle(p_token text, p_interval text, p_bucket timestamptz) returns void
language plpgsql as $fn$
declare step interval := case p_interval
  when '1s' then interval '1 second' when '5s' then interval '5 seconds' when '15s' then interval '15 seconds'
  when '1m' then interval '1 minute' when '5m' then interval '5 minutes' when '15m' then interval '15 minutes'
  when '1h' then interval '1 hour' when '4h' then interval '4 hours' when '1d' then interval '1 day' end;
begin
  if step is null then raise exception 'bad interval %', p_interval; end if;
  insert into arcdex_mkt_candles as k (token, interval, bucket, o, h, l, c, v, n)
  select p_token, p_interval, p_bucket,
         (array_agg(price_usd order by block_number, log_index))[1], max(price_usd), min(price_usd),
         (array_agg(price_usd order by block_number desc, log_index desc))[1], coalesce(sum(usd_value), 0), count(*)
  from arcdex_mkt_trades
  where token = p_token and ts >= p_bucket and ts < p_bucket + step and price_usd is not null
  having count(*) > 0
  on conflict (token, interval, bucket) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, n = excluded.n;
end $fn$;

create or replace function arcdex_mkt_cleanup(p_trade_hours int default 72)
returns table (trades bigint, candles bigint, liquidity bigint)
language plpgsql as $fn$
declare a bigint; b bigint; c bigint;
begin
  delete from arcdex_mkt_trades where ts < now() - make_interval(hours => greatest(p_trade_hours, 1));
  get diagnostics a = row_count;
  delete from arcdex_mkt_candles where
       (interval = '1s' and bucket < now() - interval '6 hours') or (interval = '5s' and bucket < now() - interval '24 hours')
    or (interval = '15s' and bucket < now() - interval '3 days') or (interval = '1m' and bucket < now() - interval '30 days');
  get diagnostics b = row_count;
  delete from arcdex_mkt_liquidity where ts < now() - interval '30 days';
  get diagnostics c = row_count;
  return query select a, b, c;
end $fn$;
`

const CHUNK = 500

/** INSERT … VALUES ($1,$2,…),(…) ON CONFLICT … for one chunk of rows. */
function upsertSql(table: string, cols: readonly string[], rows: Row[], conflict: string, update: readonly string[] | null) {
  const values: unknown[] = []
  const tuples = rows.map(r => `(${cols.map(c => { values.push(r[c] ?? null); return `$${values.length}` }).join(',')})`)
  const onConflict = update && update.length
    ? `on conflict (${conflict}) do update set ${update.map(c => `${c} = excluded.${c}`).join(', ')}`
    : `on conflict (${conflict}) do nothing`
  return { text: `insert into ${table} (${cols.join(',')}) values ${tuples.join(',')} ${onConflict}`, values }
}

export class PostgresHistoryStore extends BatchedHistoryStore {
  readonly backend = 'postgres'
  private sql: SQL
  private ready: Promise<void>

  constructor(url: string) {
    super()
    this.sql = new SQL(url, { max: 5, idleTimeout: 30, connectionTimeout: 15 })
    this.ready = this.migrate()
  }

  /** Create or update the tables and functions (safe to run every start). */
  private async migrate() {
    try {
      await this.sql.unsafe(SCHEMA)
      log.info('history schema ready', { backend: this.backend })
    } catch (e) {
      log.error('could not create history tables', { error: errMsg(e) })
      throw e
    }
  }

  /** Resolves once the schema exists (tests, startup). */
  whenReady() { return this.ready }

  protected isSchemaError(e: unknown) {
    return /relation "arcdex_mkt_\w+" does not exist|42P01/.test(errMsg(e))
  }

  private async upsert(table: string, cols: readonly string[], rows: Row[], conflict: string, update: readonly string[] | null) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const q = upsertSql(table, cols, rows.slice(i, i + CHUNK), conflict, update)
      await this.sql.unsafe(q.text, q.values)
    }
  }

  protected async writeBatch(b: Batch) {
    await this.ready
    const not = (keys: string[]) => (cols: readonly string[]) => cols.filter(c => !keys.includes(c))
    if (b.tokens.length) await this.upsert('arcdex_mkt_tokens', TOKEN_COLS, b.tokens, 'token', not(['token'])(TOKEN_COLS))
    if (b.pools.length) await this.upsert('arcdex_mkt_pools', POOL_COLS, b.pools, 'pool', not(['pool'])(POOL_COLS))
    if (b.trades.length) await this.upsert('arcdex_mkt_trades', TRADE_COLS, b.trades, 'trade_id', null)
    if (b.candles.length) await this.upsert('arcdex_mkt_candles', CANDLE_COLS, b.candles, 'token, interval, bucket', ['o', 'h', 'l', 'c', 'v', 'n'])
    if (b.liquidity.length) await this.upsert('arcdex_mkt_liquidity', LIQ_COLS, b.liquidity, 'pool, block_number', null)
    for (const r of b.repairs) await this.sql.unsafe('select arcdex_mkt_rebuild_candle($1, $2, $3)', [r.token, r.interval, iso(r.bucket * 1000)])
  }

  async getCursor() {
    try {
      await this.ready
      const r = (await this.sql.unsafe(`select block from arcdex_mkt_cursor where stream = 'main'`)) as Row[]
      return r.length ? Number(r[0].block) : null
    } catch { return null }
  }
  async setCursor(block: number) {
    await this.ready
    await this.sql.unsafe(`insert into arcdex_mkt_cursor (stream, block, updated_at) values ('main', $1, now()) on conflict (stream) do update set block = excluded.block, updated_at = now()`, [block])
  }
  async trades(token: string, limit: number, beforeTs?: number): Promise<Trade[]> {
    await this.ready
    const rows = (await this.sql.unsafe(
      `select * from arcdex_mkt_trades where token = $1 and ($2::timestamptz is null or ts < $2) order by ts desc, block_number desc, log_index desc limit $3`,
      [token, beforeTs ? iso(beforeTs) : null, Math.min(500, limit)],
    )) as Row[]
    return rows.map(rowToTrade)
  }
  async candles(token: string, interval: Interval, limit: number, beforeTs?: number): Promise<WireCandle[]> {
    await this.ready
    const rows = (await this.sql.unsafe(
      `select * from arcdex_mkt_candles where token = $1 and interval = $2 and ($3::timestamptz is null or bucket < $3) order by bucket desc limit $4`,
      [token, interval, beforeTs ? iso(beforeTs) : null, Math.min(1_000, limit)],
    )) as Row[]
    return rows.reverse().map(rowToCandle)
  }
  async launches(limit: number): Promise<LaunchInfo[]> {
    await this.ready
    const rows = (await this.sql.unsafe(`select * from arcdex_mkt_tokens where launched_at is not null order by launched_at desc limit $1`, [Math.min(500, limit)])) as Row[]
    return rows.map(rowToLaunch)
  }
  async token(token: string): Promise<LaunchInfo | null> {
    await this.ready
    const rows = (await this.sql.unsafe(`select * from arcdex_mkt_tokens where token = $1 limit 1`, [token])) as Row[]
    return rows.length ? rowToLaunch(rows[0]) : null
  }
  async cleanup(tradeRetentionHours: number) {
    try {
      await this.ready
      const r = await this.sql.unsafe(`select * from arcdex_mkt_cleanup($1)`, [tradeRetentionHours])
      log.info('history cleanup', { result: r })
    } catch (e) { log.warn('history cleanup failed', { error: errMsg(e) }) }
  }

  close() {
    super.close()
    void this.sql.close({ timeout: 5 })
  }
}
