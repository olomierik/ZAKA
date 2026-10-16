// Comments, reports, mutes and moderation (the build pack's Phase 6: "comments", "anti-abuse"; acceptance: "reports and
// mutes work"; 06's test matrix: "XSS on user content (theses, comments)").
//
//  - Comments: on a thesis (its thread) or a coin, by a signed-in wallet (the site's wallet session). Plain text, cleaned
//    (cleanText: control and zero-width characters out), at most 280 characters, 30 a day and one every 10 seconds. The
//    site shows them as text, never as HTML. An author can delete their own.
//  - Reports: any comment, thesis or profile, by a signed-in wallet, once per target, 20 a day, with a reason. A comment
//    or thesis reported by 3 different wallets (not its author, not banned) is hidden until an admin looks at it.
//  - Mutes: a signed-in wallet hides another's theses, comments and feed items for itself (1,000 at most).
//  - Admins (/admin → Reports): hide, restore, dismiss, ban and unban, each signed (moderationMessage) by the admin
//    who's signed in, and kept in the append-only audit log. A restored or dismissed item isn't hidden by reports again.
//    A banned wallet can't comment, report, post a thesis or edit its profile, and what it posted is hidden.
//
// Comments, reports and mutes are rows in the engine's Postgres; the moderation state (hidden, cleared, banned) is a
// small setting. Theses stay in Supabase: the site leaves out the ones hidden here (GET /v1/social/moderation).

import { isHex, type Hex } from 'viem'
import {
  MODERATION_ACTIONS, REPORT_REASONS, SOCIAL_LIMITS, cleanText, isReportReason, moderationMessage, parseCommentTarget, parseReportTarget,
  type CommentTarget, type CommentV, type ModerationAction, type ModerationState, type MyView, type ReportGroup, type ReportReason, type ReportTarget,
} from '../../../api/_socialProtocol'
import type { AuditStore, VerifyAdmin } from '../site/tradeSwitch'
import { errMsg, log } from '../log'

export interface CommentRow { id: string; target: CommentTarget; author: string; body: string; at: number; deletedAt: number | null }
export interface ReportRow { reporter: string; target: ReportTarget; reason: ReportReason; note: string | null; at: number; snapshot: { author: string | null; body: string | null } | null }
export interface MuteRow { muter: string; muted: string; at: number }

export interface ModerationStore {
  socialComments(): Promise<CommentRow[]>
  putComment(c: CommentRow): Promise<void>
  socialReports(): Promise<ReportRow[]>
  putReport(r: ReportRow): Promise<void>
  socialMutes(): Promise<MuteRow[]>
  setMute(m: MuteRow, on: boolean): Promise<void>
}
interface Settings { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }

/** A thesis's author and text (from the site's Supabase), or null when it doesn't exist. */
export type ThesisReader = (id: number) => Promise<{ author: string; body: string } | null>

interface ModState {
  hidden: Record<string, { by: 'reports' | 'admin'; at: number; reason?: string }>
  cleared: Record<string, { as: 'restored' | 'dismissed'; at: number }>
  banned: Record<string, { at: number; reason: string }>
}
const KEY = 'social-moderation'
const EVM = /^0x[0-9a-f]{40}$/
const DAY = 86_400_000

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string }
const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error })

export class Moderation {
  private comments = new Map<string, CommentRow>()
  private byTarget = new Map<string, CommentRow[]>()
  private reports = new Map<string, ReportRow>()
  private mutes = new Map<string, Map<string, number>>()
  private st: ModState = { hidden: {}, cleared: {}, banned: {} }

  constructor(private o: { store: ModerationStore; settings: Settings; audit: AuditStore; verify: VerifyAdmin; thesis?: ThesisReader | null }) {}

  async load() {
    const [c, r, m, s] = await Promise.all([
      this.o.store.socialComments().catch(e => { log.error('social: comments not loaded', { error: errMsg(e) }); return [] }),
      this.o.store.socialReports().catch(e => { log.error('social: reports not loaded', { error: errMsg(e) }); return [] }),
      this.o.store.socialMutes().catch(e => { log.error('social: mutes not loaded', { error: errMsg(e) }); return [] }),
      this.o.settings.getSetting(KEY).catch(() => null),
    ])
    for (const x of c) this.indexComment(x)
    for (const x of r) this.reports.set(`${x.reporter}|${x.target}`, x)
    for (const x of m) (this.mutes.get(x.muter) ?? this.mutes.set(x.muter, new Map()).get(x.muter)!).set(x.muted, x.at)
    if (s) {
      try {
        const j = JSON.parse(s) as Partial<ModState>
        this.st = { hidden: j.hidden ?? {}, cleared: j.cleared ?? {}, banned: j.banned ?? {} }
      } catch { /* keep the empty state */ }
    }
  }

