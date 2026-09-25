-- ARCDEX social v3: points seasons, support tickets, sign-out-everywhere.
-- ---------------------------------------------------------------------------
-- Run once in the Supabase dashboard → SQL Editor, after the v1 and v2
-- migrations (safe to re-run).
-- Points are public (read-only functions over already-public trades).
-- Support tickets and session revocations are PRIVATE: RLS on with no read
-- policy, so only ARCDEX's server (service role) can see them.

-- ── points ───────────────────────────────────────────────────────────────
-- ARCDEX Points for a season window [p_since, p_until):
--   trade    1 pt per $1 traded through the ARCDEX router
--   referral 20% of the trade points of every wallet you referred
--            (only their trades after the referral was bound on-chain)
--   days     10 pts per day with at least $5 traded
--   social   2 pts per like on your theses from wallets that have traded
--            at least $10 (no self-likes), capped at 500 per season
-- Every trade pays the 2% platform fee, so volume points can't be farmed
-- for free.
create or replace function public.arcdex_points(p_since timestamptz, p_until timestamptz, p_limit int default 100)
returns table (trader text, trade_pts numeric, referral_pts numeric, day_pts numeric, social_pts numeric, active_days int, total numeric, rank bigint)
language sql stable security invoker set search_path = public as $$
  with win as (
    select t.trader, t.usdc, t.block_time
    from arcdex_trades t
    where t.block_time >= p_since and t.block_time < p_until
  ),
  trade as (
    select w.trader, sum(w.usdc) as pts from win w group by w.trader
  ),
  days as (
    select d.trader, count(*)::int as n
    from (select w.trader, date_trunc('day', w.block_time) as day, sum(w.usdc) as v
          from win w group by 1, 2) d
    where d.v >= 5
    group by d.trader
  ),
  referral as (
    select r.referrer as trader, 0.2 * sum(w.usdc) as pts
    from win w
    join arcdex_referrals r on r.user_address = w.trader and w.block_time >= r.block_time
    group by r.referrer
  ),
  traders as (
    select t.trader from arcdex_trades t group by t.trader having sum(t.usdc) >= 10
  ),
  social as (
    select th.author as trader, least(500, 2 * count(*)) as pts
    from arcdex_thesis_likes l
    join arcdex_theses th on th.id = l.thesis_id
    join traders tr on tr.trader = l.liker
    where l.created_at >= p_since and l.created_at < p_until and l.liker <> th.author
    group by th.author
  ),
  everyone as (
    select trade.trader from trade union select referral.trader from referral union select social.trader from social
  ),
  scored as (
    select e.trader,
           round(coalesce(tr.pts, 0), 2)          as trade_pts,
           round(coalesce(rf.pts, 0), 2)          as referral_pts,
           10 * coalesce(d.n, 0)::numeric         as day_pts,
           coalesce(s.pts, 0)::numeric            as social_pts,
           coalesce(d.n, 0)                       as active_days
    from everyone e
    left join trade tr on tr.trader = e.trader
    left join referral rf on rf.trader = e.trader
    left join days d on d.trader = e.trader
    left join social s on s.trader = e.trader
  )
  select s.trader, s.trade_pts, s.referral_pts, s.day_pts, s.social_pts, s.active_days,
         s.trade_pts + s.referral_pts + s.day_pts + s.social_pts as total,
         rank() over (order by s.trade_pts + s.referral_pts + s.day_pts + s.social_pts desc) as rank
  from scored s
  order by total desc
  limit greatest(1, least(p_limit, 500));
$$;

-- One wallet's points and rank for the window (0 / null rank if unranked).
create or replace function public.arcdex_points_of(p_trader text, p_since timestamptz, p_until timestamptz)
returns table (trader text, trade_pts numeric, referral_pts numeric, day_pts numeric, social_pts numeric, active_days int, total numeric, rank bigint)
language sql stable security invoker set search_path = public as $$
  select * from arcdex_points(p_since, p_until, 500) p where p.trader = lower(p_trader);
$$;

-- ── support tickets (private) ────────────────────────────────────────────
create table if not exists public.arcdex_support_tickets (
  id         bigint generated always as identity primary key,
  address    text not null check (address ~ '^0x[0-9a-f]{40}$'),
  category   text not null check (category in ('trade', 'deposit', 'withdraw', 'account', 'bug', 'idea', 'other')),
  message    text not null check (char_length(message) between 5 and 2000),
  contact    text check (char_length(contact) <= 120),
  page       text check (char_length(page) <= 300),
  tx_hash    text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status     text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at timestamptz not null default now()
);
create index if not exists arcdex_support_tickets_addr_idx on public.arcdex_support_tickets (address, created_at desc);

-- ── sign out of all devices (private) ────────────────────────────────────
-- Session tokens issued before `revoked_before` are rejected by the server.
create table if not exists public.arcdex_session_revocations (
  address        text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  revoked_before timestamptz not null
);

do $$
declare t text;
begin
  foreach t in array array['arcdex_support_tickets','arcdex_session_revocations']
  loop
    execute format('alter table public.%I enable row level security', t);
    -- deliberately no policies: anon/authenticated can neither read nor write
    execute format('drop policy if exists "public read" on public.%I', t);
  end loop;
end $$;

grant execute on function public.arcdex_points(timestamptz, timestamptz, int)      to anon, authenticated;
grant execute on function public.arcdex_points_of(text, timestamptz, timestamptz)  to anon, authenticated;

-- ── platform fee totals (landing page / burn dashboard) ─────────────────
-- Swap-router fees taken in USDC, and the part already paid out to
-- referrers. What's left is ARCDEX's revenue — earmarked for buying back
-- and burning $ARCD.
create or replace function public.arcdex_fee_stats()
returns table (fees_usdc numeric, fees_24h numeric, referral_paid numeric, trades bigint, traders bigint)
language sql stable security invoker set search_path = public as $$
  select coalesce(sum(t.fee_usdc), 0),
         coalesce(sum(t.fee_usdc) filter (where t.block_time >= now() - interval '24 hours'), 0),
         (select coalesce(sum(p.amount), 0) from arcdex_referral_payouts p
           where p.token = '0x3600000000000000000000000000000000000000'),
         count(*),
         count(distinct t.trader)
  from arcdex_trades t;
$$;
grant execute on function public.arcdex_fee_stats() to anon, authenticated;
