// The admin panel's routes (the build pack's Phase 4; 03 §6 "Admin: nonce, verify, live, fees, fees/claim, audit, kill").
//
//   POST /v1/admin/auth/nonce | verify | logout | logout-all     sign-in (admin/auth.ts)
//   GET  /v1/admin/me                                           the signed-in admin
//   GET  /v1/admin/live                                         who's online, by section; admin sessions; bots; the switch
//   GET  /v1/admin/fees                                         the fee ledger, what the sweeper would act on, its runs
//   POST /v1/admin/sweep          {mode:'dry'} | {mode:'real', at, signature}   the fee sweeper (admin/sweeper.ts)
//   GET  /v1/admin/trades                                       ARCDEX's own trades, newest first, and the last 24 hours
//   GET  /v1/admin/audit                                        the append-only audit log
//   POST /v1/admin/flags          {flag, on, reason, at, signature}             runtime flags (admin/flags.ts)
//   GET  /v1/flags                                              the flags an admin set, public (the site reads them)
//   GET  /v1/admin/reports                                      reported comments, theses and profiles (social/moderation.ts)
//   POST /v1/admin/moderate       {action, target, reason, at, signature}      hide, restore, dismiss, ban, unban
//   GET  /v1/admin/copy                                         copy trading: wallets, rules, fees owed, how fast copies land
//   GET  /v1/admin/analytics?days=30                            sign-ins, traders, trades, volume, fees, by day (analytics.ts)
// The kill switch stays where it was (POST /v1/trading/control, a signed change that needs no session, so it works in an
// emergency). Everything under /v1/admin needs a live session (Authorization: Bearer …) except the sign-in itself; reads
// change nothing, and each change (a real sweep, a flag) also needs the admin's signature of exactly that change.

import { isHex, type Hex } from 'viem'
import { sweepRunMessage } from '../../../api/_marketProtocol'
import type { AdminAuth } from './auth'
import type { FeatureFlags } from './flags'
import type { Sweeper } from './sweeper'
import type { AuditEntry } from '../site/tradeSwitch'
import type { FeeLedger } from '../fees/ledger'
import type { Traffic } from '../traffic'
import type { TradeSwitch } from '../site/tradeSwitch'
import type { VerifyAdmin } from '../site/tradeSwitch'
import type { Moderation } from '../social/moderation'
import type { Analytics } from '../analytics'
import { errMsg, log } from '../log'

export interface AdminTrade { tx: string; at: number; trader: string; token: string; side: 'buy' | 'sell'; usd: number; feeUsd: number; venue: string }
export interface AdminTrades { source: 'supabase' | 'ledger'; rows: AdminTrade[]; day: { trades: number; volumeUsd: number; feesUsd: number } }

export interface AdminApiOptions {
  auth: AdminAuth
  origins: readonly string[]
  audit: { audit(limit: number): Promise<AuditEntry[]> }
  verify: VerifyAdmin
  flags: FeatureFlags | null
  sweeper: Sweeper | null
  ledger: FeeLedger | null
  traffic: Traffic | null
  tradeSwitch: TradeSwitch | null
  trades: (() => Promise<AdminTrades>) | null
  moderation?: Moderation | null
  copy?: () => { adminView(): unknown } | null
  analytics?: Analytics | null
  bots: (() => { bots: number; running: number; live: number }) | null
}

export interface AdminResponse { status: number; body: unknown; cache?: string }

export class AdminApi {
  constructor(private o: AdminApiOptions) {}

