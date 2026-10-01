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

import { every, keepAliveOnUnhandled, startWithRetry } from './lifecycle'
import { randomBytes } from 'node:crypto'
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
import { FazeAdapter } from './launchpads/faze'
import { MercuriAdapter } from './launchpads/mercuri'
import { PeachAdapter } from './launchpads/peach'
import { SolonPadAdapter } from './launchpads/solonpad'
import { V4LaunchDetector } from './launchpads/v4Launches'
import { log, errMsg, setLogLevel } from './log'
import { MarketEngine, type Publisher } from './market/engine'
import { metrics } from './metrics'
import { NullHistoryStore, SupabaseHistoryStore, type HistoryStore } from './store/history'
import { PostgresHistoryStore } from './store/postgresHistory'
import { MemoryHotStore, RedisHotStore, type HotStore } from './store/hot'
import { Bot } from './bot/bot'
import { ControlVerifier } from './bot/control'
import { DEFAULT_LIMITS, LiveTrader } from './bot/liveTrader'
import { mailerFromEnv } from './bot/mailer'
import { PaperAccounts } from './bot/paperAccounts'
import { UserLive, WalletVault } from './bot/userLive'
import { Users } from './bot/users'
import { Tiers } from './bot/tiers'
import { MemoryBotStore, PostgresBotStore } from './bot/store'
import { LiveExecutor } from './trading/live'
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
let botsHealth: (() => { email: boolean; userLive: boolean; ownerWallet: boolean; mode: string | null; bots: number; running: number }) | null = null
let stream: ChainStream | null = null
let redisOk = hot.kind === 'memory'

