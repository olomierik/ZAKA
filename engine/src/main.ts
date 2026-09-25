// ARCDEX Real-Time Market Engine — entry point.
//
//   Arc chain ──WebSocket──▶ ChainStream ──▶ adapters / trade parser
//     (live + reconcile + backfill, deduped)        │  normalized trades,
//                                                   ▼  launches
//                               MarketEngine (hot state, candles)
//                               │            │              │
//                          Redis (hot)   Postgres (history)  WebSocket API ──▶ browsers
//
// Roles (ENGINE_ROLE): `all` (default) runs everything in one process;
// `ingest` + `gateway` split chain ingestion from client connections, with
// events fanned out over Redis pub/sub, for scaling out WebSocket servers.
//
//   bun engine/src/main.ts          (see engine/README.md)

import { RedisClient } from 'bun'
import { scanLogs, setLogEndpoints, type RawLog } from '../../api/_arcLogs'
import { POOL_MANAGER, V3_SWAP, V4_INITIALIZE, V4_SWAP } from '../../api/_arcSwaps'
import type { ServerMessage } from '../../api/_marketProtocol'
import { HttpRpc } from './chain/http'
import { ChainStream, type CursorStore, type FetchLogs } from './chain/stream'
import { WsProvider, type LogFilterWs } from './chain/wsProvider'
import { loadConfig, redacted } from './config'
import { PoolRegistry } from './dex/pools'
import { MakerResolver, QuoteOracle, TradeParser, isSwapLog, poolKeyOf } from './dex/trades'
import { AdapterRegistry } from './launchpads/adapter'
import { ArcLaunchpadAdapter } from './launchpads/arcLaunchpad'
import { ArgusAdapter } from './launchpads/argus'
import { log, errMsg, setLogLevel } from './log'
import { MarketEngine, type Publisher } from './market/engine'
import { metrics } from './metrics'
import { NullHistoryStore, SupabaseHistoryStore, type HistoryStore } from './store/history'
import { PostgresHistoryStore } from './store/postgresHistory'
import { MemoryHotStore, RedisHotStore, type HotStore } from './store/hot'
import { DataApi, startServer } from './ws/server'

const cfg = loadConfig()
setLogLevel(cfg.logLevel)
setLogEndpoints(cfg.logsRecentUrl, cfg.logsArchiveUrls)
log.info('engine starting', redacted(cfg))

const hot: HotStore = cfg.redisUrl
  ? new RedisHotStore(new RedisClient(cfg.redisUrl), () => new RedisClient(cfg.redisUrl!))
  : new MemoryHotStore()
if (hot.kind === 'memory') log.warn('REDIS_URL not set — hot state is in-process only (fine for dev; use Redis in production)')
const history: HistoryStore = !cfg.historyEnabled ? new NullHistoryStore()
  : cfg.databaseUrl ? new PostgresHistoryStore(cfg.databaseUrl)
  : new SupabaseHistoryStore()
if (!history.enabled) log.warn('history disabled — set DATABASE_URL (any Postgres, e.g. Railway) or SUPABASE_URL + SUPABASE_SECRET_KEY to store trades and candles')

const rpc = new HttpRpc(cfg.httpUrls)
const ws = new WsProvider(cfg.wsUrls, { staleHeadMs: cfg.staleHeadMs })

let engine: MarketEngine | null = null
let stream: ChainStream | null = null
let redisOk = hot.kind === 'memory'

const health = () => {
  const head = ws.lastHead?.number ?? (metrics.gauges.chain_head as number | undefined) ?? 0
  const lag = stream && head ? head - stream.handledTo : null
  const db = history.status()
  const chainDown = cfg.role !== 'gateway' && (ws.status === 'down' || ws.status === 'stale') && (lag === null || lag > 100)
  const degraded = (lag !== null && lag > 20) || !redisOk || (history.enabled && db.lastError !== null) || stream?.mode === 'catching_up'
  return {
    status: chainDown ? 'down' as const : degraded ? 'degraded' as const : 'ok' as const,
    role: cfg.role,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
    chain: cfg.role === 'gateway' ? null : {
      ws: ws.status, provider: ws.provider, lastBlock: ws.lastHead?.number ?? null,
      lastProcessedBlock: stream?.handledTo ?? null, lastFetchedBlock: stream?.cursor ?? null, queuedEvents: stream?.queued ?? 0,
      lagBlocks: lag, mode: stream?.mode ?? null,
      backfillRemainingBlocks: metrics.gauges.backfill_remaining_blocks ?? 0, http: rpc.status(),
    },
    rates: { eventsPerSec: metrics.rate('events'), tradesPerSec: metrics.rate('trades'), newTokens: metrics.counters.new_tokens ?? 0 },
    latencyMs: metrics.snapshot().latencyMs,
    redis: { kind: hot.kind, ok: redisOk, latencyMs: metrics.gauges.redis_latency_ms ?? null },
    db,
    ws: { clients: metrics.gauges.ws_clients ?? 0 },
    lastNewTokenAt: engine?.lastNewTokenAt || null,
  }
}

