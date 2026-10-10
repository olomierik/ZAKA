// ARCDEX Algo's REST API (CORS like the rest of the engine's API):
//
//   GET  /v1/algo/status                 mode, waiting, the gates, every market's last decision, risk, results, calibration
//   GET  /v1/algo/decisions?limit&market every candle's decision, newest first, with its gates and snapshot
//   GET  /v1/algo/trades?limit           the book's trades, newest first
//   GET  /v1/algo/reviews?limit          the nightly reviews
//   GET  /v1/algo/schema                 the typed decision schema and the gates
//   POST /v1/algo/control                the owner's signed controls: kill switch, mode, reset, gates

import { isHex, type Hex } from 'viem'
import { algoControlMessage, ALGO_MARKETS, DECISION_JSON_SCHEMA, type AlgoControl } from '../../../api/_algoProtocol'
import type { ControlVerifier } from '../bot/control'
import { log } from '../log'
import type { AlgoAgent } from './agent'
import { applyGatePatch } from './config'

type Json = (status: number, body: unknown, cache?: string) => Response

export function parseAlgoControl(body: unknown): { control: AlgoControl; at: number; signature: Hex } | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object'
  const b = body as Record<string, unknown>
  const at = Number(b.at)
  if (!Number.isFinite(at)) return 'missing "at"'
  if (typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return 'missing or bad "signature"'
  const signature = b.signature as Hex
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if (b.action === 'kill' && typeof b.on === 'boolean') {
    if (!note || note.length > 300) return '"note" must say why (at most 300 characters)'
    return { control: { action: 'kill', on: b.on, note }, at, signature }
  }
  if (b.action === 'mode' && (b.mode === 'paper' || b.mode === 'testnet')) return { control: { action: 'mode', mode: b.mode }, at, signature }
  if (b.action === 'reset') {
    const startUsd = Number(b.startUsd)
    if (!Number.isFinite(startUsd) || startUsd < 100 || startUsd > 1_000_000) return '"startUsd" must be 100 to 1,000,000'
    return { control: { action: 'reset', startUsd }, at, signature }
  }
  if (b.action === 'gates') {
    if (typeof b.patch !== 'string' || b.patch.length > 2_000) return '"patch" must be a JSON string'
    if (!note || note.length > 300) return '"note" must say why (at most 300 characters)'
    return { control: { action: 'gates', patch: b.patch, note }, at, signature }
  }
  return 'unknown action'
}

export async function algoApi(req: Request, url: URL, agent: AlgoAgent, control: ControlVerifier | null, json: Json): Promise<Response> {
  const q = (k: string) => url.searchParams.get(k)
  const limit = (def: number, max: number) => Math.max(1, Math.min(max, Number(q('limit')) || def))
  if (req.method === 'POST' && url.pathname === '/v1/algo/control') {
    if (!control) return json(503, { error: 'owner controls are not set up on this engine (BOT_OWNER_ADDRESS)' })
    if (Number(req.headers.get('content-length') ?? 0) > 8_000) return json(413, { error: 'too large' })
    const parsed = parseAlgoControl(await req.json().catch(() => null))
    if (typeof parsed === 'string') return json(400, { error: parsed })
    const bad = await control.verifyText(algoControlMessage(parsed.control, parsed.at), parsed.at, parsed.signature)
    if (bad) { log.warn('algo control refused', { action: parsed.control.action, why: bad }); return json(403, { error: bad }) }
    const c = parsed.control
    log.info('algo control', { action: c.action })
    if (c.action === 'kill') await agent.setKill(c.on, c.note)
    else if (c.action === 'mode') { const e = await agent.setMode(c.mode); if (e) return json(409, { error: e }) }
    else if (c.action === 'reset') { const e = await agent.reset(c.startUsd); if (e) return json(409, { error: e }) }
    else {
      let next
      try { next = applyGatePatch(agent.core.cfg, JSON.parse(c.patch)) } catch (e) { return json(400, { error: `the patch doesn't fit: ${e instanceof Error ? e.message : String(e)}` }) }
      await agent.setConfig(next)
    }
    return json(200, { ok: true, status: agent.status() })
  }
  if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
  const p = url.pathname
  if (p === '/v1/algo/status') return json(200, agent.status(), 'public, max-age=3')
  if (p === '/v1/algo/decisions') {
    const m = q('market')?.toUpperCase() ?? null
    if (m && !(ALGO_MARKETS as readonly string[]).includes(m)) return json(400, { error: 'unknown market' })
    return json(200, { decisions: agent.decisions(limit(60, 500), m) }, 'public, max-age=5')
  }
  if (p === '/v1/algo/trades') return json(200, { trades: agent.trades(limit(100, 1_000)) }, 'public, max-age=5')
  if (p === '/v1/algo/reviews') return json(200, { reviews: agent.reviews.slice(0, limit(14, 60)) }, 'public, max-age=60')
  if (p === '/v1/algo/schema') return json(200, { schema: DECISION_JSON_SCHEMA, gates: agent.core.cfg.gates, limits: agent.core.cfg.limits, geometry: agent.core.cfg.geometry, reflex: agent.core.cfg.reflex }, 'public, max-age=60')
  return json(404, { error: 'not found' })
}
