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
    historyEnabled: process.env.HISTORY_ENABLED === '0' ? false : supabase,
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
    redis: c.redisUrl ? host(c.redisUrl) : null, history: c.historyEnabled,
    allowedOrigins: c.allowedOrigins,
  }
}
