// The engine's view of the chain: every log matching the watched filters,
// exactly once, fast.
//
//   live       eth_subscribe logs → dispatched the moment they arrive
//   reconcile  every RECONCILE_MS, eth_getLogs over (cursor, head − 2]
//              catches anything the socket missed (counted as
//              missed_events_recovered); the cursor only moves once
//              everything up to it has been handed to the engine
//   catch-up   after a restart or a dropped connection the cursor is behind:
//              the gap is backfilled from getLogs in block order while new
//              live logs wait in a buffer, then the buffer is flushed and the
//              stream is live again
//
// Duplicates (the same log from live and reconcile, or a replay after a
// restart) are dropped by id = txHash:logIndex. Arc has single-slot
// finality, so logs are never reorganised; `removed` logs are ignored anyway.

import type { RawLog } from '../../../api/_arcLogs'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import type { Rpc } from './http'
import type { LogFilterWs, WsProvider } from './wsProvider'

export interface CursorStore {
  get(): Promise<number | null>
  set(block: number): Promise<void>
}

export interface DispatchCtx {
  /** Old data (backfill/replay): update state and history, don't broadcast each event. */
  replay: boolean
  source: 'live' | 'reconcile' | 'backfill'
}

export type FetchLogs = (f: LogFilterWs, from: number, to: number, head: number) => Promise<{ logs: RawLog[]; scannedTo: number }>

export interface StreamOptions {
  filters: LogFilterWs[]
  reconcileMs: number
  backfillOnStartBlocks: number
  backfillMaxBlocks: number
  /** Largest range fetched per reconcile round while catching up (small, so
   * each round lands and the cursor moves — ~10k swaps at Arc's pace). */
  catchUpChunk?: number
  /** Logs older than this are treated as replay (not broadcast one by one). */
  replayAgeMs?: number
}

export const logId = (l: RawLog) => `${l.transactionHash.toLowerCase()}:${parseInt(l.logIndex, 16)}`
const order = (a: RawLog, b: RawLog) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)

class Lru {
  private m = new Map<string, true>()
  constructor(private cap: number) {}
  has(k: string) { return this.m.has(k) }
  add(k: string) { this.m.set(k, true); if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string) }
}

export class ChainStream {
  cursor = -1
  mode: 'starting' | 'catching_up' | 'live' = 'starting'
  private seen = new Lru(400_000)
  private buffer: RawLog[] = []
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubs: (() => void)[] = []
  private stopped = false
  private reconciling = false
  private lastCursorSave = 0
  lastProcessedAt = 0

  constructor(
    private ws: WsProvider,
    private rpc: Rpc,
    private fetchLogs: FetchLogs,
    private cursors: CursorStore,
    private handler: (logs: RawLog[], ctx: DispatchCtx) => Promise<void>,
    private opts: StreamOptions,
  ) {}

  async start() {
    const head = await this.head()
    const saved = await this.cursors.get().catch(() => null)
    let cursor = saved ?? Math.max(0, head - this.opts.backfillOnStartBlocks)
    if (head - cursor > this.opts.backfillMaxBlocks) {
      log.warn('downtime longer than BACKFILL_MAX_BLOCKS — skipping the oldest part', { cursor, head, skipped: head - cursor - this.opts.backfillMaxBlocks })
      metrics.inc('backfill_skipped_blocks', head - cursor - this.opts.backfillMaxBlocks)
      cursor = head - this.opts.backfillMaxBlocks
    }
    this.cursor = cursor
    this.mode = head - cursor > 4 ? 'catching_up' : 'live'
    metrics.set('backfill_status', this.mode === 'catching_up' ? 'running' : 'idle')
    log.info('chain stream starting', { cursor, head, behind: head - cursor, resumed: saved !== null })

    for (const f of this.opts.filters) this.unsubs.push(this.ws.subscribeLogs(f, l => this.onLive(l)))
    this.unsubs.push(this.ws.subscribeHeads(() => { /* heads drive the watchdog; reconcile reads ws.lastHead */ }))
    this.ws.onReconnect = () => {
      // Whatever landed while the socket was down is fetched by reconcile;
      // hold new live logs back until then so they stay in order.
      if (this.mode === 'live') { this.mode = 'catching_up'; metrics.set('backfill_status', 'running'); log.info('reconnected — backfilling the gap') }
      this.kick()
    }
    this.ws.start()
    this.kick()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.unsubs.forEach(u => u())
    this.ws.stop()
  }

  /** Resolves once everything dispatched so far has been handled. */
  drain() { return this.queue }

  /** On shutdown: wait for the handler, then save the exact cursor. */
  async persist() {
    await this.queue
    if (this.cursor >= 0) await this.cursors.set(this.cursor)
  }

