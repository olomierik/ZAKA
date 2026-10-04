// Across's API with ARCSENSE's key, for the Robinhood Chain trades (src/arcdex/lib/acrossQuote.ts).
// The key is a secret in Netlify's environment (ACROSS_API_KEY), never in the page; the integrator
// ID can sit there too (ACROSS_INTEGRATOR_ID). Only ARCSENSE's own requests pass: from the site's
// own pages, a quote between Arc and Robinhood Chain whose fee (if any) goes to ARCSENSE's fee
// wallet, or a deposit's status. Without a key it answers 503 and the site asks Across directly.

declare const Netlify: { env: { get(name: string): string | undefined } }

const UPSTREAM = 'https://app.across.to/api'
const FEE_WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const CHAINS = new Set(['5042', '4663'])

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })

/** The Across path and query to forward, or why not. */
export function acrossRequest(url: URL, headers: Headers): { path: string } | { error: string; status: number } {
  // Browsers say where a request comes from; other sites' pages can't use the key.
  if (headers.get('sec-fetch-site') !== 'same-origin') return { error: 'not from this site', status: 403 }
  const path = url.pathname.replace(/^\/across/, '')
  const q = url.searchParams
  if (path === '/deposit/status') {
    const ref = q.get('depositTxnRef') ?? ''
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref) || [...q.keys()].length !== 1) return { error: 'bad request', status: 400 }
    return { path: `/deposit/status?depositTxnRef=${ref}` }
  }
  if (path !== '/swap/approval') return { error: 'not served', status: 404 }
  const from = q.get('originChainId') ?? ''
  const to = q.get('destinationChainId') ?? ''
  if (!CHAINS.has(from) || !CHAINS.has(to) || from === to) return { error: 'route not served', status: 400 }
  const fee = q.get('appFee')
  if (fee !== null && (!(Number(fee) >= 0 && Number(fee) <= 0.02) || (q.get('appFeeRecipient') ?? '').toLowerCase() !== FEE_WALLET)) {
    return { error: 'fee not served', status: 400 }
  }
  return { path: `/swap/approval?${q}` }
}

export default async (req: Request) => {
  if (req.method !== 'GET') return json(405, { error: 'GET only' })
  const key = Netlify.env.get('ACROSS_API_KEY')?.trim()
  if (!key) return json(503, { error: 'not configured' })
  const url = new URL(req.url)
  const r = acrossRequest(url, req.headers)
  if ('error' in r) return json(r.status, { error: r.error })
  let path = r.path
  const id = Netlify.env.get('ACROSS_INTEGRATOR_ID')?.trim()
  if (id && /^0x[0-9a-fA-F]{4}$/.test(id) && path.startsWith('/swap/approval') && !url.searchParams.has('integratorId')) path += `&integratorId=${id}`
  try {
    const up = await fetch(UPSTREAM + path, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
    return new Response(up.body, {
      status: up.status,
      headers: { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'private, no-store', 'x-arcsense-across': 'key' },
    })
  } catch {
    return json(502, { error: 'Across did not answer' })
  }
}

export const config = { path: '/across/*' }
