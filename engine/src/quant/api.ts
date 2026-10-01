// The signal engine's REST API (CORS like the rest of the engine's API):
//
//   GET  /v1/quant/status                    switches, the live gate, regime, settings, results, latency
//   GET  /v1/quant/signals?limit&strategy&decision&minScore   recent signals, newest first, each with every reason
//   GET  /v1/quant/signals/:id               one signal
//   GET  /v1/quant/radar?limit               every scored coin now, best first
//   GET  /v1/quant/positions?mode&status&limit   paper and live positions with their fills
//   GET  /v1/quant/wallets?limit             the best smart-money wallets and the classes' counts
//   GET  /v1/quant/events?kind=risk|execution&limit
//   GET  /v1/quant/validations?limit         walk-forward runs
//   GET  /v1/quant/dataset?since&limit       feature vectors with outcome labels (Bearer METRICS_TOKEN when set)
//   POST /v1/quant/control                   the owner's signed controls: settings, kill switch, validate now

import { quantControlMessage, type QuantControl, type QuantStatus, type QuantValidationRun, type QuantWallet } from '../../../api/_quantProtocol'
import { isHex, type Hex } from 'viem'
import type { ControlVerifier } from '../bot/control'
import { log } from '../log'
import { metrics } from '../metrics'
import { mergeConfig, STRATEGY_IDS, type QuantConfig } from './config'
import type { SignalEngine } from './engine'
import type { Validator } from './validator'

export interface QuantApiDeps {
  engine: SignalEngine
  validator: Validator | null
  control: ControlVerifier | null
  warm: () => { done: boolean; trades: number; detail: string }
  metricsToken: string | null
}

type Json = (status: number, body: unknown, cache?: string) => Response

const LATENCY_KEYS = ['quant_data_latency', 'quant_eval_ms', 'quant_signal_ms', 'quant_validation_ms', 'block_to_publish', 'trade_processing']

export function quantStatus(d: QuantApiDeps, now = Date.now()): QuantStatus {
  const e = d.engine
  const c = e.cfg
  const lat = metrics.snapshot().latencyMs as Record<string, { p50: number; p90: number; p99: number; n: number } | null>
  const wallets = e.wallets.summary(now)
  return {
    enabled: true, at: now, version: e.cfgVersion, config: c as unknown as Record<string, unknown>,
    controls: { tradingEnabled: c.risk.tradingEnabled, paperEnabled: c.risk.paperEnabled, liveEnabled: c.risk.liveEnabled, killSwitch: c.risk.killSwitch, liveAllowedByEnv: e.risk.liveAllowedByEnv, hasWallet: !!e.d.hasWallet && !!e.d.live },
    liveGate: e.liveGate(now),
    regime: e.regime,
    warm: d.warm(),
    counts: { coins: e.tapes.size, wallets: wallets.wallets, smartWallets: wallets.SMART_MONEY, openPaper: e.positions.filter(p => p.mode === 'paper').length, openLive: e.positions.filter(p => p.mode === 'live').length, pendingLabels: e.labeler.pending },
    equity: { paper: Math.round(e.equity('paper') * 100) / 100, live: e.d.liveEquity?.() ?? null },
    stats: { paper: e.stats('paper'), live: e.stats('live') },
    latencyMs: Object.fromEntries(LATENCY_KEYS.map(k => [k, lat[k] ?? null])),
    validation: { running: d.validator?.running ?? false, last: d.validator?.last ?? null, next: d.validator?.next ?? null },
  }
}

/** Parses a signed control, or says why it's refused. */
export function parseQuantControl(body: unknown): { control: QuantControl; at: number; signature: Hex } | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object'
  const b = body as Record<string, unknown>
  const at = Number(b.at)
  if (!Number.isFinite(at)) return 'missing "at"'
  if (typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return 'missing or bad "signature"'
  const signature = b.signature as Hex
  if (b.action === 'settings') {
    if (typeof b.patch !== 'string' || b.patch.length > 8_000) return '"patch" must be a JSON string (at most 8,000 characters)'
    if (typeof b.note !== 'string' || !b.note.trim() || b.note.length > 300) return '"note" must say why (at most 300 characters)'
    return { control: { action: 'settings', patch: b.patch, note: b.note }, at, signature }
  }
  if (b.action === 'kill' && typeof b.on === 'boolean') return { control: { action: 'kill', on: b.on }, at, signature }
  if (b.action === 'validate') return { control: { action: 'validate' }, at, signature }
  return 'unknown action'
}