const health = () => {
  const head = ws.lastHead?.number ?? (metrics.gauges.chain_head as number | undefined) ?? 0
  const lag = stream && head ? head - stream.handledTo : null
  const db = history.status()
  // Not started yet (still trying: see startWithRetry) counts as down, so a redeploy that can't reach the chain fails its health check and the running deployment stays.
  const notStarted = cfg.role !== 'gateway' && (!stream || stream.mode === 'starting')
  const chainDown = cfg.role !== 'gateway' && (notStarted || ((ws.status === 'down' || ws.status === 'stale') && (lag === null || lag > 100)))
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
    // What's switched on for visitors' bots (yes/no only; never a secret): email (RESEND_API_KEY), live (BOT_WALLET_SECRET), the owner's bot wallet (BOT_PRIVATE_KEY).
    bots: botsHealth?.() ?? null,
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
  const adapters = new AdapterRegistry([new ArgusAdapter(), new ArcLaunchpadAdapter(), new MercuriAdapter(), new SolonPadAdapter(), new PeachAdapter(), new FazeAdapter()])
  // Adapters see the transaction's sender too: a trade through a router names the router in its event.
  const adapterCtx = { rpc, pools, sender: (txHash: string) => makers.get(txHash) }

  let srv: ReturnType<typeof startServer> | null = null
  let dataApi: DataApi | null = null
  let publisher: Publisher
  if (cfg.role === 'all') {
    // Serve /health right away; the engine attaches once it exists.
    const api = new DataApi(null, hot, history)
    dataApi = api
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
  // Signals and trading (engine/src/bot): watches launches from the engine's own trades.
  // Live trading needs a bot wallet: BOT_PRIVATE_KEY, set by the owner (read here only, never logged).
  let botRef: Bot | null = null
  let live: LiveTrader | null = null
  const key = process.env.BOT_PRIVATE_KEY?.trim()
  if (cfg.botMode !== 'off' && key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) log.error('BOT_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key: live trading stays off')
    else {
      // The send endpoint stays out of the published limits and the logs (a private RPC URL can carry a token).
      const { sendUrl, ...limits } = cfg.live
      const exec = new LiveExecutor({ privateKey: key as `0x${string}`, readUrls: cfg.httpUrls, sendUrl })
      live = new LiveTrader({
        exec,
        limits: { ...DEFAULT_LIMITS, ...limits },
        positions: () => botRef?.positions ?? [],
        params: s => botRef!.params(s),
        save: p => botRef?.persist(p),
      })
      log.info('bot wallet ready', { wallet: exec.address, limits, owner: cfg.botOwner })
      void exec.ready().catch(e => log.error('live: Universal Router check failed', { error: errMsg(e) }))
    }
  }
  const botStore = cfg.databaseUrl ? new PostgresBotStore(cfg.databaseUrl) : new MemoryBotStore()
  // Visitors' bots live on: accounts (email + passcode, Resend for email), and
  // live trading from each bot's own wallet once BOT_WALLET_SECRET is set.
  // Secrets are read here only and never logged.
  const mailer = mailerFromEnv()
  let authSecret = process.env.AUTH_SECRET?.trim() || await botStore.getSetting('auth_secret').catch(() => null)
  if (!authSecret) { authSecret = randomBytes(32).toString('hex'); await botStore.setSetting('auth_secret', authSecret).catch(e => log.warn('auth secret not saved: sessions end at restart', { error: errMsg(e) })) }
  const users = cfg.botMode === 'off' ? null : new Users({ store: botStore, mailer, secret: authSecret })
  if (users) await users.load().catch(e => log.error('bot accounts: load failed', { error: errMsg(e) }))
  let vault: WalletVault | null = null
  const walletSecret = process.env.BOT_WALLET_SECRET?.trim()
  if (walletSecret) { try { vault = new WalletVault(walletSecret) } catch (e) { log.error('BOT_WALLET_SECRET is not usable: live trading for visitors\' bots stays off', { error: errMsg(e) }) } }
  const userLive = new UserLive({
    vault, why: walletSecret && !vault ? 'the engine\'s wallet secret is misconfigured' : null,
    makeExec: privateKey => new LiveExecutor({ privateKey, readUrls: cfg.httpUrls, sendUrl: cfg.live.sendUrl }),
    rpc,
    pools: token => { const mp = eng.tokens.get(token)?.mainPool; return mp ? pools.get(mp) ?? null : null },
  })
  log.info('visitors\' bots', { email: mailer.enabled, live: !!vault })
  botsHealth = () => ({ email: mailer.enabled, userLive: !!vault, ownerWallet: !!live, mode: botRef?.mode ?? null, bots: accounts?.count ?? 0, running: accounts?.running ?? 0 })
  // Tiers (bot/tiers.ts): what each account gets; everything, for everyone, until TIERS_ENFORCED.
  const tiers = new Tiers({ enforced: cfg.tiersEnforced, rpc, enforceAt: cfg.tiersEnforceAt })
  log.info('autotrade tiers', { enforced: tiers.enforced, enforceAt: tiers.enforceAt === null ? null : new Date(tiers.enforceAt).toISOString() })
  // Linked wallets' $ARCD, read at start and every 10 minutes (and again whenever an account's tier is asked with a stale balance).
  const readHoldings = () => { for (const w of users?.linkedWallets() ?? []) void tiers.read(w) }
  readHoldings()
  every(10 * 60_000, 'tier holdings', readHoldings)
  const accounts = cfg.botMode === 'off' ? null : new PaperAccounts({ store: botStore, priceOf: token => botRef?.priceOf(token) ?? eng.tokens.get(token)?.priceUsd ?? null, params: s => botRef!.params(s), live: userLive, paperSignals: cfg.botSignals.paper, access: ownerId => tiers.access(users?.get(ownerId) ?? null), liveRouting: cfg.liveGrades === 'board' ? 'board' : 'grades' })
  if (accounts) await accounts.load().catch(e => log.error('paper accounts: load failed', { error: errMsg(e) }))
  const bot = cfg.botMode === 'off' ? null : new Bot({
    rpc, engine: eng, pools, mode: cfg.botMode, sizeUsd: cfg.botSizeUsd ?? undefined, scalpSizeUsd: cfg.botScalpSizeUsd ?? undefined,
    store: botStore, accounts,
    publish: (topics, msg) => publisher.publish(topics, msg),
    live, owner: cfg.botOwner, history: history.enabled ? history : null, liveSignals: cfg.botSignals.live, liveGrades: cfg.liveGrades, launchpadOnly: cfg.launchpadOnly,
  })
  botRef = bot
  if (bot) {
    eng.observers.push(bot)
    await bot.start()
    dataApi?.attachBot(bot, new ControlVerifier(cfg.botOwner as `0x${string}` | null, cfg.httpUrls), accounts, users, tiers)
  }
  await eng.warmStart()
  // The scanner lists every launch of the last 48h at once, not only coins that trade after a restart.
  bot?.seed()
  const parser = new TradeParser(pools, oracle, makers, eng.launchpadOf)
  // Launches on launchpads without an adapter, found from their pool's Initialize.
  const v4Launches = new V4LaunchDetector(rpc, token => eng.metas.has(token))

  const isInitialize = (l: RawLog) => l.topics[0] === V4_INITIALIZE && l.address.toLowerCase() === POOL_MANAGER
  const parseOne = async (l: RawLog) => {
    try {
      if (isInitialize(l)) {
        // Registered in the pre-pass; a coin created in this block is a launch.
        const info = pools.get(l.topics[1])
        const launch = info ? await v4Launches.detect(l, info) : null
        if (!launch || !info) return null
        const q = oracle.usd(info.quote)
        return { launch, initialPriceUsd: info.initialPrice && q ? info.initialPrice * q : null }
      }
      const ad = adapters.find(l)
      if (ad) {
        const launch = await ad.parseLaunch(l, adapterCtx)
        if (launch) {
          const p = launch.pool ? pools.get(launch.pool) : undefined
          const q = launch.quote ? oracle.usd(launch.quote) : null
          // A pool's initial price; a launchpad curve states its own opening price.
          return { launch, initialPriceUsd: (p?.initialPrice && q ? p.initialPrice * q : null) ?? launch.priceUsd ?? null }
        }
        const trade = await ad.parseTrade?.(l, adapterCtx)
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
  // The chain stream starts in the background, retried until it does. A
  // failed start (an RPC answering with an error page while Railway
  // redeployed) used to end the process: "engine failed to start", restarted
  // into the same failure, then left down. The API, the bots' pages and their
  // time exits keep running meanwhile; /health says "down" until it starts.
  void startWithRetry('chain stream', () => stream!.start())

  every(1_000, 'market tick', () => eng.tick())
  // Time exits, visitors' bots and cleanup every 5s; every coin trading right now is evaluated every 3s.
  if (bot) every(5_000, 'bot tick', () => bot.tick())
  if (bot) every(3_000, 'bot sweep', () => { bot.sweep() })
  // Signals replayed at live speed on their coins' stored trades (signals/liveSpeed.ts): what live bots may trade.
  if (bot) every(30_000, 'bot replay', () => void bot.replayDue().catch(e => log.warn('bot: replay failed', { error: errMsg(e) })))
  // The live scanner on the site: what changed, every 2s.
  if (bot) every(2_000, 'scan push', () => bot.pushScan())
  every(10_000, 'redis ping', () => void hot.ping().then(() => { redisOk = true }, () => { redisOk = false; log.warn('redis ping failed') }))
  every(3_600_000, 'history cleanup', () => void history.cleanup(cfg.tradeRetentionHours))
  if (srv) every(10_000, 'subscription counts', () => hot.putSubscriptions(srv!.subscriptionCounts()))

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

keepAliveOnUnhandled()
main().catch(e => { log.error('engine failed to start', { error: errMsg(e) }); process.exit(1) })