  /** null when `url` isn't an admin route. */
  async handle(req: Request, url: URL, ip: string, ctx: { wsClients: number } = { wsClients: 0 }): Promise<AdminResponse | null> {
    const path = url.pathname
    if (path === '/v1/flags' && req.method === 'GET') {
      return this.o.flags ? { status: 200, body: this.o.flags.state(), cache: 'public, max-age=30' } : { status: 503, body: { error: 'flags are not running in this process' } }
    }
    if (!path.startsWith('/v1/admin/')) return null
    const origin = req.headers.get('origin')
    const post = req.method === 'POST'
    if (post) {
      if (origin && !this.o.origins.includes(origin)) return { status: 403, body: { error: 'admin requests come from the site' } }
      if (Number(req.headers.get('content-length') ?? 0) > 4_096) return { status: 413, body: { error: 'too large' } }
    }
    const body = post ? await req.json().catch(() => null) : null
    const auth = this.o.auth
    try {
      if (post && path === '/v1/admin/auth/nonce') {
        const r = auth.nonce(body, origin, ip)
        return 'status' in r ? { status: r.status, body: { error: r.error } } : { status: 200, body: r }
      }
      if (post && path === '/v1/admin/auth/verify') {
        const r = await auth.verify(body, origin, ip, req.headers.get('user-agent'))
        return 'status' in r ? { status: r.status, body: { error: r.error } } : { status: 200, body: r }
      }
      if (post && path === '/v1/admin/auth/logout') return { status: 200, body: { ok: await auth.logout(req.headers.get('authorization')) } }

      // Everything else needs a session.
      const s = auth.session(req.headers.get('authorization'))
      if (!s) return { status: 401, body: { error: 'sign in as an admin first (or your session ended)' } }

      if (post && path === '/v1/admin/auth/logout-all') return { status: 200, body: { ended: await auth.logoutAll(s.address) } }
      if (!post && path === '/v1/admin/me') return { status: 200, body: { address: s.address, expiresAt: s.expiresAt } }
      if (!post && path === '/v1/admin/live') {
        const t = this.o.traffic
        return {
          status: 200,
          body: {
            at: Date.now(),
            traffic: t ? await t.counts() : null,
            sections: t ? t.sections() : null,
            sockets: ctx.wsClients,
            admins: auth.active(),
            bots: this.o.bots?.() ?? null,
            trading: this.o.tradeSwitch?.state() ?? null,
          },
        }
      }
      if (!post && path === '/v1/admin/fees') {
        const [summary, plan, runs] = await Promise.all([
          this.o.ledger?.summary() ?? null,
          this.o.sweeper ? this.o.sweeper.plan().catch(e => ({ error: errMsg(e).slice(0, 200) })) : null,
          this.o.sweeper ? this.o.sweeper.recent(20) : [],
        ])
        return { status: 200, body: { summary, plan, runs } }
      }
      if (post && (path === '/v1/admin/sweep' || path === '/v1/admin/fees/claim')) {
        const sw = this.o.sweeper
        if (!sw) return { status: 503, body: { error: 'the sweeper is not running in this process' } }
        const b = (body ?? {}) as { mode?: unknown; at?: unknown; signature?: unknown }
        const mode = path === '/v1/admin/fees/claim' ? 'real' : b.mode
        if (mode === 'dry') return { status: 200, body: { run: await sw.run('dry', s.address) } }
        if (mode !== 'real') return { status: 400, body: { error: '"mode" must be "dry" or "real"' } }
        const at = Number(b.at)
        if (!Number.isFinite(at) || typeof b.signature !== 'string' || !isHex(b.signature)) return { status: 400, body: { error: 'a real run needs {at, signature}: sign the sweep message' } }
        const who = await this.o.verify(sweepRunMessage(at), at, b.signature as Hex, Date.now())
        if (typeof who === 'string') return { status: 403, body: { error: who } }
        if (who.by.toLowerCase() !== s.address.toLowerCase()) return { status: 403, body: { error: 'sign with the wallet you signed in with' } }
        return { status: 200, body: { run: await sw.run('real', s.address) } }
      }
      if (!post && path === '/v1/admin/trades') {
        if (!this.o.trades) return { status: 503, body: { error: 'trades are not readable in this process' } }
        return { status: 200, body: await this.o.trades() }
      }
      if (!post && path === '/v1/admin/audit') {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
        return { status: 200, body: { entries: await this.o.audit.audit(limit) } }
      }
      if (post && path === '/v1/admin/flags') {
        if (!this.o.flags) return { status: 503, body: { error: 'flags are not running in this process' } }
        const r = await this.o.flags.change(body, s.address)
        return { status: r.status, body: r.body }
      }
      if (!post && path === '/v1/admin/copy') {
        const copy = this.o.copy?.()
        if (!copy) return { status: 503, body: { error: 'copy trading is not running in this process' } }
        return { status: 200, body: copy.adminView(), cache: 'no-store' }
      }
      if (!post && path === '/v1/admin/analytics') {
        if (!this.o.analytics) return { status: 503, body: { error: 'analytics aren’t running in this process' } }
        const days = Number(url.searchParams.get('days')) || 30
        return { status: 200, body: await this.o.analytics.report(days), cache: 'no-store' }
      }
      if (!post && path === '/v1/admin/reports') {
        if (!this.o.moderation) return { status: 503, body: { error: 'the social layer is not running in this process' } }
        return { status: 200, body: { reports: this.o.moderation.groups(), state: this.o.moderation.state() } }
      }
      if (post && path === '/v1/admin/moderate') {
        if (!this.o.moderation) return { status: 503, body: { error: 'the social layer is not running in this process' } }
        const r = await this.o.moderation.moderate(body, s.address)
        return { status: r.status, body: r.body }
      }
      return { status: 404, body: { error: 'not found' } }
    } catch (e) {
      log.error('admin route failed', { path, error: errMsg(e) })
      return { status: 500, body: { error: 'something went wrong; try again' } }
    }
  }
}
