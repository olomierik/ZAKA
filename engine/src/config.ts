// Engine configuration — everything comes from the environment; nothing
// provider-specific or secret is hard-coded. See engine/.env.example.

declare const process: { env: Record<string, string | undefined> }

const list = (v: string | undefined, fallback: string[]) =>
  v ? v.split(',').map(s => s.trim()).filter(Boolean) : fallback
const int = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max} (got ${raw})`)
  return Math.floor(n)
}
const urls = (name: string, fallback: string[], schemes: RegExp) => {
  const v = list(process.env[name], fallback)
  for (const u of v) if (!schemes.test(u)) throw new Error(`${name}: not a valid URL: ${u}`)
  return v
}

export type Role = 'all' | 'ingest' | 'gateway'

export interface Config {
  role: Role
  port: number
  /** WebSocket JSON-RPC endpoints for live subscriptions, in failover order. */
  wsUrls: string[]
  /** HTTP JSON-RPC endpoints for calls, in failover order. */
  httpUrls: string[]
  /** getLogs endpoint for recent blocks (large ranges) and archive endpoints for older ones. */
  logsRecentUrl: string
  logsArchiveUrls: string[]
  redisUrl: string | null
  /** History in this Postgres (e.g. Railway); otherwise Supabase if configured. */
  databaseUrl: string | null
  /** Fan events out through Redis pub/sub (needed when running separate ingest/gateway processes). */
  redisPubSub: boolean
  historyEnabled: boolean
  allowedOrigins: string[]
  metricsToken: string | null
  /** With no saved cursor: how far back to replay on first start (default ~24h, so 24h stats are right). */
  backfillOnStartBlocks: number
  /** Never replay more than this after downtime (older gaps are skipped with a warning). */
  backfillMaxBlocks: number
  /** How often live results are reconciled against getLogs (missed-event detection). */
  reconcileMs: number
  /** No new block for this long = the stream is stale → reconnect / fail over. */
  staleHeadMs: number
  maxConnsPerIp: number
  maxMsgsPerSec: number
  maxSubsPerConn: number
  restRatePerSec: number
  tradeRetentionHours: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Signals and trading (engine/src/bot): paper (default), live (needs a bot wallet) or off. The owner's switch on the site overrides it. */
  botMode: 'paper' | 'live' | 'off'
  /**
   * Where signals go (owner's request, 2026-09-30: "all the signals to the live
   * trades only for now; the settings from when paper was making profits").
   * `live`: `all` sends live bots every signal not on probation, as before the
   * live-speed gate; `proven` only the kinds that make money at live speed
   * (signals/liveSpeed.ts), and not the lowest 20% by quality. `paper`: false
   * sends visitors' paper bots none (the engine's own paper book still trades
   * and measures every signal).
   */
  botSignals: { live: 'all' | 'proven'; paper: boolean }
  /** Autotrade tiers (bot/tiers.ts): enforced only once TIERS_ENFORCED=true; until then every account gets every tier's signals. */
  tiersEnforced: boolean
  /**
   * When tiers start by themselves (TIERS_ENFORCE_AT, an ISO time, or "never"). Default "never" since 2026-10-03 (owner:
   * "remove the tiers limit and let bots trade until further notice"); it was 3 October 2026, 00:00 UTC.
   */
  tiersEnforceAt: number | null
  /**
   * Which signals live bots trade (BOT_LIVE_GRADES): `dollar` (the default: every snipe and fast scalp at $2, sold at
   * +$1, bot/dollarPlan.ts), `board` (the strategy board, bot/strategyBoard.ts), `proven` (Prime and Core unless their
   * record fails, Standard once proven), or `off` (no new live buys). `all` is retired and means the default.
   */
  liveGrades: 'dollar' | 'board' | 'proven' | 'all' | 'off'
  /** Launchpad coins only (SIGNALS_LAUNCHPAD_ONLY, intel/launchpadGate.ts): `strict` (the default), `origin` or `off`. */
  launchpadOnly: 'strict' | 'origin' | 'off'
  /** Paper position size in USD for snipes and second legs (default: each strategy's own, $25). */
  botSizeUsd: number | null
  /** Paper position size in USD for scalps, the small fast trades on risky coins (default $5). */
  botScalpSizeUsd: number | null
  /** The wallet that may switch paper/live (its signature is checked). The bot wallet's key is read in main.ts, never kept here. */
  botOwner: string | null
  /** Live trading limits (bot/liveTrader.ts). */
  live: { minTradeUsd: number; maxTradeUsd: number; dailyLossUsd: number; maxOpen: number; maxOpenScalp: number; slippageBps: number; reserveUsd: number; preflight: boolean; maxRoundTripPct: number; maxShareOfBalance: number; sendUrl: string }
}

export function loadConfig(): Config {
  const role = (process.env.ENGINE_ROLE ?? 'all') as Role
  if (!['all', 'ingest', 'gateway'].includes(role)) throw new Error('ENGINE_ROLE must be all, ingest or gateway')
  const ws = /^wss?:\/\//, http = /^https?:\/\//
  const supabase = Boolean((process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL) && (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY))
  const cfg: Config = {
    role,
    port: int('PORT', 8080, 1, 65535),
    wsUrls: urls('ARC_WS_URLS', ['wss://rpc.mainnet.arc.io', 'wss://rpc.drpc.mainnet.arc.io'], ws),
    httpUrls: urls('ARC_HTTP_URLS', ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'], http),
    logsRecentUrl: urls('ARC_LOGS_RECENT_URL', ['https://rpc.blockdaemon.mainnet.arc.io'], http)[0],
    logsArchiveUrls: urls('ARC_LOGS_ARCHIVE_URLS', ['https://rpc.beamrpc.com', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://rpc.quicknode.mainnet.arc.io'], http),
    redisUrl: process.env.REDIS_URL || null,
    redisPubSub: process.env.REDIS_PUBSUB === '1' || role !== 'all',
    databaseUrl: process.env.DATABASE_URL || null,
    historyEnabled: process.env.HISTORY_ENABLED === '0' ? false : Boolean(process.env.DATABASE_URL) || supabase,
    allowedOrigins: list(process.env.WS_ALLOWED_ORIGINS, ['https://arcdex.online', 'https://www.arcdex.online']),
    metricsToken: process.env.METRICS_TOKEN || null,
    backfillOnStartBlocks: int('BACKFILL_ON_START_BLOCKS', 170_000, 0, 2_000_000),
    backfillMaxBlocks: int('BACKFILL_MAX_BLOCKS', 600_000, 0, 5_000_000),
    reconcileMs: int('RECONCILE_MS', 1_500, 250, 60_000),
    staleHeadMs: int('STALE_HEAD_MS', 8_000, 1_000, 120_000),
    maxConnsPerIp: int('WS_MAX_CONNS_PER_IP', 10, 1, 10_000),
    maxMsgsPerSec: int('WS_MAX_MSGS_PER_SEC', 20, 1, 10_000),
    maxSubsPerConn: int('WS_MAX_SUBS_PER_CONN', 100, 1, 10_000),
    restRatePerSec: int('REST_RATE_PER_SEC', 20, 1, 10_000),
    tradeRetentionHours: int('HISTORY_TRADE_RETENTION_HOURS', 72, 1, 24 * 3650),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as Config['logLevel'],
    botMode: process.env.BOT_MODE === 'off' ? 'off' : process.env.BOT_MODE === 'live' ? 'live' : 'paper',
    // Paper bots trade signals again (2026-10-01): they're what live bots learn from (bot/strategyBoard.ts). BOT_PAPER_SIGNALS=off stops them.
    botSignals: { live: process.env.BOT_LIVE_SIGNALS === 'proven' ? 'proven' : 'all', paper: !/^(0|off|false|no)$/i.test(process.env.BOT_PAPER_SIGNALS ?? '') },
    tiersEnforced: process.env.TIERS_ENFORCED === 'true' || process.env.TIERS_ENFORCED === '1',
    tiersEnforceAt: (() => {
      const raw = process.env.TIERS_ENFORCE_AT?.trim()
      if (!raw || raw === 'never') return null
      const t = Date.parse(raw)
      if (!Number.isFinite(t)) throw new Error(`TIERS_ENFORCE_AT must be an ISO time or "never" (got ${raw})`)
      return t
    })(),
    // 2026-10-01: paused for an hour after DEGEN (-94%), then resumed by the owner with live trades at $2, growing with
    // their realized profit (bot/sizing.ts liveTradeSize). `off` pauses every new live buy; open live trades are still managed.
    // `board`: the strategy board decides, from the paper bots' records at live speed.
    // `dollar` (the default since 2026-10-01, owner's request): live bots trade every snipe and fast scalp at $2, all of
    // it sold once it makes $1, and learn from their own and the team's trades (bot/dollarPlan.ts).
    // `all` is retired (2026-10-01): Railway still had BOT_LIVE_GRADES=all when the owner chose the dollar plan, and with it
    // each live bot traded only the strategy it picked, so neither took a signal (all of that morning's fired as fast
    // scalps, and one bot follows snipes only). It now falls back to the default, which sends every snipe and fast scalp.
    liveGrades: (['off', 'proven', 'board'] as const).find(v => v === process.env.BOT_LIVE_GRADES) ?? 'dollar',
    // Only coins a known Arc launchpad launched, with its standard code, become signals (2026-10-01).
    launchpadOnly: (['origin', 'off'] as const).find(v => v === process.env.SIGNALS_LAUNCHPAD_ONLY) ?? 'strict',
    botSizeUsd: process.env.BOT_SIZE_USD ? int('BOT_SIZE_USD', 25, 1, 10_000) : null,
    botScalpSizeUsd: process.env.BOT_SCALP_SIZE_USD ? int('BOT_SCALP_SIZE_USD', 5, 1, 10_000) : null,
    botOwner: /^0x[0-9a-fA-F]{40}$/.test(process.env.BOT_OWNER_ADDRESS ?? '') ? process.env.BOT_OWNER_ADDRESS!.toLowerCase() : null,
    live: {
      // The bot wallet's trades start at BOT_LIVE_TRADE_USD ($2) and grow with what its live trades make, up to BOT_LIVE_MAX_TRADE_USD.
      minTradeUsd: int('BOT_LIVE_TRADE_USD', 2, 1, 10_000),
      maxTradeUsd: int('BOT_LIVE_MAX_TRADE_USD', 25, 1, 10_000),
      dailyLossUsd: int('BOT_LIVE_DAILY_LOSS_USD', 50, 1, 100_000),
      maxOpen: int('BOT_LIVE_MAX_OPEN', 3, 1, 50),
      maxOpenScalp: int('BOT_LIVE_MAX_OPEN_SCALP', 2, 0, 50),
      slippageBps: int('BOT_LIVE_SLIPPAGE_BPS', 1_000, 10, 5_000),
      reserveUsd: int('BOT_LIVE_RESERVE_USD', 2, 0, 10_000),
      // Every buy is simulated with its sale first (trading/preflight.ts); only BOT_LIVE_PREFLIGHT=off turns that off.
      preflight: !/^(0|off|false|no)$/i.test(process.env.BOT_LIVE_PREFLIGHT ?? ''),
      maxRoundTripPct: int('BOT_LIVE_MAX_ROUND_TRIP_PCT', 20, 1, 90),
      // No trade over this share of what the wallet is worth (its USDC, read before every buy, plus open trades).
      maxShareOfBalance: int('BOT_LIVE_MAX_SHARE_PCT', 20, 1, 100) / 100,
      sendUrl: urls('ARC_SEND_URL', ['https://rpc.mainnet.arc.io'], http)[0],
    },
  }
  // Separate ingest/gateway processes talk through Redis pub/sub.
  if (role !== 'all' && !cfg.redisUrl) throw new Error(`ENGINE_ROLE=${role} needs REDIS_URL`)
  return cfg
}

/** The config with secrets replaced, for logs and /health. */
export function redacted(c: Config) {
  const host = (u: string) => { try { return new URL(u).host } catch { return '?' } }
  return {
    role: c.role, port: c.port,
    wsProviders: c.wsUrls.map(host), httpProviders: c.httpUrls.map(host),
    redis: c.redisUrl ? host(c.redisUrl) : null,
    history: !c.historyEnabled ? 'off' : c.databaseUrl ? 'postgres ' + host(c.databaseUrl) : 'supabase',
    allowedOrigins: c.allowedOrigins,
  }
}
