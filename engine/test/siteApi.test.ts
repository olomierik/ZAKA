// The site's read functions served by the engine (engine/src/site/siteApi.ts, 2026-10-02): the CDN's part (caching,
// stale-while-revalidate, shared in-flight requests), GeckoTerminal metering, the holder index's rules, last good
// copies, and the routes.
import { describe, expect, test } from 'bun:test'
import { createSiteApi, meteredFetch, memoryHolders, ResponseCache, SiteKv } from '../src/site/siteApi'

const res = (body: string, cache: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache } })

describe('the response cache (what Vercel\'s CDN did)', () => {
  test('fresh for its s-maxage, then stale for its stale-while-revalidate while one request refreshes it', async () => {
    let t = 0, made = 0
    const c = new ResponseCache(100, () => t)
    const make = async () => res(String(++made), 'public, s-maxage=10, stale-while-revalidate=60')
    expect((await c.get('k', make))).toMatchObject({ from: 'miss', res: { body: '1' } })
    t = 5_000
    expect((await c.get('k', make))).toMatchObject({ from: 'fresh', res: { body: '1' } })
    t = 20_000
    const stale = await c.get('k', make)
    expect(stale).toMatchObject({ from: 'stale', res: { body: '1' } }) // answered at once…
    await new Promise(r => setTimeout(r, 5))
    expect((await c.get('k', make)).res.body).toBe('2') // …refreshed behind it
    t = 200_000
    expect((await c.get('k', make))).toMatchObject({ from: 'miss', res: { body: '3' } }) // past stale-while-revalidate: wait
  })
  test('identical requests in flight share one answer; no-store and errors are not kept', async () => {
    let made = 0
    const c = new ResponseCache()
    let release!: () => void
    const slow = () => new Promise<Response>(r => { release = () => r(res('x', 'no-store')); made++ })
    const a = c.get('k', slow), b = c.get('k', slow)
    release()
    expect([(await a).res.body, (await b).res.body]).toEqual(['x', 'x'])
    expect(made).toBe(1)
    expect(c.size).toBe(0) // no-store
    await c.get('e', async () => res('{"error":1}', 'public, s-maxage=60', 502))
    expect(c.size).toBe(0) // an error is never cached
  })
})

describe('GeckoTerminal metering', () => {
  test('so many calls a minute; over that, a 429 the callers fall back on', async () => {
    let t = 0, sent = 0
    const f = meteredFetch(2, 0, async () => { sent++; return new Response('{}') }, () => t)
    expect((await f('x')).status).toBe(200)
    expect((await f('x')).status).toBe(200)
    expect((await f('x')).status).toBe(429)
    expect(sent).toBe(2)
    t = 30_000 // half a minute: one more
    expect((await f('x')).status).toBe(200)
  })
})

describe('the holder index (the SQL function\'s rules, in memory)', () => {
  test('applies a range\'s deltas, refuses an out-of-order range, drops emptied balances, counts holders', async () => {
    const h = memoryHolders()
    expect(await h.applyDeltas('0xt', 100, 99, 150, { '0xa': '500', '0xb': '300' })).toBe(2)
    expect(await h.applyDeltas('0xt', 100, 99, 160, { '0xa': '1' })).toBe(-1) // another request got there first
    expect(await h.applyDeltas('0xt', 100, 150, 200, { '0xb': '-300', '0xc': '50' })).toBe(2)
    expect(await h.readScan('0xt')).toEqual({ token: '0xt', from_block: 100, scanned_to: 200, holders: 2 })
    expect(await h.top('0xt', 10)).toEqual([{ holder: '0xa', balance: '500' }, { holder: '0xc', balance: '50' }])
  })
})

describe('last good copies', () => {
  test('kept in memory (and the engine\'s Postgres when there is one), the oldest dropped past the cap', async () => {
    const kv = new SiteKv(null, Promise.resolve(), 2)
    await kv.set('a', { n: 1 }); await kv.set('b', 2); await kv.set('c', 3)
    expect(await kv.get('a')).toBeNull()
    expect((await kv.get('c'))?.value).toBe(3)
  })
})

describe('the routes', () => {
  test('a known function: cached, public CORS, marked as served by the engine; unknown: a 404 the browser falls back on', async () => {
    let calls = 0
    const api = createSiteApi({ databaseUrl: null, indexEveryMs: 0, warm: false, handlers: { argus: async () => { calls++; return res('{"pools":[]}', 'public, s-maxage=20') }, boom: () => { throw new Error('x') } } })
    const get = (p: string) => api.handle(new Request(`http://e${p}`), new URL(`http://e${p}`))
    const r1 = await get('/api/argus'), r2 = await get('/api/argus')
    expect(r1.status).toBe(200)
    expect(await r2.text()).toBe('{"pools":[]}')
    expect(calls).toBe(1)
    expect(r2.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(r2.headers.get('X-Arcdex-Served-By')).toBe('engine')
    expect(r2.headers.get('X-Arcdex-Cache')).toBe('fresh')
    expect(r2.headers.get('Access-Control-Expose-Headers')).toMatch(/X-Arcdex-Served-By/)
    const missing = await get('/api/session')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('X-Arcdex-Served-By')).toBeNull()
    expect((await get('/api/boom')).status).toBe(500)
    expect((await api.handle(new Request('http://e/api/argus', { method: 'POST' }), new URL('http://e/api/argus'))).status).toBe(405)
  })
  test('query order doesn\'t split the cache', async () => {
    let calls = 0
    const api = createSiteApi({ databaseUrl: null, indexEveryMs: 0, warm: false, handlers: { gecko: async () => { calls++; return res('{}', 'public, s-maxage=10') } } })
    await api.handle(new Request('http://e/api/gecko?a=1&b=2'), new URL('http://e/api/gecko?a=1&b=2'))
    await api.handle(new Request('http://e/api/gecko?b=2&a=1'), new URL('http://e/api/gecko?b=2&a=1'))
    expect(calls).toBe(1)
  })
})
