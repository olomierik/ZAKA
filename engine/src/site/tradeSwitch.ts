// The trade switch: the build pack's kill switch (04 §3 "global kill switch, per chain and global"; docs/REPO_MAP.md
// finding 4). Before it, stopping trades took an owner transaction per router (pause()), and Relay, Across, four.meme,
// AVNU and Hyperliquid trades had no switch at all.
//
//   GET  /v1/trading/status    what's off and why, public; the site reads it before every trade and every 30 seconds
//   POST /v1/trading/control   {scope, on, reason, at, signature}: an admin wallet (ADMIN_EVM_ADDRESSES, else the owner)
//                              signs tradeSwitchMessage; valid 5 minutes and once (bot/control.ts verifyAnyOf)
//
// Off stops new trades before they are signed, on one venue or all of them. Withdrawals, transfers, the bridge and
// open positions are not trades: they keep working, so nobody's money is stuck behind the switch. The state is kept in
// the engine's settings (arcdex_bot_settings, key 'trade-switch') and survives a restart; every change is written to the
// append-only audit log (arcdex_admin_audit). GLOBAL_KILL_SWITCH=true and KILL_SWITCH_VENUES on Railway turn trading off
// without a wallet (an emergency, or a lost admin key); only removing them turns it back on.

import type { Address, Hex } from 'viem'
import { isHex } from 'viem'
import { isTradeVenue, TRADE_VENUES, tradeSwitchMessage, type TradeOff, type TradeScope, type TradeSwitchControl, type TradeSwitchState, type TradeVenue } from '../../../api/_marketProtocol'
import { errMsg, log } from '../log'

export const SWITCH_KEY = 'trade-switch'
const HISTORY = 50
const REASON_MAX = 200

/** An admin action, kept for good (the store refuses updates and deletes). */
export interface AuditEntry { at: number; actor: string; action: string; detail: Record<string, unknown> }
export interface AuditStore { appendAudit(e: AuditEntry): Promise<void> }
export interface SettingsStore { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }
/** Which admin signed `message`, or why none did. */
export type VerifyAdmin = (message: string, at: number, signature: Hex, now: number) => Promise<{ by: Address } | string>

export interface SwitchRequest { control: TradeSwitchControl; at: number; signature: Hex }

/** The request's shape, or why it's refused. A reason is required, so the audit log and the site can say why. */
export function parseSwitchRequest(body: unknown): SwitchRequest | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object'
  const b = body as Record<string, unknown>
  const scope = b.scope === 'all' ? 'all' : isTradeVenue(b.scope) ? b.scope : null
  if (!scope) return `"scope" must be "all" or one of ${TRADE_VENUES.join(', ')}`
  if (typeof b.on !== 'boolean') return '"on" must be true or false'
  const reason = typeof b.reason === 'string' ? b.reason.replace(/\s+/g, ' ').trim() : ''
  if (reason.length < 3 || reason.length > REASON_MAX) return `"reason" must be 3 to ${REASON_MAX} characters`
  const at = Number(b.at)
  if (!Number.isFinite(at)) return 'missing "at"'
  if (typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return 'missing or bad "signature"'
  return { control: { scope, on: b.on, reason }, at, signature: b.signature as Hex }
}

interface Saved { all: TradeOff | null; venues: Partial<Record<TradeVenue, TradeOff>>; history: TradeSwitchState['history'] }

const empty = (): Saved => ({ all: null, venues: {}, history: [] })

