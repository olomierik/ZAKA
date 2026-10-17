// Referral rebates in the fee ledger (the build pack's Phase 5: "referral attribution and rebates verified in the
// ledger").
//
// ARCDEX's Arc routers pay a trader's referrer their share of the fee in the trade itself: ArcDexSwapRouter v2 in USDC
// (the ERC-20), ArcDexCurveRouter in native USDC. Each payment emits ReferralPaid(referrer, trader, token, amount) beside
// the trade's Swapped(trader, …, feeToken, fee). The referrer is bound to the trader for good on their first referred
// trade (ReferrerBound; the router's referrerOf), and the share is the router's referralShareBps (1500 from the
// constructor, changed only by ReferralShareUpdated).
//
// Recording: every ReferralPaid becomes one ledger row (source 'arc-referral', status 'rebate'), with the trader, the
// whole fee and the share in force at that block. Read every minute from the routers' own events, from the first block a
// referral could exist.
//
// Reconciliation, once a day after 00:40 UTC, over the blocks recorded since the last run, from a scan of its own:
//   • rebates: the ledger's rows against the routers' ReferralPaid events, one to one, to the unit;
//   • paid: each rebate is a transfer from the router to that referrer, of that amount, in that transaction (USDC's own
//     Transfer log, or the native logger's for native USDC);
//   • rate: each rebate is the share in force of the trade's whole fee (exact for the swap router; within one unit for
//     the curve router, whose fee and share are each cut from 18 decimals to 6);
//   • attribution: each rebate's referrer is the one the router holds for that trader (referrerOf, read now: bindings
//     never change), so no one is paid for a trader they didn't refer;
//   • the fee wallet: where the ledger has the fee wallet's receipt for the same trade, it is the fee less the rebate.
// The result is kept with the others (arcdex_fee_reconciliations, source 'referral'); a mismatch is logged, counted and
// alerted like the rest.
//
// Off Arc there's nothing to split: Relay's, Across's and Jupiter's fees have no referral share (Jupiter's smallest
// referral fee is ARCDEX's whole 0.5%).

import { keccak256, toBytes } from 'viem'
import { ARC_USDC, fromRaw, toRaw, type FeeLedger, type FeeRow, type ReconRow } from './ledger'
import { log, errMsg } from '../log'

export interface RouterLog { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string; blockTimestamp?: string }
interface Settings { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }

/** The routers that pay referral shares (v1 had no referrals). */
export const REFERRAL_ROUTERS: Record<string, { kind: 'swap' | 'curve'; name: string }> = {
  '0xd07583f7db671521aacfda2b4612ad187aa2924e': { kind: 'swap', name: 'ArcDexSwapRouter v2' },
  '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441': { kind: 'curve', name: 'ArcDexCurveRouter' },
}
/** Both routers' constructors set referralShareBps to 1500. */
export const DEFAULT_SHARE_BPS = 1500
/** No referral can be older than ArcDexSwapRouter v1's first block. */
export const REFERRALS_FROM_BLOCK = 22_548_761

const topic = (sig: string) => keccak256(toBytes(sig))
export const T_SWAPPED = topic('Swapped(address,address,address,uint256,uint256,address,uint256)')
export const T_BOUND = topic('ReferrerBound(address,address)')
export const T_PAID = topic('ReferralPaid(address,address,address,uint256)')
export const T_SHARE = topic('ReferralShareUpdated(uint256,uint256)')
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
/** The selector of referrerOf(address). */
export const REFERRER_OF = keccak256(toBytes('referrerOf(address)')).slice(0, 10)