async function main() {
  // ── gateway: WebSocket/REST only, events relayed from Redis ──────────
  if (cfg.role === 'gateway') {
    const srv = startServer({ cfg, api: new DataApi(null, hot, history), health })
    await hot.onEvent(m => srv.relay(m))
    setInterval(() => void hot.ping().then(() => { redisOk = true }, () => { redisOk = false }), 10_000)
    shutdownOn(async () => { srv.stop() })
    return
  }

  // ── ingest (+ serve, in `all`) ───────────────────────────────────────
  // A v4 pool not created through the PositionManager is identified by its
  // Initialize log. Every Initialize of the last ~600k blocks (~3.5 days,
  // ~15k pools) is fetched once at start in one bulk scan (~30s): a lookup
  // then replaces a ~600k-block scan per pool, which took 8–16s each and,
  // cut off by its deadline, lost pools (and their trades). Pools created
  // after the scan arrive through the stream's own Initialize logs.
  const INIT_DEPTH = 600_000
  const recentInits = (async () => {
    const t0 = Date.now()
    const head = parseInt(await rpc.call<string>('eth_blockNumber', []), 16)
    const r = await scanLogs<RawLog[]>({ address: POOL_MANAGER, topics: [V4_INITIALIZE] }, Math.max(0, head - INIT_DEPTH), head, { head, reduce: l => l, deadline: Date.now() + 180_000 })
    const byPool = new Map<string, RawLog>()
    for (const l of r.parts.flat()) if (l.topics[1]) byPool.set(l.topics[1].toLowerCase(), l)
    const complete = r.scannedTo >= head
    log.info('indexed recent pool initializations', { pools: byPool.size, complete, ms: Date.now() - t0 })
    return { byPool, complete }
  })().catch(e => { log.warn('pool initialization index failed', { error: errMsg(e) }); return { byPool: new Map<string, RawLog>(), complete: false } })
  // Fallback when the bulk scan didn't finish: one pool at a time, at most 6 at once.
  let scans = 0
  const scanWaiting: (() => void)[] = []
  const scanForInitialize = async (poolId: string) => {
    if (scans < 6) scans++
    else await new Promise<void>(r => scanWaiting.push(r)) // the finishing scan hands over its slot
    const t0 = Date.now()
    try {
      const head = parseInt(await rpc.call<string>('eth_blockNumber', []), 16)
      const r = await scanLogs<RawLog[]>({ address: POOL_MANAGER, topics: [V4_INITIALIZE, poolId] }, Math.max(0, head - INIT_DEPTH), head, { head, reduce: l => l, deadline: Date.now() + 15_000 })
      return r.parts.flat()[0] ?? null
    } finally {
      metrics.latency('pool_initialize_scan', Date.now() - t0)
      const next = scanWaiting.shift()
      if (next) next(); else scans--
    }
  }
  const findInitialize = async (poolId: string) => {
    const idx = await recentInits
    return idx.byPool.get(poolId) ?? (idx.complete ? null : scanForInitialize(poolId))
  }
  const pools = new PoolRegistry(rpc, { onNewPool: p => { hot.putPool(p); history.pool(p) }, findInitialize })
  pools.seed(await hot.getPools().catch(() => []))
  const oracle = new QuoteOracle()
  await oracle.seed(rpc)
  const makers = new MakerResolver(rpc)
  const adapters = new AdapterRegistry([new ArgusAdapter(), new ArcLaunchpadAdapter()])

  let srv: ReturnType<typeof startServer> | null = null
  let publisher: Publisher
  if (cfg.role === 'all') {
    // Serve /health right away; the engine attaches once it exists.
    const api = new DataApi(null, hot, history)
    srv = startServer({ cfg, api, health })
    publisher = srv.publisher
    // Also fan out over Redis if other gateway processes are running.
    if (cfg.redisPubSub) {
      const local = publisher
      // Gateways may have subscribers this process can't see: always publish.
      publisher = { wants: () => true, publish: (topics, msg) => { local.publish(topics, msg); hot.publish(JSON.stringify({ topics, msg })) } }
    }
    engine = new MarketEngine(publisher, hot, history, rpc)
    api.attachEngine(engine)
  } else {
    publisher = { wants: () => true, publish: (topics: string[], msg: ServerMessage) => hot.publish(JSON.stringify({ topics, msg })) }
    engine = new MarketEngine(publisher, hot, history, rpc)
  }
  const eng = engine
  await eng.warmStart()
  const parser = new TradeParser(pools, oracle, makers, eng.launchpadOf)

  const isInitialize = (l: RawLog) => l.topics[0] === V4_INITIALIZE && l.address.toLowerCase() === POOL_MANAGER
  const parseOne = async (l: RawLog) => {
    try {
      if (isInitialize(l)) return null // registered in the pre-pass
      const ad = adapters.find(l)
      if (ad) {
        const launch = await ad.parseLaunch(l, { rpc, pools })
        if (launch) {
          const p = launch.pool ? pools.get(launch.pool) : undefined
          const q = launch.quote ? oracle.usd(launch.quote) : null
          return { launch, initialPriceUsd: p?.initialPrice && q ? p.initialPrice * q : null }
        }
        const trade = await ad.parseTrade?.(l, { rpc, pools })
        return trade ? { trade } : null
      }
      if (isSwapLog(l)) { const trade = await parser.parse(l); return trade ? { trade } : null }
    } catch (e) {
      metrics.inc('parse_errors')
      log.warn('could not parse log', { tx: l.transactionHash, error: errMsg(e) })
    }
    return null
  }
  // Up to 2,000 logs parse at once (sender lookups batch and overlap, and one
  // slow pool lookup doesn't stall the rest); results apply strictly in chain order.
  const PARSE_WINDOW = 2_000
  const handler = async (logs: RawLog[], ctx: { replay: boolean }) => {
    const receivedAt = Date.now()
    // Pools created in this batch first, so their swaps find them registered
    // instead of each scanning the chain for the Initialize.
    await Promise.all(logs.filter(isInitialize).map(l => pools.fromInitialize(l).catch(e => {
      metrics.inc('parse_errors')
      log.warn('could not register pool', { tx: l.transactionHash, error: errMsg(e) })
    })))
    // Then start resolving every other pool the batch trades in, so the slow
    // ones (older pools that need an Initialize scan) run side by side rather
    // than one at a time as the parser reaches them. resolve() dedupes; the
    // cap bounds the RPC burst on a cold start (the rest resolve as reached).
    const unknown = new Set<string>()
    for (const l of logs) {
      const k = isSwapLog(l) ? poolKeyOf(l) : null
      if (k && !pools.get(k)) unknown.add(k)
      if (unknown.size >= 300) break
    }
    for (const k of unknown) void pools.resolve(k)
    const parsed: ReturnType<typeof parseOne>[] = []
    for (let i = 0; i < Math.min(PARSE_WINDOW, logs.length); i++) parsed[i] = parseOne(logs[i])
    for (let i = 0; i < logs.length; i++) {
      const p = await parsed[i]
      if (i + PARSE_WINDOW < logs.length) parsed[i + PARSE_WINDOW] = parseOne(logs[i + PARSE_WINDOW])
      if (!p) continue
      if ('launch' in p && p.launch) eng.onLaunch(p.launch, { replay: ctx.replay, initialPriceUsd: p.initialPriceUsd })
      else if ('trade' in p && p.trade) eng.onTrade(p.trade, { replay: ctx.replay, receivedAt })
    }
  }

  const filters: LogFilterWs[] = [
    { address: POOL_MANAGER, topics: [[V4_SWAP, V4_INITIALIZE]] },
    { topics: [V3_SWAP] },
    ...adapters.filters(),
  ]
  const fetchLogs: FetchLogs = async (f, from, to, head) => {
    const r = await scanLogs<RawLog[]>({ address: f.address, topics: f.topics ?? [] }, from, to, { head, reduce: l => l, deadline: Date.now() + 20_000, concurrency: 4 })
    return { logs: r.parts.flat(), scannedTo: r.scannedTo }
  }
  const cursors: CursorStore = {
    async get() {
      const [a, b] = await Promise.all([hot.getCursor().catch(() => null), history.getCursor().catch(() => null)])
      return a === null && b === null ? null : Math.max(a ?? 0, b ?? 0)
    },
    async set(block) { await Promise.all([hot.setCursor(block), history.setCursor(block).catch(() => {})]) },
  }
  stream = new ChainStream(ws, rpc, fetchLogs, cursors, handler, {
    filters, reconcileMs: cfg.reconcileMs, backfillOnStartBlocks: cfg.backfillOnStartBlocks, backfillMaxBlocks: cfg.backfillMaxBlocks,
  })
  await stream.start()

  setInterval(() => eng.tick(), 1_000)
  setInterval(() => void hot.ping().then(() => { redisOk = true }, () => { redisOk = false; log.warn('redis ping failed') }), 10_000)
  setInterval(() => void history.cleanup(cfg.tradeRetentionHours), 3_600_000)
  if (srv) setInterval(() => hot.putSubscriptions(srv!.subscriptionCounts()), 10_000)

  const s = stream
  shutdownOn(async () => {
    s.stop()
    await s.persist().catch(() => {})
    eng.tick()
    await Promise.all([hot.flush(), history.flush()])
    history.close()
    hot.close()
    srv?.stop()
  })
}

function shutdownOn(fn: () => Promise<void>) {
  let done = false
  const go = async (sig: string) => {
    if (done) return
    done = true
    log.info('shutting down', { signal: sig })
    try { await Promise.race([fn(), new Promise(r => setTimeout(r, 10_000))]) } catch (e) { log.error('shutdown error', { error: errMsg(e) }) }
    process.exit(0)
  }
  process.on('SIGTERM', () => void go('SIGTERM'))
  process.on('SIGINT', () => void go('SIGINT'))
}

main().catch(e => { log.error('engine failed to start', { error: errMsg(e) }); process.exit(1) })
