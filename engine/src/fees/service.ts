// The fee ledger's writers and its nightly reconciliation (fees/ledger.ts).
//
// Writers: the $ARCDEX program hands over each batch of the fee wallet's logs (Arc fees) and each read of Relay's
// balance (Relay fees); the Jupiter watcher reads the referral token accounts every ten minutes.
//
// Reconciliation, once a day after 00:30 UTC:
//   • Arc: the blocks since the last run, scanned again independently (the archive-aware log scan, not the program's
//     scan) for USDC that ARCDEX's contracts paid the fee wallet in others' transactions, against the ledger's rows
//     for the same blocks: the totals must be equal to the unit, transaction by transaction;
//   • Relay: each currency's balance for the fee wallet against the ledger's opening + accrued − claimed;
//   • Jupiter: each referral token account's balance against its opening + received − claimed.
// Each result is kept for good (arcdex_fee_reconciliations, append-only). A mismatch is logged as an error, counted
// (fee_reconcile_mismatch) and, with ALERT_WEBHOOK_URL set, posted there.

import { arcFeeReceipts, arcFeeRows, numStr, reconcileArc, reconcileBalance, relayRows, type FeeLedger, type RelayBalanceLike, type ReconRow } from './ledger'
import type { JupiterFeeWatcher, JupAccount } from './jupiterWatch'
import { log, errMsg } from '../log'

interface Settings { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }
interface LogLike { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex?: string }

const RELAY_PREV = 'fee-ledger-relay'
const RECON = 'fee-ledger-recon'
/** How far behind the head the Arc reconciliation stops, so both scans read settled blocks. */
const SETTLE_BLOCKS = 50
/** Relay's balances are decimal numbers: compared to the nearest millionth. */
const RELAY_DECIMALS = 9
const RELAY_TOLERANCE = 1_000n

export interface FeeServiceOptions {
  ledger: FeeLedger
  settings: Settings
  wallet: string
  sources: string[]
  /** The fee wallet's USDC transfer logs in a block range, scanned independently of the program. */
  scanArc: (from: number, to: number) => Promise<LogLike[]>
  /** Which of these transactions the fee wallet sent itself (its own trades' fees aren't income). */
  ownTxs: (hashes: string[]) => Promise<Set<string>>
  /** The last block the program has scanned (the ledger's Arc rows are complete up to it); 0 before it has loaded. */
  arcScannedTo: () => number
  relayBalances: () => Promise<RelayBalanceLike[]>
  jupiter?: JupiterFeeWatcher | null
  alert?: (text: string) => void
  /** The UTC minute of the day the nightly run starts after (default 00:30). */
  runAfterMinute?: number
}

interface ReconState { day: string | null; arcTo: number }

export class FeeLedgerService {
  private sources: Set<string>
  private recon: ReconState | null = null
  private running = false

  constructor(private o: FeeServiceOptions) {
    this.sources = new Set(o.sources.map(s => s.toLowerCase()))
  }

  /** A batch of the fee wallet's logs, as the program read them (`ownTxs`: the transactions it sent itself). */
  async onArcLogs(logs: LogLike[], timeOf: (block: number) => number | null, ownTxs: Set<string>) {
    await this.o.ledger.record(arcFeeRows(logs, this.o.wallet, this.sources, timeOf, ownTxs))
  }

  /** A read of Relay's balance for the fee wallet. */
  async onRelayBalances(balances: RelayBalanceLike[], at: number) {
    const s = await this.o.settings.getSetting(RELAY_PREV).catch(() => null)
    const prev = s ? (JSON.parse(s) as Record<string, number>) : null
    const rows = relayRows(prev, balances, at, this.o.wallet)
    await this.o.ledger.record(rows)
    await this.o.settings.setSetting(RELAY_PREV, JSON.stringify(Object.fromEntries(balances.map(b => [b.key, b.amount])))).catch(() => {})
  }

