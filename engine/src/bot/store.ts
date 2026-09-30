// Where signals and positions are kept: the engine's own Postgres when it
// has one (DATABASE_URL, tables created on start), else memory (dev, tests).
// Everything is stored as JSON rows keyed by id, so the shapes can grow.

import { SQL } from 'bun'
import { log, errMsg } from '../log'
import type { Position } from '../trading/paper'
import type { PaperAccount, PaperAccountStore } from './paperAccounts'
import type { Signal } from './types'

export interface BotStore extends PaperAccountStore {
  readonly kind: 'memory' | 'postgres'
  saveSignal(s: Signal): void
  savePosition(p: Position): void
  /** Open positions, and those closed in the last `days`. */
  positions(days: number): Promise<Position[]>
  signals(limit: number): Promise<Signal[]>
  /** Small settings that survive a restart (the owner's mode). */
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
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
  private accounts = new Map<string, PaperAccount>()
  async paperAccounts() { return [...this.accounts.values()].map(a => structuredClone(a)) }
  savePaperAccount(a: PaperAccount) { this.accounts.set(a.id, structuredClone(a)) }
  private trades = new Map<string, Map<string, Position>>()
  savePaperTrade(accountId: string, p: Position) {
    const m = this.trades.get(accountId) ?? this.trades.set(accountId, new Map()).get(accountId)!
    m.set(p.id, structuredClone(p))
  }
  async paperTrades(accountId: string, limit: number, before?: number) {
    return [...(this.trades.get(accountId)?.values() ?? [])].filter(p => before === undefined || (p.closedAt ?? 0) < before)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, limit).map(p => structuredClone(p))
  }
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
      on conflict (id) do nothing`)
  }
  async paperTrades(accountId: string, limit: number, before?: number) {
    await this.ready
    const rows = before === undefined
      ? await this.sql`select data from arcdex_paper_trades where account = ${accountId} order by closed_at desc limit ${limit}`
      : await this.sql`select data from arcdex_paper_trades where account = ${accountId} and closed_at < ${new Date(before)} order by closed_at desc limit ${limit}`
    return rows.map((r: { data: Position | string }) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Position)
  }
}
