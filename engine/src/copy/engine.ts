// Copy trading (the build pack's Phase 7; the owner chose engine-held copy wallets on 2026-10-16).
//
//   wallets   each follower (a wallet signed in on the site) gets one copy wallet, made here once it signs the terms
//             (COPY_TERMS). Its key is encrypted under BOT_WALLET_SECRET like a live bot's (bot/userLive.ts
//             WalletVault): the engine is the custodian of what followers deposit. Money out goes only to the
//             follower's own wallet or a wallet that funded the copy wallet (bot/funders.ts), signed by the follower.
//   leaders   wallets on the verified board (social/boards.ts) with LEADER_MIN behind them and no wash-trade flag,
//             checked when a rule is made and again before every copied buy.
//   copies    a leader's trade through ARCDEX's routers on Arc (their Swapped event, from the chain stream) is
//             mirrored from every following copy wallet, in the coin's Uniswap v4 USDC pool, through the bot
//             executor (trading/live.ts): buys spend the leader's size up to the rule's most, never at a price more
//             than the rule's cap worse than the leader's (the swap's on-chain minimum); sales sell the share of the
//             follower's lot that the leader sold of its own holding, at most the cap below the quote.
//   safety    before a buy: the scanner's report (Danger skipped; Risky too under safe-only), the rug guard, and the
//             executor's pre-flight (the exact buy and selling it straight back, as the copy wallet).
//   caps      the rule's most per trade, its slippage cap, the wallet's USDC less a gas reserve and fees owed, and all
//             followers of one leader trade together at most COPY.crowdPoolShare of the pool.
//   stops     the follower's stop switch, a rule switched off or deleted, the copyTrading flag (/admin), COPY=off, and
//             for buys the trade switch: each is asked before a copy starts and again right before every
//             transaction is signed (SendGuard), so a stop halts copies already under way.
//   fees      every copied trade owes ARCDEX's normal router fee (feeBps of what it spent or received), sent to the
//             fee wallet once COPY.feeSettleUsd is owed and before any withdrawal, and recorded in the fee ledger.

import type { Address, Hex } from 'viem'
import {
  COPY, COPY_TERMS_VERSION, SIGNED_FOR_MS, copyTermsMessage, copyWithdrawMessage,
  type CopyExecutionV, type CopyLeaderV, type CopyMe, type CopyRuleV, type CopySafety, type CopyStats, type CopyStatus, type CopyWalletV,
} from '../../../api/_copyProtocol'
import type { PoolInfo } from '../dex/pools'
import type { FeeRow } from '../fees/ledger'
import { errMsg, log } from '../log'
import { metrics } from '../metrics'
import type { BookTrade } from '../social/pnl'
import type { Fill, SendGuard } from '../trading/live'
import type { RoundTrip } from '../trading/preflight'
import type { FundingLedger } from '../bot/funders'
import { allocate, buyFloor, buySize, parseRule, percentiles, safetyBlocks, sellAmount, shuffle, type Rating } from './rules'

const USDC = '0x3600000000000000000000000000000000000000'
const ADDR = /^0x[0-9a-f]{40}$/
const RECENT = 200

/** What the engine needs of a copy wallet's executor (trading/live.ts LiveExecutor). */
export interface CopyExec {
  readonly address: Address
  balanceUsd(): Promise<number>
  tokenBalance(token: Address): Promise<bigint>
  buy(pool: PoolInfo, token: Address, usd: number, slippageBps: number, check?: (rt: RoundTrip) => string | null, o?: SendGuard & { floor?: bigint }): Promise<Fill & { roundTrip: RoundTrip | null }>
  sell(pool: PoolInfo, token: Address, amount: bigint, slippageBps: number, o?: SendGuard): Promise<Fill>
  approveForSale(token: Address): Promise<Fill[]>
  sendUsdc(to: Address, usd: number): Promise<Fill>
}

/** A copy wallet as stored. Its key is `enc`, opened only here. */
export interface CopyWalletRow {
  follower: string
  address: string
  enc: string
  createdAt: number
  /** Micro-USDC owed to ARCDEX, and paid. */
  feeDue: string
  feesPaid: string
  terms: { version: number; at: number; signature: string }
  stopped: boolean
  funding: FundingLedger | null
  /** Coins held through each leader's copies, raw, by `${leader}|${token}`: what a leader's sale sells a share of. */
  lots: Record<string, string>
}
export interface CopyRuleRow extends CopyRuleV { follower: string }
export interface CopyExecRow extends CopyExecutionV { follower: string }

