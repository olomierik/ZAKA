// Starting the signal engine inside the market engine's process (main.ts):
// its settings (the defaults, SIG_CONFIG_JSON, then the owner's last saved
// version), its store, its positions after a restart, live orders through the
// bot wallet (behind the live gate), the trade feed, a warm-up from the
// recorded trades, its timers and its validation runs.
//
// Environment (Railway, arcdex-engine):
//   SIG_ENGINE=off               don't run it (default: on, paper only)
//   SIG_LAUNCHPADS=ARGUS         the launchpads whose coins are scored
//   SIG_CONFIG_JSON='{…}'        settings laid over the defaults at start (the owner's saved version wins unless SIG_CONFIG_RESET=1)
//   SIG_LIVE_ALLOWED=1           lets live orders happen at all (still needs the owner's switch and the live gate)
//   SIG_WARM_HOURS=48            warm-up from recorded trades (wallet records, coin tapes)
//   SIG_VALIDATE_HOURS=48        each validation run's span; SIG_VALIDATE_EVERY_HOURS=12 (0: only when the owner asks)

import { SQL } from 'bun'
import type { Trade } from '../../../api/_marketProtocol'
import type { Bot } from '../bot/bot'
import type { ControlVerifier } from '../bot/control'
import type { PoolRegistry } from '../dex/pools'
import { every } from '../lifecycle'
import { log, errMsg } from '../log'
import type { MarketEngine } from '../market/engine'
import type { LiveExecutor } from '../trading/live'
import type { QuantApiDeps } from './api'
import { configFromEnv, validateConfig, type QuantConfig } from './config'
import { SignalEngine } from './engine'
import { LiveOrders } from './execution'
import { eachTrade, launchesBetween } from './history'
import { MemoryQuantStore, PostgresQuantStore, type QuantStore } from './store'
import { Validator } from './validator'
import type { QuantValidationRun } from '../../../api/_quantProtocol'
import type { LaunchInfo } from '../../../api/_marketProtocol'

export interface QuantBoot { engine: SignalEngine; api: QuantApiDeps; health: () => { enabled: true; warm: boolean; regime: string; signals: number; openPaper: number } }

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

