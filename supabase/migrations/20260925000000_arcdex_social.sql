-- ARCDEX social + trading index (arcdex.online)
-- ---------------------------------------------------------------------------
-- Run once in the Supabase dashboard → SQL Editor (safe to re-run).
--
-- Security model:
--   * Every arcdex_* table is PUBLIC READ (anyone can see profiles, theses,
--     follows, leaderboards — that's the product).
--   * There are NO write policies. Only ARCDEX's server (Vercel functions
--     holding the Supabase secret/service-role key) can write, and it only
--     writes (a) on-chain events it read from the ArcDexSwapRouter itself,
--     or (b) social actions for a wallet that proved ownership by signing
--     a message. Browsers can never write directly.
--   * Prefixed arcdex_ so nothing collides with the ZAKA wallet's tables.
--
-- Addresses are stored lowercase. Token amounts are raw on-chain integers
-- (PnL only ever uses ratios of them, so decimals don't matter); USDC
-- amounts are whole USDC (already divided by 1e6).

-- ── profiles ─────────────────────────────────────────────────────────────
create table if not exists public.arcdex_profiles (
  address      text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  username     text unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text check (char_length(display_name) <= 40),
  avatar_url   text check (avatar_url ~ '^https://' and char_length(avatar_url) <= 500),
  bio          text check (char_length(bio) <= 160),
  x_handle     text check (x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── follows ──────────────────────────────────────────────────────────────
create table if not exists public.arcdex_follows (
  follower   text not null check (follower ~ '^0x[0-9a-f]{40}$'),
  following  text not null check (following ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  primary key (follower, following),
  check (follower <> following)
);
create index if not exists arcdex_follows_following_idx on public.arcdex_follows (following);

-- ── theses (a trader's public note on why they hold a coin) ──────────────
create table if not exists public.arcdex_theses (
  id           bigint generated always as identity primary key,
  author       text not null check (author ~ '^0x[0-9a-f]{40}$'),
  token        text not null check (token ~ '^0x[0-9a-f]{40}$'),
  body         text not null check (char_length(body) between 1 and 280),
  position_usd numeric,          -- author's position value when posted (display only)
  created_at   timestamptz not null default now()
);
create index if not exists arcdex_theses_token_idx  on public.arcdex_theses (token, created_at desc);
create index if not exists arcdex_theses_author_idx on public.arcdex_theses (author, created_at desc);
create index if not exists arcdex_theses_time_idx   on public.arcdex_theses (created_at desc);

create table if not exists public.arcdex_thesis_likes (
  thesis_id  bigint not null references public.arcdex_theses (id) on delete cascade,
  liker      text not null check (liker ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  primary key (thesis_id, liker)
);

create or replace view public.arcdex_theses_v
with (security_invoker = true) as
select t.*,
       (select count(*) from public.arcdex_thesis_likes l where l.thesis_id = t.id) as likes
from public.arcdex_theses t;

-- ── on-chain index: trades through ArcDexSwapRouter (v1 + v2) ────────────
create table if not exists public.arcdex_trades (
  tx_hash      text   not null,
  log_index    int    not null,
  router       text   not null,
  block_number bigint not null,
  block_time   timestamptz not null,
  trader       text   not null,
  token        text   not null,
  side         text   not null check (side in ('buy', 'sell')),
  usdc         numeric not null, -- USDC paid in (buy, incl. fee) or received (sell, after fee)
  token_amount numeric not null, -- raw token units bought or sold
  fee_usdc     numeric not null default 0,
  primary key (tx_hash, log_index)
);
create index if not exists arcdex_trades_trader_idx on public.arcdex_trades (trader, block_time desc);
create index if not exists arcdex_trades_token_idx  on public.arcdex_trades (token, block_time desc);
create index if not exists arcdex_trades_time_idx   on public.arcdex_trades (block_time desc);

create table if not exists public.arcdex_referrals (          -- ReferrerBound
  user_address text primary key,
  referrer     text not null,
  block_time   timestamptz not null,
  tx_hash      text not null
);
create index if not exists arcdex_referrals_referrer_idx on public.arcdex_referrals (referrer);

create table if not exists public.arcdex_referral_payouts (   -- ReferralPaid
  tx_hash      text not null,
  log_index    int  not null,
  referrer     text not null,
  user_address text not null,
  token        text not null,
  amount       numeric not null, -- whole units if USDC, raw otherwise
  block_time   timestamptz not null,
  primary key (tx_hash, log_index)
);
create index if not exists arcdex_referral_payouts_referrer_idx on public.arcdex_referral_payouts (referrer, block_time desc);

create table if not exists public.arcdex_indexer_state (
  router     text primary key,
  last_block bigint not null,
  updated_at timestamptz not null default now()
);

-- ── read-side functions ──────────────────────────────────────────────────
-- Realized PnL per trader over trades since p_since: for each coin, what
-- they got for what they sold minus the average cost of those tokens.
create or replace function public.arcdex_leaderboard(p_since timestamptz, p_limit int default 100)
returns table (trader text, volume_usdc numeric, realized_pnl numeric, trades bigint, coins bigint)
language sql stable
set search_path = public
as $$
  with per as (
    select trader, token,
           sum(case when side = 'buy'  then usdc else 0 end)         as bought_usdc,
           sum(case when side = 'buy'  then token_amount else 0 end) as bought_tok,
           sum(case when side = 'sell' then usdc else 0 end)         as sold_usdc,
           sum(case when side = 'sell' then token_amount else 0 end) as sold_tok,
           count(*)  as n,
           sum(usdc) as vol
    from arcdex_trades
    where block_time >= p_since
    group by trader, token
  )
  select trader,
         round(sum(vol), 2),
         round(sum(case when bought_tok > 0 and sold_tok > 0
                        then sold_usdc - bought_usdc * least(sold_tok / bought_tok, 1)
                        else 0 end), 2),
         sum(n)::bigint,
         count(*)::bigint
  from per
  group by trader
  order by 3 desc, 2 desc
  limit greatest(1, least(p_limit, 500));
$$;

-- Every coin a trader has traded through ARCDEX, with cost basis.
create or replace function public.arcdex_trader_positions(p_trader text)
returns table (token text, bought_usdc numeric, bought_tok numeric, sold_usdc numeric, sold_tok numeric,
               trades bigint, last_trade timestamptz)
language sql stable
set search_path = public
as $$
  select token,
         sum(case when side = 'buy'  then usdc else 0 end),
         sum(case when side = 'buy'  then token_amount else 0 end),
         sum(case when side = 'sell' then usdc else 0 end),
         sum(case when side = 'sell' then token_amount else 0 end),
         count(*)::bigint,
         max(block_time)
  from arcdex_trades
  where trader = lower(p_trader)
  group by token
  order by max(block_time) desc;
$$;

create or replace function public.arcdex_referral_stats(p_referrer text)
returns table (referred_users bigint, earned_usdc numeric, payouts bigint)
language sql stable
set search_path = public
as $$
  select (select count(*) from arcdex_referrals where referrer = lower(p_referrer)),
         coalesce((select round(sum(amount), 6) from arcdex_referral_payouts
                   where referrer = lower(p_referrer) and token = '0x3600000000000000000000000000000000000000'), 0),
         (select count(*) from arcdex_referral_payouts where referrer = lower(p_referrer));
$$;

-- ── row level security: public read, no client writes ────────────────────
do $$
declare t text;
begin
  foreach t in array array['arcdex_profiles','arcdex_follows','arcdex_theses','arcdex_thesis_likes',
                           'arcdex_trades','arcdex_referrals','arcdex_referral_payouts','arcdex_indexer_state']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

grant select on public.arcdex_theses_v to anon, authenticated;
grant execute on function public.arcdex_leaderboard(timestamptz, int)   to anon, authenticated;
grant execute on function public.arcdex_trader_positions(text)           to anon, authenticated;
grant execute on function public.arcdex_referral_stats(text)             to anon, authenticated;