export interface CopyStore {
  copyWallets(): Promise<CopyWalletRow[]>
  saveCopyWallet(w: CopyWalletRow): Promise<void>
  copyRules(): Promise<CopyRuleRow[]>
  saveCopyRule(r: CopyRuleRow): Promise<void>
  deleteCopyRule(id: string): Promise<void>
  /** The latest executions, `perFollower` each at most. */
  copyExecutions(perFollower: number): Promise<CopyExecRow[]>
  appendCopyExecution(e: CopyExecRow): Promise<void>
}

/** Memory (dev, tests). */
export class MemoryCopyStore implements CopyStore {
  private w = new Map<string, CopyWalletRow>()
  private r = new Map<string, CopyRuleRow>()
  private e: CopyExecRow[] = []
  async copyWallets() { return [...this.w.values()].map(x => structuredClone(x)) }
  async saveCopyWallet(x: CopyWalletRow) { this.w.set(x.follower, structuredClone(x)) }
  async copyRules() { return [...this.r.values()].map(x => structuredClone(x)) }
  async saveCopyRule(x: CopyRuleRow) { this.r.set(x.id, structuredClone(x)) }
  async deleteCopyRule(id: string) { this.r.delete(id) }
  async copyExecutions(perFollower: number) {
    const seen = new Map<string, number>()
    const out: CopyExecRow[] = []
    for (const x of [...this.e].sort((a, b) => b.at - a.at)) {
      const n = seen.get(x.follower) ?? 0
      if (n >= perFollower) continue
      seen.set(x.follower, n + 1)
      out.push(structuredClone(x))
    }
    return out
  }
  async appendCopyExecution(x: CopyExecRow) { if (!this.e.some(y => y.id === x.id)) this.e.push(structuredClone(x)) }
}

export interface Vault { create(id: string, now?: number): { address: string; enc: string }; open(w: { address: string; enc: string }, id: string): Hex }

export interface CopyOptions {
  store: CopyStore
  /** Null: copy wallets can't be made or opened (no BOT_WALLET_SECRET). */
  vault: Vault | null
  makeExec: (key: Hex) => CopyExec
  /** The coin's main pool, its liquidity and ticker (the market engine). */
  pool: (token: string) => PoolInfo | null
  liquidityUsd: (token: string) => number | null
  symbol: (token: string) => string | null
  /** The coin's rating for a copy: the scanner's report (deep for safe-only) and the rug guard (copy/rules.ts screen). */
  screen: (token: string, level: CopySafety) => Promise<{ rating: Rating; why: string | null }>
  /** Null when `address` can be copied, else why not (copy/rules.ts leaderVerdict over the verified record). */
  leader: (address: string) => Promise<string | null>
  /** Eligible leaders, best first (the verified board). */
  leaders?: (limit: number) => Promise<Omit<CopyLeaderV, 'followers'>[]>
  /** The leader's balance of `token` after `block` (an eth_call at that block); null when it can't be read. */
  leaderBalanceAt: (token: string, leader: string, block: number) => Promise<bigint | null>
  /** ARCDEX's swap router fee in basis points (read from the chain); null when unknown. */
  feeBps: () => number | null
  feeWallet: Address
  /** Null when copying is on for everyone; else why not (the copyTrading flag, COPY=off). */
  on: () => string | null
  /** The trade switch for Arc: false stops copied buys (sales still follow the leader out). */
  tradingOn: () => boolean
  /** Whether `address` signed `message` (EOAs and contract wallets). */
  verify: (address: string, message: string, signature: Hex) => Promise<boolean>
  /** The wallets that funded a copy wallet (bot/funders.ts), with the ledger to keep; null when the chain can't be read. */
  funders: (w: CopyWalletRow) => Promise<{ list: { address: string; usd: number }[]; ledger: FundingLedger } | null>
  ledger?: (rows: FeeRow[]) => Promise<unknown>
  alert?: (text: string) => void
  now?: () => number
}

type Result = { status: number; body: unknown }
/** What one leader trade asks once for all its followers: the leader's standing and the coin's rating per safety level. */
interface TradeChecks { leader: Promise<string | null> | null; screens: Map<CopySafety, Promise<{ rating: Rating; why: string | null }>> }
const fail = (status: number, error: string): Result => ({ status, body: { error } })
const micro = (usd: number) => BigInt(Math.round(usd * 1e6))
const usdOf = (m: bigint | string) => Number(BigInt(m)) / 1e6

export class CopyEngine {
  private wallets = new Map<string, CopyWalletRow>()
  private rules = new Map<string, CopyRuleRow>()
  private byLeader = new Map<string, Set<string>>()
  private recent = new Map<string, CopyExecRow[]>()
  private execs = new Map<string, CopyExec>()
  private queues = new Map<string, Promise<unknown>>()
  private done = new Set<string>()
  private pending = new Map<string, { id: string; leader: string; token: string; side: 'buy' | 'sell'; at: number }>()
  private balances = new Map<string, { usd: number; at: number }>()
  private signatures = new Map<string, number>()
  private settling = new Set<string>()
  private loaded = false

