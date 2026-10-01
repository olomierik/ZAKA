// Client for the ARCDEX market engine (engine/): one shared WebSocket for
// the whole app, plus the engine's REST history endpoints.
//
// Enabled when VITE_ARCDEX_WS_URL is set at build time (e.g.
// wss://api.arcdex.online/ws). Without it — or while the engine is
// unreachable — pages use their direct-from-chain path (api/poolSwaps.ts)
// instead, so nothing depends on the engine being up.
//
// Subscriptions are reference-counted: many components can listen to the
// same channel over one subscription. After a reconnect every active
// subscription is re-sent, and the engine answers each with a fresh snapshot.

import { useSyncExternalStore } from 'react'
import { botControlMessage, tierLinkMessage, type AccessView, type GradeRecordView, type TiersResponse, type BotControl, type BotProfit, type BotPosition, type BotStatus, type PaperAccountView, type PaperAction, type ScanRow, type ScanStats, type SearchHit, type StrategyBoardResponse, type Interval, type LaunchInfo, type NewPaperAccount, type BotUserView, type MeResponse, type MarketBot, type MarketBotDetail, type RejectionStats, type SafetyCheck, type ServerMessage, type TokenStats, type TradeSignal, type WireCandle, type WireTrade } from '../../../api/_marketProtocol'

const WS_URL = (import.meta.env.VITE_ARCDEX_WS_URL as string | undefined) || undefined
const API_URL = ((import.meta.env.VITE_ARCDEX_API_URL as string | undefined) || (WS_URL ? WS_URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '') : '')).replace(/\/$/, '')

export const engineEnabled = Boolean(WS_URL)

type Sub = { channel: 'token' | 'candles' | 'new_tokens' | 'market' | 'signals' | 'scan'; token?: string; interval?: Interval }
export type EngineStatus = 'off' | 'connecting' | 'open' | 'closed'

const keyOf = (s: Sub) => s.channel === 'candles' ? `candles:${s.token}:${s.interval}` : s.token ? `${s.channel}:${s.token}` : s.channel

class MarketStream {
  status: EngineStatus = engineEnabled ? 'closed' : 'off'
  private ws: WebSocket | null = null
  private subs = new Map<string, { sub: Sub; handlers: Set<(m: ServerMessage) => void> }>()
  private statusSubs = new Set<() => void>()
  private backoff = 500
  private retry: ReturnType<typeof setTimeout> | null = null
  private idle: ReturnType<typeof setTimeout> | null = null

  subscribe(sub: Sub, handler: (m: ServerMessage) => void): () => void {
    if (!engineEnabled) return () => {}
    const s: Sub = { ...sub, token: sub.token?.toLowerCase() }
    const k = keyOf(s)
    let e = this.subs.get(k)
    if (!e) {
      e = { sub: s, handlers: new Set() }
      this.subs.set(k, e)
      this.send({ action: 'subscribe', ...s })
    }
    e.handlers.add(handler)
    this.ensure()
    return () => {
      const cur = this.subs.get(k)
      if (!cur) return
      cur.handlers.delete(handler)
      if (cur.handlers.size === 0) {
        this.subs.delete(k)
        this.send({ action: 'unsubscribe', ...s })
        // Close the socket a little after the last listener leaves.
        if (!this.subs.size) { if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => { if (!this.subs.size) this.ws?.close() }, 30_000) }
      }
    }
  }

  onStatus(cb: () => void) { this.statusSubs.add(cb); return () => { this.statusSubs.delete(cb) } }

  private setStatus(s: EngineStatus) { if (this.status !== s) { this.status = s; this.statusSubs.forEach(f => f()) } }

  private send(msg: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)) }

  private ensure() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    if (this.ws || this.retry || !WS_URL) return
    this.setStatus('connecting')
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 500
      this.setStatus('open')
      for (const { sub } of this.subs.values()) this.send({ action: 'subscribe', ...sub })
    }
    ws.onmessage = ev => {
      let m: ServerMessage
      try { m = JSON.parse(String(ev.data)) as ServerMessage } catch { return }
      const k = 'k' in m ? m.k : undefined
      const target =
        m.t === 'CANDLE_UPDATE' ? `candles:${m.k}:${m.i}`
        : m.t === 'NEW_TOKEN' ? 'new_tokens'
        : m.t === 'TICKS' ? 'market'
        : m.t === 'SIGNAL' || m.t === 'BOT_POSITION' ? 'signals'
        : m.t === 'SCAN' ? 'scan'
        : k ? `token:${k}` : null
      if (target) this.subs.get(target)?.handlers.forEach(h => h(m))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.setStatus('closed')
      if (!this.subs.size) return
      const delay = this.backoff * (0.8 + Math.random() * 0.4)
      this.backoff = Math.min(15_000, this.backoff * 2)
      this.retry = setTimeout(() => { this.retry = null; this.ensure() }, delay)
    }
    ws.onerror = () => ws.close()
  }
}

