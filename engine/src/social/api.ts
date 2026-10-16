// The social layer's routes (the build pack's Phase 6; 03 §5: "GET /traders/:id, GET /feed, GET /leaderboard").
//
//   GET  /v1/social/board?period=7d&limit=100   the verified leaderboard: realized PnL from the router trade book,
//                                               wash-trade flagged wallets left out (and listed)
//   GET  /v1/social/trader/:address             a wallet's verified numbers for every period, its rank, its PnL chart,
//                                               its coins, and the wash-trade flag if it has one
//   GET  /v1/social/flags                       every flagged wallet and why (the site leaves them out of its other boards)
//   GET  /v1/social/checks                      the trade book's nightly checks against the chain
//   GET  /v1/social/comments?target=…           a thesis's or a coin's comments
//   GET  /v1/social/counts?targets=a,b          how many comments each target has
//   GET  /v1/social/moderation                  hidden theses and banned wallets (the site leaves them out)
//   GET  /v1/social/me                          (signed in) my mutes and what I reported
//   POST /v1/social/comment {target, body}      (signed in)
//   POST /v1/social/comment/delete {id}         (signed in, the author)
//   POST /v1/social/report {target, reason, note?}   (signed in)
//   POST /v1/social/mute {address, on}          (signed in)
//
// "Signed in" is the site's wallet session (api/_session.ts: the wallet signed a sign-in message; Authorization:
// Bearer <token>), honouring "sign out of all devices". Writes come from the site's own pages only.

import { isSocialPeriod } from '../../../api/_socialProtocol'
import { bearer, verifySession } from '../../../api/_session'
import type { SocialBoards } from './boards'
import type { TradeBook } from './book'
import type { Moderation } from './moderation'
import { errMsg, log } from '../log'

export interface SocialResponse { status: number; body: unknown; cache?: string }

export interface SocialApiOptions {
  book: TradeBook
  boards: SocialBoards
  moderation: Moderation
  origins: readonly string[]
  /** Whether a session was ended by "sign out of all devices" (the site's Supabase), false when unknown. */
  revoked?: (address: string, iat: number) => Promise<boolean>
  /** The wallet a session token was issued to (default: api/_session.ts). */
  session?: (token: string | null) => Promise<{ address: string; iat: number } | null>
}

const EVM = /^0x[0-9a-fA-F]{40}$/

export class SocialApi {
  constructor(private o: SocialApiOptions) {}

  private async me(req: Request): Promise<string | null> {
    const s = await (this.o.session ?? verifySession)(bearer(req))
    if (!s) return null
    if (this.o.revoked && await this.o.revoked(s.address, s.iat).catch(() => false)) return null
    return s.address
  }

  /** null when `url` isn't a social route. */
  async handle(req: Request, url: URL): Promise<SocialResponse | null> {
    const path = url.pathname
    if (!path.startsWith('/v1/social/')) return null
    const route = path.slice('/v1/social/'.length)
    const post = req.method === 'POST'
    try {
      if (!post) {
        if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
        if (route === 'board') {
          const period = url.searchParams.get('period') ?? '7d'
          if (!isSocialPeriod(period)) return { status: 400, body: { error: 'period is 24h, 7d, 30d or all' } }
          const limit = Number(url.searchParams.get('limit')) || 100
          return { status: 200, body: await this.o.boards.board(period, limit), cache: 'public, max-age=20' }
        }
        const tm = /^trader\/(0x[0-9a-fA-F]{40})$/.exec(route)
        if (tm) return { status: 200, body: await this.o.boards.trader(tm[1]), cache: 'public, max-age=15' }
        if (route === 'flags') return { status: 200, body: { at: Date.now(), flags: [...this.o.boards.flags().values()] }, cache: 'public, max-age=60' }
        if (route === 'checks') return { status: 200, body: { scannedTo: await this.o.book.scannedTo(), checkedTo: await this.o.book.checkedTo(), trades: this.o.book.size, checks: await this.o.book.checks() }, cache: 'public, max-age=60' }
        if (route === 'comments') {
          const r = this.o.moderation.list(url.searchParams.get('target'), Number(url.searchParams.get('limit')) || 200)
          return r.ok ? { status: 200, body: { comments: r.value }, cache: 'no-store' } : { status: r.status, body: { error: r.error } }
        }
        if (route === 'counts') return { status: 200, body: { counts: this.o.moderation.counts((url.searchParams.get('targets') ?? '').split(',').filter(Boolean)) }, cache: 'public, max-age=10' }
        if (route === 'moderation') return { status: 200, body: this.o.moderation.state(), cache: 'public, max-age=30' }
        if (route === 'me') {
          const me = await this.me(req)
          return me ? { status: 200, body: this.o.moderation.me(me), cache: 'no-store' } : { status: 401, body: { error: 'Sign in with your wallet first' } }
        }
        return { status: 404, body: { error: 'not found' } }
      }

      const origin = req.headers.get('origin')
      if (!origin || !this.o.origins.includes(origin)) return { status: 403, body: { error: 'social writes come from the site' } }
      if (Number(req.headers.get('content-length') ?? 0) > 4_096) return { status: 413, body: { error: 'too large' } }
      const me = await this.me(req)
      if (!me) return { status: 401, body: { error: 'Sign in with your wallet first' } }
      const b = await req.json().catch(() => null) as Record<string, unknown> | null
      if (!b || typeof b !== 'object') return { status: 400, body: { error: 'expected a JSON object' } }
      const m = this.o.moderation
      const r = route === 'comment' ? await m.comment(me, b.target, b.body)
        : route === 'comment/delete' ? await m.deleteComment(me, b.id)
        : route === 'report' ? await m.report(me, b.target, b.reason, b.note)
        : route === 'mute' ? await m.mute(me, typeof b.address === 'string' && EVM.test(b.address) ? b.address : '', b.on)
        : null
      if (!r) return { status: 404, body: { error: 'not found' } }
      return r.ok ? { status: 200, body: r.value, cache: 'no-store' } : { status: r.status, body: { error: r.error } }
    } catch (e) {
      log.error('social route failed', { path, error: errMsg(e) })
      return { status: 500, body: { error: 'something went wrong; try again' } }
    }
  }
}