/** A stored state, or an empty one: anything malformed is dropped, field by field. */
function parseSaved(raw: string | null): Saved {
  if (!raw) return empty()
  try {
    const j = JSON.parse(raw) as Partial<Saved>
    const off = (o: unknown): TradeOff | null => {
      const x = o as TradeOff | null
      return x && typeof x.reason === 'string' && Number.isFinite(x.at) ? { reason: x.reason, at: x.at } : null
    }
    const venues: Saved['venues'] = {}
    for (const v of TRADE_VENUES) { const o = off(j.venues?.[v]); if (o) venues[v] = o }
    const history = Array.isArray(j.history) ? j.history.filter(h => h && (h.scope === 'all' || isTradeVenue(h.scope)) && typeof h.on === 'boolean' && Number.isFinite(h.at)).slice(0, HISTORY) : []
    return { all: off(j.all), venues, history }
  } catch { return empty() }
}

export class TradeSwitch {
  private saved: Saved = empty()

  constructor(private o: { settings: SettingsStore; audit: AuditStore; verify: VerifyAdmin; env: { all: boolean; venues: TradeVenue[] } }) {}

  /** The stored state, read at start. */
  async load() {
    this.saved = parseSaved(await this.o.settings.getSetting(SWITCH_KEY).catch(e => { log.warn('trade switch: not loaded', { error: errMsg(e) }); return null }))
    const s = this.state()
    if (!s.on || Object.keys(s.venues).length) log.warn('trade switch: trading is off', { all: !s.on, venues: Object.keys(s.venues) })
  }

  state(now = Date.now()): TradeSwitchState {
    const venues: TradeSwitchState['venues'] = { ...this.saved.venues }
    for (const v of this.o.env.venues) venues[v] = { reason: 'turned off on the engine (KILL_SWITCH_VENUES)', at: venues[v]?.at ?? 0 }
    const all = this.o.env.all ? { reason: 'turned off on the engine (GLOBAL_KILL_SWITCH)', at: this.saved.all?.at ?? 0 } : this.saved.all
    return { at: now, on: !all, all, venues, env: { all: this.o.env.all, venues: [...this.o.env.venues] }, history: this.saved.history }
  }

  /** Why trading on `venue` is off now, or null. */
  offWhy(venue: TradeVenue): string | null {
    const s = this.state()
    return s.all?.reason ?? s.venues[venue]?.reason ?? null
  }

  /** An admin's signed change: applied at once, saved, and written to the audit log. */
  async control(body: unknown, now = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = parseSwitchRequest(body)
    if (typeof r === 'string') return { status: 400, body: { error: r } }
    const who = await this.o.verify(tradeSwitchMessage(r.control, r.at), r.at, r.signature, now)
    if (typeof who === 'string') {
      log.warn('trade switch: refused', { scope: r.control.scope, on: r.control.on, why: who })
      return { status: 403, body: { error: who } }
    }
    const { scope, on, reason } = r.control
    this.set(scope, on ? null : { reason, at: now })
    this.saved.history = [{ at: now, scope, on, reason }, ...this.saved.history].slice(0, HISTORY)
    log.warn('trade switch: changed', { scope, on, reason, by: who.by })
    // Applied in memory first: a switch turned off must stop trades even if the database is down.
    const saved = await this.o.settings.setSetting(SWITCH_KEY, JSON.stringify(this.saved)).then(() => true, e => { log.error('trade switch: not saved', { error: errMsg(e) }); return false })
    const audited = await this.o.audit.appendAudit({ at: now, actor: who.by.toLowerCase(), action: 'trade-switch', detail: { scope, on, reason } }).then(() => true, e => { log.error('trade switch: not audited', { error: errMsg(e) }); return false })
    const state = this.state(now)
    const stillOff = on && (scope === 'all' ? this.o.env.all : this.o.env.all || this.o.env.venues.includes(scope))
    return { status: 200, body: { ok: true, saved, audited, state, ...(stillOff ? { note: 'still off: the engine\'s GLOBAL_KILL_SWITCH or KILL_SWITCH_VENUES keeps it off until removed on Railway' } : {}) } }
  }

  private set(scope: TradeScope, off: TradeOff | null) {
    if (scope === 'all') { this.saved.all = off; return }
    if (off) this.saved.venues[scope] = off
    else delete this.saved.venues[scope]
  }
}