export const marketStream = new MarketStream()

/** The engine connection's status, for components that switch data sources. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(cb => marketStream.onStatus(cb), () => marketStream.status)
}

// ── REST ─────────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal: AbortSignal.timeout(6_000) })
  if (!res.ok) throw new Error(`engine ${path.split('?')[0]} → ${res.status}`)
  return res.json() as Promise<T>
}

export const getEngineTrades = (token: string, limit = 200) =>
  get<{ trades: WireTrade[] }>(`/v1/tokens/${token.toLowerCase()}/trades?limit=${limit}`).then(r => r.trades)
export const getEngineCandles = (token: string, interval: Interval, limit = 500) =>
  get<{ candles: WireCandle[] }>(`/v1/tokens/${token.toLowerCase()}/candles?interval=${interval}&limit=${limit}`).then(r => r.candles)
export const getEngineToken = (token: string) =>
  get<{ token: string; meta: LaunchInfo | null; stats: TokenStats | null }>(`/v1/tokens/${token.toLowerCase()}`)
export const getNewTokens = (limit = 100) =>
  get<{ launches: LaunchInfo[] }>(`/v1/tokens/new?limit=${limit}`).then(r => r.launches)

// ── signals, paper and live trading (engine/src/bot) ─────────────────────

export interface BotStats {
  closed: number; open: number; wins: number; losses: number
  winRate: number | null; avgWinUsd: number | null; avgLossUsd: number | null
  profitFactor: number | null; expectancyUsd: number | null; totalPnlUsd: number; maxDrawdownUsd: number
}
export interface BotStatsSet { all: BotStats; snipe: BotStats; secondLeg: BotStats; /** Missing from engines before scalps (2026-09-30). */ scalp?: BotStats }
/** Top level: paper results; `live`: the bot wallet's real trades (engines before live trading lack it). */
export interface BotStatsResponse extends BotStatsSet {
  mode: 'paper' | 'live' | 'off'; live?: BotStatsSet; watching: number
  /** The engine's paper results by the rule that fired each signal (engines since 2026-10-01). */
  byRule?: { momentum: BotStats; snipe: BotStats; 'second-leg': BotStats }
  /** Each kind of signal (`rule/strategy`) replayed on real trades at live speed; live bots trade only those `ok` (engine/src/signals/liveSpeed.ts). */
  liveSpeed?: LiveSpeedRow[]
  /** Where signals go (the platform's setting): live bots every signal not on probation (`all`) or only the proven kinds; paper bots or not. */
  routing?: { liveSignals: 'all' | 'proven'; paperSignals: boolean; /** Launchpad coins only (engines since 2026-10-01): `strict`, `origin` or `off`. */ launchpadOnly?: 'strict' | 'origin' | 'off' }
  /** Each signal grade's record at live speed (engines since the grades, 2026-09-30). */
  grades?: GradeRecordView[]
}
export interface LiveSpeedRow { key: string; trades: number; wins: number; winRate: number | null; avgReturn: number | null; ok: boolean }
export interface SafetyReport { token: string; launchpad: string; at: number; verdict: 'pass' | 'risky' | 'fail' | 'pending'; score: number; checks: SafetyCheck[]; template: string | null }

