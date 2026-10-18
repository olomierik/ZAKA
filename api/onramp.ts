// Card deposits: buy USDC on Arc with a debit card, Apple Pay or Google Pay
// (bank transfer in some regions) through Circle's Onramp widget.
//
//   GET  /api/onramp   → { enabled, sandbox }         (is it configured?)
//   POST /api/onramp   (Authorization: Bearer <session token>)
//                      → { session, widgetBaseUrl }  (30-minute widget session;
//                        the user picks the amount inside the widget)
//
// The widget handles KYC and payment; USDC lands directly in the signed-in
// wallet on Arc. A session can only ever deliver to the caller's own
// address — the body can't name another destination.
//
// Served by the market engine (engine/src/site/siteApi.ts, 2026-10-18): the site on Netlify serves only its files.
//
// Owner setup (Railway → arcdex-engine → Variables):
//   CIRCLE_ONRAMP_API_KEY   Circle Console API key (server secret; CIRCLE_API_KEY also works)
//   ONRAMP_SANDBOX=1        optional: use Circle's sandbox (test money)
//   ONRAMP_REFERRER_DOMAIN  optional: the host the page is served from (default arcsense.site)
// Debit card / Apple Pay / Google Pay also need KYB completed in the
// Circle Console with arcsense.site registered as the web URL.

import { createOnrampServerKit, KitError } from '@circle-fin/onramp-kit/server'
import { bearer, verifySession } from './_session'
import { json, sessionRevoked } from './_supabaseAdmin'

declare const process: { env: Record<string, string | undefined> }

export const config = { runtime: 'nodejs' }

export interface OnrampOptions {
  apiKey: string | null
  sandbox?: boolean
  /** The exact host the page is served from: the widget's frame-ancestors allowlist is built from it. */
  referrerDomain?: string
  /** Tests: a stand-in for Circle's API, and for the site's wallet sessions. */
  fetch?: typeof globalThis.fetch
  verify?: (token: string | null) => Promise<{ address: string; iat: number } | null>
  revoked?: (address: string, iat: number) => Promise<boolean>
}

const STATUS: Record<string, number> = { INPUT: 400, RATE_LIMIT: 429, NETWORK: 504, SERVICE: 502, RPC: 502 }

export function createOnramp(o: OnrampOptions): (req: Request) => Promise<Response> {
  const sandbox = !!o.sandbox
  const widgetBaseUrl = sandbox ? 'https://onramp-sandbox.arc.io' : 'https://onramp.arc.io'
  const verify = o.verify ?? verifySession
  const revoked = o.revoked ?? sessionRevoked
  const kit = o.apiKey
    ? createOnrampServerKit({
        apiKey: o.apiKey,
        // Fixed server-side (never from the request). www.arcsense.site and arcdex.online both redirect to
        // arcsense.site, so that's the host the widget is framed by.
        referrerDomain: o.referrerDomain || 'arcsense.site',
        widgetBaseUrl,
        ...(sandbox ? { baseUrl: 'https://api-test.circle.com' } : {}),
        ...(o.fetch ? { fetch: o.fetch } : {}),
      })
    : null

  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'GET' || req.method === 'HEAD') return json(200, { enabled: Boolean(kit), sandbox }, 'public, s-maxage=60')
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
    if (!kit) return json(503, { error: 'Card deposits are not switched on yet' })
    const session = await verify(bearer(req))
    if (!session) return json(401, { error: 'Sign in with your wallet first' })
    if (await revoked(session.address, session.iat)) return json(401, { error: 'You signed out of all devices — sign in again' })

    try {
      const s = await kit.createSession({
        appUserId: session.address,
        destinationAddress: session.address,
        assets: { pairs: [{ token: 'USDC', chain: 'arc' }] },
      })
      return json(200, { session: s, widgetBaseUrl })
    } catch (e) {
      if (e instanceof KitError) return json(STATUS[e.type] ?? 500, { error: e.message })
      return json(500, { error: 'Could not start a card deposit — try again' })
    }
  }
}

const handler = createOnramp({
  apiKey: (process.env.CIRCLE_ONRAMP_API_KEY || process.env.CIRCLE_API_KEY || '').trim() || null,
  sandbox: process.env.ONRAMP_SANDBOX === '1',
  referrerDomain: process.env.ONRAMP_REFERRER_DOMAIN?.trim(),
})

export default handler
export const GET = handler
export const POST = handler