const addr = (t: string | undefined) => `0x${(t ?? '').slice(-40)}`.toLowerCase()
const word = (data: string, i: number) => { try { return BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'}`) } catch { return 0n } }
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

/** What the reader asks the chain for: the routers' events, and every transfer out of them (any token, the native
 * logger included) for the reconciliation. */
export const routerFilter = () => ({ address: Object.keys(REFERRAL_ROUTERS), topics: [[T_PAID, T_SWAPPED, T_BOUND, T_SHARE]] })
export const routerTransfersFilter = () => ({ topics: [T_TRANSFER, Object.keys(REFERRAL_ROUTERS).map(pad)] })

/** The share in force on a router at a point in the chain: [block, logIndex, bps], oldest first. */
export type ShareHistory = Record<string, [number, number, number][]>

export function shareAt(hist: ShareHistory, router: string, block: number, logIndex: number): number {
  let bps = DEFAULT_SHARE_BPS
  for (const [b, i, v] of hist[router] ?? []) if (b < block || (b === block && i < logIndex)) bps = v
  return bps
}

/** Adds the share changes in these logs to the history. */
export function learnShares(hist: ShareHistory, logs: RouterLog[]): ShareHistory {
  const out: ShareHistory = Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, [...v]]))
  for (const l of logs) {
    const router = l.address.toLowerCase()
    if (l.topics[0]?.toLowerCase() !== T_SHARE || !REFERRAL_ROUTERS[router]) continue
    const e: [number, number, number] = [Number(BigInt(l.blockNumber)), Number(BigInt(l.logIndex)), Number(word(l.data, 1))]
    const list = out[router] ?? (out[router] = [])
    if (!list.some(x => x[0] === e[0] && x[1] === e[1])) list.push(e)
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  }
  return out
}

export interface Rebate {
  router: string; tx: string; block: number; logIndex: number
  referrer: string; trader: string; token: string
  /** Raw, in the token's units as the event gives them (USDC: 6 decimals, on both routers). */
  amount: bigint
  /** The trade's whole fee (raw), from its Swapped event; null if the event wasn't found. */
  fee: bigint | null
  shareBps: number
}

/** The rebates in a batch of the routers' logs. */
export function decodeRebates(logs: RouterLog[], hist: ShareHistory): Rebate[] {
  const fees = new Map<string, bigint>()
  for (const l of logs) {
    if (l.topics[0]?.toLowerCase() !== T_SWAPPED || !REFERRAL_ROUTERS[l.address.toLowerCase()]) continue
    fees.set(`${l.transactionHash.toLowerCase()}:${l.address.toLowerCase()}:${addr(l.topics[1])}`, word(l.data, 3))
  }
  const out: Rebate[] = []
  for (const l of logs) {
    const router = l.address.toLowerCase()
    if (l.topics[0]?.toLowerCase() !== T_PAID || !REFERRAL_ROUTERS[router] || l.topics.length < 4) continue
    const tx = l.transactionHash.toLowerCase(), block = Number(BigInt(l.blockNumber)), logIndex = Number(BigInt(l.logIndex))
    const trader = addr(l.topics[2])
    out.push({
      router, tx, block, logIndex, referrer: addr(l.topics[1]), trader, token: addr(l.topics[3]), amount: word(l.data, 0),
      fee: fees.get(`${tx}:${router}:${trader}`) ?? null, shareBps: shareAt(hist, router, block, logIndex),
    })
  }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
}

/** Ledger rows for rebates. Both routers name USDC (6 decimals) as the token; another token keeps its raw amount and is
 * given its own decimals by `decimalsOf`. */
export function rebateRows(rebates: Rebate[], timeOf: (block: number) => number | null, decimalsOf: (token: string) => number = () => 18): FeeRow[] {
  return rebates.map(r => {
    const usdc = r.token === ARC_USDC
    const decimals = usdc ? 6 : decimalsOf(r.token)
    const amount = fromRaw(r.amount, decimals)
    return {
      id: `ref:${r.tx}:${r.logIndex}`, at: timeOf(r.block) ?? Date.now(), chain: 'arc', source: 'arc-referral', token: r.token, symbol: usdc ? 'USDC' : 'TOKEN',
      amount, amountUsd: usdc ? Number(amount) : null, recipient: r.referrer, tx: r.tx, block: r.block, status: 'rebate', trader: r.trader,
      meta: { router: r.router, fee: r.fee === null ? '' : r.fee.toString(), shareBps: r.shareBps, logIndex: r.logIndex, decimals },
    } satisfies FeeRow
  })
}

