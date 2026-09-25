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
// Owner setup (Vercel → project `app` → env):
//   CIRCLE_ONRAMP_API_KEY   Circle Console API key (server secret)
//   ONRAMP_SANDBOX=1        optional: use Circle's sandbox (test money)
// Debit card / Apple Pay / Google Pay also need KYB completed in the
// Circle Console with arcdex.online registered as the web URL.

import { createOnrampServerKit, KitError } from '@circle-fin/onramp-kit/server'
import { bearer, verifySession } from './_session'
import { json, sessionRevoked } from './_supabaseAdmin'

declare const process: { env: Record<string, string | undefined> }

export const config = { runtime: 'nodejs' }

const API_KEY = process.env.CIRCLE_ONRAMP_API_KEY ?? process.env.CIRCLE_API_KEY
const SANDBOX = process.env.ONRAMP_SANDBOX === '1'
const WIDGET_BASE_URL = SANDBOX ? 'https://onramp-sandbox.arc.io' : 'https://onramp.arc.io'
// Fixed server-side (never from the request): the widget's frame-ancestors
// allowlist is built from it.
const REFERRER_DOMAIN = process.env.ONRAMP_REFERRER_DOMAIN ?? 'arcdex.online'

const kit = API_KEY
  ? createOnrampServerKit({
      apiKey: API_KEY,
      referrerDomain: REFERRER_DOMAIN,
      widgetBaseUrl: WIDGET_BASE_URL,
      ...(SANDBOX ? { baseUrl: 'https://api-test.circle.com' } : {}),
    })
  : null

const STATUS: Record<string, number> = { INPUT: 400, RATE_LIMIT: 429, NETWORK: 504, SERVICE: 502, RPC: 502 }

export async function GET(): Promise<Response> {
  return json(200, { enabled: Boolean(kit), sandbox: SANDBOX }, 'public, s-maxage=60')
}

export async function POST(req: Request): Promise<Response> {
  if (!kit) return json(503, { error: 'Card deposits are not switched on yet' })
  const session = await verifySession(bearer(req))
  if (!session) return json(401, { error: 'Sign in with your wallet first' })
  if (await sessionRevoked(session.address, session.iat)) return json(401, { error: 'You signed out of all devices — sign in again' })

  try {
    const s = await kit.createSession({
      appUserId: session.address,
      destinationAddress: session.address,
      assets: { pairs: [{ token: 'USDC', chain: 'arc' }] },
    })
    return json(200, { session: s, widgetBaseUrl: WIDGET_BASE_URL })
  } catch (e) {
    if (e instanceof KitError) return json(STATUS[e.type] ?? 500, { error: e.message })
    return json(500, { error: 'Could not start a card deposit — try again' })
  }
}
