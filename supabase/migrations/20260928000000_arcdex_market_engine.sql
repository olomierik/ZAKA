-- ARCDEX v5: history for the real-time market engine (engine/).
-- ---------------------------------------------------------------------------
-- Run once in the Supabase dashboard → SQL Editor, after v1–v4 (safe to
-- re-run). Only the engine writes (service role); everything here is public
-- chain data, so reads are public except the engine's cursor.
--
-- Volume: Arc's DEXes carry ~2 swaps per block (~340k trades/day, mostly
-- bots), so raw trades are kept HISTORY_TRADE_RETENTION_HOURS (default 72h)
-- and fine candles expire (1s: 6h, 5s: 24h, 15s: 3d, 1m: 30d; 5m and up are
-- kept). arcdex_mkt_cleanup() — called hourly by the engine — enforces it.
-- At larger scale, point the engine's HistoryStore at an analytical store
-- (e.g. ClickHouse) instead; this schema maps 1:1.

create table if not exists public.arcdex_mkt_tokens (
  token        text primary key check (token ~ '^0x[0-9a-f]{40}$'),
  name         text,
  symbol       text,
  decimals     int,
  creator      text,
  launchpad    text,
  portal       int,
  launch_tx    text,
  launch_block bigint,
  launched_at  timestamptz,
  pool         text,
  quote        text,
  image        text,
  status       text not null default 'LIVE',
  updated_at   timestamptz not null default now()
);
create index if not exists arcdex_mkt_tokens_launched on public.arcdex_mkt_tokens (launched_at desc);

create table if not exists public.arcdex_mkt_pools (
  pool           text primary key,
  dex            text not null,
  currency0      text not null,
  currency1      text not null,
  fee            int,
  tick_spacing   int,
  hooks          text,
  base           text not null,
  quote          text not null,
  base_decimals  int not null,
  quote_decimals int not null,
  created_at     timestamptz not null default now()
);
create index if not exists arcdex_mkt_pools_base on public.arcdex_mkt_pools (base);

create table if not exists public.arcdex_mkt_trades (
  trade_id      text primary key,                 -- txHash:logIndex
  token         text not null,
  pool          text not null,
  quote         text not null,
  side          text not null check (side in ('BUY', 'SELL', 'UNKNOWN')),
  token_amount  double precision not null,
  quote_amount  double precision not null,
  price         double precision not null,        -- quote per token, after the trade
  price_usd     double precision,
  usd_value     double precision,
  wallet        text,
  tx_hash       text not null,
  block_number  bigint not null,
  log_index     int not null,
  ts            timestamptz not null,
  dex           text not null,
  launchpad     text,
  liquidity_usd double precision
);
create index if not exists arcdex_mkt_trades_token_ts on public.arcdex_mkt_trades (token, ts desc, block_number desc, log_index desc);
create index if not exists arcdex_mkt_trades_wallet_ts on public.arcdex_mkt_trades (wallet, ts desc) where wallet is not null;
create index if not exists arcdex_mkt_trades_ts on public.arcdex_mkt_trades (ts);

create table if not exists public.arcdex_mkt_candles (
  token    text not null,
  interval text not null check (interval in ('1s','5s','15s','1m','5m','15m','1h','4h','1d')),
  bucket   timestamptz not null,
  o double precision not null, h double precision not null, l double precision not null, c double precision not null,
  v double precision not null default 0,
  n int not null default 0,
  primary key (token, interval, bucket)
);

create table if not exists public.arcdex_mkt_liquidity (
  pool          text not null,
  token         text not null,
  block_number  bigint not null,
  ts            timestamptz not null,
  liquidity_usd double precision not null,
  primary key (pool, block_number)
);

create table if not exists public.arcdex_mkt_cursor (
  stream     text primary key,
  block      bigint not null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['arcdex_mkt_tokens','arcdex_mkt_pools','arcdex_mkt_trades','arcdex_mkt_candles','arcdex_mkt_liquidity']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
  end loop;
  alter table public.arcdex_mkt_cursor enable row level security; -- server only
end $$;
grant select on public.arcdex_mkt_tokens, public.arcdex_mkt_pools, public.arcdex_mkt_trades,
                public.arcdex_mkt_candles, public.arcdex_mkt_liquidity to anon, authenticated;

-- Rebuild one candle from the stored trades (a trade that arrived too late
-- for the engine's in-memory candles). OPEN is the first trade's price.
create or replace function public.arcdex_mkt_rebuild_candle(p_token text, p_interval text, p_bucket timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
declare
  step interval := case p_interval
    when '1s' then interval '1 second' when '5s' then interval '5 seconds' when '15s' then interval '15 seconds'
    when '1m' then interval '1 minute' when '5m' then interval '5 minutes' when '15m' then interval '15 minutes'
    when '1h' then interval '1 hour' when '4h' then interval '4 hours' when '1d' then interval '1 day' end;
begin
  if step is null then raise exception 'bad interval %', p_interval; end if;
  insert into arcdex_mkt_candles as k (token, interval, bucket, o, h, l, c, v, n)
  select p_token, p_interval, p_bucket,
         (array_agg(price_usd order by block_number, log_index))[1],
         max(price_usd), min(price_usd),
         (array_agg(price_usd order by block_number desc, log_index desc))[1],
         coalesce(sum(usd_value), 0), count(*)
  from arcdex_mkt_trades
  where token = p_token and ts >= p_bucket and ts < p_bucket + step and price_usd is not null
  having count(*) > 0
  on conflict (token, interval, bucket) do update
    set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, n = excluded.n;
end $$;

-- Retention (called hourly by the engine).
create or replace function public.arcdex_mkt_cleanup(p_trade_hours int default 72)
returns table (trades bigint, candles bigint, liquidity bigint)
language plpgsql security definer set search_path = public as $$
declare a bigint; b bigint; c bigint;
begin
  delete from arcdex_mkt_trades where ts < now() - make_interval(hours => greatest(p_trade_hours, 1));
  get diagnostics a = row_count;
  delete from arcdex_mkt_candles where
       (interval = '1s'  and bucket < now() - interval '6 hours')
    or (interval = '5s'  and bucket < now() - interval '24 hours')
    or (interval = '15s' and bucket < now() - interval '3 days')
    or (interval = '1m'  and bucket < now() - interval '30 days');
  get diagnostics b = row_count;
  delete from arcdex_mkt_liquidity where ts < now() - interval '30 days';
  get diagnostics c = row_count;
  return query select a, b, c;
end $$;

revoke all on function public.arcdex_mkt_rebuild_candle(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.arcdex_mkt_cleanup(int) from public, anon, authenticated;
grant execute on function public.arcdex_mkt_rebuild_candle(text, text, timestamptz) to service_role;
grant execute on function public.arcdex_mkt_cleanup(int) to service_role;
