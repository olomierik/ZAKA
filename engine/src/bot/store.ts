// Where signals and positions are kept: the engine's own Postgres when it
// has one (DATABASE_URL, tables created on start), else memory (dev, tests).
// Everything is stored as JSON rows keyed by id, so the shapes can grow.

import { SQL } from 'bun'
import { log, errMsg } from '../log'
import type { Position } from '../trading/paper'
import type { PaperAccount, PaperAccountStore } from './paperAccounts'
import type { VisitorStore } from '../traffic'
import { MemoryVoteStore, emptyCounts, isVoteKind, type VoteKind, type VoteStore } from '../votes'
import type { Signal } from './types'
import type { User, UserStore } from './users'
import type { AuditEntry, AuditStore } from '../site/tradeSwitch'
import { MemoryFeeLedgerStore, type FeeLedgerStore, type FeeRow, type FeeSource, type ReconRow } from '../fees/ledger'
import { MemorySweepStore, type SweepStore } from '../admin/sweeper'
import type { SweepRun } from '../../../api/_marketProtocol'

export interface BotStore extends PaperAccountStore, UserStore, VisitorStore, VoteStore, AuditStore, FeeLedgerStore, SweepStore {
  readonly kind: 'memory' | 'postgres'
  saveSignal(s: Signal): void
  savePosition(p: Position): void
  /** Open positions, and those closed in the last `days`. */
  positions(days: number): Promise<Position[]>
  signals(limit: number): Promise<Signal[]>
  /** Small settings that survive a restart (the owner's mode). */
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
  /** The admin audit log, newest first (appendAudit adds; nothing changes or removes an entry). */
  audit(limit: number): Promise<AuditEntry[]>
}

export class MemoryBotStore implements BotStore {
  readonly kind = 'memory' as const
  private s = new Map<string, Signal>()
  private p = new Map<string, Position>()
  saveSignal(s: Signal) { this.s.set(s.id, s) }
  savePosition(p: Position) { this.p.set(p.id, structuredClone(p)) }
  async positions(days: number) {
    const since = Date.now() - days * 86_400_000
    return [...this.p.values()].filter(p => p.status === 'open' || (p.closedAt ?? 0) >= since).map(p => structuredClone(p))
  }
  async signals(limit: number) { return [...this.s.values()].sort((a, b) => b.at - a.at).slice(0, limit) }
  private kv = new Map<string, string>()
  async getSetting(key: string) { return this.kv.get(key) ?? null }
  async setSetting(key: string, value: string) { this.kv.set(key, value) }
  private auditLog: AuditEntry[] = []
  async appendAudit(e: AuditEntry) { this.auditLog.push(structuredClone(e)) }
  async audit(limit: number) { return this.auditLog.slice(-limit).reverse().map(e => structuredClone(e)) }
  private accounts = new Map<string, PaperAccount>()
  async paperAccounts() { return [...this.accounts.values()].map(a => structuredClone(a)) }
  savePaperAccount(a: PaperAccount) { this.accounts.set(a.id, structuredClone(a)) }
  private trades = new Map<string, Map<string, Position>>()
  savePaperTrade(accountId: string, p: Position) {
    const m = this.trades.get(accountId) ?? this.trades.set(accountId, new Map()).get(accountId)!
    m.set(p.id, structuredClone(p))
  }
  private userRows = new Map<string, User>()
  async users() { return [...this.userRows.values()].map(u => structuredClone(u)) }
  saveUser(u: User) { this.userRows.set(u.id, structuredClone(u)) }
  private visitors = new Map<string, { first: number; last: number }>()
  visitorSeen(id: string, at: number) { const v = this.visitors.get(id); this.visitors.set(id, { first: v?.first ?? at, last: at }) }
  async visitorCounts(dayStart: number) { return { total: this.visitors.size, today: [...this.visitors.values()].filter(v => v.last >= dayStart).length } }
  private votes = new MemoryVoteStore()
  voteSet(chain: string, address: string, voter: string, kind: VoteKind | null, at: number) { return this.votes.voteSet(chain, address, voter, kind) }
  voteCounts(chain: string, address: string) { return this.votes.voteCounts(chain, address) }
  async paperTrades(accountId: string, limit: number, before?: number) {
    return [...(this.trades.get(accountId)?.values() ?? [])].filter(p => before === undefined || (p.closedAt ?? 0) < before)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, limit).map(p => structuredClone(p))
  }
  private fees = new MemoryFeeLedgerStore()
  appendFees(rows: FeeRow[]) { return this.fees.appendFees(rows) }
  feeRows(q: { limit: number; source?: FeeSource; sinceAt?: number }) { return this.fees.feeRows(q) }
  allFees(source?: FeeSource) { return this.fees.allFees(source) }
  appendRecon(r: ReconRow) { return this.fees.appendRecon(r) }
  recons(limit: number) { return this.fees.recons(limit) }
  private sweeps = new MemorySweepStore()
  appendSweepRun(r: SweepRun) { return this.sweeps.appendSweepRun(r) }
  sweepRuns(limit: number) { return this.sweeps.sweepRuns(limit) }
}