  /** The reconciliation's progress; the first time, the ledger's Arc rows start after the block the program had
   * reached (blocks scanned before the ledger existed have no rows to compare). Null until the program has loaded. */
  private async state(): Promise<ReconState | null> {
    if (this.recon) return this.recon
    const s = await this.o.settings.getSetting(RECON).catch(() => null)
    if (s) { this.recon = JSON.parse(s) as ReconState; return this.recon }
    const at = this.o.arcScannedTo()
    if (!(at > 0)) return null
    this.recon = { day: null, arcTo: at }
    await this.o.settings.setSetting(RECON, JSON.stringify(this.recon)).catch(() => {})
    return this.recon
  }

  /** Call once the program has loaded, so the ledger's Arc start is fixed before its first rows. */
  async begin() { await this.state() }

  /** Runs the nightly reconciliation when it's due. */
  async tick(now = Date.now()) {
    const st = await this.state()
    if (!st) return
    const d = new Date(now)
    const day = d.toISOString().slice(0, 10)
    if (st.day === day || d.getUTCHours() * 60 + d.getUTCMinutes() < (this.o.runAfterMinute ?? 30)) return
    await this.reconcile(now)
  }

  /** Reconciles everything now; returns the results. */
  async reconcile(now = Date.now()): Promise<ReconRow[]> {
    if (this.running) return []
    this.running = true
    const out: ReconRow[] = []
    try {
      const st = await this.state()
      if (!st) return out
      const all = await this.o.ledger.store.allFees()
      // Arc: the blocks since the last run, up to what the program has settled.
      const from = st.arcTo + 1
      const to = this.o.arcScannedTo() - SETTLE_BLOCKS
      if (to >= from) {
        try {
          const logs = await this.o.scanArc(from, to)
          const receipts = arcFeeReceipts(logs, this.o.wallet, this.sources)
          const own = await this.o.ownTxs([...new Set([...receipts.values()].map(r => r.tx))])
          for (const [k, r] of receipts) if (own.has(r.tx) || r.raw <= 0n) receipts.delete(k)
          out.push(reconcileArc(all, receipts, from, to, now))
          st.arcTo = to
        } catch (e) { log.warn('fee ledger: Arc not reconciled', { error: errMsg(e) }) }
      }
      // Relay: each currency's balance.
      try {
        const balances = await this.o.relayBalances()
        const keys = new Set([...balances.map(b => b.key), ...all.filter(r => r.source === 'relay').map(r => r.token)])
        for (const key of keys) {
          const b = balances.find(x => x.key === key)
          out.push(reconcileBalance('relay', all, key, numStr(b?.amount ?? 0), RELAY_DECIMALS, now, RELAY_TOLERANCE))
        }
      } catch (e) { log.warn('fee ledger: Relay not reconciled', { error: errMsg(e) }) }
      // Jupiter: each referral token account's balance.
      if (this.o.jupiter) {
        try {
          const accounts: JupAccount[] = await this.o.jupiter.accounts()
          for (const a of accounts) {
            const rows = all.filter(r => r.source === 'jupiter' && r.recipient === a.account)
            out.push({ ...reconcileBalance('jupiter', rows, a.mint, a.amount, a.decimals, now), scope: `balance ${a.account}` })
          }
        } catch (e) { log.warn('fee ledger: Jupiter not reconciled', { error: errMsg(e) }) }
      }
      for (const r of out) {
        await this.o.ledger.reconciled(r)
        if (!r.ok) this.o.alert?.(`ARCDEX fee ledger mismatch: ${r.source} ${r.scope}: ledger ${r.ledger}, on-chain ${r.onchain} (diff ${r.diff})`)
      }
      st.day = new Date(now).toISOString().slice(0, 10)
      await this.o.settings.setSetting(RECON, JSON.stringify(st)).catch(() => {})
      log.info('fee ledger: reconciled', { results: out.length, ok: out.every(r => r.ok) })
    } finally {
      this.running = false
    }
    return out
  }
}

/** Posts an alert to ALERT_WEBHOOK_URL (Slack- and Discord-style JSON); never throws. */
export function webhookAlert(url: string | undefined): ((text: string) => void) | undefined {
  const u = url?.trim()
  if (!u || !/^https:\/\//.test(u)) return undefined
  return text => { void fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(8_000) }).catch(() => {}) }
}
