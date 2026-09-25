// Upstream selection for /api/gecko, /api/argus and /api/arcd (api/_geckoterminal.ts).
//   bun scripts/test-geckoterminal.ts
// The tier logic runs against a mocked upstream (CoinGecko's real error
// shapes); then one live request per upstream that can be reached: the free
// GeckoTerminal API always, and CoinGecko too if COINGECKO_API_KEY is set here.
import { createUpstream } from '../api/_geckoterminal'

let fails = 0
const check = (ok: boolean, msg: string, detail = '') => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg, ok ? '' : detail) }

type Call = { url: string; headers: Record<string, string> }
/** A fake upstream: `answer` decides each response from the URL and headers. */
function mock(answer: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = []
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const c = { url, headers: init?.headers ?? {} }
    calls.push(c)
    const a = answer(c)
    return new Response(JSON.stringify(a.body), { status: a.status })
  }) as unknown as typeof fetch
  return { f, calls }
}
const PATH = '/networks/arc/pools/0xabc?include=base_token'
const OK = { status: 200, body: { data: { id: 'arc_0xabc' } } }
// CoinGecko's answers (status + body) for a key it won't take.
const DEMO_ON_PRO = { status: 400, body: { status: { error_code: 10011, error_message: 'If you are using Demo API key, please change your root URL from pro-api.coingecko.com to api.coingecko.com' } } }
const BAD_KEY = { status: 401, body: { status: { error_code: 10002, error_message: 'Invalid API Key' } } }
const isPro = (c: Call) => c.url.startsWith('https://pro-api.coingecko.com/api/v3/onchain/')
const isDemo = (c: Call) => c.url.startsWith('https://api.coingecko.com/api/v3/onchain/')
const isFree = (c: Call) => c.url.startsWith('https://api.geckoterminal.com/api/v2/')

console.log('no key')
{
  const { f, calls } = mock(() => OK)
  const up = createUpstream(undefined, f)
  const r = await up.fetch(PATH)
  check(r.ok && up.upstream() === 'geckoterminal', 'uses the free GeckoTerminal API')
  check(isFree(calls[0]) && calls[0].url.endsWith(PATH), 'same path on api.geckoterminal.com/api/v2', calls[0]?.url)
  check(!Object.keys(calls[0].headers).some(h => h.startsWith('x-cg')), 'sends no key header')
  const blank = createUpstream('   ', f)
  check(blank.upstream() === 'geckoterminal', 'a blank key counts as no key')
}

console.log('Pro key')
{
  const { f, calls } = mock(c => isPro(c) && c.headers['x-cg-pro-api-key'] === 'CG-pro' ? OK : BAD_KEY)
  const up = createUpstream(' CG-pro\n', f)
  const r = await up.fetch(PATH)
  check(r.ok && up.upstream() === 'coingecko-pro', 'served by pro-api.coingecko.com (key trimmed)')
  check(calls.length === 1, 'one request, no probing')
}

console.log('Demo key')
{
  const { f, calls } = mock(c => isPro(c) ? DEMO_ON_PRO : isDemo(c) && c.headers['x-cg-demo-api-key'] === 'CG-demo' ? OK : BAD_KEY)
  const up = createUpstream('CG-demo', f)
  const r = await up.fetch(PATH)
  check(r.ok && up.upstream() === 'coingecko-demo', 'pro-api refuses it, api.coingecko.com with x-cg-demo-api-key serves it')
  await up.fetch(PATH)
  check(calls.length === 3 && isDemo(calls[2]), 'later requests go straight to Demo', calls.map(c => c.url).join(' '))
}

console.log('rejected key')
{
  const { f, calls } = mock(c => isFree(c) ? OK : BAD_KEY)
  const up = createUpstream('CG-expired', f)
  const r = await up.fetch(PATH)
  check(r.ok && up.upstream() === 'geckoterminal', 'falls back to the free API instead of failing')
  check(!Object.keys(calls[calls.length - 1].headers).some(h => h.startsWith('x-cg')), 'and never sends the key there')
}

console.log('errors that are not about the key')
{
  const { f } = mock(c => isPro(c) ? { status: 429, body: { status: { error_code: 429, error_message: "You've exceeded the Rate Limit" } } } : OK)
  const up = createUpstream('CG-pro', f)
  const r = await up.fetch(PATH)
  check(r.status === 429 && up.upstream() === 'coingecko-pro', 'a 429 is passed on, the tier stays Pro')
  const nf = mock(c => isPro(c) ? { status: 404, body: { errors: [{ status: '404', title: 'Not Found' }] } } : OK)
  const up2 = createUpstream('CG-pro', nf.f)
  check((await up2.fetch(PATH)).status === 404 && up2.upstream() === 'coingecko-pro', 'a 404 is passed on, the tier stays Pro')
}

console.log('concurrent requests')
{
  const { f } = mock(c => isPro(c) ? DEMO_ON_PRO : isDemo(c) ? OK : BAD_KEY)
  const up = createUpstream('CG-demo', f)
  const rs = await Promise.all(Array.from({ length: 20 }, () => up.fetch(PATH)))
  check(rs.every(r => r.ok) && up.upstream() === 'coingecko-demo', '20 at once step down to Demo once, not past it')
}

console.log('live')
{
  const POOL = '/networks/arc/pools/0x87b65f8831a8f3ba17da44003fae5294476b9a5c7ac5da53485a44dd12af9897?include=base_token' // $ARCD/USDC
  const free = createUpstream(undefined)
  const r = await free.fetch(POOL, { signal: AbortSignal.timeout(10_000) }).catch(e => e as Error)
  if (r instanceof Response && r.status === 429) console.log('  – free API throttled this IP just now (not a failure of this code)')
  else check(r instanceof Response && r.ok, 'free GeckoTerminal API answers for the $ARCD pool', String(r instanceof Response ? r.status : r))
  if (process.env.COINGECKO_API_KEY) {
    const paid = createUpstream(process.env.COINGECKO_API_KEY)
    const p = await paid.fetch(POOL, { signal: AbortSignal.timeout(10_000) })
    check(p.ok && paid.upstream() !== 'geckoterminal', `COINGECKO_API_KEY works (${paid.upstream()})`, `status ${p.status}, upstream ${paid.upstream()}`)
  } else console.log('  – COINGECKO_API_KEY not set here: CoinGecko not tried')
}

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
