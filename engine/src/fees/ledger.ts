// The fee ledger (the build pack's Phase 2: "fee_ledger, append-only; a nightly job reconciles ledger totals against
// on-chain balances and receipts"). Every row comes from evidence the engine read itself, never from a page:
//
//   arc        USDC ARCDEX's trading contracts paid the fee wallet in someone else's transaction (the swap routers, the
//              curve router, the launchpad, Uniswap's Universal Router, Across's handler for Robinhood Chain sales),
//              read by the $ARCDEX program's scan of the fee wallet (coin/program.ts): one row per transaction and
//              paying contract, the exact amount in USDC's 6-decimal units.
//   relay      Relay's app fees for the fee wallet (Solana and BNB Chain trades), which Relay holds until they're
//              claimed: what each currency's balance grew by is a row 'accrued', what it fell by 'claimed', and the
//              balance found the first time 'opening'.
//   jupiter    Jupiter's referral fees (Solana swaps through Jupiter): paid into token accounts owned by ARCDEX's
//              referral account (fees/jupiterWatch.ts): each transaction into one is 'received', each out 'claimed',
//              the balance found the first time 'opening'.
//   referral   the share of a fee ARCDEX's Arc routers paid a trader's referrer in the same trade (fees/referrals.ts):
//              one 'rebate' row per ReferralPaid event, with the trader, the whole fee and the share in force. Paid out,
//              not income: it's what the fee wallet didn't get.
//
// Rows are never changed or removed: arcdex_fee_ledger refuses updates, deletes and truncates, and a row seen again
// (the same id) is ignored. Amounts are exact decimal strings in the token's units.

import { log, errMsg } from '../log'

export type FeeChain = 'arc' | 'solana' | 'bnb' | 'robinhood'
export type FeeSource = 'arc-router' | 'arc-curve' | 'arc-ur' | 'arc-launchpad' | 'across' | 'arc-other' | 'relay' | 'jupiter' | 'arc-referral'
export type FeeStatus = 'received' | 'accrued' | 'claimed' | 'opening' | 'rebate'

export interface FeeRow {
  /** Deterministic, so a row read twice is written once: arc:<tx>:<payer>, relay:<currency>:<at>, jupiter:<sig>:<account>. */
  id: string
  at: number
  chain: FeeChain
  source: FeeSource
  /** A token address or mint, or Relay's currency key. */
  token: string
  symbol: string
  /** Exact, in the token's units ("1.234567"); negative for a claim. */
  amount: string
  amountUsd: number | null
  /** Who holds it: the fee wallet, Relay's balance for it, or the referral token account. */
  recipient: string
  tx: string | null
  block: number | null
  status: FeeStatus
  /** A rebate's referred trader (whose trade paid the fee); null otherwise. */
  trader?: string | null
  /** A rebate's evidence: the router, the whole fee (raw), the share in force (bps), the event's log index. */
  meta?: Record<string, string | number> | null
}

export interface ReconRow {
  at: number
  source: 'arc' | 'relay' | 'jupiter' | 'referral'
  /** What was compared: a block range, or "balance". */
  scope: string
  ledger: string
  onchain: string
  diff: string
  ok: boolean
  detail: Record<string, unknown>
}

export interface FeeLedgerStore {
  /** Adds rows not seen before (by id); returns how many were new. */
  appendFees(rows: FeeRow[]): Promise<number>
  feeRows(q: { limit: number; source?: FeeSource; sinceAt?: number }): Promise<FeeRow[]>
  /** Every row of a source (for reconciliation and totals). */
  allFees(source?: FeeSource): Promise<FeeRow[]>
  appendRecon(r: ReconRow): Promise<void>
  recons(limit: number): Promise<ReconRow[]>
}

// ── Exact decimals ───────────────────────────────────────────────────────

/** `raw` in units of 10^-decimals, as an exact decimal string. */
export function fromRaw(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals), frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : ''
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** An exact decimal string in units of 10^-decimals (extra digits are cut, never rounded up). */
export function toRaw(amount: string, decimals: number): bigint {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(amount.trim())
  if (!m) return 0n
  const frac = (m[3] ?? '').slice(0, decimals).padEnd(decimals, '0')
  const v = BigInt((m[2] || '0') + frac)
  return m[1] ? -v : v
}