export const getSignals = (limit = 100) => get<{ signals: TradeSignal[] }>(`/v1/signals?limit=${limit}`).then(r => r.signals)
export const getBotStats = () => get<BotStatsResponse>('/v1/bot/stats')
export const getBotPositions = (status: 'open' | 'closed' | 'all' = 'all', limit = 200) =>
  get<{ positions: BotPosition[] }>(`/v1/bot/positions?status=${status}&limit=${limit}`).then(r => r.positions)
export const getSafety = (token: string) => get<{ report: SafetyReport }>(`/v1/safety/${token.toLowerCase()}`).then(r => r.report)
export const getBotStatus = () => get<BotStatus>('/v1/bot/status')
/** Coins by name, ticker or address: every launch the engine has seen (lib/coinFinder.ts merges it with the rest). */
export const engineSearch = (q: string, limit = 20) => get<{ tokens: SearchHit[] }>(`/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`).then(r => r.tokens)
export const getScan = (limit = 200, status?: ScanRow['status']) => get<{ rows: ScanRow[]; stats: ScanStats }>(`/v1/bot/scan?limit=${limit}${status ? `&status=${status}` : ''}`)

// ── visitors' paper accounts (virtual USDC; engine/src/bot/paperAccounts.ts) ──

const PAPER_KEY = 'arcdex:paper-key'
/** This browser's paper account key (the engine keeps only its hash). */
export function paperKey(): string | null {
  try { return localStorage.getItem(PAPER_KEY) } catch { return null }
}
function setPaperKey(k: string | null) {
  try { if (k) localStorage.setItem(PAPER_KEY, k); else localStorage.removeItem(PAPER_KEY) } catch { /* storage blocked */ }
}
async function paperFetch(path: string, init: RequestInit & { key?: string | null } = {}): Promise<{ key?: string; account: PaperAccountView }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init, signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', ...(init.key ? { 'X-Paper-Key': init.key } : {}) },
  })
  const body = await res.json().catch(() => ({})) as { key?: string; account?: PaperAccountView; error?: string }
  if (res.status === 404 && init.key) setPaperKey(null) // the account is gone: start over
  if (!res.ok || !body.account) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return body as { key?: string; account: PaperAccountView }
}
/** A new bot for this browser: its name and strategies. */
export async function createPaperAccount(bot: NewPaperAccount): Promise<PaperAccountView> {
  const r = await paperFetch('/v1/paper/accounts', { method: 'POST', body: JSON.stringify(bot) })
  if (r.key) setPaperKey(r.key)
  return r.account
}
export const getPaperAccount = (key: string) => paperFetch('/v1/paper/account', { key }).then(r => r.account)
export const paperAction = (key: string, action: PaperAction) => paperFetch('/v1/paper/account', { method: 'POST', key, body: JSON.stringify(action) }).then(r => r.account)
/** The bot's trade log: every closed trade, newest first (`before`: a closing time, for the next page). */
export async function getPaperTrades(key: string, limit = 100, before?: number): Promise<{ trades: BotPosition[]; total: number }> {
  const res = await fetch(`${API_URL}/v1/paper/trades?limit=${limit}${before ? `&before=${before}` : ''}`, { headers: { 'X-Paper-Key': key }, signal: AbortSignal.timeout(10_000) })
  const body = await res.json().catch(() => ({})) as { trades?: BotPosition[]; total?: number; error?: string }
  if (!res.ok || !body.trades) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return { trades: body.trades, total: body.total ?? body.trades.length }
}

// ── Autotrade accounts, owners' bots and the marketplace (engine/src/ws/botApi.ts) ──

const SESSION_KEY = 'arcdex:bot-session'
/** This browser's Autotrade session (email + passcode sign-in); the engine checks its signature. */
export function botSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY) } catch { return null }
}
function setBotSession(t: string | null) {
  try { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY) } catch { /* storage blocked */ }
  window.dispatchEvent(new Event('arcdex:bot-session'))
}
export function botSignOut() { setBotSession(null) }