/** What each router sent each address in each transaction: `${tx}:${router}:${to}:${token}` → raw. USDC moved natively is
 * logged by the native logger in 18 decimals and counted in USDC's 6 (as the curve router's events give it); an ERC-20
 * USDC transfer is also logged there, so the larger of the two counts, never both. */
export function routerPayments(transfers: RouterLog[]): Map<string, bigint> {
  const erc = new Map<string, bigint>(), native = new Map<string, bigint>()
  const seen = new Set<string>()
  for (const l of transfers) {
    if (l.topics[0]?.toLowerCase() !== T_TRANSFER || l.topics.length < 3) continue
    const router = addr(l.topics[1])
    if (!REFERRAL_ROUTERS[router]) continue
    const tx = l.transactionHash.toLowerCase(), token = l.address.toLowerCase()
    const dupe = `${tx}:${token}:${l.logIndex}`
    if (seen.has(dupe)) continue
    seen.add(dupe)
    const isNative = token === NATIVE_LOGGER
    const key = `${tx}:${router}:${addr(l.topics[2])}:${isNative ? ARC_USDC : token}`
    const v = word(l.data, 0)
    if (isNative) native.set(key, (native.get(key) ?? 0n) + v / 1_000_000_000_000n)
    else erc.set(key, (erc.get(key) ?? 0n) + v)
  }
  const out = new Map(erc)
  for (const [k, v] of native) out.set(k, (out.get(k) ?? 0n) > v ? out.get(k)! : v)
  return out
}

/** The rebate a fee owes at a share: exact on the swap router; the curve router cuts both from 18 decimals, so one unit
 * either way is its rounding. */
export function rateOk(r: Pick<Rebate, 'router' | 'amount' | 'fee' | 'shareBps'>): boolean {
  if (r.fee === null) return false
  const want = (r.fee * BigInt(r.shareBps)) / 10_000n
  const slack = REFERRAL_ROUTERS[r.router]?.kind === 'curve' ? 1n : 0n
  const d = r.amount - want
  return (d < 0n ? -d : d) <= slack
}

export interface ReferralCheck {
  /** The ledger's rebate rows (all of them; the range is applied here). */
  rows: FeeRow[]
  /** The routers' events in the range, from a scan of its own. */
  events: RouterLog[]
  /** Every transfer out of the routers in the range. */
  transfers: RouterLog[]
  /** The referrer each router holds for each trader now: `${router}:${trader}` → referrer (or null). */
  bound: Map<string, string | null>
  /** The ledger's fee-wallet receipts by `${tx}:${router}` (raw, 6 decimals), for trades it has. */
  feeWallet: Map<string, bigint>
  /** The share history known before the range. */
  shares: ShareHistory
  from: number
  to: number
  at: number
}

