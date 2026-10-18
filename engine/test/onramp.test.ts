// Card deposits (api/onramp.ts), served by the engine since 2026-10-18: Circle's Onramp widget session, minted for the
// signed-in wallet only, with Circle's API stood in for.
import { describe, expect, test } from 'bun:test'
import { createOnramp } from '../../api/onramp'
import { createSiteApi } from '../src/site/siteApi'

const ME = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const KEY = 'TEST_API_KEY:abc:def'

function circle(reply: () => Response = () => Response.json({ data: { sessionToken: 'tok-1', sessionId: 's-1', expiresAt: '2026-10-18T06:30:00Z', internalNote: 'never forwarded' } })) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({ url: req.url, auth: req.headers.get('Authorization'), body: await req.json() as Record<string, unknown> })
    return reply()
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const signedIn = async (t: string | null) => (t === 'good' ? { address: ME, iat: 1 } : null)
const post = (token: string | null, body: unknown = {}) =>
  new Request('http://e/api/onramp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

describe('card deposits', () => {
  test('without a key: switched off, and says so', async () => {
    const h = createOnramp({ apiKey: null, verify: signedIn, revoked: async () => false })
    expect(await (await h(new Request('http://e/api/onramp'))).json()).toEqual({ enabled: false, sandbox: false })
    const r = await h(post('good'))
    expect(r.status).toBe(503)
  })

  test('a session for the signed-in wallet only, framed by arcsense.site, USDC on Arc', async () => {
    const c = circle()
    const h = createOnramp({ apiKey: KEY, fetch: c.fetch, verify: signedIn, revoked: async () => false })
    expect(await (await h(new Request('http://e/api/onramp'))).json()).toEqual({ enabled: true, sandbox: false })
    // The body can't name another wallet: it's ignored.
    const r = await h(post('good', { destinationAddress: OTHER, appUserId: OTHER, referrerDomain: 'evil.example' }))
    expect(r.status).toBe(200)
    expect(c.calls).toHaveLength(1)
    const [call] = c.calls
    expect(call.url).toMatch(/^https:\/\/api\.circle\.com\/v1\/stablecoinKits\/sessions$/)
    expect(call.auth).toBe(`Bearer ${KEY}`)
    expect(call.body).toMatchObject({ appUserId: ME, walletAddress: ME, referrerDomain: 'arcsense.site' })
    expect(JSON.stringify(call.body)).not.toContain(OTHER)
    const j = await r.json() as { session: Record<string, unknown>; widgetBaseUrl: string }
    expect(j.widgetBaseUrl).toBe('https://onramp.arc.io')
    expect(j.session.sessionToken).toBe('tok-1')
    expect(j.session.internalNote).toBeUndefined()
    const url = new URL(String(j.session.widgetUrl))
    expect(url.origin).toBe('https://onramp.arc.io')
    expect(url.searchParams.get('destinationWallet')).toBe(ME)
    expect(url.searchParams.get('pairs')).toBe('USDC:arc')
    expect(r.headers.get('Cache-Control')).not.toMatch(/s-maxage/)
  })

  test('sandbox: Circle\'s test API and widget; a referrer domain from Railway', async () => {
    const c = circle()
    const h = createOnramp({ apiKey: KEY, sandbox: true, referrerDomain: 'www.example.com', fetch: c.fetch, verify: signedIn, revoked: async () => false })
    const r = await h(post('good'))
    expect(c.calls[0].url).toStartWith('https://api-test.circle.com/')
    expect(c.calls[0].body.referrerDomain).toBe('www.example.com')
    expect((await r.json() as { widgetBaseUrl: string }).widgetBaseUrl).toBe('https://onramp-sandbox.arc.io')
  })

  test('refused: not signed in, signed out of all devices; Circle\'s refusals passed on', async () => {
    const c = circle()
    const h = createOnramp({ apiKey: KEY, fetch: c.fetch, verify: signedIn, revoked: async () => false })
    expect((await h(post(null))).status).toBe(401)
    expect((await h(post('forged'))).status).toBe(401)
    const out = createOnramp({ apiKey: KEY, fetch: c.fetch, verify: signedIn, revoked: async () => true })
    expect((await out(post('good'))).status).toBe(401)
    expect(c.calls).toHaveLength(0)
    const busy = createOnramp({ apiKey: KEY, fetch: circle(() => Response.json({ message: 'slow down' }, { status: 429 })).fetch, verify: signedIn, revoked: async () => false })
    expect((await busy(post('good'))).status).toBe(429)
    expect((await h(new Request('http://e/api/onramp', { method: 'PUT' }))).status).toBe(405)
  })

  test('the engine serves it as a write: never cached, marked as served by the engine', async () => {
    const api = createSiteApi({ databaseUrl: null, indexEveryMs: 0, warm: false })
    expect(api.names).toContain('onramp')
    const r = await api.handle(new Request('http://e/api/onramp'), new URL('http://e/api/onramp'))
    expect(r.status).toBe(200)
    expect(r.headers.get('X-Arcdex-Served-By')).toBe('engine')
    expect(await r.json()).toHaveProperty('enabled')
  })
})
