// /api/upload with Supabase mocked out (no network, nothing stored).
//   bun scripts/test-upload.ts
// Throwaway secrets for this process only; every Supabase call is answered
// by a fake that records what would have been written.
process.env.ARCDEX_SESSION_SECRET = 'test-secret-'.padEnd(48, 'x')
process.env.SUPABASE_URL = 'https://supabase.test'
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'

type Call = { url: string; method: string; body: unknown; type: string | null }
const calls: Call[] = []
const kv = new Map<string, unknown>()
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const method = init?.method ?? 'GET'
  const type = new Headers(init?.headers).get('content-type')
  calls.push({ url, method, body: init?.body, type })
  if (url.includes('/rest/v1/arcdex_kv') && method === 'GET') {
    const key = decodeURIComponent(/key=eq\.([^&]+)/.exec(url)?.[1] ?? '')
    return new Response(JSON.stringify(kv.has(key) ? [{ value: kv.get(key), updated_at: new Date().toISOString() }] : []))
  }
  if (url.includes('/rest/v1/arcdex_kv') && method === 'POST') {
    for (const r of JSON.parse(String(init?.body)) as { key: string; value: unknown }[]) kv.set(r.key, r.value)
    return new Response(null, { status: 201 })
  }
  if (url.includes('/rest/v1/')) return new Response('[]')
  if (url.endsWith('/storage/v1/bucket')) return new Response(JSON.stringify({ name: 'launchpad-media' }))
  if (url.includes('/storage/v1/object/')) return new Response(JSON.stringify({ Key: 'ok' }))
  return new Response('not mocked', { status: 500 })
}) as typeof fetch

const { issueToken } = await import('../api/_session')
const { default: handler } = await import('../api/upload')

let fails = 0
const check = (ok: boolean, msg: string, detail = '') => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg, ok ? '' : detail) }
const me = '0x' + 'ab'.repeat(20)
const { token } = await issueToken(me)
const post = (kind: string, body: BodyInit, auth = true, type = 'application/octet-stream') =>
  handler(new Request(`https://arcdex.online/api/upload?kind=${kind}`, { method: 'POST', body, headers: { 'Content-Type': type, ...(auth ? { Authorization: `Bearer ${token}` } : {}) } }))
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2])

console.log('auth')
check((await post('image', png, false)).status === 401, 'no session → 401')
check((await handler(new Request('https://arcdex.online/api/upload?kind=image', { method: 'POST', body: png, headers: { Authorization: 'Bearer forged.token' } }))).status === 401, 'forged session → 401')
check((await post('script', png)).status === 400, 'unknown kind → 400')

console.log('images')
const r1 = await post('image', png)
const j1 = await r1.json() as { url?: string }
check(r1.status === 200 && /^https:\/\/supabase\.test\/storage\/v1\/object\/public\/launchpad-media\/images\/0x(ab){20}\/\d+-[0-9a-f]{16}\.png$/.test(j1.url ?? ''), 'PNG → public URL under the wallet\'s folder', JSON.stringify(j1))
const stored = calls.find(c => c.url.includes('/storage/v1/object/launchpad-media/images/'))
check(stored?.type === 'image/png', 'stored with the sniffed type, not the one sent', String(stored?.type))
check(calls.some(c => c.url.endsWith('/storage/v1/bucket') && c.method === 'POST'), 'creates the bucket on first use')
check((await post('image', webp)).status === 200, 'WebP accepted')
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
check((await post('image', svg, true, 'image/png')).status === 415, 'SVG (even labelled image/png) → 415')
check((await post('image', new Uint8Array(2 * 1024 * 1024 + 10).fill(0x89))).status === 413, 'over 2 MB → 413')
check((await post('image', new Uint8Array(0))).status === 400, 'empty → 400')

console.log('metadata')
const r2 = await post('metadata', JSON.stringify({ name: 'Moon‮', symbol: 'MOON', image: 'javascript:alert(1)', website: 'https://moon.xyz', twitter: '@moon', extra: 'x'.repeat(50) }), true, 'application/json')
const metaCall = calls.filter(c => c.url.includes('/metadata/')).pop()
const saved = JSON.parse(String(metaCall?.body ?? '{}')) as Record<string, unknown>
check(r2.status === 200 && saved.name === 'Moon' && saved.symbol === 'MOON' && saved.image === undefined && saved.website === 'https://moon.xyz' && saved.twitter === '@moon' && !('extra' in saved), 'sanitized: bidi stripped, javascript: image dropped, unknown fields dropped', JSON.stringify(saved))
check((await post('metadata', JSON.stringify({ symbol: 'X' }), true, 'application/json')).status === 400, 'missing name → 400')
check((await post('metadata', '{not json', true, 'application/json')).status === 400, 'invalid JSON → 400')

console.log('daily limit')
const day = new Date().toISOString().slice(0, 10)
check(kv.get(`upload:${me}:${day}`) === 3, 'counts successful uploads only', String(kv.get(`upload:${me}:${day}`)))
kv.set(`upload:${me}:${day}`, 30)
check((await post('image', png)).status === 429, '31st upload of the day → 429')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
