// Card deposits through MoonPay: Visa or Mastercard (and Apple Pay / Google Pay where MoonPay offers them) buy USDC
// that MoonPay sends straight to the signed-in wallet on Arc (its currency `usdc_arc`).
//
// Added 2026-10-18 beside Circle's widget (api/onramp.ts): Circle's payment partner offers no payment method in
// Tanzania ("Unavailable in Tanzania"), while MoonPay's country list allows buying there.
//
//   GET  /api/moonpay   → { enabled, sandbox }
//   POST /api/moonpay   (Authorization: Bearer <session token>) → { url }: MoonPay's checkout for this wallet, signed
//
// MoonPay requires a signature whenever the URL names the wallet: an HMAC-SHA256 of the query string under the
// secret key, base64, appended last. Without it (or with the wallet changed) MoonPay's page refuses to load, so the
// wallet in a signed URL can't be swapped for another. The secret never leaves the engine.
//
// Owner setup (Railway → arcdex-engine → Variables), from MoonPay's dashboard (Developers → API keys):
//   MOONPAY_PUBLISHABLE_KEY  pk_live_… (pk_test_… opens MoonPay's sandbox, test cards only)
//   MOONPAY_SECRET_KEY       sk_live_… (or sk_test_…, matching the publishable key)
// MoonPay must also approve the account for live payments, with arcsense.site as the site.

import { bearer, verifySession } from './_session'
import { json, sessionRevoked } from './_supabaseAdmin'

declare const process: { env: Record<string, string | undefined> }

export const config = { runtime: 'nodejs' }

/** MoonPay's code for USDC on Arc (its /v3/currencies, checked 2026-10-18). */
export const MOONPAY_CURRENCY = 'usdc_arc'

export interface MoonpayOptions {
  publishableKey: string | null
  secretKey: string | null
  /** Where MoonPay sends the buyer back after paying. */
  redirectUrl?: string
  /** Tests: a stand-in for the site's wallet sessions. */
  verify?: (token: string | null) => Promise<{ address: string; iat: number } | null>
  revoked?: (address: string, iat: number) => Promise<boolean>
}

/** MoonPay's signature: base64 HMAC-SHA256 of the query string (from its "?"), keyed by the secret key. */
export async function moonpaySignature(search: string, secretKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(search)))
  let bin = ''
  for (const b of mac) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The signed checkout URL for one wallet. */
export async function moonpayUrl(o: { publishableKey: string; secretKey: string; wallet: string; redirectUrl?: string }): Promise<string> {
  const host = o.publishableKey.startsWith('pk_test_') ? 'https://buy-sandbox.moonpay.com' : 'https://buy.moonpay.com'
  const q = new URLSearchParams({
    apiKey: o.publishableKey,
    currencyCode: MOONPAY_CURRENCY,
    walletAddress: o.wallet,
    externalCustomerId: o.wallet,
    baseCurrencyCode: 'usd',
    ...(o.redirectUrl ? { redirectURL: o.redirectUrl } : {}),
  })
  const url = new URL(`${host}/?${q}`)
  return `${url.toString()}&signature=${encodeURIComponent(await moonpaySignature(url.search, o.secretKey))}`
}

export function createMoonpay(o: MoonpayOptions): (req: Request) => Promise<Response> {
  const pk = o.publishableKey?.trim() || null
  const sk = o.secretKey?.trim() || null
  // A publishable key and a secret key from the same mode, or nothing (a mismatched pair only makes MoonPay refuse).
  const enabled = !!pk && !!sk && /^pk_(live|test)_/.test(pk) && /^sk_(live|test)_/.test(sk) && pk.startsWith('pk_test_') === sk.startsWith('sk_test_')
  const sandbox = enabled && pk!.startsWith('pk_test_')
  const verify = o.verify ?? verifySession
  const revoked = o.revoked ?? sessionRevoked

  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'GET' || req.method === 'HEAD') return json(200, { enabled, sandbox }, 'public, s-maxage=60')
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
    if (!enabled) return json(503, { error: 'Card deposits through MoonPay are not switched on yet' })
    const session = await verify(bearer(req))
    if (!session) return json(401, { error: 'Sign in with your wallet first' })
    if (await revoked(session.address, session.iat)) return json(401, { error: 'You signed out of all devices — sign in again' })
    const url = await moonpayUrl({ publishableKey: pk!, secretKey: sk!, wallet: session.address, redirectUrl: o.redirectUrl })
    return json(200, { url, sandbox })
  }
}

const handler = createMoonpay({
  publishableKey: process.env.MOONPAY_PUBLISHABLE_KEY ?? null,
  secretKey: process.env.MOONPAY_SECRET_KEY ?? null,
  redirectUrl: process.env.MOONPAY_REDIRECT_URL || 'https://arcsense.site/portfolio',
})

export default handler