  private async head(): Promise<number> {
    const h = this.ws.lastHead
    if (h && Date.now() - this.ws.lastHeadAt < 5_000) return h.number
    return parseInt(await this.rpc.call<string>('eth_blockNumber', [], 5_000), 16)
  }

  private dispatch(logs: RawLog[], ctx: DispatchCtx) {
    const fresh: RawLog[] = []
    for (const l of logs) {
      if (l.removed) continue
      const id = logId(l)
      if (this.seen.has(id)) { metrics.inc('duplicate_events'); continue }
      this.seen.add(id)
      fresh.push(l)
    }
    if (!fresh.length) return
    metrics.inc('events', fresh.length)
    this.queue = this.queue.then(() => this.handler(fresh, ctx)).catch(e => {
      metrics.inc('handler_errors')
      log.error('event handler failed', { error: errMsg(e) })
    })
    this.lastProcessedAt = Date.now()
  }

  private onLive(l: RawLog) {
    metrics.inc('live_events')
    if (this.mode !== 'live') {
      // Keep order during catch-up; if the buffer grows too big, drop it —
      // reconcile fetches those blocks anyway.
      if (this.buffer.length < 100_000) this.buffer.push(l)
      return
    }
    this.dispatch([l], { replay: false, source: 'live' })
  }

  private kick(delay = 0) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.reconcile(), delay)
  }

  private async reconcile() {
    if (this.stopped || this.reconciling) return
    this.reconciling = true
    let behind = false
    try {
      const head = await this.head()
      metrics.set('chain_head', head)
      // Live mode leaves the newest 2 blocks to the socket (lowest latency);
      // anything it hasn't delivered by then is fetched here.
      const target = this.mode === 'live' ? head - 2 : head
      if (target > this.cursor) {
        const to = Math.min(target, this.cursor + (this.opts.catchUpChunk ?? 5_000))
        const from = this.cursor + 1
        const results = await Promise.all(this.opts.filters.map(f => this.fetchLogs(f, from, to, head)))
        const scannedTo = Math.min(...results.map(r => r.scannedTo))
        if (scannedTo >= from) {
          const logs = results.flatMap(r => r.logs).filter(l => parseInt(l.blockNumber, 16) <= scannedTo).sort(order)
          const replayAge = this.opts.replayAgeMs ?? 60_000
          const now = Date.now()
          const missed = this.mode === 'live' ? logs.filter(l => !this.seen.has(logId(l))).length : 0
          if (missed) { metrics.inc('missed_events_recovered', missed); log.info('recovered events the socket missed', { count: missed, from, to: scannedTo }) }
          // Old logs are replays; recent ones are broadcast like live ones.
          const old = logs.filter(l => l.blockTimestamp && now - parseInt(l.blockTimestamp, 16) * 1000 > replayAge)
          const recent = logs.filter(l => !(l.blockTimestamp && now - parseInt(l.blockTimestamp, 16) * 1000 > replayAge))
          if (old.length) this.dispatch(old, { replay: true, source: this.mode === 'live' ? 'reconcile' : 'backfill' })
          if (recent.length) this.dispatch(recent, { replay: false, source: this.mode === 'live' ? 'reconcile' : 'backfill' })
          this.cursor = scannedTo
          metrics.set('last_processed_block', scannedTo)
          metrics.set('lag_blocks', head - scannedTo)
          this.saveCursor(scannedTo)
        }
        behind = head - this.cursor > 4
      }
      if (this.mode === 'catching_up' && head - this.cursor <= 4) this.goLive()
      else if (this.mode === 'catching_up') metrics.set('backfill_remaining_blocks', head - this.cursor)
    } catch (e) {
      metrics.inc('reconcile_errors')
      log.warn('reconcile failed', { error: errMsg(e), cursor: this.cursor })
    } finally {
      this.reconciling = false
      // Catching up: go again at once. Live: the regular cadence.
      this.kick(behind ? 0 : this.opts.reconcileMs)
    }
  }

  private goLive() {
    const buffered = this.buffer.sort(order)
    this.buffer = []
    this.mode = 'live'
    metrics.set('backfill_status', 'idle')
    metrics.set('backfill_remaining_blocks', 0)
    log.info('chain stream live', { cursor: this.cursor, buffered: buffered.length })
    if (buffered.length) this.dispatch(buffered, { replay: false, source: 'live' })
  }

  private saveCursor(block: number) {
    if (Date.now() - this.lastCursorSave < 2_000) return
    this.lastCursorSave = Date.now()
    // Only after everything up to `block` has been handled.
    void this.queue.then(() => this.cursors.set(block)).catch(e => log.warn('cursor save failed', { error: errMsg(e) }))
  }
}