/** A plain number as an exact-enough decimal string (Relay's balances come as numbers). */
export const numStr = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : '0')

/** Sum of exact decimal strings, at `decimals` places. */
export function sumAmounts(amounts: string[], decimals: number): string {
  return fromRaw(amounts.reduce((s, a) => s + toRaw(a, decimals), 0n), decimals)
}

// ── Arc: fees paid by ARCDEX's contracts ─────────────────────────────────

export const ARC_USDC = '0x3600000000000000000000000000000000000000'
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Which of ARCDEX's contracts paid a fee. */
export const ARC_FEE_SOURCE: Record<string, FeeSource> = {
  '0xc519b929981f5375d67ab3930ffb100f0a606088': 'arc-router', // ArcDexSwapRouter v1
  '0xd07583f7db671521aacfda2b4612ad187aa2924e': 'arc-router', // ArcDexSwapRouter v2
  '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441': 'arc-curve', // ArcDexCurveRouter
  '0xef6a8fdaf0181e19cc2c7575ada4b9c279809a67': 'arc-launchpad', // ArcLaunchpad
  '0x8702463e73f74d0b6765abceb314ef07acb92650': 'arc-ur', // Universal Router 2.1.2
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1': 'arc-ur', // Universal Router 2.1.1
  '0xa07480456c4ebad7626e4fdf4a180709e238547b': 'across', // Across's MulticallHandler on Arc (Robinhood Chain sales)
}

interface LogLike { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex?: string }
const addr = (t: string | undefined) => `0x${(t ?? '').slice(-40)}`.toLowerCase()
const rawOf = (data: string) => { try { return BigInt(data && data !== '0x' ? data : '0x0') } catch { return 0n } }

/** USDC each of `sources` paid `wallet` in these logs, by transaction and payer, in 6-decimal units. An ERC-20
 * transfer is logged twice (by USDC at 0x3600…, 6 decimals; by the native logger, 18 decimals), a native one once:
 * the larger of the two per transaction and payer is what was paid. */
export function arcFeeReceipts(logs: LogLike[], wallet: string, sources: Set<string>): Map<string, { tx: string; payer: string; block: number; raw: bigint }> {
  const w = wallet.toLowerCase()
  const erc = new Map<string, bigint>(), native = new Map<string, bigint>(), meta = new Map<string, { tx: string; payer: string; block: number }>()
  const seen = new Set<string>()
  for (const l of logs) {
    const token = l.address.toLowerCase()
    if ((token !== ARC_USDC && token !== NATIVE_LOGGER) || l.topics[0]?.toLowerCase() !== TRANSFER || l.topics.length < 3) continue
    if (addr(l.topics[2]) !== w) continue
    const payer = addr(l.topics[1])
    if (!sources.has(payer)) continue
    const dupe = `${l.transactionHash.toLowerCase()}:${token}:${l.logIndex ?? ''}:${l.data}`
    if (seen.has(dupe)) continue
    seen.add(dupe)
    const key = `${l.transactionHash.toLowerCase()}:${payer}`
    meta.set(key, { tx: l.transactionHash.toLowerCase(), payer, block: Number(BigInt(l.blockNumber)) })
    if (token === ARC_USDC) erc.set(key, (erc.get(key) ?? 0n) + rawOf(l.data))
    else native.set(key, (native.get(key) ?? 0n) + rawOf(l.data) / 1_000_000_000_000n)
  }
  const out = new Map<string, { tx: string; payer: string; block: number; raw: bigint }>()
  for (const [k, m] of meta) {
    const a = erc.get(k) ?? 0n, b = native.get(k) ?? 0n
    out.set(k, { ...m, raw: a > b ? a : b })
  }
  return out
}