const SCHEMA = `
create table if not exists arcdex_bot_signals (
  id text primary key, at timestamptz not null, strategy text not null, token text not null, data jsonb not null
);
create index if not exists arcdex_bot_signals_at on arcdex_bot_signals (at desc);
create table if not exists arcdex_bot_positions (
  id text primary key, token text not null, strategy text not null, status text not null,
  opened_at timestamptz not null, closed_at timestamptz, data jsonb not null
);
create index if not exists arcdex_bot_positions_open on arcdex_bot_positions (status, closed_at desc);
create table if not exists arcdex_bot_settings (key text primary key, value text not null, at timestamptz not null default now());
create table if not exists arcdex_paper_accounts (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists arcdex_paper_trades (id text primary key, account text not null, closed_at timestamptz not null, data jsonb not null);
create index if not exists arcdex_paper_trades_account on arcdex_paper_trades (account, closed_at desc);
create table if not exists arcdex_bot_users (id text primary key, email text not null unique, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists arcdex_visitors (id text primary key, first_seen timestamptz not null, last_seen timestamptz not null);
create index if not exists arcdex_visitors_last on arcdex_visitors (last_seen);
create table if not exists arcdex_coin_votes (chain text not null, address text not null, voter text not null, kind text not null, at timestamptz not null, primary key (chain, address, voter));
-- Admin actions (the trade switch), kept for good: the triggers refuse every update, delete and truncate, whoever runs it.
create table if not exists arcdex_admin_audit (id bigserial primary key, at timestamptz not null, actor text not null, action text not null, detail jsonb not null);
create index if not exists arcdex_admin_audit_at on arcdex_admin_audit (at desc);
create or replace function arcdex_admin_audit_append_only() returns trigger language plpgsql as $$
begin raise exception 'arcdex_admin_audit is append-only'; end $$;
drop trigger if exists arcdex_admin_audit_no_change on arcdex_admin_audit;
create trigger arcdex_admin_audit_no_change before update or delete on arcdex_admin_audit for each row execute function arcdex_admin_audit_append_only();
drop trigger if exists arcdex_admin_audit_no_truncate on arcdex_admin_audit;
create trigger arcdex_admin_audit_no_truncate before truncate on arcdex_admin_audit for each statement execute function arcdex_admin_audit_append_only();
-- The fee ledger (fees/ledger.ts): every fee ARCDEX collected, from on-chain evidence, and each nightly reconciliation.
-- Append-only like the audit log: a row seen again is ignored (on conflict do nothing), nothing is changed or removed.
create table if not exists arcdex_fee_ledger (
  id text primary key, at timestamptz not null, chain text not null, source text not null, token text not null, symbol text not null,
  amount numeric not null, amount_usd double precision, recipient text not null, tx text, block bigint, status text not null,
  inserted_at timestamptz not null default now()
);
create index if not exists arcdex_fee_ledger_at on arcdex_fee_ledger (at desc);
-- Referral rebates (fees/referrals.ts): the referred trader and the evidence. Adding columns isn't a change to any row.
alter table arcdex_fee_ledger add column if not exists trader text;
alter table arcdex_fee_ledger add column if not exists meta jsonb;
create index if not exists arcdex_fee_ledger_source on arcdex_fee_ledger (source, at);
create table if not exists arcdex_fee_reconciliations (
  id bigserial primary key, at timestamptz not null, source text not null, scope text not null,
  ledger numeric not null, onchain numeric not null, diff numeric not null, ok boolean not null, detail jsonb not null
);
create index if not exists arcdex_fee_reconciliations_at on arcdex_fee_reconciliations (at desc);
create or replace function arcdex_fee_append_only() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name; end $$;
drop trigger if exists arcdex_fee_ledger_no_change on arcdex_fee_ledger;
create trigger arcdex_fee_ledger_no_change before update or delete on arcdex_fee_ledger for each row execute function arcdex_fee_append_only();
drop trigger if exists arcdex_fee_ledger_no_truncate on arcdex_fee_ledger;
create trigger arcdex_fee_ledger_no_truncate before truncate on arcdex_fee_ledger for each statement execute function arcdex_fee_append_only();
drop trigger if exists arcdex_fee_recon_no_change on arcdex_fee_reconciliations;
create trigger arcdex_fee_recon_no_change before update or delete on arcdex_fee_reconciliations for each row execute function arcdex_fee_append_only();
drop trigger if exists arcdex_fee_recon_no_truncate on arcdex_fee_reconciliations;
create trigger arcdex_fee_recon_no_truncate before truncate on arcdex_fee_reconciliations for each statement execute function arcdex_fee_append_only();
-- The fee sweeper's runs (admin/sweeper.ts), dry and real, kept for good like the ledger.
create table if not exists arcdex_sweep_runs (
  id text primary key, at timestamptz not null, day text not null, mode text not null, by_actor text not null, status text not null, run jsonb not null
);
create index if not exists arcdex_sweep_runs_at on arcdex_sweep_runs (at desc);
drop trigger if exists arcdex_sweep_runs_no_change on arcdex_sweep_runs;
create trigger arcdex_sweep_runs_no_change before update or delete on arcdex_sweep_runs for each row execute function arcdex_fee_append_only();
drop trigger if exists arcdex_sweep_runs_no_truncate on arcdex_sweep_runs;
create trigger arcdex_sweep_runs_no_truncate before truncate on arcdex_sweep_runs for each statement execute function arcdex_fee_append_only();
`