export async function startSignalEngine(o: { eng: MarketEngine; pools: PoolRegistry; bot: Bot | null; exec: LiveExecutor | null; databaseUrl: string | null; control: ControlVerifier | null; metricsToken: string | null; env?: Record<string, string | undefined> }): Promise<QuantBoot | null> {
  const env = o.env ?? process.env
  if (/^(0|off|false|no)$/i.test(env.SIG_ENGINE ?? '')) { log.info('signal engine: off (SIG_ENGINE)'); return null }
  let cfg: QuantConfig
  try { cfg = configFromEnv(env) } catch (e) { log.error('signal engine: bad settings, not started', { error: errMsg(e) }); return null }
  const store: QuantStore = o.databaseUrl ? new PostgresQuantStore(o.databaseUrl) : new MemoryQuantStore()
  // The owner's last saved settings survive a restart (unless SIG_CONFIG_RESET=1).
  let version = 0
  if (env.SIG_CONFIG_RESET !== '1') {
    const saved = await store.latestParams().catch(() => null)
    if (saved && !validateConfig(saved.config as QuantConfig)) { cfg = saved.config as QuantConfig; version = saved.version }
    else if (saved) log.warn('signal engine: the saved settings no longer fit; using the defaults', { version: saved.version })
  }
  const metas = new Map<string, LaunchInfo>()
  let balance: number | null = null
  const liveAllowed = env.SIG_LIVE_ALLOWED === '1'
  let engine!: SignalEngine
  const live = o.exec ? new LiveOrders({
    exec: o.exec,
    pool: token => { const mp = o.eng.tokens.get(token)?.mainPool; return mp ? o.pools.get(mp) ?? null : null },
    event: e => engine.onLiveEvent(e),
    timeoutMs: () => engine.cfg.execution.orderTimeoutMs,
  }) : null
  engine = new SignalEngine({
    store, mode: 'live', config: cfg,
    meta: token => o.eng.metas.get(token) ?? metas.get(token) ?? null,
    token: token => { const st = o.eng.tokens.get(token); return st ? { mainPool: st.mainPool, liquidityUsd: st.liquidityUsd, supply: st.supply } : null },
    safety: token => o.bot?.reportCached(token) ?? null,
    requestSafety: token => { void o.bot?.report(token, true).catch(() => {}) },
    rugAlarm: (token, now) => o.bot?.rug.recentAlarm(token, now)?.text ?? null,
    live, liveAllowedByEnv: liveAllowed, hasWallet: !!o.exec,
    liveEquity: () => balance,
    decimals: token => o.eng.metas.get(token)?.decimals ?? metas.get(token)?.decimals ?? 18,
  })
  engine.cfgVersion = version
  engine.restore(await store.positions(14).catch(() => []))
  // The live wallet's worth, read every minute while live trading is allowed at all.
  if (o.exec && liveAllowed) {
    const read = () => void o.exec!.balanceUsd().then(b => { balance = b }, () => {})
    read(); every(60_000, 'quant wallet balance', read)
  }
  // The trade feed: held while the warm-up replays the recorded hours, then live.
  let warming = !!o.databaseUrl
  let warmTrades = 0, warmDetail = warming ? 'starting' : 'no database: starts from now'
  const held: Trade[] = []
  o.eng.observers.push({
    onTrade: (t, ctx) => {
      if (warming) { if (held.length < 300_000) held.push(t); return }
      engine.ingest(t, { replay: ctx.replay })
    },
  })
  if (o.databaseUrl) {
    const hours = num(env.SIG_WARM_HOURS, 48)
    void (async () => {
      const sql = new SQL(o.databaseUrl!, { max: 1, idleTimeout: 30, connectionTimeout: 15 })
      const t0 = Date.now()
      try {
        const now = Date.now()
        for (const l of await launchesBetween(sql, now - (hours + 24) * 3_600_000, now, null)) metas.set(l.token, l)
        warmDetail = `replaying ${hours}h of recorded trades`
        warmTrades = await eachTrade(sql, now - hours * 3_600_000, now, null, page => { for (const t of page) engine.ingest(t, { replay: true }) })
        warmDetail = `replayed ${warmTrades.toLocaleString('en-US')} recorded trades of ${hours}h in ${Math.round((Date.now() - t0) / 1000)}s`
      } catch (e) {
        warmDetail = `warm-up failed (${errMsg(e)}): started from now`
        log.warn('signal engine: warm-up failed', { error: errMsg(e) })
      } finally {
        await sql.close({ timeout: 5 }).catch(() => {})
        // What arrived meanwhile: state only (minutes old), then the live feed.
        for (const t of held.splice(0)) engine.ingest(t, { replay: true })
        warming = false
        log.info('signal engine: warm', { detail: warmDetail })
      }
    })()
  }
  every(250, 'quant evaluate', () => { if (!warming) engine.evaluateDue(Date.now()) })
  every(1_000, 'quant tick', () => { if (!warming) engine.tick(Date.now()) })
  const validator = o.databaseUrl ? new Validator({ engine, databaseUrl: o.databaseUrl, hours: num(env.SIG_VALIDATE_HOURS, 48), everyHours: num(env.SIG_VALIDATE_EVERY_HOURS, 12), folds: 3 }) : null
  if (validator) {
    const last = (await store.backtests(1).catch(() => []))[0]
    if (last) validator.restore(last.data as unknown as QuantValidationRun)
    validator.start()
  }
  log.info('signal engine started', { launchpads: cfg.launchpads, version, store: store.kind, live: { allowedByEnv: liveAllowed, wallet: !!o.exec, switch: cfg.risk.liveEnabled } })
  const api: QuantApiDeps = { engine, validator, control: o.control, warm: () => ({ done: !warming, trades: warmTrades, detail: warmDetail }), metricsToken: o.metricsToken }
  return { engine, api, health: () => ({ enabled: true, warm: !warming, regime: engine.regime.regime, signals: engine.signals.length, openPaper: engine.positions.filter(p => p.mode === 'paper').length }) }
}
