// Site feature flags an admin sets while the site runs (the build pack's Phase 4 "Flags"; 03: feature_flags).
//
//   GET  /v1/flags              the flags an admin has set, public (the site reads them at start and every few minutes)
//   POST /v1/admin/flags        {flag, on, reason, at, signature}: an admin session AND the admin's signature of
//                               flagChangeMessage, valid 5 minutes and once: the second confirmation 04 asks for
//
// A flag set at build time (VITE_FLAG_<NAME> on Netlify) always wins on the site. A protective flag (withdrawLimits) can
// only be turned on here, never off: loosening a protection takes a deploy, so a stolen admin session can't. The state
// is kept in the engine's settings ('feature-flags'); every change goes in the append-only audit log.

import { isHex, type Hex } from 'viem'
import { flagChangeMessage, isSiteFlag, SITE_FLAGS, type FlagsState, type SiteFlag } from '../../../api/_marketProtocol'
import type { AuditStore, SettingsStore, VerifyAdmin } from '../site/tradeSwitch'
import { errMsg, log } from '../log'

export const FLAGS_KEY = 'feature-flags'
const HISTORY = 50

export interface FlagRequest { flag: SiteFlag; on: boolean; reason: string; at: number; signature: Hex }

export function parseFlagRequest(body: unknown): FlagRequest | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object'
  const b = body as Record<string, unknown>
  if (!isSiteFlag(b.flag)) return `"flag" must be one of ${Object.keys(SITE_FLAGS).join(', ')}`
  if (typeof b.on !== 'boolean') return '"on" must be true or false'
  const reason = typeof b.reason === 'string' ? b.reason.replace(/\s+/g, ' ').trim() : ''
  if (reason.length < 3 || reason.length > 200) return '"reason" must be 3 to 200 characters'
  const at = Number(b.at)
  if (!Number.isFinite(at)) return 'missing "at"'
  if (typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return 'missing or bad "signature"'
  return { flag: b.flag, on: b.on, reason, at, signature: b.signature as Hex }
}

function parseSaved(raw: string | null): FlagsState {
  const empty: FlagsState = { at: 0, flags: {}, history: [] }
  if (!raw) return empty
  try {
    const j = JSON.parse(raw) as Partial<FlagsState>
    const flags: FlagsState['flags'] = {}
    for (const [k, v] of Object.entries(j.flags ?? {})) if (isSiteFlag(k) && typeof v === 'boolean') flags[k] = v
    const history = Array.isArray(j.history) ? j.history.filter(h => h && isSiteFlag(h.flag) && typeof h.on === 'boolean' && Number.isFinite(h.at)).slice(0, HISTORY) : []
    return { at: Number(j.at) || 0, flags, history }
  } catch { return empty }
}

export class FeatureFlags {
  private s: FlagsState = { at: 0, flags: {}, history: [] }

  constructor(private o: { settings: SettingsStore; audit: AuditStore; verify: VerifyAdmin }) {}

  async load() {
    this.s = parseSaved(await this.o.settings.getSetting(FLAGS_KEY).catch(e => { log.warn('flags: not loaded', { error: errMsg(e) }); return null }))
  }

  state(): FlagsState { return structuredClone(this.s) }

  /** A signed change from an admin who's signed in as `session`. */
  async change(body: unknown, session: string, now = Date.now()): Promise<{ status: number; body: unknown }> {
    const r = parseFlagRequest(body)
    if (typeof r === 'string') return { status: 400, body: { error: r } }
    if (SITE_FLAGS[r.flag].protective && !r.on) return { status: 403, body: { error: `${r.flag} protects people's money: it can only be turned off with a deploy (VITE_FLAG_${r.flag.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}=off on Netlify)` } }
    const who = await this.o.verify(flagChangeMessage(r.flag, r.on, r.reason, r.at), r.at, r.signature, now)
    if (typeof who === 'string') return { status: 403, body: { error: who } }
    if (who.by.toLowerCase() !== session.toLowerCase()) return { status: 403, body: { error: 'sign with the wallet you signed in with' } }
    this.s = { at: now, flags: { ...this.s.flags, [r.flag]: r.on }, history: [{ at: now, flag: r.flag, on: r.on, reason: r.reason }, ...this.s.history].slice(0, HISTORY) }
    let saved = true
    await this.o.settings.setSetting(FLAGS_KEY, JSON.stringify(this.s)).catch(e => { saved = false; log.error('flags: not saved', { error: errMsg(e) }) })
    await this.o.audit.appendAudit({ at: now, actor: who.by.toLowerCase(), action: 'flag.change', detail: { flag: r.flag, on: r.on, reason: r.reason } })
      .catch(e => log.error('flags: not audited', { error: errMsg(e) }))
    log.warn('feature flag changed', { flag: r.flag, on: r.on, by: who.by })
    return { status: 200, body: { ok: true, saved, state: this.state() } }
  }
}