  constructor(private o: CopyOptions) {}

  private now() { return this.o.now?.() ?? Date.now() }

  async load() {
    const [wallets, rules, execs] = await Promise.all([this.o.store.copyWallets(), this.o.store.copyRules(), this.o.store.copyExecutions(RECENT)])
    for (const w of wallets) this.wallets.set(w.follower, { ...w, lots: w.lots ?? {} })
    for (const r of rules) this.index(r)
    for (const e of [...execs].sort((a, b) => a.at - b.at)) this.remember(e)
    this.loaded = true
  }

  // ── state ─────────────────────────────────────────────────────────────

  private index(r: CopyRuleRow) {
    const old = this.rules.get(r.id)
    if (old) this.byLeader.get(old.leader)?.delete(r.id)
    this.rules.set(r.id, r)
    let s = this.byLeader.get(r.leader)
    if (!s) this.byLeader.set(r.leader, (s = new Set()))
    s.add(r.id)
  }

  private lotKey = (leader: string, token: string) => `${leader}|${token}`
  private lotOf = (w: CopyWalletRow, leader: string, token: string) => BigInt(w.lots[this.lotKey(leader, token)] ?? '0')

  /** Keeps an execution (newest RECENT per follower in memory; every one in the store). */
  private remember(e: CopyExecRow) {
    this.done.add(e.id)
    const list = this.recent.get(e.follower) ?? []
    list.push(e)
    if (list.length > RECENT) list.splice(0, list.length - RECENT)
    this.recent.set(e.follower, list)
  }

  /** A filled copy's effect on the follower's lot of the leader's coin. */
  private applyLot(w: CopyWalletRow, e: CopyExecRow) {
    if (e.status !== 'filled' || !e.tokens) return
    const k = this.lotKey(e.leader, e.token)
    const lot = BigInt(w.lots[k] ?? '0') + (e.side === 'buy' ? BigInt(e.tokens) : -BigInt(e.tokens))
    if (lot > 0n) w.lots[k] = lot.toString(); else delete w.lots[k]
  }

  private rulesOf(follower: string) { return [...this.rules.values()].filter(r => r.follower === follower).sort((a, b) => a.createdAt - b.createdAt) }

  /** Why copying can't happen at all right now, or null. */
  why(): string | null {
    if (!this.o.vault) return 'copy trading isn’t switched on yet: the platform owner sets BOT_WALLET_SECRET on the engine'
    if (!this.loaded) return 'copy trading is starting'
    return this.o.on()
  }

  /** What stops one rule's copy now (asked before it starts and again before each transaction is signed). */
  private stop(follower: string, ruleId: string, side: 'buy' | 'sell'): string | null {
    const g = this.why()
    if (g) return `stopped: ${g}`
    const w = this.wallets.get(follower)
    if (!w) return 'stopped: no copy wallet'
    if (w.stopped) return 'stopped: you paused copying'
    const r = this.rules.get(ruleId)
    if (!r) return 'stopped: the rule was deleted'
    if (!r.enabled) return 'stopped: the rule is switched off'
    if (side === 'buy' && !this.o.tradingOn()) return 'stopped: trading on Arc is paused by ARCDEX'
    return null
  }

  private exec(w: CopyWalletRow): CopyExec | null {
    const have = this.execs.get(w.follower)
    if (have) return have
    if (!this.o.vault) return null
    try {
      const e = this.o.makeExec(this.o.vault.open(w, `copy:${w.follower}`))
      this.execs.set(w.follower, e)
      return e
    } catch (e) { log.error('copy: wallet did not open', { follower: w.follower, error: errMsg(e) }); return null }
  }

  private async balance(w: CopyWalletRow, fresh = false): Promise<number | null> {
    const hit = this.balances.get(w.follower)
    if (!fresh && hit && this.now() - hit.at < 15_000) return hit.usd
    const e = this.exec(w)
    if (!e) return hit?.usd ?? null
    try {
      const usd = await e.balanceUsd()
      this.balances.set(w.follower, { usd, at: this.now() })
      return usd
    } catch (err) { log.debug('copy: balance read failed', { error: errMsg(err) }); return hit?.usd ?? null }
  }

  // ── reads ─────────────────────────────────────────────────────────────