export class PostgresBotStore implements BotStore {
  readonly kind = 'postgres' as const
  private sql: SQL
  private ready: Promise<void>
  constructor(url: string) {
    this.sql = new SQL(url)
    this.ready = this.sql.unsafe(SCHEMA).then(() => undefined, e => log.error('bot store: schema failed', { error: errMsg(e) }))
  }
  private write(what: string, fn: () => Promise<unknown>) {
    void this.ready.then(fn).catch(e => log.warn(`bot store: ${what} failed`, { error: errMsg(e) }))
  }
  saveSignal(s: Signal) {
    this.write('signal', () => this.sql`insert into arcdex_bot_signals (id, at, strategy, token, data) values (${s.id}, ${new Date(s.at)}, ${s.strategy}, ${s.token}, ${JSON.stringify(s)}::jsonb) on conflict (id) do nothing`)
  }
  savePosition(p: Position) {
    this.write('position', () => this.sql`insert into arcdex_bot_positions (id, token, strategy, status, opened_at, closed_at, data)
      values (${p.id}, ${p.token}, ${p.strategy}, ${p.status}, ${new Date(p.openedAt)}, ${p.closedAt ? new Date(p.closedAt) : null}, ${JSON.stringify(p)}::jsonb)
      on conflict (id) do update set status = excluded.status, closed_at = excluded.closed_at, data = excluded.data`)
  }
  async positions(days: number) {
    await this.ready
    const rows = await this.sql`select data from arcdex_bot_positions where status = 'open' or closed_at >= ${new Date(Date.now() - days * 86_400_000)} order by opened_at`
    return rows.map((r: { data: Position | string }) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Position)
  }
  async signals(limit: number) {
    await this.ready
    const rows = await this.sql`select data from arcdex_bot_signals order by at desc limit ${limit}`
    return rows.map((r: { data: Signal | string }) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Signal)
  }
  async getSetting(key: string) {
    await this.ready
    const rows = await this.sql`select value from arcdex_bot_settings where key = ${key}`
    return (rows[0] as { value: string } | undefined)?.value ?? null
  }
  async setSetting(key: string, value: string) {
    await this.ready
    await this.sql`insert into arcdex_bot_settings (key, value, at) values (${key}, ${value}, now()) on conflict (key) do update set value = excluded.value, at = excluded.at`
  }
  async appendAudit(e: AuditEntry) {
    await this.ready
    await this.sql`insert into arcdex_admin_audit (at, actor, action, detail) values (${new Date(e.at)}, ${e.actor}, ${e.action}, ${JSON.stringify(e.detail)}::jsonb)`
  }
  async audit(limit: number): Promise<AuditEntry[]> {
    await this.ready
    const rows = await this.sql`select at, actor, action, detail from arcdex_admin_audit order by at desc, id desc limit ${limit}`
    return rows.map((r: { at: Date; actor: string; action: string; detail: Record<string, unknown> | string }) => ({
      at: new Date(r.at).getTime(), actor: r.actor, action: r.action, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
    }))
  }
  async paperAccounts() {
    await this.ready
    const rows = await this.sql`select data from arcdex_paper_accounts`
    return rows.map((r: { data: PaperAccount | string }) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as PaperAccount)
  }
  savePaperAccount(a: PaperAccount) {
    this.write('paper account', () => this.sql`insert into arcdex_paper_accounts (id, data, updated_at) values (${a.id}, ${JSON.stringify(a)}::jsonb, now())
      on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at`)
  }
  savePaperTrade(accountId: string, p: Position) {
    this.write('paper trade', () => this.sql`insert into arcdex_paper_trades (id, account, closed_at, data) values (${`${accountId.slice(0, 16)}:${p.id}`}, ${accountId}, ${new Date(p.closedAt ?? Date.now())}, ${JSON.stringify(p)}::jsonb)
      on conflict (id) do update set data = excluded.data`)
  }
  async users() {
    await this.ready
    const rows = await this.sql`select data from arcdex_bot_users`
    return rows.map((r: { data: User | string }) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as User)
  }
  saveUser(u: User) {
    this.write('user', () => this.sql`insert into arcdex_bot_users (id, email, data, updated_at) values (${u.id}, ${u.email}, ${JSON.stringify(u)}::jsonb, now())
      on conflict (id) do update set email = excluded.email, data = excluded.data, updated_at = excluded.updated_at`)
  }
  visitorSeen(id: string, at: number) {
    this.write('visitor', () => this.sql`insert into arcdex_visitors (id, first_seen, last_seen) values (${id}, ${new Date(at)}, ${new Date(at)})
      on conflict (id) do update set last_seen = excluded.last_seen`)
  }
  async voteSet(chain: string, address: string, voter: string, kind: VoteKind | null, at: number) {
    await this.ready
    if (kind) {
      await this.sql`insert into arcdex_coin_votes (chain, address, voter, kind, at) values (${chain}, ${address}, ${voter}, ${kind}, ${new Date(at)})
        on conflict (chain, address, voter) do update set kind = excluded.kind, at = excluded.at`
    } else {
      await this.sql`delete from arcdex_coin_votes where chain = ${chain} and address = ${address} and voter = ${voter}`
    }
  }
  async voteCounts(chain: string, address: string) {
    await this.ready
    const rows = await this.sql`select kind, count(*)::int as n from arcdex_coin_votes where chain = ${chain} and address = ${address} group by kind`
    const c = emptyCounts()
    for (const r of rows as { kind: string; n: number }[]) if (isVoteKind(r.kind)) c[r.kind] = Number(r.n)
    return c
  }
  async visitorCounts(dayStart: number) {
    await this.ready
    const rows = await this.sql`select count(*)::int as total, (count(*) filter (where last_seen >= ${new Date(dayStart)}))::int as today from arcdex_visitors`
    const r = rows[0] as { total: number; today: number } | undefined
    return { total: Number(r?.total ?? 0), today: Number(r?.today ?? 0) }
  }
  async paperTrades(accountId: string, limit: number, before?: number) {
    await this.ready
    const rows = before === undefined
      ? await this.sql`select data from arcdex_paper_trades where account = ${accountId} order by closed_at desc limit ${limit}`
      : await this.sql`select data from arcdex_paper_trades where account = ${accountId} and closed_at < ${new Date(before)} order by closed_at desc limit ${limit}`
    return rows.map((r: { data: Position | string }) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Position)
  }