/** Ledger rows for the fees in one batch of the fee wallet's logs (transactions it didn't send itself). */
export function arcFeeRows(logs: LogLike[], wallet: string, sources: Set<string>, timeOf: (block: number) => number | null, ownTxs: Set<string>): FeeRow[] {
  const rows: FeeRow[] = []
  for (const r of arcFeeReceipts(logs, wallet, sources).values()) {
    if (ownTxs.has(r.tx) || r.raw <= 0n) continue
    const amount = fromRaw(r.raw, 6)
    rows.push({
      id: `arc:${r.tx}:${r.payer}`, at: timeOf(r.block) ?? Date.now(), chain: 'arc', source: ARC_FEE_SOURCE[r.payer] ?? 'arc-other',
      token: ARC_USDC, symbol: 'USDC', amount, amountUsd: Number(amount), recipient: wallet.toLowerCase(), tx: r.tx, block: r.block, status: 'received',
    })
  }
  return rows.sort((a, b) => (a.block ?? 0) - (b.block ?? 0))
}

// ── Relay: app fees held for the fee wallet ──────────────────────────────

export interface RelayBalanceLike { key: string; symbol: string; amount: number; usd: number }

/** Rows for how Relay's balance for the fee wallet moved since the last read: growth accrued, drops claimed; the
 * first read (no previous balance at all) records each balance as opening. */
export function relayRows(prev: Record<string, number> | null, now: RelayBalanceLike[], at: number, wallet: string): FeeRow[] {
  const rows: FeeRow[] = []
  const first = prev === null
  const p = prev ?? {}
  const keys = new Set([...Object.keys(p), ...now.map(b => b.key)])
  for (const key of keys) {
    const b = now.find(x => x.key === key)
    const was = p[key] ?? 0, is = b?.amount ?? 0
    const delta = is - was
    if (Math.abs(delta) < 1e-12) continue
    const unit = b && b.amount > 0 ? b.usd / b.amount : null
    const status: FeeStatus = first ? 'opening' : delta > 0 ? 'accrued' : 'claimed'
    rows.push({
      id: `relay:${key}:${at}:${status}`, at, chain: 'solana', source: 'relay', token: key, symbol: b?.symbol ?? key,
      amount: numStr(delta), amountUsd: unit === null ? null : Math.round(delta * unit * 100) / 100,
      recipient: `relay:${wallet.toLowerCase()}`, tx: null, block: null, status,
    })
  }
  return rows
}

// ── Reconciliation ───────────────────────────────────────────────────────

/** Arc: the ledger's rows in a block range against an independent scan of the same range. */
export function reconcileArc(rows: FeeRow[], onchain: Map<string, { raw: bigint }>, from: number, to: number, at: number): ReconRow {
  // The fee wallet's receipts only: referral rebates went to referrers, and are reconciled on their own (fees/referrals.ts).
  const inRange = rows.filter(r => r.chain === 'arc' && r.status === 'received' && r.source !== 'arc-referral' && r.block !== null && r.block >= from && r.block <= to)
  const ledgerRaw = inRange.reduce((s, r) => s + toRaw(r.amount, 6), 0n)
  const chainRaw = [...onchain.values()].reduce((s, r) => s + r.raw, 0n)
  const ids = new Set(inRange.map(r => r.id.split(':').slice(1).join(':')))
  const missing = [...onchain.keys()].filter(k => !ids.has(k))
  const extra = [...ids].filter(k => !onchain.has(k))
  return {
    at, source: 'arc', scope: `blocks ${from}-${to}`, ledger: fromRaw(ledgerRaw, 6), onchain: fromRaw(chainRaw, 6), diff: fromRaw(ledgerRaw - chainRaw, 6),
    ok: ledgerRaw === chainRaw && !missing.length && !extra.length,
    detail: { rows: inRange.length, receipts: onchain.size, missing: missing.slice(0, 20), extra: extra.slice(0, 20) },
  }
}

/** A held balance (Relay's, or a referral token account's) against the ledger: opening + received/accrued − claimed. */
export function reconcileBalance(source: 'relay' | 'jupiter', rows: FeeRow[], token: string, balance: string, decimals: number, at: number, tolerance = 0n): ReconRow {
  const mine = rows.filter(r => r.source === source && r.token === token)
  const ledgerRaw = mine.reduce((s, r) => s + toRaw(r.amount, decimals), 0n)
  const chainRaw = toRaw(balance, decimals)
  const diff = ledgerRaw - chainRaw
  return {
    at, source, scope: `balance ${token}`, ledger: fromRaw(ledgerRaw, decimals), onchain: fromRaw(chainRaw, decimals), diff: fromRaw(diff, decimals),
    ok: (diff < 0n ? -diff : diff) <= tolerance, detail: { rows: mine.length },
  }
}