  stats(now = this.now()): CopyStats {
    let copies = 0, skipped = 0, failed = 0
    const times: number[] = []
    for (const list of this.recent.values()) for (const e of list) {
      if (e.status === 'filled') { copies++; if (e.latencyMs !== null && now - e.at < 7 * 86_400_000) times.push(e.latencyMs) }
      else if (e.status === 'skipped') skipped++
      else failed++
    }
    const p = percentiles(times)
    return { copies, skipped, failed, withinWindow: times.length ? times.filter(t => t <= COPY.windowMs).length / times.length : null, p50Ms: p.p50, p95Ms: p.p95 }
  }

  status() {
    const why = this.why()
    return { on: !why, why, terms: COPY_TERMS_VERSION, feeBps: this.o.feeBps(), limits: COPY, stats: this.stats() }
  }

  async me(follower: string): Promise<CopyMe> {
    const f = follower.toLowerCase()
    const w = this.wallets.get(f) ?? null
    const why = this.why()
    let wallet: CopyWalletV | null = null
    if (w) wallet = { address: w.address, balanceUsd: await this.balance(w), feeDueUsd: usdOf(w.feeDue), feesPaidUsd: usdOf(w.feesPaid), createdAt: w.createdAt }
    const lots = Object.entries(w?.lots ?? {}).map(([k, v]) => { const [leader, token] = k.split('|'); return { leader, token, tokens: v } })
    return {
      on: !why, why, accepted: w?.terms.version ?? null, stopped: w?.stopped ?? false, wallet,
      rules: this.rulesOf(f).map(({ follower: _f, ...r }) => r),
      executions: [...(this.recent.get(f) ?? [])].reverse().slice(0, 100).map(({ follower: _f, ...e }) => e),
      lots,
    }
  }

  /** Copying in progress for a follower (the page shows them until they land). */
  inFlight(follower: string) { return [...this.pending.values()].filter(p => p.id.startsWith(`${follower.toLowerCase()}|`)) }

  async leaders(limit = 50): Promise<CopyLeaderV[]> {
    const list = (await this.o.leaders?.(limit)) ?? []
    return list.map(l => ({ ...l, followers: [...(this.byLeader.get(l.address) ?? [])].filter(id => this.rules.get(id)?.enabled).length }))
  }

  isCopyWallet(address: string) { const a = address.toLowerCase(); for (const w of this.wallets.values()) if (w.address === a) return true; return false }

  // ── a follower's changes ───────────────────────────────────────────────

  /** Accepts the terms (signed) and makes the follower's copy wallet. Accepting a new version keeps the wallet. */
  async open(follower: string, body: unknown): Promise<Result> {
    const f = follower.toLowerCase()
    if (!this.o.vault) return fail(503, this.why()!)
    const b = (body ?? {}) as { at?: unknown; signature?: unknown }
    const at = Number(b.at), sig = typeof b.signature === 'string' ? b.signature as Hex : null
    if (!Number.isFinite(at) || !sig || !/^0x[0-9a-fA-F]+$/.test(sig)) return fail(400, 'sign the terms first')
    if (Math.abs(this.now() - at) > SIGNED_FOR_MS) return fail(400, 'that signature is too old: sign again')
    if (!(await this.o.verify(f, copyTermsMessage(f, COPY_TERMS_VERSION, at), sig).catch(() => false))) return fail(403, 'the signature doesn’t match this wallet')
    const terms = { version: COPY_TERMS_VERSION, at, signature: sig }
    let w = this.wallets.get(f)
    if (w) w = { ...w, terms }
    else {
      const made = this.o.vault.create(`copy:${f}`, this.now())
      w = { follower: f, address: made.address.toLowerCase(), enc: made.enc, createdAt: this.now(), feeDue: '0', feesPaid: '0', terms, stopped: false, funding: null, lots: {} }
    }
    await this.o.store.saveCopyWallet(w)
    this.wallets.set(f, w)
    log.info('copy: wallet ready', { follower: f, wallet: w.address })
    return { status: 200, body: await this.me(f) }
  }