  async appendFees(rows: FeeRow[]) {
    await this.ready
    let n = 0
    for (const r of rows) {
      const res = await this.sql`insert into arcdex_fee_ledger (id, at, chain, source, token, symbol, amount, amount_usd, recipient, tx, block, status, trader, meta)
        values (${r.id}, ${new Date(r.at)}, ${r.chain}, ${r.source}, ${r.token}, ${r.symbol}, ${r.amount}::numeric, ${r.amountUsd}, ${r.recipient}, ${r.tx}, ${r.block}, ${r.status},
          ${r.trader ?? null}, ${r.meta ? JSON.stringify(r.meta) : null}::jsonb)
        on conflict (id) do nothing returning id`
      n += res.length
    }
    return n
  }
  private feeOf = (r: Record<string, unknown>): FeeRow => ({
    id: String(r.id), at: new Date(r.at as Date).getTime(), chain: r.chain as FeeRow['chain'], source: r.source as FeeSource, token: String(r.token), symbol: String(r.symbol),
    amount: String(r.amount), amountUsd: r.amount_usd === null ? null : Number(r.amount_usd), recipient: String(r.recipient), tx: (r.tx as string | null) ?? null,
    block: r.block === null || r.block === undefined ? null : Number(r.block), status: r.status as FeeRow['status'],
    trader: (r.trader as string | null | undefined) ?? null,
    meta: r.meta == null ? null : typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta as Record<string, string | number>),
  })
  async feeRows(q: { limit: number; source?: FeeSource; sinceAt?: number }) {
    await this.ready
    const since = new Date(q.sinceAt ?? 0)
    const rows = q.source
      ? await this.sql`select * from arcdex_fee_ledger where source = ${q.source} and at >= ${since} order by at desc, id limit ${q.limit}`
      : await this.sql`select * from arcdex_fee_ledger where at >= ${since} order by at desc, id limit ${q.limit}`
    return (rows as Record<string, unknown>[]).map(this.feeOf)
  }
  async allFees(source?: FeeSource) {
    await this.ready
    const rows = source ? await this.sql`select * from arcdex_fee_ledger where source = ${source}` : await this.sql`select * from arcdex_fee_ledger`
    return (rows as Record<string, unknown>[]).map(this.feeOf)
  }
  async appendRecon(r: ReconRow) {
    await this.ready
    await this.sql`insert into arcdex_fee_reconciliations (at, source, scope, ledger, onchain, diff, ok, detail)
      values (${new Date(r.at)}, ${r.source}, ${r.scope}, ${r.ledger}::numeric, ${r.onchain}::numeric, ${r.diff}::numeric, ${r.ok}, ${JSON.stringify(r.detail)}::jsonb)`
  }
  async recons(limit: number): Promise<ReconRow[]> {
    await this.ready
    const rows = await this.sql`select * from arcdex_fee_reconciliations order by at desc, id desc limit ${limit}`
    return (rows as Record<string, unknown>[]).map(r => ({
      at: new Date(r.at as Date).getTime(), source: r.source as ReconRow['source'], scope: String(r.scope), ledger: String(r.ledger), onchain: String(r.onchain),
      diff: String(r.diff), ok: !!r.ok, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : (r.detail as Record<string, unknown>),
    }))
  }
  async appendSweepRun(r: SweepRun) {
    await this.ready
    await this.sql`insert into arcdex_sweep_runs (id, at, day, mode, by_actor, status, run) values (${r.id}, ${new Date(r.at)}, ${r.day}, ${r.mode}, ${r.by}, ${r.status}, ${JSON.stringify(r)}::jsonb)
      on conflict (id) do nothing`
  }
  async sweepRuns(limit: number): Promise<SweepRun[]> {
    await this.ready
    const rows = await this.sql`select run from arcdex_sweep_runs order by at desc limit ${limit}`
    return rows.map((r: { run: SweepRun | string }) => (typeof r.run === 'string' ? JSON.parse(r.run) : r.run) as SweepRun)
  }
}