async function botFetch<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean; withKey?: boolean } = {}): Promise<T> {
  const token = init.auth ? botSession() : null
  if (init.auth && !token) throw new Error('sign in first')
  const key = init.withKey ? paperKey() : null
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Paper-Key': key } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = await res.json().catch(() => ({})) as T & { error?: string }
  if (res.status === 401 && init.auth) setBotSession(null) // expired or signed out elsewhere
  if (!res.ok) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return body
}
async function signedIn(path: string, email: string, passcode: string) {
  const r = await botFetch<{ token: string; user: BotUserView; claimed: string | null }>(path, { method: 'POST', body: { email, passcode }, withKey: true })
  setBotSession(r.token)
  if (r.claimed) setPaperKey(null) // this browser's old bot joined the account
  return r
}
export const botSignup = (email: string, passcode: string) => signedIn('/v1/auth/signup', email, passcode)
export const botLogin = (email: string, passcode: string) => signedIn('/v1/auth/login', email, passcode)
export const botForgot = (email: string) => botFetch<{ message: string }>('/v1/auth/forgot', { method: 'POST', body: { email } }).then(r => r.message)
export const botVerifySend = () => botFetch<{ ok: true }>('/v1/auth/verify/send', { method: 'POST', body: {}, auth: true })
export const botVerify = (code: string) => botFetch<{ user: BotUserView }>('/v1/auth/verify', { method: 'POST', body: { code }, auth: true }).then(r => r.user)
export async function botChangePasscode(current: string, next: string) {
  const r = await botFetch<{ token: string }>('/v1/auth/passcode', { method: 'POST', body: { current, next }, auth: true })
  setBotSession(r.token)
}
export async function botSignOutAll() { await botFetch('/v1/auth/logout-all', { method: 'POST', body: {}, auth: true }); setBotSession(null) }
export const botMe = () => botFetch<MeResponse>('/v1/me', { auth: true })
/** Winning trades the signed-in owner's bots closed after `since` (the profit notifications). */
export const botProfits = (since: number) => botFetch<{ profits: BotProfit[]; now: number }>(`/v1/me/profits?since=${Math.floor(since)}`, { auth: true })
export const botCreate = (bot: NewPaperAccount) => botFetch<{ account: PaperAccountView }>('/v1/me/bots', { method: 'POST', body: bot, auth: true }).then(r => r.account)
export const botAction = (slug: string, action: PaperAction) => botFetch<{ account: PaperAccountView }>(`/v1/me/bots/${encodeURIComponent(slug)}`, { method: 'POST', body: action, auth: true }).then(r => r.account)
export const botTrades = (slug: string, limit = 100, before?: number) =>
  botFetch<{ trades: BotPosition[]; total: number }>(`/v1/me/bots/${encodeURIComponent(slug)}/trades?limit=${limit}${before ? `&before=${before}` : ''}`, { auth: true })
export const botWithdrawCode = (slug: string, to: string, amountUsd: number) =>
  botFetch<{ message: string }>(`/v1/me/bots/${encodeURIComponent(slug)}/withdraw/code`, { method: 'POST', body: { to, amountUsd }, auth: true }).then(r => r.message)
export const botWithdraw = (slug: string, code: string) =>
  botFetch<{ hash: string; account: PaperAccountView }>(`/v1/me/bots/${encodeURIComponent(slug)}/withdraw`, { method: 'POST', body: { code }, auth: true })
/** Without email: the account passcode, and only back to a wallet that funded the bot (`botFunders`). */
export const botWithdrawPasscode = (slug: string, to: string, amountUsd: number, passcode: string) =>
  botFetch<{ hash: string; account: PaperAccountView }>(`/v1/me/bots/${encodeURIComponent(slug)}/withdraw`, { method: 'POST', body: { to, amountUsd, passcode }, auth: true })
/** The wallets that funded a bot's live wallet (read from the chain by the engine). */
export const botFunders = (slug: string) =>
  botFetch<{ funders: { address: string; usd: number }[]; known: boolean }>(`/v1/me/bots/${encodeURIComponent(slug)}/funders`, { auth: true })