export async function quantApi(req: Request, url: URL, d: QuantApiDeps, json: Json): Promise<Response> {
  const e = d.engine
  const q = (k: string) => url.searchParams.get(k)
  const limit = (def: number, max: number) => Math.max(1, Math.min(max, Number(q('limit')) || def))
  if (req.method === 'POST' && url.pathname === '/v1/quant/control') {
    if (!d.control) return json(503, { error: 'owner controls are not set up on this engine' })
    if (Number(req.headers.get('content-length') ?? 0) > 16_000) return json(413, { error: 'too large' })
    const parsed = parseQuantControl(await req.json().catch(() => null))
    if (typeof parsed === 'string') return json(400, { error: parsed })
    const bad = await d.control.verifyText(quantControlMessage(parsed.control, parsed.at), parsed.at, parsed.signature)
    if (bad) { metrics.inc('quant_control_refused'); log.warn('quant control refused', { action: parsed.control.action, why: bad }); return json(403, { error: bad }) }
    const c = parsed.control
    if (c.action === 'settings') {
      let next: QuantConfig
      try { next = mergeConfig(e.cfg, JSON.parse(c.patch)) } catch (err) { return json(400, { error: `the patch doesn't fit the settings: ${err instanceof Error ? err.message : String(err)}` }) }
      const r = await e.setConfig(next, 'owner', c.note)
      return r.ok ? json(200, { ok: true, version: r.version, status: quantStatus(d) }) : json(400, { error: r.error })
    }
    if (c.action === 'kill') {
      const r = await e.setConfig(mergeConfig(e.cfg, { risk: { killSwitch: c.on } }), 'owner', c.on ? 'kill switch on' : 'kill switch off')
      return r.ok ? json(200, { ok: true, status: quantStatus(d) }) : json(400, { error: r.error })
    }
    if (!d.validator) return json(503, { error: 'validation needs the engine\'s database (DATABASE_URL)' })
    if (d.validator.running) return json(409, { error: 'a validation run is already going' })
    void d.validator.run('owner')
    return json(202, { ok: true, status: quantStatus(d) })
  }
  if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
  const path = url.pathname
  if (path === '/v1/quant/status') return json(200, quantStatus(d), 'no-store')
  if (path === '/v1/quant/signals') {
    const strategy = q('strategy'), decision = q('decision'), min = Number(q('minScore')) || 0
    const rows = e.signals.filter(s => (!strategy || s.strategy === strategy) && (!decision || s.decision === decision) && s.signal_score >= min)
    return json(200, { signals: rows.slice(0, limit(100, 500)) }, 'public, max-age=2')
  }
  const sm = /^\/v1\/quant\/signals\/(.+)$/.exec(path)
  if (sm) {
    const id = decodeURIComponent(sm[1])
    const s = e.signals.find(x => x.id === id) ?? (await e.d.store.signals(2_000).catch(() => [])).find(x => x.id === id)
    return s ? json(200, { signal: s }, 'public, max-age=30') : json(404, { error: 'no such signal' })
  }
  if (path === '/v1/quant/radar') return json(200, { coins: [...e.radar.values()].sort((a, b) => b.score - a.score).slice(0, limit(50, 400)) }, 'public, max-age=2')
  if (path === '/v1/quant/positions') {
    const mode = q('mode') ?? 'paper', status = q('status') ?? 'all'
    const open = e.positions.filter(p => p.mode === mode)
    const closed = e.closed.filter(p => p.mode === mode).slice().reverse()
    const rows = status === 'open' ? open : status === 'closed' ? closed : [...open, ...closed]
    return json(200, { positions: rows.slice(0, limit(100, 1_000)).map(({ exits: _x, ...p }) => p) }, 'public, max-age=2')
  }
  if (path === '/v1/quant/wallets') {
    const now = Date.now()
    const top: QuantWallet[] = e.wallets.top(limit(25, 200), now).map(w => ({ wallet: w.wallet, class: w.class, quality: Math.round(w.quality * 1_000) / 1_000, trade_count: w.trade_count, win_rate: w.win_rate, profit_factor: w.profit_factor, median_return: w.median_return, realized_profit: Math.round(w.realized_profit), realized_loss: Math.round(w.realized_loss), tokens_traded: w.tokens_traded, average_hold_ms: w.average_hold_ms, early_entry_frequency: w.early_entry_frequency }))
    return json(200, { summary: e.wallets.summary(now), top }, 'public, max-age=30')
  }
  if (path === '/v1/quant/events') {
    const kind = q('kind') === 'execution' ? 'execution' : 'risk'
    return json(200, { events: kind === 'risk' ? e.riskLog.slice(0, limit(100, 300)) : e.execLog.slice(0, limit(100, 300)) }, 'no-store')
  }
  if (path === '/v1/quant/validations') {
    const runs = (await e.d.store.backtests(limit(10, 50)).catch(() => [])).map(r => r.data as unknown as QuantValidationRun)
    return json(200, { runs, running: d.validator?.running ?? false }, 'public, max-age=10')
  }
  if (path === '/v1/quant/dataset') {
    if (d.metricsToken && req.headers.get('authorization') !== `Bearer ${d.metricsToken}`) return json(401, { error: 'unauthorized' })
    const rows = await e.d.store.dataset(Number(q('since')) || 0, limit(1_000, 10_000)).catch(() => [])
    return json(200, { rows, strategies: STRATEGY_IDS }, 'no-store')
  }
  return json(404, { error: 'not found' })
}
