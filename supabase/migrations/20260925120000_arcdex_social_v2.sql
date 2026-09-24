-- ARCDEX social v2 (fomo parity): profile banners, clans, holders, most-held,
-- closed positions, multi-trader buys, PnL history, trader stats.
-- ---------------------------------------------------------------------------
-- Run once in the Supabase dashboard → SQL Editor, after
-- 20260925000000_arcdex_social.sql (safe to re-run).
-- Same security model: public read, no client writes — ARCDEX's server
-- writes on behalf of wallets that proved ownership with a signature.

-- ── profile banner ───────────────────────────────────────────────────────
alter table public.arcdex_profiles
  add column if not exists banner_url text
  check (banner_url ~ '^https://' and char_length(banner_url) <= 500);

-- ── clans: groups of traders ranked by combined PnL ──────────────────────
create table if not exists public.arcdex_clans (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9-]{3,32}$'),
  name       text not null check (char_length(name) between 2 and 40),
  motto      text check (char_length(motto) <= 120),
  avatar_url text check (avatar_url ~ '^https://' and char_length(avatar_url) <= 500),
  banner_url text check (banner_url ~ '^https://' and char_length(banner_url) <= 500),
  owner      text not null check (owner ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.arcdex_clan_members (
  member    text primary key check (member ~ '^0x[0-9a-f]{40}$'), -- one clan per wallet
  clan_id   uuid not null references public.arcdex_clans (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now()
);
create index if not exists arcdex_clan_members_clan_idx on public.arcdex_clan_members (clan_id);

-- ── notes attached to cash sent between traders ──────────────────────────
create table if not exists public.arcdex_transfer_notes (
  tx_hash    text primary key,
  sender     text not null,
  recipient  text not null,
  amount     numeric not null, -- whole USDC
  note       text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists arcdex_transfer_notes_recipient_idx on public.arcdex_transfer_notes (recipient, created_at desc);
create index if not exists arcdex_transfer_notes_sender_idx on public.arcdex_transfer_notes (sender, created_at desc);

-- ── per-position aggregates (one row per trader × coin) ──────────────────
create or replace view public.arcdex_positions_v
with (security_invoker = true) as
select trader, token,
       sum(case when side = 'buy'  then usdc else 0 end)         as bought_usdc,
       sum(case when side = 'buy'  then token_amount else 0 end) as bought_tok,
       sum(case when side = 'sell' then usdc else 0 end)         as sold_usdc,
       sum(case when side = 'sell' then token_amount else 0 end) as sold_tok,
       count(*)                                                  as trades,
       min(block_time) filter (where side = 'buy')               as first_buy,
       max(block_time)                                           as last_trade
from public.arcdex_trades
group by trader, token;

-- ARCDEX traders currently holding a coin (net bought > sold), with cost
-- basis — the fomo "Holders" tab. Value/PnL is priced on the client.
create or replace function public.arcdex_token_holders(p_token text, p_limit int default 200)
returns table (trader text, bought_usdc numeric, bought_tok numeric, sold_usdc numeric, sold_tok numeric,
               trades bigint, first_buy timestamptz, last_trade timestamptz)
language sql stable set search_path = public as $$
  select trader, bought_usdc, bought_tok, sold_usdc, sold_tok, trades, first_buy, last_trade
  from arcdex_positions_v
  where token = lower(p_token) and bought_tok > sold_tok * 1.0001
  order by (bought_tok - sold_tok) desc
  limit greatest(1, least(p_limit, 1000));
$$;

-- Coins held by the most ARCDEX traders — the fomo "Most held" list.
create or replace function public.arcdex_most_held(p_limit int default 50)
returns table (token text, holders bigint, invested_usdc numeric)
language sql stable set search_path = public as $$
  select token, count(*)::bigint, round(sum(bought_usdc - sold_usdc), 2)
  from arcdex_positions_v
  where bought_tok > sold_tok * 1.0001
  group by token
  order by 2 desc, 3 desc
  limit greatest(1, least(p_limit, 200));
$$;

-- One trader's headline numbers over a window.
create or replace function public.arcdex_trader_stats(p_trader text, p_since timestamptz default 'epoch')
returns table (realized_pnl numeric, volume_usdc numeric, trades bigint, avg_hold_seconds numeric, first_trade timestamptz)
language sql stable set search_path = public as $$
  with per as (
    select token,
           sum(case when side = 'buy'  then usdc else 0 end)         as bu,
           sum(case when side = 'buy'  then token_amount else 0 end) as bt,
           sum(case when side = 'sell' then usdc else 0 end)         as su,
           sum(case when side = 'sell' then token_amount else 0 end) as st,
           count(*) as n, sum(usdc) as vol,
           min(block_time) filter (where side = 'buy')  as fb,
           max(block_time) filter (where side = 'sell') as ls,
           min(block_time) as ft
    from arcdex_trades
    where trader = lower(p_trader) and block_time >= p_since
    group by token
  )
  select round(coalesce(sum(case when bt > 0 and st > 0 then su - bu * least(st / bt, 1) else 0 end), 0), 2),
         round(coalesce(sum(vol), 0), 2),
         coalesce(sum(n), 0)::bigint,
         round(avg(extract(epoch from (case when st >= bt * 0.9999 and ls is not null then ls else now() end) - fb))
           filter (where fb is not null)),
         min(ft)
  from per;
$$;

-- Realized PnL after every sell, cumulative, for a trader's PnL chart.
-- Average-cost basis per coin, computed in trade order.
create or replace function public.arcdex_pnl_history(p_trader text)
returns table (t timestamptz, pnl numeric, cumulative numeric)
language sql stable set search_path = public as $$
  with ordered as (
    select block_time, token, side, usdc, token_amount,
           sum(case when side = 'buy' then usdc else 0 end)
             over (partition by token order by block_time, log_index rows unbounded preceding) as cum_bu,
           sum(case when side = 'buy' then token_amount else 0 end)
             over (partition by token order by block_time, log_index rows unbounded preceding) as cum_bt
    from arcdex_trades
    where trader = lower(p_trader)
  ), sells as (
    select block_time as t,
           case when cum_bt > 0 then usdc - (cum_bu / cum_bt) * token_amount else 0 end as pnl
    from ordered where side = 'sell'
  )
  select t, round(pnl, 2), round(sum(pnl) over (order by t rows unbounded preceding), 2)
  from sells order by t;
$$;

-- Positions fully closed since p_since, with their realized PnL — feed
-- "closed position" and "profit milestone" events.
create or replace function public.arcdex_closed_positions(p_since timestamptz, p_limit int default 50)
returns table (trader text, token text, bought_usdc numeric, sold_usdc numeric, pnl numeric, closed_at timestamptz)
language sql stable set search_path = public as $$
  select trader, token, round(bought_usdc, 2), round(sold_usdc, 2), round(sold_usdc - bought_usdc, 2), last_trade
  from arcdex_positions_v
  where bought_tok > 0 and sold_tok >= bought_tok * 0.9999 and last_trade >= p_since
  order by last_trade desc
  limit greatest(1, least(p_limit, 200));
$$;

-- Coins that several different traders bought within a short window —
-- feed "multi-user trades".
create or replace function public.arcdex_multi_buys(p_since timestamptz, p_min int default 3)
returns table (token text, buyers bigint, usdc numeric, traders text[], last_buy timestamptz)
language sql stable set search_path = public as $$
  select token, count(distinct trader)::bigint, round(sum(usdc), 2),
         (array_agg(distinct trader))[1:8], max(block_time)
  from arcdex_trades
  where side = 'buy' and block_time >= p_since
  group by token
  having count(distinct trader) >= greatest(2, p_min)
  order by max(block_time) desc;
$$;

-- ── clans: leaderboard, members, holdings ────────────────────────────────
create or replace function public.arcdex_clan_leaderboard(p_since timestamptz, p_limit int default 50)
returns table (clan_id uuid, slug text, name text, avatar_url text, members bigint, realized_pnl numeric, volume_usdc numeric)
language sql stable set search_path = public as $$
  with per as (
    select m.clan_id, t.trader, t.token,
           sum(case when t.side = 'buy'  then t.usdc else 0 end)         as bu,
           sum(case when t.side = 'buy'  then t.token_amount else 0 end) as bt,
           sum(case when t.side = 'sell' then t.usdc else 0 end)         as su,
           sum(case when t.side = 'sell' then t.token_amount else 0 end) as st,
           sum(t.usdc) as vol
    from arcdex_clan_members m
    join arcdex_trades t on t.trader = m.member and t.block_time >= p_since
    group by m.clan_id, t.trader, t.token
  ), agg as (
    select clan_id,
           sum(case when bt > 0 and st > 0 then su - bu * least(st / bt, 1) else 0 end) as pnl,
           sum(vol) as vol
    from per group by clan_id
  )
  select c.id, c.slug, c.name, c.avatar_url,
         (select count(*) from arcdex_clan_members mm where mm.clan_id = c.id)::bigint,
         round(coalesce(a.pnl, 0), 2), round(coalesce(a.vol, 0), 2)
  from arcdex_clans c left join agg a on a.clan_id = c.id
  order by 6 desc, 5 desc
  limit greatest(1, least(p_limit, 200));
$$;

create or replace function public.arcdex_clan_members_pnl(p_clan uuid, p_since timestamptz)
returns table (member text, role text, joined_at timestamptz, realized_pnl numeric, volume_usdc numeric)
language sql stable set search_path = public as $$
  with per as (
    select t.trader, t.token,
           sum(case when t.side = 'buy'  then t.usdc else 0 end)         as bu,
           sum(case when t.side = 'buy'  then t.token_amount else 0 end) as bt,
           sum(case when t.side = 'sell' then t.usdc else 0 end)         as su,
           sum(case when t.side = 'sell' then t.token_amount else 0 end) as st,
           sum(t.usdc) as vol
    from arcdex_trades t
    where t.block_time >= p_since and t.trader in (select member from arcdex_clan_members where clan_id = p_clan)
    group by t.trader, t.token
  ), agg as (
    select trader, sum(case when bt > 0 and st > 0 then su - bu * least(st / bt, 1) else 0 end) as pnl, sum(vol) as vol
    from per group by trader
  )
  select m.member, m.role, m.joined_at, round(coalesce(a.pnl, 0), 2), round(coalesce(a.vol, 0), 2)
  from arcdex_clan_members m left join agg a on a.trader = m.member
  where m.clan_id = p_clan
  order by 4 desc;
$$;

create or replace function public.arcdex_clan_holdings(p_clan uuid)
returns table (token text, members bigint, holders text[], bought_usdc numeric, bought_tok numeric, sold_usdc numeric, sold_tok numeric)
language sql stable set search_path = public as $$
  select p.token, count(*)::bigint, (array_agg(p.trader))[1:6],
         sum(p.bought_usdc), sum(p.bought_tok), sum(p.sold_usdc), sum(p.sold_tok)
  from arcdex_positions_v p
  join arcdex_clan_members m on m.member = p.trader and m.clan_id = p_clan
  where p.bought_tok > p.sold_tok * 1.0001
  group by p.token
  order by sum(p.bought_usdc - p.sold_usdc) desc;
$$;

-- ── row level security: public read, no client writes ────────────────────
do $$
declare t text;
begin
  foreach t in array array['arcdex_clans','arcdex_clan_members','arcdex_transfer_notes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

grant select on public.arcdex_positions_v to anon, authenticated;
grant execute on function public.arcdex_token_holders(text, int)                 to anon, authenticated;
grant execute on function public.arcdex_most_held(int)                           to anon, authenticated;
grant execute on function public.arcdex_trader_stats(text, timestamptz)          to anon, authenticated;
grant execute on function public.arcdex_pnl_history(text)                        to anon, authenticated;
grant execute on function public.arcdex_closed_positions(timestamptz, int)       to anon, authenticated;
grant execute on function public.arcdex_multi_buys(timestamptz, int)             to anon, authenticated;
grant execute on function public.arcdex_clan_leaderboard(timestamptz, int)       to anon, authenticated;
grant execute on function public.arcdex_clan_members_pnl(uuid, timestamptz)      to anon, authenticated;
grant execute on function public.arcdex_clan_holdings(uuid)                      to anon, authenticated;
