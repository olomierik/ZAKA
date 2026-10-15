// Jupiter's Swap API V2 with ARCDEX's key, for Solana swaps (src/arcdex/lib/jupiter.ts, 2026-10-15).
// The key is a secret in Netlify's environment (JUPITER_API_KEY), never in the page. Only ARCDEX's own requests pass:
// from the site's own pages, an order (`GET /swap/v2/order`) with the parameters the site sends and ARCDEX's referral
// account, or the execution of a signed order (`POST /swap/v2/execute`). Without a key it answers 503 and the site
// trades through Relay as before.
//
// The referral account is VITE_JUP_REFERRAL_ACCOUNT, the same Netlify variable the site is built with. An order naming
// another referral account, a fee outside Jupiter's 50–255 bps, a receiver or a payer is refused: the output always goes
// to the taker, who pays their own gas or takes Jupiter's own sponsorship.

declare const Netlify: { env: { get(name: string): string | undefined } }

const UPSTREAM = 'https://api.jup.ag/swap/v2'
/** What an order may carry. */
const ORDER_PARAMS = new Set(['inputMint', 'outputMint', 'amount', 'taker', 'swapMode', 'slippageBps', 'referralAccount', 'referralFee'])
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** A signed transaction is at most 1,232 bytes: ~1.7 KB in base64, plus the request id. */
const MAX_EXECUTE_BODY = 8_192

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })

/** The referral account from the environment value, or null when it isn't a Solana address. */
export function referralFrom(raw: string | undefined): string | null {
  const v = String(raw ?? '').trim()
  return SOL_ADDRESS.test(v) ? v : null
}

/** The Jupiter path and query to forward, or why not. */
export function jupiterRequest(url: URL, headers: Headers, method: string, referral: string | null): { path: string } | { error: string; status: number } {
  // Browsers say where a request comes from; other sites' pages can't use the key.
  if (headers.get('sec-fetch-site') !== 'same-origin') return { error: 'not from this site', status: 403 }
  const path = url.pathname.replace(/^\/jup\/swap\/v2/, '')
  if (path === '/execute') {
    if (method !== 'POST' || [...url.searchParams.keys()].length) return { error: 'bad request', status: 400 }
    return { path: '/execute' }
  }
  if (path !== '/order') return { error: 'not served', status: 404 }
  if (method !== 'GET') return { error: 'GET only', status: 405 }
  const q = url.searchParams
  for (const k of q.keys()) if (!ORDER_PARAMS.has(k)) return { error: `${k} not served`, status: 400 }
  for (const k of ['inputMint', 'outputMint']) if (!SOL_ADDRESS.test(q.get(k) ?? '')) return { error: `bad ${k}`, status: 400 }
  if (!/^[1-9][0-9]{0,30}$/.test(q.get('amount') ?? '')) return { error: 'bad amount', status: 400 }
  const taker = q.get('taker')
  if (taker !== null && !SOL_ADDRESS.test(taker)) return { error: 'bad taker', status: 400 }
  const slip = q.get('slippageBps')
  if (slip !== null && !(/^[0-9]{1,5}$/.test(slip) && Number(slip) <= 10_000)) return { error: 'bad slippage', status: 400 }
  const ref = q.get('referralAccount')
  const fee = q.get('referralFee')
  if ((ref === null) !== (fee === null)) return { error: 'referral account and fee go together', status: 400 }
  if (ref !== null && (ref !== referral || !/^[0-9]{2,3}$/.test(fee ?? '') || Number(fee) < 50 || Number(fee) > 255)) return { error: 'fee not served', status: 400 }
  return { path: `/order?${q}` }
}

/** The body of an execution: exactly a signed transaction and the order's request id. */
export function executeBody(text: string): string | null {
  if (text.length > MAX_EXECUTE_BODY) return null
  try {
    const b = JSON.parse(text) as Record<string, unknown>
    const keys = Object.keys(b).sort().join(',')
    if (keys !== 'requestId,signedTransaction' && keys !== 'lastValidBlockHeight,requestId,signedTransaction') return null
    if (typeof b.signedTransaction !== 'string' || !/^[A-Za-z0-9+/=]{100,4096}$/.test(b.signedTransaction)) return null
    if (typeof b.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,200}$/.test(b.requestId)) return null
    if (b.lastValidBlockHeight !== undefined && !/^[0-9]{1,20}$/.test(String(b.lastValidBlockHeight))) return null
    return JSON.stringify(b)
  } catch { return null }
}

export default async (req: Request) => {
  const key = Netlify.env.get('JUPITER_API_KEY')?.trim()
  if (!key) return json(503, { error: 'not configured' })
  const url = new URL(req.url)
  const r = jupiterRequest(url, req.headers, req.method, referralFrom(Netlify.env.get('VITE_JUP_REFERRAL_ACCOUNT')))
  if ('error' in r) return json(r.status, { error: r.error })
  let body: string | undefined
  if (r.path === '/execute') {
    const b = executeBody(await req.text())
    if (!b) return json(400, { error: 'bad body' })
    body = b
  }
  try {
    const up = await fetch(UPSTREAM + r.path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-api-key': key, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
    })
    return new Response(up.body, {
      status: up.status,
      headers: { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'private, no-store', 'x-arcdex-jupiter': 'key' },
    })
  } catch {
    return json(502, { error: 'Jupiter did not answer' })
  }
}

export const config = { path: '/jup/swap/v2/*' }