/** The marketplace: every bot, public. */
/** The marketplace; `mode` lists only live or only paper bots (`counts` has both; older engines leave it out). */
export const getMarket = (sort: 'pnl' | 'winrate' | 'new' | 'live' = 'pnl', limit = 100, mode?: 'live' | 'paper') =>
  botFetch<{ bots: MarketBot[]; total: number; counts?: { live: number; paper: number } }>(`/v1/bots?sort=${sort}&limit=${limit}${mode ? `&mode=${mode}` : ''}`)
export const getMarketBot = (slug: string) => botFetch<{ bot: MarketBotDetail }>(`/v1/bots/${encodeURIComponent(slug)}`).then(r => r.bot)
export const getRejections = () => get<RejectionStats>('/v1/bot/rejections')
/** The strategy board: which of the three strategies live bots trade now, with whose settings (engines since 2026-10-01). */
export const getStrategyBoard = () => get<StrategyBoardResponse>('/v1/bot/board')

/** The owner's signed switch: paper/live, or sell every live position (engine/src/bot/control.ts). */
/** The tiers, whether they're enforced, and each signal grade's record (GET /v1/tiers). */
export const getTiers = () => get<TiersResponse>('/v1/tiers')

/** Links a wallet to the signed-in account: the wallet signs, and its $ARCD counts toward the account's tier. */
export async function botLinkWallet(email: string, address: string, sign: (message: string) => Promise<`0x${string}`>): Promise<AccessView> {
  const at = Date.now()
  const signature = await sign(tierLinkMessage(email, address, at))
  return botFetch<{ access: AccessView }>('/v1/me/wallets', { method: 'POST', body: { address, at, signature }, auth: true }).then(r => r.access)
}
export const botUnlinkWallet = (address: string) => botFetch<{ access: AccessView }>('/v1/me/wallets/remove', { method: 'POST', body: { address }, auth: true }).then(r => r.access)

/** The owner grants an account a tier for some days (0 takes it back), signed by the owner's wallet. */
export async function sendTierGrant(control: Extract<BotControl, { action: 'grant-tier' }>, sign: (message: string) => Promise<`0x${string}`>): Promise<{ grant: { tier: string; until: number } | null; access: AccessView | null }> {
  const at = Date.now()
  const signature = await sign(botControlMessage(control, at))
  const res = await fetch(`${API_URL}/v1/bot/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...control, at, signature }), signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({})) as { ok?: boolean; grant?: { tier: string; until: number } | null; access?: AccessView | null; error?: string }
  if (!res.ok || !body.ok) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return { grant: body.grant ?? null, access: body.access ?? null }
}

export async function sendBotControl(control: BotControl, sign: (message: string) => Promise<`0x${string}`>): Promise<BotStatus> {
  const at = Date.now()
  const signature = await sign(botControlMessage(control, at))
  const res = await fetch(`${API_URL}/v1/bot/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...control, at, signature }), signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({})) as { status?: BotStatus; error?: string }
  if (!res.ok || !body.status) throw new Error(body.error ?? `the engine answered ${res.status}`)
  return body.status
}

// ── recent launches (shared: Terminal, search) ───────────────────────────
let launches: LaunchInfo[] = []
const launchListeners = new Set<() => void>()
let launchesStarted = false
function startLaunches() {
  if (launchesStarted || !engineEnabled) return
  launchesStarted = true
  const merge = (ls: LaunchInfo[]) => {
    const seen = new Set(launches.map(l => l.token))
    launches = [...ls.filter(l => !seen.has(l.token)), ...launches].sort((a, b) => b.timestamp - a.timestamp).slice(0, 500)
    launchListeners.forEach(f => f())
  }
  void getNewTokens(200).then(merge).catch(() => {})
  marketStream.subscribe({ channel: 'new_tokens' }, m => { if (m.t === 'NEW_TOKEN') merge([m.d]) })
}

/** Launches the engine has detected, newest first (empty without the engine). */
export function useRecentLaunches(): LaunchInfo[] {
  return useSyncExternalStore(cb => { startLaunches(); launchListeners.add(cb); return () => { launchListeners.delete(cb) } }, () => launches)
}