/** Reconciles the rebates of a block range (see the header). */
export function reconcileReferrals(c: ReferralCheck): ReconRow {
  const inRange = c.rows.filter(r => r.source === 'arc-referral' && r.block !== null && r.block >= c.from && r.block <= c.to)
  const chain = decodeRebates(c.events, learnShares(c.shares, c.events))
  const paid = routerPayments(c.transfers)
  const byId = new Map(chain.map(r => [`ref:${r.tx}:${r.logIndex}`, r]))
  const ledgerIds = new Set(inRange.map(r => r.id))
  const missing = [...byId.keys()].filter(k => !ledgerIds.has(k))
  const extra = [...ledgerIds].filter(k => !byId.has(k))
  const wrongAmount: string[] = [], unpaid: string[] = [], wrongRate: string[] = [], wrongReferrer: string[] = [], feeWalletOff: string[] = []
  for (const r of inRange) {
    const e = byId.get(r.id)
    if (!e) continue
    const decimals = Number(r.meta?.decimals ?? 6)
    if (toRaw(r.amount, decimals) !== e.amount || r.token !== e.token || r.recipient !== e.referrer || (r.trader ?? '') !== e.trader) wrongAmount.push(r.id)
    const sent = paid.get(`${e.tx}:${e.router}:${e.referrer}:${e.token}`) ?? 0n
    if (sent !== e.amount) unpaid.push(r.id)
    if (!rateOk(e)) wrongRate.push(r.id)
    const holds = c.bound.get(`${e.router}:${e.trader}`)
    if (holds === undefined || holds?.toLowerCase() !== e.referrer) wrongReferrer.push(r.id)
    const fw = c.feeWallet.get(`${e.tx}:${e.router}`)
    if (fw !== undefined && e.fee !== null && e.token === ARC_USDC) {
      const d = fw - (e.fee - e.amount)
      if ((d < 0n ? -d : d) > (REFERRAL_ROUTERS[e.router]?.kind === 'curve' ? 1n : 0n)) feeWalletOff.push(r.id)
    }
  }
  const usdcLedger = inRange.filter(r => r.token === ARC_USDC).reduce((s, r) => s + toRaw(r.amount, 6), 0n)
  const usdcChain = chain.filter(r => r.token === ARC_USDC).reduce((s, r) => s + (paid.get(`${r.tx}:${r.router}:${r.referrer}:${r.token}`) ?? 0n), 0n)
  const problems = { missing, extra, wrongAmount, unpaid, wrongRate, wrongReferrer, feeWalletOff }
  return {
    at: c.at, source: 'referral', scope: `blocks ${c.from}-${c.to}`, ledger: fromRaw(usdcLedger, 6), onchain: fromRaw(usdcChain, 6), diff: fromRaw(usdcLedger - usdcChain, 6),
    ok: usdcLedger === usdcChain && Object.values(problems).every(p => p.length === 0),
    detail: {
      rebates: inRange.length, events: chain.length, referrers: new Set(chain.map(r => r.referrer)).size,
      bindings: c.events.filter(l => l.topics[0]?.toLowerCase() === T_BOUND).length,
      ...Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.slice(0, 20)])),
    },
  }
}

// ── The watcher ──────────────────────────────────────────────────────────

export interface ReferralWatchOptions {
  ledger: FeeLedger
  settings: Settings
  /** Logs for a filter over a block range: the contiguous prefix it finished, and how far that reached. */
  scan: (filter: { address?: string[]; topics: (string | string[] | null)[] }, from: number, to: number) => Promise<{ logs: RouterLog[]; scannedTo: number }>
  head: () => Promise<number>
  /** Block times (ms) for blocks whose logs carry none. */
  times: (blocks: number[]) => Promise<Map<number, number | null>>
  /** referrerOf(trader) on each router, read now. */
  referrerOf: (pairs: { router: string; trader: string }[]) => Promise<(string | null)[]>
  alert?: (text: string) => void
  /** The UTC minute of the day the nightly run starts after (default 00:40). */
  runAfterMinute?: number
  from?: number
}

interface WatchState { to: number; shares: ShareHistory; recon: { day: string | null; to: number } }
const KEY = 'fee-ledger-referrals'
/** Blocks left behind the head, so the reader and the reconciliation read settled blocks. */
const SETTLE = 50

export class ReferralWatcher {
  private st: WatchState | null = null
  private busy = false

  constructor(private o: ReferralWatchOptions) {}

  private async state(): Promise<WatchState> {
    if (this.st) return this.st
    const s = await this.o.settings.getSetting(KEY).catch(() => null)
    const start = (this.o.from ?? REFERRALS_FROM_BLOCK) - 1
    this.st = s ? JSON.parse(s) as WatchState : { to: start, shares: {}, recon: { day: null, to: start } }
    return this.st
  }

  private async save() { if (this.st) await this.o.settings.setSetting(KEY, JSON.stringify(this.st)).catch(() => {}) }

  /** How far the ledger's rebates are complete. */
  async scannedTo() { return (await this.state()).to }

