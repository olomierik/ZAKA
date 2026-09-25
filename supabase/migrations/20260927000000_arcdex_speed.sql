-- ARCDEX v4: speed + true holder counts.
-- ---------------------------------------------------------------------------
-- Run once in the Supabase dashboard → SQL Editor, after v1–v3 (safe to
-- re-run).
--
-- arcdex_kv               PRIVATE. ARCDEX's server keeps the last good copy
--                         of each upstream response (GeckoTerminal market
--                         list, pools, candles…) so a throttled or slow
--                         upstream never leaves visitors waiting: they get
--                         the last copy instantly while it refreshes.
-- arcdex_holder_scans     PUBLIC READ. Per token: the block it was created
--                         in, how far its Transfer logs have been indexed,
--                         and the holder count.
-- arcdex_holder_balances  PUBLIC READ. Every current holder's exact balance
--                         (raw units), rebuilt from on-chain Transfer logs.
-- Only the server (service role) writes, through
-- arcdex_apply_holder_deltas(), which applies one contiguous block range at
-- a time so two scans of the same token can never double-count.

create table if not exists public.arcdex_kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.arcdex_holder_scans (
  token      text primary key check (token ~ '^0x[0-9a-f]{40}$'),
  from_block bigint not null,
  scanned_to bigint not null,
  holders    integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.arcdex_holder_balances (
  token   text not null,
  holder  text not null,
  balance numeric(78, 0) not null,
  primary key (token, holder)
);
create index if not exists arcdex_holder_balances_top on public.arcdex_holder_balances (token, balance desc);

do $$
declare t text;
begin
  alter table public.arcdex_kv enable row level security;
  -- deliberately no policies on arcdex_kv: server-only
  foreach t in array array['arcdex_holder_scans','arcdex_holder_balances']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
  end loop;
end $$;
grant select on public.arcdex_holder_scans, public.arcdex_holder_balances to anon, authenticated;

-- Apply the net balance changes of Transfer logs in blocks
-- (p_expected, p_to] for one token. p_deltas is {"0xholder": "<signed raw
-- amount>", …}. Returns the new holder count, or -1 if the stored scan
-- position isn't p_expected (another scan got there first — the caller
-- drops its work and re-reads).
create or replace function public.arcdex_apply_holder_deltas(
  p_token text, p_from_block bigint, p_expected bigint, p_to bigint, p_deltas jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  cur bigint;
  n integer;
begin
  if p_to < p_expected then raise exception 'p_to before p_expected'; end if;
  insert into arcdex_holder_scans (token, from_block, scanned_to)
    values (p_token, p_from_block, p_from_block - 1)
    on conflict (token) do nothing;
  select scanned_to into cur from arcdex_holder_scans where token = p_token for update;
  if cur <> p_expected then return -1; end if;

  insert into arcdex_holder_balances as b (token, holder, balance)
    select p_token, d.key, d.value::numeric
    from jsonb_each_text(coalesce(p_deltas, '{}'::jsonb)) d
    where d.value::numeric <> 0
  on conflict (token, holder) do update set balance = b.balance + excluded.balance;
  delete from arcdex_holder_balances where token = p_token and balance <= 0;

  select count(*) into n from arcdex_holder_balances where token = p_token;
  update arcdex_holder_scans set scanned_to = p_to, holders = n, updated_at = now() where token = p_token;
  return n;
end $$;
revoke all on function public.arcdex_apply_holder_deltas(text, bigint, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.arcdex_apply_holder_deltas(text, bigint, bigint, bigint, jsonb) to service_role;