  /** Makes or changes the follower's rule for a leader (one per leader). */
  async setRule(follower: string, body: unknown): Promise<Result> {
    const f = follower.toLowerCase()
    const w = this.wallets.get(f)
    if (!w) return fail(400, 'open a copy wallet first')
    if (w.terms.version < COPY_TERMS_VERSION) return fail(400, 'accept the updated terms first')
    const p = parseRule(body)
    if (typeof p === 'string') return fail(400, p)
    if (p.leader === f) return fail(400, 'you can’t copy yourself')
    if (this.isCopyWallet(p.leader)) return fail(400, 'a copy wallet can’t be copied')
    const have = this.rulesOf(f).find(r => r.leader === p.leader)
    if (!have && this.rulesOf(f).length >= COPY.maxRules) return fail(400, `at most ${COPY.maxRules} leaders`)
    if (p.enabled) {
      const no = await this.o.leader(p.leader)
      if (no) return fail(400, no)
    }
    const now = this.now()
    const r: CopyRuleRow = have ? { ...have, ...p, updatedAt: now } : { id: `cr_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, follower: f, ...p, createdAt: now, updatedAt: now }
    await this.o.store.saveCopyRule(r)
    this.index(r)
    return { status: 200, body: await this.me(f) }
  }

  async deleteRule(follower: string, body: unknown): Promise<Result> {
    const f = follower.toLowerCase()
    const id = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : ''
    const r = this.rules.get(id)
    if (!r || r.follower !== f) return fail(404, 'no such rule')
    // Gone from memory first: a copy under way stops before its next transaction.
    this.rules.delete(id)
    this.byLeader.get(r.leader)?.delete(id)
    await this.o.store.deleteCopyRule(id)
    return { status: 200, body: await this.me(f) }
  }

  /** The follower's stop switch: every rule paused at once (copies under way stop before their next transaction). */
  async setStopped(follower: string, body: unknown): Promise<Result> {
    const f = follower.toLowerCase()
    const w = this.wallets.get(f)
    if (!w) return fail(400, 'no copy wallet')
    const stopped = (body as { stopped?: unknown })?.stopped
    if (typeof stopped !== 'boolean') return fail(400, 'stopped must be true or false')
    w.stopped = stopped
    await this.o.store.saveCopyWallet(w).catch(e => log.error('copy: stop not saved', { follower: f, error: errMsg(e) }))
    log.info(stopped ? 'copy: follower stopped copying' : 'copy: follower resumed copying', { follower: f })
    return { status: 200, body: await this.me(f) }
  }

  /** Who a withdrawal may go to: the follower, or a wallet that funded the copy wallet. */
  async destinations(follower: string): Promise<{ address: string; usd: number | null }[]> {
    const f = follower.toLowerCase()
    const w = this.wallets.get(f)
    if (!w) return []
    const fu = await this.o.funders(w).catch(() => null)
    if (fu) { w.funding = fu.ledger; void this.o.store.saveCopyWallet(w).catch(() => {}) }
    const out = new Map<string, number | null>([[f, null]])
    for (const x of fu?.list ?? []) out.set(x.address.toLowerCase(), x.usd)
    return [...out.entries()].map(([address, usd]) => ({ address, usd }))
  }

  /** Sends USDC out of the copy wallet: signed by the follower, to the follower or a funder, fees owed paid first. */
  async withdraw(follower: string, body: unknown): Promise<Result> {
    const f = follower.toLowerCase()
    const w = this.wallets.get(f)
    if (!w) return fail(400, 'no copy wallet')
    const b = (body ?? {}) as { to?: unknown; amountUsd?: unknown; at?: unknown; signature?: unknown }
    const to = typeof b.to === 'string' ? b.to.toLowerCase() : ''
    const amount = Math.floor(Number(b.amountUsd) * 100) / 100
    const at = Number(b.at), sig = typeof b.signature === 'string' ? b.signature as Hex : null
    if (!ADDR.test(to)) return fail(400, 'send to a wallet address')
    if (!(amount > 0)) return fail(400, 'send more than $0')
    if (!Number.isFinite(at) || !sig) return fail(400, 'sign the withdrawal first')
    if (Math.abs(this.now() - at) > SIGNED_FOR_MS) return fail(400, 'that signature is too old: sign again')
    if (this.signatures.has(sig)) return fail(400, 'that signature was used already')
    if (!(await this.o.verify(f, copyWithdrawMessage(f, to, amount, at), sig).catch(() => false))) return fail(403, 'the signature doesn’t match this wallet')
    this.signatures.set(sig, this.now())
    for (const [k, t] of this.signatures) if (this.now() - t > SIGNED_FOR_MS * 2) this.signatures.delete(k)
    const ok = (await this.destinations(f)).some(d => d.address === to)
    if (!ok) return fail(403, 'withdrawals go only to the wallet you signed in with, or to a wallet that funded the copy wallet')
    const e = this.exec(w)
    if (!e) return fail(503, this.why() ?? 'the copy wallet can’t be opened')
    // One thing at a time for this wallet: no copy spends what is being withdrawn.
    return this.serial(f, async () => {
      if (BigInt(w.feeDue) > 0n) {
        const paid = await this.settle(w)
        if (!paid) return fail(503, 'fees owed couldn’t be sent first: try again in a minute')
      }
      const bal = await this.balance(w, true)
      if (bal === null) return fail(503, 'the copy wallet’s balance couldn’t be read')
      const most = Math.floor((bal - 0.05) * 100) / 100
      if (amount > most) return fail(400, `at most $${Math.max(0, most).toFixed(2)} can be sent (a little is kept for gas)`)
      try {
        const fill = await e.sendUsdc(to as Address, amount)
        this.balances.delete(f)
        log.info('copy: withdrawal', { follower: f, to, usd: amount, tx: fill.hash })
        return { status: 200, body: { hash: fill.hash, me: await this.me(f) } }
      } catch (err) { return fail(502, `the withdrawal didn’t go through: ${errMsg(err)}`) }
    })
  }

  // ── copying ───────────────────────────────────────────────────────────

  private serial<T>(follower: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(follower) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.queues.set(follower, next.catch(() => undefined))
    return next
  }

  /** A leader's trade through ARCDEX's routers, as the chain stream sees it. Resolves when every copy has finished. */
  async onLeaderTrade(t: BookTrade, receivedAt = this.now()): Promise<void> {
    const ids = this.byLeader.get(t.trader)
    if (!ids?.size) return
    const rules = shuffle([...ids].map(id => this.rules.get(id)!).filter(r => r?.enabled), `${t.id}`)
    if (!rules.length) return
    metrics.inc('copy_leader_trades')
    const late = receivedAt - t.at > COPY.staleMs
    const symbol = this.o.symbol(t.token)
    const base = (r: CopyRuleRow): CopyExecRow => ({
      id: `${r.follower}|${r.id}|${t.id}`, follower: r.follower, ruleId: r.id, leader: t.trader, leaderTx: t.tx, leaderAt: t.at,
      token: t.token, symbol, side: t.side, status: 'skipped', reason: null, usd: null, tokens: null, tx: null, latencyMs: null, feeUsd: null, at: this.now(),
    })
    // What each buy would spend, then the room all of them share in the pool (in this trade's order).
    const sizes = new Map<string, number>()
    const once: TradeChecks = { leader: null, screens: new Map() }
    if (t.side === 'buy' && !late) {
      const leaderPoolUsd = usdOf(t.usdc - t.fee)
      const feeBps = this.o.feeBps() ?? 0
      // Asked once for every follower of this trade (in parallel with the balances).
      once.leader = this.o.leader(t.trader).catch(e => `the leader’s record couldn’t be read (${errMsg(e)})`)
      await Promise.all(rules.map(async r => {
        const w = this.wallets.get(r.follower)
        if (!w || w.stopped) return
        const bal = await this.balance(w, true)
        if (bal === null) return
        const available = bal - COPY.reserveUsd - usdOf(w.feeDue)
        sizes.set(r.id, buySize(leaderPoolUsd, r.maxPerTradeUsd, available, feeBps))
      }))
    }
    const room = allocate(rules.map(r => ({ key: r.id, usd: sizes.get(r.id) ?? 0 })), this.o.liquidityUsd(t.token))
    await Promise.all(rules.map(r => {
      const e = base(r)
      if (this.done.has(e.id)) return Promise.resolve()
      this.done.add(e.id)
      if (late) return this.finish({ ...e, reason: `too late: the engine saw the leader’s trade ${Math.round((receivedAt - t.at) / 1000)}s after it` })
      return this.serial(r.follower, () => this.copy(r, t, e, sizes.get(r.id) ?? 0, room.get(r.id) ?? 0, once))
    }))
  }

  private async copy(r: CopyRuleRow, t: BookTrade, e: CopyExecRow, wanted: number, allowed: number, once: TradeChecks): Promise<void> {
    const key = e.id
    this.pending.set(key, { id: key, leader: t.trader, token: t.token, side: t.side, at: this.now() })
    try {
      const stopped = this.stop(r.follower, r.id, t.side)
      if (stopped) return await this.finish({ ...e, reason: stopped })
      const w = this.wallets.get(r.follower)!
      const ex = this.exec(w)
      if (!ex) return await this.finish({ ...e, status: 'failed', reason: 'the copy wallet couldn’t be opened' })
      const pool = this.o.pool(t.token)
      if (!pool) return await this.finish({ ...e, reason: 'ARCDEX can’t copy trades in this coin: it has no Uniswap v4 pool against USDC' })
      const guard = () => this.stop(r.follower, r.id, t.side)
      if (t.side === 'buy') await this.copyBuy(r, t, e, ex, pool, wanted, allowed, guard, once)
      else await this.copySell(r, t, e, ex, pool, guard)
    } catch (err) {
      await this.finish({ ...e, status: 'failed', reason: errMsg(err).slice(0, 200) })
    } finally { this.pending.delete(key) }
  }

  private async copyBuy(r: CopyRuleRow, t: BookTrade, e: CopyExecRow, ex: CopyExec, pool: PoolInfo, wanted: number, allowed: number, guard: () => string | null, once: TradeChecks) {
    const feeBps = this.o.feeBps()
    if (feeBps === null) return this.finish({ ...e, reason: 'skipped: ARCDEX’s fee couldn’t be read' })
    const no = await (once.leader ?? this.o.leader(t.trader))
    if (no) return this.finish({ ...e, reason: `skipped: ${no}` })
    if (wanted < COPY.minTradeUsd) return this.finish({ ...e, reason: wanted <= 0 ? 'skipped: not enough USDC in your copy wallet' : `skipped: $${wanted.toFixed(2)} is under the $${COPY.minTradeUsd} a copy needs` })
    if (allowed < COPY.minTradeUsd) return this.finish({ ...e, reason: 'skipped: the followers’ share of this trade was full (they may buy at most 2% of the pool together)' })
    let screened = once.screens.get(r.safety)
    if (!screened) once.screens.set(r.safety, (screened = this.o.screen(t.token, r.safety).catch(err => ({ rating: 'unknown' as const, why: errMsg(err) }))))
    const s = await screened
    const blocked = safetyBlocks(r.safety, s)
    if (blocked) { metrics.inc('copy_safety_skips'); return this.finish({ ...e, reason: blocked }) }
    const usd = Math.min(wanted, allowed)
    const floor = buyFloor(micro(usd), t, r.slippageBps)
    const check = (rt: RoundTrip) => rt.lossPct !== null && rt.lossPct > COPY.maxRoundTripPct ? `buying and selling straight back costs ${rt.lossPct.toFixed(1)}%` : null
    let fill: Fill
    try { fill = await ex.buy(pool, t.token as Address, usd, r.slippageBps, check, { floor, guard }) }
    catch (err) {
      const msg = errMsg(err)
      if (/^stopped:/.test(msg)) return this.finish({ ...e, reason: msg })
      if (/price moved past the cap/.test(msg)) return this.finish({ ...e, reason: `skipped: the price moved more than your ${r.slippageBps / 100}% cap since the leader bought` })
      if (/pre-flight/.test(msg)) return this.finish({ ...e, reason: `skipped by the safety screen (${msg})` })
      throw err
    }
    this.balances.delete(r.follower)
    const fee = micro((fill.usd * feeBps) / 10_000)
    await this.finish({ ...e, status: 'filled', reason: null, usd: fill.usd, tokens: fill.tokens.toString(), tx: fill.hash, latencyMs: fill.at - t.at, feeUsd: usdOf(fee) }, fee)
    // Selling it later needs no approval wait: approved for the router right away, once per coin.
    void ex.approveForSale(t.token as Address).catch(err => log.warn('copy: approval for sale failed', { token: t.token, error: errMsg(err) }))
  }

  private async copySell(r: CopyRuleRow, t: BookTrade, e: CopyExecRow, ex: CopyExec, pool: PoolInfo, guard: () => string | null) {
    const lot = this.lotOf(this.wallets.get(r.follower)!, t.trader, t.token)
    if (lot <= 0n) return this.finish({ ...e, reason: 'skipped: you hold none of this coin from this leader’s copies' })
    const held = await ex.tokenBalance(t.token as Address).catch(() => lot)
    const after = await this.o.leaderBalanceAt(t.token, t.trader, t.block).catch(() => null)
    let amount = sellAmount(lot < held ? lot : held, t.tokens, after)
    if (amount <= 0n) return this.finish({ ...e, reason: 'skipped: nothing left to sell' })
    if (amount > held) amount = held
    const fill = await ex.sell(pool, t.token as Address, amount, r.slippageBps, { guard }).catch(err => {
      const msg = errMsg(err)
      if (/^stopped:/.test(msg)) return msg
      throw err
    })
    if (typeof fill === 'string') return this.finish({ ...e, reason: fill })
    this.balances.delete(r.follower)
    const feeBps = this.o.feeBps() ?? 0
    const fee = micro((fill.usd * feeBps) / 10_000)
    await this.finish({ ...e, status: 'filled', reason: null, usd: fill.usd, tokens: fill.tokens.toString(), tx: fill.hash, latencyMs: fill.at - t.at, feeUsd: usdOf(fee) }, fee)
  }

  private async finish(e: CopyExecRow, fee = 0n) {
    e.at = this.now()
    this.remember(e)
    metrics.inc(e.status === 'filled' ? 'copy_filled' : e.status === 'skipped' ? 'copy_skipped' : 'copy_failed')
    if (e.status === 'filled' && e.latencyMs !== null) {
      metrics.inc(e.latencyMs <= COPY.windowMs ? 'copy_within_window' : 'copy_late')
      if (e.latencyMs > COPY.windowMs) log.warn('copy: landed outside the window', { id: e.id, latencyMs: e.latencyMs })
    }
    if (e.status === 'failed') log.warn('copy: failed', { id: e.id, reason: e.reason })
    const w = this.wallets.get(e.follower)
    if (w && e.status === 'filled') {
      this.applyLot(w, e)
      if (fee > 0n) w.feeDue = (BigInt(w.feeDue) + fee).toString()
      await this.o.store.saveCopyWallet(w).catch(err => log.error('copy: lot and fee owed not saved', { follower: e.follower, error: errMsg(err) }))
    }
    await this.o.store.appendCopyExecution(e).catch(err => log.error('copy: execution not saved', { id: e.id, error: errMsg(err) }))
  }

  // ── fees ──────────────────────────────────────────────────────────────

  /** Sends what a wallet owes ARCDEX to the fee wallet, recorded in the fee ledger. True when nothing is owed now. */
  private async settle(w: CopyWalletRow): Promise<boolean> {
    const due = BigInt(w.feeDue)
    if (due <= 0n) return true
    if (this.settling.has(w.follower)) return false
    const ex = this.exec(w)
    if (!ex) return false
    this.settling.add(w.follower)
    try {
      const usd = usdOf(due)
      const f = await ex.sendUsdc(this.o.feeWallet, usd)
      w.feeDue = (BigInt(w.feeDue) - due).toString()
      w.feesPaid = (BigInt(w.feesPaid) + due).toString()
      await this.o.store.saveCopyWallet(w).catch(err => log.error('copy: fee payment not saved', { follower: w.follower, error: errMsg(err) }))
      const amount = `${due / 1_000_000n}.${(due % 1_000_000n).toString().padStart(6, '0')}`
      await this.o.ledger?.([{ id: `copy:${f.hash}`, at: f.at, chain: 'arc', source: 'arc-copy', token: USDC, symbol: 'USDC', amount, amountUsd: usd, recipient: this.o.feeWallet.toLowerCase(), tx: f.hash, block: null, status: 'received', trader: w.follower }])
        .catch(err => log.error('copy: fee not in the ledger', { tx: f.hash, error: errMsg(err) }))
      this.balances.delete(w.follower)
      return true
    } catch (err) {
      log.warn('copy: fee not sent', { follower: w.follower, error: errMsg(err) })
      return false
    } finally { this.settling.delete(w.follower) }
  }

  /** Every minute: wallets owing COPY.feeSettleUsd or more pay it. */
  async settleFees(): Promise<number> {
    let paid = 0
    for (const w of this.wallets.values()) {
      if (usdOf(w.feeDue) < COPY.feeSettleUsd) continue
      if (await this.serial(w.follower, () => this.settle(w))) paid++
    }
    return paid
  }

  // ── admin ─────────────────────────────────────────────────────────────

  adminView() {
    const rules = [...this.rules.values()]
    return {
      on: !this.why(), why: this.why(),
      wallets: this.wallets.size, stopped: [...this.wallets.values()].filter(w => w.stopped).length,
      rules: rules.length, enabled: rules.filter(r => r.enabled).length,
      leaders: new Set(rules.filter(r => r.enabled).map(r => r.leader)).size,
      feeDueUsd: [...this.wallets.values()].reduce((s, w) => s + usdOf(w.feeDue), 0),
      feesPaidUsd: [...this.wallets.values()].reduce((s, w) => s + usdOf(w.feesPaid), 0),
      inFlight: this.pending.size,
      stats: this.stats(),
      recent: [...this.recent.values()].flat().sort((a, b) => b.at - a.at).slice(0, 50),
    }
  }

  /** Copy wallets' addresses (the trade book and boards may leave them out). */
  addresses(): string[] { return [...this.wallets.values()].map(w => w.address) }

  /** Settled from main: copies under way finish their current step; new ones stop (COPY=off on shutdown). */
  pendingCount() { return this.pending.size }

  /** For tests and the stand-in: whether a copy for this follower is under way. */
  busy(follower: string) { return this.inFlight(follower).length > 0 }

  /** The executions recorded for a follower (tests). */
  executionsOf(follower: string): CopyExecRow[] { return [...(this.recent.get(follower.toLowerCase()) ?? [])] }

  /** Status of one execution by id (tests). */
  statusOf(id: string): CopyStatus | null { for (const l of this.recent.values()) { const e = l.find(x => x.id === id); if (e) return e.status } return null }
}