// ── The ledger ───────────────────────────────────────────────────────────

export class MemoryFeeLedgerStore implements FeeLedgerStore {
  private rows = new Map<string, FeeRow>()
  private rc: ReconRow[] = []
  async appendFees(rows: FeeRow[]) { let n = 0; for (const r of rows) if (!this.rows.has(r.id)) { this.rows.set(r.id, { ...r }); n++ } return n }
  async feeRows(q: { limit: number; source?: FeeSource; sinceAt?: number }) {
    return [...this.rows.values()].filter(r => (!q.source || r.source === q.source) && (!q.sinceAt || r.at >= q.sinceAt)).sort((a, b) => b.at - a.at).slice(0, q.limit).map(r => ({ ...r }))
  }
  async allFees(source?: FeeSource) { return [...this.rows.values()].filter(r => !source || r.source === source).map(r => ({ ...r })) }
  async appendRecon(r: ReconRow) { this.rc.push({ ...r }) }
  async recons(limit: number) { return this.rc.slice(-limit).reverse().map(r => ({ ...r })) }
}

export interface FeeSummary {
  rows: number
  /** Dollars received or accrued, by source, since the ledger began. */
  bySource: Record<string, { usd: number; rows: number }>
  /** Referral rebates ARCDEX's routers paid referrers (USDC), since the ledger began. */
  rebates: { usdc: string; usd: number; rows: number; referrers: number }
  latest: FeeRow[]
  reconciliations: ReconRow[]
  lastReconciled: number | null
  allOk: boolean | null
}

export class FeeLedger {
  constructor(readonly store: FeeLedgerStore, private onMismatch?: (r: ReconRow) => void) {}

  async record(rows: FeeRow[]): Promise<number> {
    if (!rows.length) return 0
    try {
      const n = await this.store.appendFees(rows)
      if (n) log.info('fee ledger: recorded', { rows: n })
      return n
    } catch (e) {
      log.error('fee ledger: not recorded', { error: errMsg(e), rows: rows.length })
      return 0
    }
  }

  async reconciled(r: ReconRow) {
    await this.store.appendRecon(r).catch(e => log.error('fee ledger: reconciliation not saved', { error: errMsg(e) }))
    if (!r.ok) {
      log.error('fee ledger: reconciliation mismatch', { source: r.source, scope: r.scope, ledger: r.ledger, onchain: r.onchain, diff: r.diff })
      this.onMismatch?.(r)
    }
  }

  async summary(): Promise<FeeSummary> {
    const all = await this.store.allFees()
    const bySource: FeeSummary['bySource'] = {}
    const reb = all.filter(r => r.status === 'rebate')
    const usdc = sumAmounts(reb.filter(r => r.token === ARC_USDC).map(r => r.amount), 6)
    const rebates = { usdc, usd: Math.round(Number(usdc) * 100) / 100, rows: reb.length, referrers: new Set(reb.map(r => r.recipient)).size }
    for (const r of all) {
      if (r.status !== 'received' && r.status !== 'accrued') continue
      const s = bySource[r.source] ?? (bySource[r.source] = { usd: 0, rows: 0 })
      s.usd += r.amountUsd ?? 0
      s.rows++
    }
    // Rounded once, to the cent, not row by row (which drifted: two 1.7¢ fees read 4¢).
    for (const s of Object.values(bySource)) s.usd = Math.round(s.usd * 100) / 100
    const recs = await this.store.recons(20)
    // The latest result per source and scope.
    const latest = new Map<string, ReconRow>()
    for (const r of recs) if (!latest.has(`${r.source}:${r.scope.split(' ')[0]}`)) latest.set(`${r.source}:${r.scope.split(' ')[0]}`, r)
    return {
      rows: all.length, bySource, rebates,
      latest: all.sort((a, b) => b.at - a.at).slice(0, 25),
      reconciliations: recs,
      lastReconciled: recs[0]?.at ?? null,
      allOk: latest.size ? [...latest.values()].every(r => r.ok) : null,
    }
  }
}
