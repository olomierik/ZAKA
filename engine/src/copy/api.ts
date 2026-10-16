// Copy trading's routes (the build pack's Phase 7; copy/engine.ts has the design).
//
//   GET  /v1/copy/status                 on or off and why, the terms version, ARCDEX's fee, the limits, and how fast
//                                        copies land (the share within COPY.windowMs, p50 and p95)
//   GET  /v1/copy/leaders?limit=         wallets that can be copied (the verified board, LEADER_MIN, no wash flag), with
//                                        how many follow each
//   GET  /v1/copy/me                     (signed in) my copy wallet, rules, the latest copies and what's under way
//   GET  /v1/copy/destinations           (signed in) where a withdrawal may go: me, or a wallet that funded the copy wallet
//   POST /v1/copy/open {at, signature}   (signed in) accept the terms, signed by the wallet; makes the copy wallet
//   POST /v1/copy/rules {leader, maxPerTradeUsd, slippageBps, safety, enabled}   (signed in) one rule per leader
//   POST /v1/copy/rules/delete {id}      (signed in)
//   POST /v1/copy/stop {stopped}         (signed in) the stop switch: every rule paused at once
//   POST /v1/copy/withdraw {to, amountUsd, at, signature}   (signed in, and signed by the wallet)
//
// "Signed in" is the site's wallet session (api/_session.ts), as for the social routes. Writes come from the site's
// own pages only. Accepting the terms and withdrawing also need the wallet's own signature of exactly that action.

import { bearer, verifySession } from '../../../api/_session'
import type { CopyEngine } from './engine'
import { errMsg, log } from '../log'

export interface CopyResponse { status: number; body: unknown; cache?: string }

export interface CopyApiOptions {
  engine: CopyEngine
  origins: readonly string[]
  revoked?: (address: string, iat: number) => Promise<boolean>
  session?: (token: string | null) => Promise<{ address: string; iat: number } | null>
}

export class CopyApi {
  constructor(private o: CopyApiOptions) {}

  private async me(req: Request): Promise<string | null> {
    const s = await (this.o.session ?? verifySession)(bearer(req))
    if (!s) return null
    if (this.o.revoked && await this.o.revoked(s.address, s.iat).catch(() => false)) return null
    return s.address.toLowerCase()
  }

  /** null when `url` isn't a copy route. */
  async handle(req: Request, url: URL): Promise<CopyResponse | null> {
    const path = url.pathname
    if (!path.startsWith('/v1/copy/')) return null
    const route = path.slice('/v1/copy/'.length)
    const e = this.o.engine
    try {
      if (req.method === 'GET') {
        if (route === 'status') return { status: 200, body: e.status(), cache: 'public, max-age=10' }
        if (route === 'leaders') return { status: 200, body: { leaders: await e.leaders(Math.min(100, Number(url.searchParams.get('limit')) || 50)) }, cache: 'public, max-age=30' }
        if (route === 'me' || route === 'destinations') {
          const me = await this.me(req)
          if (!me) return { status: 401, body: { error: 'Sign in with your wallet first' } }
          if (route === 'me') return { status: 200, body: { ...(await e.me(me)), inFlight: e.inFlight(me) }, cache: 'no-store' }
          return { status: 200, body: { destinations: await e.destinations(me) }, cache: 'no-store' }
        }
        return { status: 404, body: { error: 'not found' } }
      }
      if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
      const origin = req.headers.get('origin')
      if (!origin || !this.o.origins.includes(origin)) return { status: 403, body: { error: 'copy trading changes come from the site' } }
      if (Number(req.headers.get('content-length') ?? 0) > 4_096) return { status: 413, body: { error: 'too large' } }
      const me = await this.me(req)
      if (!me) return { status: 401, body: { error: 'Sign in with your wallet first' } }
      const b = await req.json().catch(() => null) as Record<string, unknown> | null
      if (!b || typeof b !== 'object') return { status: 400, body: { error: 'expected a JSON object' } }
      const r = route === 'open' ? await e.open(me, b)
        : route === 'rules' ? await e.setRule(me, b)
        : route === 'rules/delete' ? await e.deleteRule(me, b)
        : route === 'stop' ? await e.setStopped(me, b)
        : route === 'withdraw' ? await e.withdraw(me, b)
        : null
      if (!r) return { status: 404, body: { error: 'not found' } }
      return { ...r, cache: 'no-store' }
    } catch (err) {
      log.error('copy route failed', { path, error: errMsg(err) })
      return { status: 500, body: { error: 'something went wrong; try again' } }
    }
  }
}