  private indexComment(c: CommentRow) {
    const prev = this.comments.get(c.id)
    this.comments.set(c.id, c)
    const list = this.byTarget.get(c.target) ?? this.byTarget.set(c.target, []).get(c.target)!
    if (prev) list[list.indexOf(prev)] = c
    else list.push(c)
  }

  private async saveState() { await this.o.settings.setSetting(KEY, JSON.stringify(this.st)) }

  isBanned(address: string) { return !!this.st.banned[address.toLowerCase()] }
  private hidden(target: string) { return !!this.st.hidden[target] }

  /** What the site leaves out: hidden theses, and banned wallets (whose posts are hidden too). */
  state(): ModerationState {
    return {
      theses: Object.keys(this.st.hidden).filter(k => k.startsWith('thesis:')).map(k => Number(k.slice(7))).sort((a, b) => a - b),
      banned: Object.keys(this.st.banned).sort(),
    }
  }

  private view(c: CommentRow): CommentV {
    return c.deletedAt ? { id: c.id, target: c.target, author: c.author, body: '', at: c.at, deleted: true } : { id: c.id, target: c.target, author: c.author, body: c.body, at: c.at }
  }

  /** A target's comments, oldest first: hidden ones and banned authors' left out. */
  list(target: unknown, limit = 200): Result<CommentV[]> {
    const t = parseCommentTarget(target)
    if (!t) return fail(400, 'unknown target')
    const rows = (this.byTarget.get(t) ?? []).filter(c => !this.hidden(`comment:${c.id}`) && !this.isBanned(c.author))
    return { ok: true, value: rows.slice(-Math.max(1, Math.min(500, limit))).map(c => this.view(c)) }
  }

  /** How many comments each target has (visible ones), for a list of targets. */
  counts(targets: string[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const raw of targets.slice(0, 200)) {
      const t = parseCommentTarget(raw)
      if (t) out[t] = (this.byTarget.get(t) ?? []).filter(c => !c.deletedAt && !this.hidden(`comment:${c.id}`) && !this.isBanned(c.author)).length
    }
    return out
  }

