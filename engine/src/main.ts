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

import { Traffic } from './traffic'
import { Votes } from './votes'
import { PredictPractice } from './practice/predict'
import { DOLLAR_PLAN } from './bot/dollarPlan'
import { every, keepAliveOnUnhandled, startWithRetry } from './lifecycle'
import { randomBytes } from 'node:crypto'
import { RedisClient } from 'bun'
import { scanLogs, setLogEndpoints, type LogFilter, type RawLog } from '../../api/_arcLogs'
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
import { toFunctionSelector, type Address } from 'viem'
import { DEFAULT_LIMITS, LiveTrader } from './bot/liveTrader'
import { mailerFromEnv } from './bot/mailer'
import { PaperAccounts } from './bot/paperAccounts'
import { UserLive, WalletVault } from './bot/userLive'
import { Users } from './bot/users'
import { Tiers } from './bot/tiers'
import { MemoryBotStore, PostgresBotStore } from './bot/store'
import { PerpsService } from './perps/service'
import { CoinProgram, FEE_SOURCES, FEE_WALLET, fetchRelayBalances } from './coin/program'
import { FeeLedger } from './fees/ledger'
import { FeeLedgerService, webhookAlert } from './fees/service'
import { REFERRER_OF, ReferralWatcher } from './fees/referrals'
import { PushAlerts } from './alerts/service'
import { generateVapidKeys, vapidValid, type VapidKeys } from './alerts/webpush'
import { JupiterFeeWatcher, type SolCall } from './fees/jupiterWatch'
import { AdminAuth } from './admin/auth'
import { adminEmails, DEFAULT_PRIVY_APP_ID, PrivyIdentityCheck } from './admin/privyIdentity'
import { FeatureFlags } from './admin/flags'
import { Sweeper, cronMinuteOfDay } from './admin/sweeper'
import { AdminApi, type AdminTrades } from './admin/api'
import { adminReady, db, sessionRevoked } from '../../api/_supabaseAdmin'
import { TradeBook, type IndexRow } from './social/book'
import { SocialBoards } from './social/boards'
import { Moderation } from './social/moderation'
import { SocialApi } from './social/api'
import { CopyEngine } from './copy/engine'
import { CopyApi } from './copy/api'
import { leaderVerdict, screen as copyScreen } from './copy/rules'
import { decodeTrades, T_SWAPPED, type RouterLog } from './social/pnl'
import { emptyLedger, FUNDER, knownFunders, scanFunding } from './bot/funders'
import { FEE_RECIPIENT } from './feeWallet'
import { SOCIAL_ROUTERS } from '../../api/_socialProtocol'
import { setSocialGuard } from '../../api/social'
import type { VerifyAdmin } from './site/tradeSwitch'
import { SOL_RPC_SERVER } from '../../api/_solCore'
import { BondingBook } from './market/bonding'
import { PostgresCandleStore } from './perps/store'
import { MemoryCandleStore } from './perps/candles'
import { LiveExecutor } from './trading/live'
import { DataApi, startServer } from './ws/server'
import { TradeSwitch } from './site/tradeSwitch'
import { startSignalEngine, type QuantBoot } from './quant/boot'
import { AlgoAgent } from './algo/agent'
import { Brain } from './algo/brain'
import { createSiteApi } from './site/siteApi'
import { EstablishedBook } from './market/established'
import { setArcExtra } from '../../api/_argusCore'
import { TrenchService } from './trench/service'
import { Analytics, ANALYTICS, ANALYTICS_RPCS, type ChainTrade } from './analytics'
import { jsonRpc as chainJsonRpc } from './trench/bsc'

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
let quant: QuantBoot | null = null
let algo: AlgoAgent | null = null
let trench: TrenchService | null = null
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
    // The signal engine (engine/src/quant): on, warm, the regime, signals kept, open paper positions.
    quant: quant?.health() ?? null,
    // ARCDEX Algo (engine/src/algo): mode, running, open positions, kill switch, brain.
    algo: algo?.health() ?? null,
    // The Trenches' live feed (trench/service.ts): each chain live or not, trades a minute, launches kept, smart wallets.
    trench: trench?.health() ?? null,
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
  // The bot wallet's executor, shared with the signal engine's live orders (one nonce sequence for the wallet).
  let exec: LiveExecutor | null = null
  const key = process.env.BOT_PRIVATE_KEY?.trim()
  if (cfg.botMode !== 'off' && key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) log.error('BOT_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key: live trading stays off')
    else {
      // The send endpoint stays out of the published limits and the logs (a private RPC URL can carry a token).
      const { sendUrl, ...limits } = cfg.live
      exec = new LiveExecutor({ privateKey: key as `0x${string}`, readUrls: cfg.httpUrls, sendUrl })
      live = new LiveTrader({
        exec,
        // On the dollar plan the day's loss counts from the plan's start (bot/dollarPlan.ts).
        limits: { ...DEFAULT_LIMITS, ...limits, ...(cfg.liveGrades === 'dollar' ? { lossSince: DOLLAR_PLAN.since } : {}) },
        positions: () => botRef?.positions ?? [],
        params: s => botRef!.params(s),
        save: p => botRef?.persist(p),
      })
      log.info('bot wallet ready', { wallet: exec.address, limits, owner: cfg.botOwner })
      void exec.ready().catch(e => log.error('live: Universal Router check failed', { error: errMsg(e) }))
    }
  }
  const botStore = cfg.databaseUrl ? new PostgresBotStore(cfg.databaseUrl) : new MemoryBotStore()
  // The site's traffic counter (traffic.ts): online now, visitors today and ever, kept with the bots' data.
  if (dataApi) dataApi.traffic = new Traffic(botStore)
  // Community sentiment on each coin (votes.ts), kept beside it.
  if (dataApi) dataApi.votes = new Votes(botStore)
  // Practice predictions (practice/predict.ts): papertrade.xyz's one-tap trading on Hyperliquid's prediction markets,
  // with virtual USDC, filled at the mids read here and settled by Hyperliquid's own settledOutcome.
  if (dataApi && !/^(0|off|false|no)$/i.test(process.env.PRACTICE?.trim() ?? '')) {
    const practice = new PredictPractice({
      store: botStore,
      info: async body => {
        const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6_000) })
        if (!r.ok) throw new Error(`hyperliquid ${String(body.type)} ${r.status}`)
        return r.json()
      },
    })
    await practice.load().catch(e => log.error('practice predictions: load failed', { error: errMsg(e) }))
    dataApi.practice = practice
    every(30_000, 'practice settlement', () => { void practice.settleTick().catch(e => log.warn('practice: settlement failed', { error: errMsg(e) })) })
  }
  // Price and activity alerts by web push (alerts/service.ts): Arc coins on every trade, Hyperliquid every 2 seconds;
  // followed wallets from the wallet tracker (the Trenches' service, below).
  let pushAlerts: PushAlerts | null = null
  if (dataApi && !/^(0|off|false|no)$/i.test(process.env.PUSH?.trim() ?? '')) {
    let keys: VapidKeys | null = null
    const envKeys = { publicKey: process.env.VAPID_PUBLIC_KEY?.trim() ?? '', privateKey: process.env.VAPID_PRIVATE_KEY?.trim() ?? '' }
    if (envKeys.publicKey && await vapidValid(envKeys)) keys = envKeys
    else {
      if (envKeys.publicKey) log.warn('push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY aren’t a matching pair; using the stored keys')
      const stored = await botStore.getSetting('push-vapid').catch(() => null)
      const k = stored ? JSON.parse(stored) as VapidKeys : null
      if (k && await vapidValid(k)) keys = k
      else { keys = await generateVapidKeys(); await botStore.setSetting('push-vapid', JSON.stringify(keys)).catch(e => log.error('push: keys not saved', { error: errMsg(e) })) }
    }
    const push = new PushAlerts({
      store: botStore, keys, subject: process.env.VAPID_SUBJECT?.trim() || 'https://arcsense.site',
      hlMids: async dex => {
        const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }), signal: AbortSignal.timeout(4_000) })
        if (!r.ok) throw new Error(`hyperliquid allMids ${r.status}`)
        const j = await r.json() as Record<string, string>
        return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, Number(v)]))
      },
    })
    await push.load()
    dataApi.push = push
    pushAlerts = push
    eng.observers.push({ onTrade: (t, ctx) => { if (!ctx.replay) push.onTrade(t) } })
    every(2_000, 'push alerts', () => { void push.tickHl().catch(e => log.warn('push: hyperliquid check failed', { error: errMsg(e) })) })
  }
  // The trade switch (site/tradeSwitch.ts): trading off everywhere or on one venue, by an admin wallet's signature or
  // GLOBAL_KILL_SWITCH / KILL_SWITCH_VENUES; every change in the append-only audit log.
  // One verifier for every admin signature (the switch, flags, the sweeper), so a signature is used once across all of them.
  const adminCheck = new ControlVerifier(null, cfg.httpUrls)
  // Admins signed in by email (admin/privyIdentity.ts) sign with their Privy wallet, which isn't in cfg.admins.
  let emailAdminWallets: () => string[] = () => []
  const verifyAdmin: VerifyAdmin = (m, at, sig, now) => adminCheck.verifyAnyOf([...cfg.admins, ...emailAdminWallets()], m, at, sig, now)
  if (dataApi) {
    const tradeSwitch = new TradeSwitch({ settings: botStore, audit: botStore, env: cfg.killSwitch, verify: verifyAdmin })
    await tradeSwitch.load()
    dataApi.tradeSwitch = tradeSwitch
    log.info('trade switch', { admins: cfg.admins.length, on: tradeSwitch.state().on, envAll: cfg.killSwitch.all, envVenues: cfg.killSwitch.venues })
  }
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
  // ARCSENSE futures (perps/service.ts): RedStone's signed prices, the chart, and on Arc testnet
  // the contracts' deployment and keeper. PERPS=off stops it.
  let perpsRef: PerpsService | null = null
  if (dataApi && !/^(0|off|false|no)$/i.test(process.env.PERPS?.trim() ?? '')) {
    const perps = new PerpsService({ settings: botStore, candleStore: cfg.databaseUrl ? new PostgresCandleStore(cfg.databaseUrl) : new MemoryCandleStore(), vault })
    dataApi.perps = perps
    perpsRef = perps
    void perps.start().catch(e => log.error('perps: did not start', { error: errMsg(e) }))
  }
  // $ARCDEX buyback, burns and liquidity (coin/program.ts): the fee wallet's activity, 30% / 70% of
  // fees, and every burn. The SENSE_* names still work (the program bought $SENSE until 2026-10-04).
  const env = (name: string) => process.env[`COIN_${name}`] ?? process.env[`SENSE_${name}`]
  let feeRefs: { ledger: FeeLedger; jupiter: JupiterFeeWatcher | null } | null = null
  if (dataApi && !/^(0|off|false|no)$/i.test(env('PROGRAM')?.trim() ?? '')) {
    const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{40}$/.test(s))
    // The fee ledger (fees/ledger.ts): every fee from on-chain evidence, append-only, reconciled every night.
    const feeLedger = new FeeLedger(botStore, () => metrics.inc('fee_reconcile_mismatch'))
    const jupRef = (process.env.JUP_REFERRAL_ACCOUNT ?? process.env.VITE_JUP_REFERRAL_ACCOUNT ?? '').trim()
    const solCall: SolCall = async <T>(method: string, params: unknown[]) => {
      let last: unknown = new Error('no Solana RPC')
      for (const url of SOL_RPC_SERVER) {
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) })
          const j = await r.json() as { result?: T; error?: { message?: string } }
          if (j.error) throw new Error(j.error.message ?? 'rpc error')
          return j.result as T
        } catch (e) { last = e }
      }
      throw last
    }
    const jupiterFees = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(jupRef) ? new JupiterFeeWatcher({ referral: jupRef, call: solCall, ledger: feeLedger, settings: botStore }) : null
    let programRef: CoinProgram | null = null
    const feeSources = [...FEE_SOURCES, ...list(env('FEE_SOURCES'))]
    const fees = new FeeLedgerService({
      ledger: feeLedger, settings: botStore, wallet: FEE_WALLET, sources: feeSources,
      scanArc: async (from, to) => {
        const filter: LogFilter = { address: ['0x3600000000000000000000000000000000000000', '0xfffffffffffffffffffffffffffffffffffffffe'], topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, `0x${FEE_WALLET.slice(2).padStart(64, '0')}`] }
        const r = await scanLogs(filter, from, to, { head: to, reduce: (logs: RawLog[]) => logs, deadline: Date.now() + 5 * 60_000 })
        if (r.scannedTo < to) throw new Error(`scanned to ${r.scannedTo} of ${to}`)
        return r.parts.flat()
      },
      ownTxs: async hashes => {
        if (!hashes.length) return new Set()
        const txs = await rpc.batch<{ from: string } | null>(hashes.map(h => ({ method: 'eth_getTransactionByHash', params: [h] })))
        return new Set(hashes.filter((_, i) => txs[i]?.from?.toLowerCase() === FEE_WALLET))
      },
      arcScannedTo: () => programRef?.scannedTo ?? 0,
      relayBalances: () => fetchRelayBalances(FEE_WALLET),
      jupiter: jupiterFees,
      alert: webhookAlert(process.env.ALERT_WEBHOOK_URL),
    })
    const program = new CoinProgram({
      rpc, settings: botStore, priceOf: t => eng.tokens.get(t)?.priceUsd ?? null,
      // More contracts whose payments are fees (the futures contract on mainnet), and where liquidity goes.
      feeSources: list(env('FEE_SOURCES')),
      liquidityTargets: list(env('LIQUIDITY_TARGETS')),
      onFeeLogs: (logs, timeOf, own) => fees.onArcLogs(logs, timeOf, own),
      onRelayBalances: (balances, at) => fees.onRelayBalances(balances, at),
    })
    programRef = program
    dataApi.coin = program
    dataApi.fees = { ledger: feeLedger, service: fees }
    feeRefs = { ledger: feeLedger, jupiter: jupiterFees }
    void program.start().then(() => fees.begin()).catch(e => log.error('coin program: did not start', { error: errMsg(e) }))
    every(10 * 60_000, 'fee ledger', () => { void jupiterFees?.tick(); void fees.tick().catch(e => log.warn('fee ledger: reconciliation failed', { error: errMsg(e) })) })
    // Referral rebates (fees/referrals.ts): the routers' ReferralPaid events into the ledger every minute, reconciled nightly.
    const referrals = new ReferralWatcher({
      ledger: feeLedger, settings: botStore,
      scan: async (filter, from, to) => {
        const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])))
        const r = await scanLogs(filter as LogFilter, from, to, { head, reduce: (logs: RawLog[]) => logs, deadline: Date.now() + 60_000 })
        return { logs: r.parts.flat(), scannedTo: r.scannedTo }
      },
      head: async () => Number(BigInt(await rpc.call<string>('eth_blockNumber', []))),
      times: async blocks => {
        const got = await rpc.batch<{ timestamp: string } | null>(blocks.map(b => ({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] })))
        return new Map(blocks.map((b, i) => [b, got[i] ? Number(BigInt(got[i]!.timestamp)) * 1000 : null]))
      },
      referrerOf: async pairs => {
        const got = await rpc.batch<string>(pairs.map(p => ({ method: 'eth_call', params: [{ to: p.router, data: `${REFERRER_OF}${p.trader.slice(2).padStart(64, '0')}` }, 'latest'] })))
        return got.map(h => (h && h.length >= 42 ? `0x${h.slice(-40)}`.toLowerCase() : null)).map(a => (a && !/^0x0{40}$/.test(a) ? a : null))
      },
      alert: webhookAlert(process.env.ALERT_WEBHOOK_URL),
    })
    dataApi.fees.referrals = referrals
    every(60_000, 'referral rebates', () => { void referrals.tick() })
  }
  // Every Argus coin on its launch curve and how close it is to graduating (market/bonding.ts), for the Near bond column.
  if (dataApi) { const book = new BondingBook({ rpc, engine: eng }); dataApi.bonding = book; book.start() }
  botsHealth = () => ({ email: mailer.enabled, userLive: !!vault, ownerWallet: !!live, mode: botRef?.mode ?? null, bots: accounts?.count ?? 0, running: accounts?.running ?? 0 })
  // Tiers (bot/tiers.ts): what each account gets; everything, for everyone, until TIERS_ENFORCED.
  const tiers = new Tiers({ enforced: cfg.tiersEnforced, rpc, enforceAt: cfg.tiersEnforceAt })
  if (cfg.autotradePaused) log.info('autotrade paused: bots open no new trades (AUTOTRADE_PAUSED=off resumes it)')
  log.info('autotrade tiers', { enforced: tiers.enforced, enforceAt: tiers.enforceAt === null ? null : new Date(tiers.enforceAt).toISOString() })
  // Linked wallets' $ARCD, read at start and every 10 minutes (and again whenever an account's tier is asked with a stale balance).
  const readHoldings = () => { for (const w of users?.linkedWallets() ?? []) void tiers.read(w) }
  readHoldings()
  every(10 * 60_000, 'tier holdings', readHoldings)
  const accounts = cfg.botMode === 'off' ? null : new PaperAccounts({ store: botStore, priceOf: token => botRef?.priceOf(token) ?? eng.tokens.get(token)?.priceUsd ?? null, params: s => botRef!.params(s), live: userLive, paperSignals: cfg.botSignals.paper, access: ownerId => tiers.access(users?.get(ownerId) ?? null), liveRouting: cfg.liveGrades === 'board' ? 'board' : cfg.liveGrades === 'dollar' ? 'dollar' : 'grades', paused: cfg.autotradePaused })
  if (accounts) await accounts.load().catch(e => log.error('paper accounts: load failed', { error: errMsg(e) }))
  // The social layer (social/*): verified PnL from the routers' own trades, the wash-trade filter, comments, reports
  // and mutes. SOCIAL=off stops it.
  let moderation: Moderation | null = null
  let socialBoards: SocialBoards | null = null
  let siteFlags: FeatureFlags | null = null
  let copyRef: CopyEngine | null = null
  let socialBookRef: TradeBook | null = null
  if (dataApi && !/^(0|off|false|no)$/i.test(process.env.SOCIAL?.trim() ?? '')) {
    const headNow = async () => Number(BigInt(await rpc.call<string>('eth_blockNumber', [])))
    const book = new TradeBook({
      store: botStore, settings: botStore,
      scan: async (filter, from, to) => {
        const r = await scanLogs(filter as LogFilter, from, to, { head: await headNow(), reduce: (logs: RawLog[]) => logs, deadline: Date.now() + 60_000 })
        return { logs: r.parts.flat(), scannedTo: r.scannedTo }
      },
      head: headNow,
      times: async blocks => {
        const got = await rpc.batch<{ timestamp: string } | null>(blocks.map(b => ({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] })))
        return new Map(blocks.map((b, i) => [b, got[i] ? Number(BigInt(got[i]!.timestamp)) * 1000 : null]))
      },
      indexRows: adminReady ? async (from, to) => {
        const out: IndexRow[] = []
        for (let offset = 0; ; offset += 1000) {
          const page = await db<IndexRow[]>(`arcdex_trades?select=tx_hash,log_index,trader,token,side,usdc,token_amount,block_number&block_number=gte.${from}&block_number=lte.${to}&order=block_number,log_index&limit=1000&offset=${offset}`)
          out.push(...page)
          if (page.length < 1000) return out
        }
      } : null,
      alert: webhookAlert(process.env.ALERT_WEBHOOK_URL),
    })
    await book.load()
    socialBookRef = book
    every(60_000, 'social book', () => { void book.tick() })
    void book.tick()
    moderation = new Moderation({
      store: botStore, settings: botStore, audit: botStore, verify: verifyAdmin,
      thesis: adminReady ? async id => (await db<{ author: string; body: string }[]>(`arcdex_theses?id=eq.${id}&select=author,body`))[0] ?? null : null,
    })
    await moderation.load()
    // A banned wallet can't post a thesis, edit its profile or make a clan either (api/social.ts).
    const mod = moderation
    setSocialGuard(me => (mod.isBanned(me) ? 'This wallet can’t post on ARCDEX' : null))
    socialBoards = new SocialBoards(book)
    dataApi.social = new SocialApi({ book, boards: socialBoards, moderation, origins: cfg.allowedOrigins, revoked: adminReady ? sessionRevoked : undefined })
    log.info('social layer', { trades: book.size, scannedTo: await book.scannedTo() })
  }
  // The admin panel (admin/*): sign-in, live sessions, fees and the sweeper, trades, the audit log, runtime flags.
  if (dataApi) {
    const alert = webhookAlert(process.env.ALERT_WEBHOOK_URL)
    const off = (v: string | undefined) => /^(0|off|false|no)$/i.test(v?.trim() ?? '')
    const byEmail = new PrivyIdentityCheck({ appId: (process.env.PRIVY_APP_ID ?? DEFAULT_PRIVY_APP_ID).trim(), emails: adminEmails(process.env.ADMIN_EMAILS) })
    const auth = new AdminAuth({ admins: cfg.admins, origins: cfg.allowedOrigins, ttlMinutes: Number(process.env.ADMIN_SESSION_TTL_MINUTES) || 30, signedBy: (a, m, sig) => adminCheck.signedBy(a, m, sig), audit: botStore, alert, byEmail })
    emailAdminWallets = () => auth.emailAdminWallets()
    const flags = new FeatureFlags({ settings: botStore, audit: botStore, verify: verifyAdmin })
    siteFlags = flags
    await flags.load()
    const minute = cronMinuteOfDay(process.env.SWEEPER_CRON ?? '0 3 * * *')
    const jup = feeRefs?.jupiter ?? null
    const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', WSOL = 'So11111111111111111111111111111111111111112'
    const sweeper = new Sweeper({
      store: botStore, settings: botStore, audit: botStore,
      minUsd: Math.max(0, Number(process.env.SWEEPER_MIN_USD ?? 10) || 0),
      owedFees: () => accounts?.owedFees() ?? [],
      sendOwedFees: () => accounts?.sendOwedFees() ?? Promise.resolve([]),
      relayBalances: async () => (await fetchRelayBalances(FEE_WALLET)).map(b => ({ holder: `Relay ${b.key}`, token: b.symbol, amount: String(b.amount), usd: b.usd })),
      jupiterBalances: jup ? async () => (await jup.accounts()).map(a => ({ holder: a.account, token: a.mint === SOL_USDC ? 'USDC' : a.mint === WSOL ? 'SOL' : a.mint.slice(0, 6), amount: a.amount, usd: a.mint === SOL_USDC ? Number(a.amount) : null })) : null,
      paused: () => off(process.env.SWEEPER) ? 'SWEEPER=off on the engine' : dataApi.tradeSwitch && !dataApi.tradeSwitch.state().on ? 'trading is off everywhere (the trade switch)' : null,
      alert,
      schedule: off(process.env.SWEEPER) || minute === null ? 'off' : { minuteOfDay: minute, mode: process.env.SWEEPER_MODE === 'dry' ? 'dry' : 'real' },
    })
    every(5 * 60_000, 'fee sweeper', () => { void sweeper.tick() })
    const ledgerTrades = async (): Promise<AdminTrades> => {
      const rows = (await feeRefs?.ledger.store.feeRows({ limit: 100 })) ?? []
      const since = Date.now() - 86_400_000
      const day = rows.filter(r => r.at >= since && (r.status === 'received' || r.status === 'accrued'))
      return {
        source: 'ledger',
        rows: rows.filter(r => r.tx).map(r => ({ tx: r.tx!, at: r.at, trader: '', token: r.token, side: 'buy' as const, usd: 0, feeUsd: r.amountUsd ?? 0, venue: r.source })),
        day: { trades: day.length, volumeUsd: 0, feesUsd: Math.round(day.reduce((t, r) => t + (r.amountUsd ?? 0), 0) * 100) / 100 },
      }
    }
    const trades = async (): Promise<AdminTrades> => {
      if (!adminReady) return ledgerTrades()
      type Row = { tx_hash: string; block_time: string; trader: string; token: string; side: 'buy' | 'sell'; usdc: string; fee_usdc: string; router: string }
      const since = new Date(Date.now() - 86_400_000).toISOString()
      const [rows, day] = await Promise.all([
        db<Row[]>('arcdex_trades?select=tx_hash,block_time,trader,token,side,usdc,fee_usdc,router&order=block_time.desc&limit=100'),
        db<{ usdc: string; fee_usdc: string }[]>(`arcdex_trades?select=usdc,fee_usdc&block_time=gte.${encodeURIComponent(since)}&limit=10000`),
      ])
      const sum = (xs: string[]) => Math.round(xs.reduce((t, x) => t + (Number(x) || 0), 0) * 100) / 100
      return {
        source: 'supabase',
        rows: rows.map(r => ({ tx: r.tx_hash, at: Date.parse(r.block_time), trader: r.trader, token: r.token, side: r.side, usd: Number(r.usdc) || 0, feeUsd: Number(r.fee_usdc) || 0, venue: r.router })),
        day: { trades: day.length, volumeUsd: sum(day.map(d => d.usdc)), feesUsd: sum(day.map(d => d.fee_usdc)) },
      }
    }
    // The owner's analytics (analytics.ts): sign-ins and trades the site sends, each trade checked on its chain, ARCDEX's
    // router trades from the book, the fee ledger and the traffic counter. ANALYTICS=off stops it.
    if (!off(process.env.ANALYTICS)) {
      const rpcs = Object.fromEntries(Object.entries(ANALYTICS_RPCS).map(([c, urls]) => [c, chainJsonRpc(urls)]))
      const analytics = new Analytics({
        store: botStore,
        call: (chain, method, params) => { const r = rpcs[chain]; return r ? r.call(method, params) : Promise.resolve(null) },
        fees: feeRefs ? () => botStore.allFees() : undefined,
        chainTrades: () => (socialBookRef?.all() ?? []).map((t): ChainTrade => ({ tx: t.tx, at: t.at, trader: t.trader, usd: Number(t.usdc) / 1e6, feeUsd: Number(t.fee) / 1e6, side: t.side, token: t.token })),
        traffic: dataApi.traffic ? () => dataApi.traffic!.counts() : undefined,
        feeWallet: FEE_RECIPIENT,
      })
      dataApi.analytics = analytics
      every(ANALYTICS.checkEveryMs, 'analytics checks', () => { void analytics.checkPending().catch(e => log.warn('analytics: checks failed', { error: errMsg(e) })) })
    }
    dataApi.admin = new AdminApi({
      auth, origins: cfg.allowedOrigins, audit: botStore, verify: verifyAdmin, flags, sweeper, ledger: feeRefs?.ledger ?? null,
      traffic: dataApi.traffic, tradeSwitch: dataApi.tradeSwitch, trades, moderation, copy: () => copyRef, analytics: dataApi.analytics,
      bots: accounts ? () => ({ bots: accounts.count, running: accounts.running, live: accounts.liveCount }) : null,
    })
    log.info('admin panel', { admins: cfg.admins.length, sweeper: minute === null || off(process.env.SWEEPER) ? 'off' : `daily after ${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')} UTC`, alerts: !!alert })
  }
  const bot = cfg.botMode === 'off' ? null : new Bot({
    rpc, engine: eng, pools, mode: cfg.botMode, sizeUsd: cfg.botSizeUsd ?? undefined, scalpSizeUsd: cfg.botScalpSizeUsd ?? undefined,
    store: botStore, accounts,
    publish: (topics, msg) => publisher.publish(topics, msg),
    live, owner: cfg.botOwner, history: history.enabled ? history : null, liveSignals: cfg.botSignals.live, liveGrades: cfg.liveGrades, launchpadOnly: cfg.launchpadOnly, paused: cfg.autotradePaused,
  })
  botRef = bot
  const control = new ControlVerifier(cfg.botOwner as `0x${string}` | null, cfg.httpUrls)
  if (bot) {
    eng.observers.push(bot)
    await bot.start()
    dataApi?.attachBot(bot, control, accounts, users, tiers)
  }
  // Copy trading (copy/*, the build pack's Phase 7): engine-held copy wallets mirror the verified leaders' router trades.
  // On only once an admin turns the copyTrading flag on (/admin → Flags); COPY=off stops it whatever the flag says.
  if (dataApi && socialBoards && !/^(0|off|false|no)$/i.test(process.env.COPY?.trim() ?? '')) {
    const boards = socialBoards
    const SWAP_ROUTER_V2 = '0xd07583f7db671521aacfda2b4612ad187aa2924e'
    let feeBps: number | null = null
    const readFee = async () => {
      const r = await rpc.call<string>('eth_call', [{ to: SWAP_ROUTER_V2, data: toFunctionSelector('feeBps()') }, 'latest'])
      const n = Number(BigInt(r))
      if (Number.isInteger(n) && n >= 0 && n <= 1_000) feeBps = n
    }
    await readFee().catch(e => log.warn('copy: router fee not read', { error: errMsg(e) }))
    every(10 * 60_000, 'copy fee', () => { void readFee().catch(e => log.warn('copy: router fee not read', { error: errMsg(e) })) })
    const BALANCE_OF = '0x70a08231'
    const copy = new CopyEngine({
      // No engine-held copy wallets (owner, 2026-10-16: "I don't want ARCDEX to hold users' copy trade wallets"): without a
      // vault none can be made or opened, whatever the copyTrading flag says, until a non-custodial design replaces it.
      store: botStore, vault: null,
      makeExec: key => new LiveExecutor({ privateKey: key, readUrls: cfg.httpUrls, sendUrl: cfg.live.sendUrl }),
      pool: token => { const k = eng.tokens.get(token)?.mainPool; return k ? pools.get(k) ?? null : null },
      liquidityUsd: token => eng.tokens.get(token)?.liquidityUsd ?? null,
      symbol: token => eng.metas.get(token)?.symbol ?? null,
      // The scanner's report (a fresh one, or a scan now: the full one for safe-only rules, whose holders must be known),
      // and the rug guard. A coin the scanner doesn't track (no launch record) can't be rated, so it isn't copied.
      screen: async (token, level) => {
        if (!bot) return { rating: 'unknown', why: 'the safety scanner isn’t running' }
        const deep = level === 'safe-only'
        const hit = bot.reportCached(token, 10 * 60_000)
        const r = hit && (!deep || hit.checks.some(c => c.id === 'holders' && c.ok !== null)) ? hit
          : await Promise.race([bot.report(token, deep), new Promise<null>(res => setTimeout(() => res(null), 20_000))]).catch(() => null)
        return copyScreen(r, bot.rug.recentAlarm(token)?.text ?? null)
      },
      leader: async address => leaderVerdict(await boards.trader(address), Date.now()),
      leaders: async limit => {
        const b = await boards.board('all', 200)
        return b.rows.filter(r => !copy.isCopyWallet(r.trader) && !leaderVerdict({ periods: { all: r.stats }, wash: null }, Date.now())).slice(0, limit)
          .map(r => ({ address: r.trader, realized: r.stats.realized, volume: r.stats.volume, trades: r.stats.trades, winRate: r.stats.counted ? r.stats.wins / r.stats.counted : null, first: r.stats.first }))
      },
      leaderBalanceAt: async (token, leader, block) => {
        const r = await rpc.call<string>('eth_call', [{ to: token, data: `${BALANCE_OF}${leader.slice(2).padStart(64, '0')}` }, `0x${block.toString(16)}`])
        return BigInt(r)
      },
      feeBps: () => feeBps,
      feeWallet: FEE_RECIPIENT,
      on: () => (siteFlags?.state().flags.copyTrading === true ? null : 'copy trading is off: an admin turns it on from /admin → Flags'),
      tradingOn: () => !dataApi.tradeSwitch?.offWhy('arc'),
      verify: (a, m, sig) => adminCheck.signedBy(a as Address, m, sig),
      funders: async w => {
        const l = w.funding ?? emptyLedger()
        const head = l.scannedTo ? 0 : Number(BigInt(await rpc.call<string>('eth_blockNumber', [])))
        const start = l.scannedTo ? l.scannedTo + 1 : Math.max(0, head - Math.ceil((Date.now() - w.createdAt) / FUNDER.msPerBlock) - FUNDER.margin)
        const ledger = await scanFunding(rpc, w.address, l, start)
        return { list: knownFunders(ledger), ledger }
      },
      ledger: rows => feeRefs ? feeRefs.ledger.record(rows) : Promise.resolve(0),
      alert: webhookAlert(process.env.ALERT_WEBHOOK_URL),
    })
    await copy.load().catch(e => log.error('copy: load failed', { error: errMsg(e) }))
    copyRef = copy
    dataApi.copy = new CopyApi({ engine: copy, origins: cfg.allowedOrigins, revoked: adminReady ? sessionRevoked : undefined })
    every(60_000, 'copy fees', () => { void copy.settleFees().catch(e => log.warn('copy: fee settlement failed', { error: errMsg(e) })) })
    log.info('copy trading', { on: !copy.why(), why: copy.why(), feeBps })
  }
  // The signal engine (engine/src/quant): its own scoring, strategies, paper book and validation; live orders only
  // behind its live gate (SIG_LIVE_ALLOWED, the owner's switch, walk-forward and paper records).
  // ARCDEX Algo (algo/agent.ts): the 24/7 futures agent on BTC, ETH and SOL, paper or Arc testnet,
  // on the futures' signed prices. ALGO=off stops it; ANTHROPIC_API_KEY connects its brain.
  if (dataApi && perpsRef && !/^(0|off|false|no)$/i.test(process.env.ALGO?.trim() ?? '')) {
    const agent = new AlgoAgent({ perps: perpsRef, settings: botStore, vault, brain: new Brain(process.env.ANTHROPIC_API_KEY?.trim() || null) })
    algo = agent
    dataApi.algo = agent
    dataApi.algoControl = cfg.botOwner ? control : null
    // After the candles have loaded (perps.start), so the warm-up replay has history.
    setTimeout(() => void agent.start().catch(e => log.error('algo: did not start', { error: errMsg(e) })), 20_000)
  }
  quant = await startSignalEngine({ eng, pools, bot, exec, databaseUrl: cfg.databaseUrl, control: cfg.botOwner ? control : null, metricsToken: cfg.metricsToken })
  if (quant && dataApi) dataApi.quant = quant.api
  // The site's read functions, moved off Vercel (2026-10-02: Vercel paused arcdex.online for CPU use): SITE_API=off stops them.
  if (dataApi && !/^(0|off|false|no)$/i.test(process.env.SITE_API ?? '')) {
    const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)
    dataApi.site = createSiteApi({
      databaseUrl: cfg.databaseUrl, gtPerMin: n(process.env.SITE_GT_PER_MIN, 25),
      indexUrl: process.env.SITE_INDEX_URL === 'off' ? null : process.env.SITE_INDEX_URL || undefined, indexEveryMs: n(process.env.SITE_INDEX_EVERY_MS, 60_000),
      // Holder counts kept fresh for what's trading now (MarketEngine.active).
      hotTokens: () => eng.active(30).map(r => ({ token: r.token, createdSec: r.meta ? Math.floor(r.meta.timestamp / 1000) : undefined })),
    })
    log.info('site api: serving', { functions: dataApi.site.names })
    // Arc's established coins from the engine's own trades, named and dated on-chain once (market/established.ts):
    // the list, trending and coin titles add those GeckoTerminal's throttled builds miss.
    const established = new EstablishedBook({
      tokens: eng.tokens, hasMeta: t => eng.metas.has(t), pool: p => pools.get(p), rpc,
      load: () => botStore.getSetting('arc-established'), save: j => botStore.setSetting('arc-established', j),
    })
    setArcExtra({ rows: () => established.rows(), capOf: t => established.capOf(t) })
    every(20_000, 'established coins', () => { void established.refresh().catch(e => log.debug('established: round failed', { error: errMsg(e) })) })
  }
  // The Trenches' live feed (trench/service.ts): Solana's pump.fun and PumpSwap, BNB Chain's four.meme and PancakeSwap,
  // Robinhood Chain's listed pools and Arc's own trades, with each chain's smart wallets. TRENCH=off stops it.
  if (dataApi && !/^(0|off|false|no)$/i.test(process.env.TRENCH?.trim() ?? '')) {
    const off = (name: string) => /^(0|off|false|no)$/i.test(process.env[name]?.trim() ?? '')
    trench = new TrenchService({
      // A followed wallet's trade goes to the pages watching it and to its push alerts (alerts/service.ts).
      publish: (topics, msg) => { publisher.publish(topics, msg); if (msg.t === 'WTRADE') pushAlerts?.onWalletTrade(msg.d) },
      wants: topic => publisher.wants(topic) || (pushAlerts?.wantsWallet(topic) ?? false),
      settings: botStore, listBase: `http://127.0.0.1:${cfg.port}`,
      arcMeta: token => { const m = eng.metas.get(token); return m ? { symbol: m.symbol, name: m.name, image: m.image ?? null, launchedAt: m.timestamp } : null },
      feeds: { sol: !off('TRENCH_SOL'), bnb: !off('TRENCH_BNB'), hood: !off('TRENCH_HOOD') },
      solWss: (process.env.TRENCH_SOL_WSS ?? '').split(',').map(s => s.trim()).filter(s => /^wss:\/\//.test(s)),
    })
    dataApi.trench = trench
    eng.observers.push(trench)
    void trench.start().catch(e => log.error('trench: did not start', { error: errMsg(e) }))
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
    // A leader's trade through ARCDEX's routers is copied first, before the batch is parsed (copy/engine.ts).
    if (copyRef && !ctx.replay) {
      const routerLogs = logs.filter(l => SOCIAL_ROUTERS[l.address.toLowerCase()] && l.topics[0]?.toLowerCase() === T_SWAPPED)
      for (const t of decodeTrades(routerLogs as RouterLog[], () => receivedAt)) void copyRef.onLeaderTrade(t, receivedAt).catch(e => log.error('copy: leader trade not handled', { tx: t.tx, error: errMsg(e) }))
    }
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
    // ARCDEX's routers' Swapped events: leaders' trades for copy trading.
    ...(copyRef ? [{ address: Object.keys(SOCIAL_ROUTERS), topics: [T_SWAPPED] }] : []),
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