  /** Reads the routers' new events into the ledger; then the nightly reconciliation when it's due. */
  async tick(now = Date.now()) {
    if (this.busy) return
    this.busy = true
    try {
      const st = await this.state()
      const head = (await this.o.head()) - SETTLE
      if (head > st.to) {
        const r = await this.o.scan(routerFilter(), st.to + 1, head)
        if (r.scannedTo > st.to) {
          const logs = r.logs.filter(l => Number(BigInt(l.blockNumber)) <= r.scannedTo)
          const rebates = decodeRebates(logs, learnShares(st.shares, logs))
          const blocks = [...new Set(rebates.map(x => x.block))]
          const stamped = new Map(logs.filter(l => l.blockTimestamp).map(l => [Number(BigInt(l.blockNumber)), Number(BigInt(l.blockTimestamp!)) * 1000]))
          const times = blocks.some(b => !stamped.has(b)) ? await this.o.times(blocks.filter(b => !stamped.has(b))) : new Map<number, number | null>()
          await this.o.ledger.record(rebateRows(rebates, b => stamped.get(b) ?? times.get(b) ?? null))
          st.shares = learnShares(st.shares, logs)
          st.to = r.scannedTo
          await this.save()
        }
      }
      const d = new Date(now)
      if (st.recon.day !== d.toISOString().slice(0, 10) && d.getUTCHours() * 60 + d.getUTCMinutes() >= (this.o.runAfterMinute ?? 40)) await this.reconcile(now)
    } catch (e) {
      log.warn('fee ledger: referrals not read', { error: errMsg(e) })
    } finally {
      this.busy = false
    }
  }

  /** Every log for a filter over the range, scanned in as many pieces as it takes; null if a piece makes no progress. */
  private async scanAll(filter: ReturnType<typeof routerFilter> | ReturnType<typeof routerTransfersFilter>, from: number, to: number): Promise<RouterLog[] | null> {
    const out: RouterLog[] = []
    for (let a = from; a <= to;) {
      const r = await this.o.scan(filter, a, to)
      if (r.scannedTo < a) return null
      out.push(...r.logs.filter(l => { const b = Number(BigInt(l.blockNumber)); return b >= a && b <= r.scannedTo }))
      a = r.scannedTo + 1
    }
    return out
  }

  /** Reconciles the blocks recorded since the last run (see the header); returns the result, or null with nothing new. */
  async reconcile(now = Date.now()): Promise<ReconRow | null> {
    const st = await this.state()
    const from = st.recon.to + 1, to = st.to
    if (to < from) { st.recon.day = new Date(now).toISOString().slice(0, 10); await this.save(); return null }
    const ev = await this.scanAll(routerFilter(), from, to)
    const tr = await this.scanAll(routerTransfersFilter(), from, to)
    if (!ev || !tr) { log.warn('fee ledger: referrals not reconciled (scan incomplete)', { from, to }); return null }
    const shares = Object.fromEntries(Object.entries(st.shares).map(([k, v]) => [k, v.filter(x => x[0] < from)])) as ShareHistory
    const rebates = decodeRebates(ev, learnShares(shares, ev))
    const pairs = [...new Map(rebates.map(r => [`${r.router}:${r.trader}`, { router: r.router, trader: r.trader }])).values()]
    const holds = pairs.length ? await this.o.referrerOf(pairs) : []
    const bound = new Map(pairs.map((p, i) => [`${p.router}:${p.trader}`, holds[i] ?? null]))
    const all = await this.o.ledger.store.allFees()
    const feeWallet = new Map<string, bigint>()
    for (const r of all) {
      if (r.chain !== 'arc' || r.status !== 'received' || !r.tx || r.block === null || r.block < from || r.block > to) continue
      const payer = r.id.split(':')[2]
      if (REFERRAL_ROUTERS[payer]) feeWallet.set(`${r.tx}:${payer}`, toRaw(r.amount, 6))
    }
    const res = reconcileReferrals({ rows: all.filter(r => r.source === 'arc-referral'), events: ev, transfers: tr, bound, feeWallet, shares, from, to, at: now })
    await this.o.ledger.reconciled(res)
    if (!res.ok) {
      this.o.alert?.(`ARCDEX fee ledger mismatch: referral rebates ${res.scope}: ledger ${res.ledger}, on-chain ${res.onchain} (${JSON.stringify(res.detail)})`)
    }
    st.recon = { day: new Date(now).toISOString().slice(0, 10), to }
    await this.save()
    log.info('fee ledger: referrals reconciled', { from, to, rebates: res.detail.rebates, ok: res.ok })
    return res
  }
}