  async comment(me: string, target: unknown, body: unknown, now = Date.now()): Promise<Result<CommentV>> {
    if (this.isBanned(me)) return fail(403, 'This wallet can’t post on ARCDEX')
    const t = parseCommentTarget(target)
    if (!t) return fail(400, 'unknown target')
    const text = cleanText(body, SOCIAL_LIMITS.commentChars)
    if (!text) return fail(400, `A comment is 1–${SOCIAL_LIMITS.commentChars} characters`)
    const mine = [...this.comments.values()].filter(c => c.author === me && c.at > now - DAY)
    if (mine.length >= SOCIAL_LIMITS.commentsPerDay) return fail(429, `Limit is ${SOCIAL_LIMITS.commentsPerDay} comments a day`)
    if (mine.some(c => now - c.at < SOCIAL_LIMITS.commentGapMs)) return fail(429, 'Wait a few seconds between comments')
    if (t.startsWith('thesis:')) {
      if (this.hidden(t)) return fail(404, 'That thesis is hidden')
      if (this.o.thesis) {
        const th = await this.o.thesis(Number(t.slice(7))).catch(() => undefined)
        if (th === null) return fail(404, 'No such thesis')
        if (th && this.isBanned(th.author)) return fail(404, 'That thesis is hidden')
      }
    }
    const row: CommentRow = { id: `c_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, target: t, author: me, body: text, at: now, deletedAt: null }
    await this.o.store.putComment(row)
    this.indexComment(row)
    return { ok: true, value: this.view(row) }
  }

  async deleteComment(me: string, id: unknown, now = Date.now()): Promise<Result<CommentV>> {
    const c = typeof id === 'string' ? this.comments.get(id) : undefined
    if (!c) return fail(404, 'No such comment')
    if (c.author !== me) return fail(403, 'Only its author can delete a comment')
    if (c.deletedAt) return { ok: true, value: this.view(c) }
    const row = { ...c, body: '', deletedAt: now }
    await this.o.store.putComment(row)
    this.indexComment(row)
    return { ok: true, value: this.view(row) }
  }

  /** Who wrote a target, and what it said (for a report's snapshot). */
  private async snapshot(t: ReportTarget): Promise<{ author: string | null; body: string | null } | null | 'missing'> {
    if (t.startsWith('comment:')) {
      const c = this.comments.get(t.slice(8))
      return c ? { author: c.author, body: c.deletedAt ? null : c.body } : 'missing'
    }
    if (t.startsWith('thesis:')) {
      if (!this.o.thesis) return null
      const th = await this.o.thesis(Number(t.slice(7))).catch(() => undefined)
      if (th === null) return 'missing'
      return th ? { author: th.author.toLowerCase(), body: th.body } : null
    }
    if (t.startsWith('profile:')) return { author: t.slice(8), body: null }
    return null
  }

  async report(me: string, target: unknown, reason: unknown, note: unknown, now = Date.now()): Promise<Result<{ hidden: boolean }>> {
    if (this.isBanned(me)) return fail(403, 'This wallet can’t report on ARCDEX')
    const t = parseReportTarget(target)
    if (!t || t.startsWith('coin:')) return fail(400, 'You can report a comment, a thesis or a profile')
    if (!isReportReason(reason)) return fail(400, `The reason is one of ${REPORT_REASONS.join(', ')}`)
    const text = note === undefined || note === null || note === '' ? null : cleanText(note, SOCIAL_LIMITS.noteChars)
    if (note && !text) return fail(400, `A note is at most ${SOCIAL_LIMITS.noteChars} characters`)
    const mine = [...this.reports.values()].filter(r => r.reporter === me && r.at > now - DAY)
    const key = `${me}|${t}`
    if (!this.reports.has(key) && mine.length >= SOCIAL_LIMITS.reportsPerDay) return fail(429, `Limit is ${SOCIAL_LIMITS.reportsPerDay} reports a day`)
    const snap = await this.snapshot(t)
    if (snap === 'missing') return fail(404, 'Nothing to report there')
    if (snap?.author === me) return fail(400, 'You can’t report yourself')
    const row: ReportRow = { reporter: me, target: t, reason, note: text, at: now, snapshot: this.reports.get(key)?.snapshot ?? snap }
    await this.o.store.putReport(row)
    this.reports.set(key, row)
    return { ok: true, value: { hidden: await this.autoHide(t, row.snapshot?.author ?? null, now) } }
  }

  /** Hides a comment or thesis once enough different wallets reported it, unless an admin cleared it. */
  private async autoHide(t: ReportTarget, author: string | null, now: number): Promise<boolean> {
    if (this.hidden(t)) return true
    if (t.startsWith('profile:') || this.st.cleared[t]) return false
    const reporters = new Set([...this.reports.values()].filter(r => r.target === t && r.reporter !== author && !this.isBanned(r.reporter)).map(r => r.reporter))
    if (reporters.size < SOCIAL_LIMITS.autoHideReporters) return false
    this.st.hidden[t] = { by: 'reports', at: now }
    await this.saveState().catch(e => log.error('social: moderation not saved', { error: errMsg(e) }))
    log.warn('social: hidden by reports', { target: t, reporters: reporters.size })
    return true
  }

  async mute(me: string, address: unknown, on: unknown, now = Date.now()): Promise<Result<MyView>> {
    const who = typeof address === 'string' ? address.toLowerCase() : ''
    if (!EVM.test(who) || who === me) return fail(400, 'Bad wallet')
    if (typeof on !== 'boolean') return fail(400, '"on" must be true or false')
    const mine = this.mutes.get(me) ?? this.mutes.set(me, new Map()).get(me)!
    if (on && !mine.has(who) && mine.size >= SOCIAL_LIMITS.mutesMax) return fail(429, `You can mute ${SOCIAL_LIMITS.mutesMax} wallets at most`)
    await this.o.store.setMute({ muter: me, muted: who, at: now }, on)
    if (on) mine.set(who, now)
    else mine.delete(who)
    return { ok: true, value: this.me(me) }
  }

  me(me: string): MyView {
    return {
      mutes: [...(this.mutes.get(me)?.keys() ?? [])],
      reports: [...this.reports.values()].filter(r => r.reporter === me).map(r => r.target),
    }
  }

  // ── Admins ──────────────────────────────────────────────────────────────

  /** Reported items, the ones waiting for a look first, then newest. */
  groups(limit = 200): ReportGroup[] {
    const by = new Map<string, ReportRow[]>()
    for (const r of this.reports.values()) (by.get(r.target) ?? by.set(r.target, []).get(r.target)!).push(r)
    const out: ReportGroup[] = []
    for (const [target, rows] of by) {
      const reasons: ReportGroup['reasons'] = {}
      for (const r of rows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
      const t = target as ReportTarget
      const author = rows.find(r => r.snapshot)?.snapshot?.author ?? null
      const banned = author ? this.isBanned(author) : false
      const state: ReportGroup['state'] = this.st.hidden[t] || (t.startsWith('profile:') && banned) ? 'hidden' : this.st.cleared[t]?.as ?? 'open'
      out.push({
        target: t, reports: rows.length, reasons, latest: Math.max(...rows.map(r => r.at)), state,
        snapshot: rows.find(r => r.snapshot)?.snapshot ?? null,
        notes: rows.sort((a, b) => b.at - a.at).slice(0, 10).map(r => ({ reporter: r.reporter, reason: r.reason, note: r.note, at: r.at })),
      })
    }
    return out.sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open') || b.latest - a.latest).slice(0, limit)
  }

  /** An admin's signed moderation, by the admin signed in as `session`. */
  async moderate(body: unknown, session: string, now = Date.now()): Promise<{ status: number; body: unknown }> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const action = b.action as ModerationAction
    if (!(MODERATION_ACTIONS as readonly string[]).includes(action as string)) return { status: 400, body: { error: `"action" is one of ${MODERATION_ACTIONS.join(', ')}` } }
    const target = parseReportTarget(b.target)
    if (!target || target.startsWith('coin:')) return { status: 400, body: { error: 'bad target' } }
    const ban = action === 'ban' || action === 'unban'
    if (ban !== target.startsWith('profile:')) return { status: 400, body: { error: ban ? 'ban and unban take a profile' : 'hide, restore and dismiss take a comment or a thesis' } }
    const reason = typeof b.reason === 'string' ? b.reason.replace(/\s+/g, ' ').trim() : ''
    if (reason.length < 3 || reason.length > 200) return { status: 400, body: { error: '"reason" must be 3 to 200 characters' } }
    const at = Number(b.at)
    if (!Number.isFinite(at) || typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return { status: 400, body: { error: 'sign the moderation message' } }
    const who = await this.o.verify(moderationMessage(action, target, reason, at), at, b.signature as Hex, now)
    if (typeof who === 'string') return { status: 403, body: { error: who } }
    if (who.by.toLowerCase() !== session.toLowerCase()) return { status: 403, body: { error: 'sign with the wallet you signed in with' } }
    const s = this.st
    if (action === 'hide') { s.hidden[target] = { by: 'admin', at: now, reason }; delete s.cleared[target] }
    if (action === 'restore' || action === 'dismiss') { delete s.hidden[target]; s.cleared[target] = { as: action === 'restore' ? 'restored' : 'dismissed', at: now } }
    if (action === 'ban') s.banned[target.slice(8)] = { at: now, reason }
    if (action === 'unban') delete s.banned[target.slice(8)]
    let saved = true
    await this.saveState().catch(e => { saved = false; log.error('social: moderation not saved', { error: errMsg(e) }) })
    await this.o.audit.appendAudit({ at: now, actor: who.by.toLowerCase(), action: `moderation.${action}`, detail: { target, reason } })
      .catch(e => log.error('social: moderation not audited', { error: errMsg(e) }))
    log.warn('social: moderated', { action, target, by: who.by })
    return { status: 200, body: { ok: true, saved, state: this.state() } }
  }
}

/** Comments, reports and mutes kept in memory (dev, tests). */
export class MemoryModerationStore implements ModerationStore {
  private c = new Map<string, CommentRow>()
  private r = new Map<string, ReportRow>()
  private m = new Map<string, MuteRow>()
  async socialComments() { return [...this.c.values()].map(x => ({ ...x })) }
  async putComment(x: CommentRow) { this.c.set(x.id, { ...x }) }
  async socialReports() { return [...this.r.values()].map(x => ({ ...x })) }
  async putReport(x: ReportRow) { this.r.set(`${x.reporter}|${x.target}`, { ...x }) }
  async socialMutes() { return [...this.m.values()].map(x => ({ ...x })) }
  async setMute(x: MuteRow, on: boolean) { const k = `${x.muter}|${x.muted}`; if (on) this.m.set(k, { ...x }); else this.m.delete(k) }
}
