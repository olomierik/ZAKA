// The social layer's site side and its independent check (the build pack's Phase 6):
//  - scripts/verify-pnl.ts (its own decoder and exact fractions) agrees with the engine's verified PnL
//    (engine/src/social/pnl.ts) on the same router events, and catches an engine that's a cent off;
//  - comments and theses are shown as text: markup in them never becomes HTML (doc 06: "XSS on user content");
//  - a banned wallet can't post through /api/social, and can still do what others don't read;
//  - the `comments` flag: on by default, an admin can turn it off.
//   bun scripts/test-social.tsx
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import type { RawLog, Trade } from './verify-pnl'

process.env.ARCDEX_SESSION_SECRET = 'test-secret-for-the-social-check-0123456789abcdef'
process.env.SUPABASE_URL = 'https://supabase.stub'
process.env.SUPABASE_SECRET_KEY = 'sb_secret_stub'

const V = await import('./verify-pnl')
const E = await import('../engine/src/social/pnl')
const { SITE_FLAGS } = await import('../api/_marketProtocol')
const { cleanText } = await import('../api/_socialProtocol')

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

// ── the same router events, read by both ─────────────────────────────────────
const ROUTER = V.ROUTERS[1] as Hex
const USDC = V.USDC as Hex
const COINS = ['0x00000000000000000000000000000000000c0101', '0x00000000000000000000000000000000000c0102', '0x00000000000000000000000000000000000c0103'] as Hex[]
const TRADER = '0x00000000000000000000000000000000000a11ce' as Hex
let seed = 7
const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
const big = (lo: number, hi: number) => BigInt(Math.floor(lo + rnd() * (hi - lo)))

function event(i: number, block: number, buy: boolean, coin: Hex, usdc: bigint, tokens: bigint, fee: bigint): RawLog & { blockTimestamp: string } {
  const topics = encodeEventTopics({ abi: V.SWAPPED_ABI, eventName: 'Swapped', args: { user: TRADER, tokenIn: buy ? USDC : coin, tokenOut: buy ? coin : USDC } }) as Hex[]
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [buy ? usdc : tokens, buy ? tokens : usdc, USDC, fee])
  return { address: ROUTER, topics, data, transactionHash: `0x${i.toString(16).padStart(64, '0')}`, blockNumber: `0x${block.toString(16)}`, logIndex: '0x0', blockTimestamp: `0x${(1_800_000_000 + (block - 30_000_000)).toString(16)}` }
}

function history(n: number) {
  const logs: ReturnType<typeof event>[] = []
  const held = new Map<Hex, bigint>()
  let block = 30_000_000
  for (let i = 0; i < n; i++) {
    block += Math.floor(1 + rnd() * 3_000)
    const coin = COINS[Math.floor(rnd() * COINS.length)]
    const h = held.get(coin) ?? 0n
    const buy = h === 0n || rnd() < 0.55
    if (buy) {
      const tokens = big(1, 9e9) * 10n ** 9n
      held.set(coin, h + tokens)
      logs.push(event(i, block, true, coin, big(1_000, 5e8), tokens, big(0, 1e6)))
    } else {
      // Sometimes more than was bought here (tokens sent in from elsewhere), sometimes all, usually part.
      const r = rnd()
      const tokens = r < 0.1 ? h + big(1, 1e9) * 10n ** 9n : r < 0.3 ? h : (h * big(1, 999)) / 1000n || 1n
      held.set(coin, h > tokens ? h - tokens : 0n)
      logs.push(event(i, block, false, coin, big(1, 9e8), tokens, big(0, 1e6)))
    }
  }
  return logs
}

const engineStats = (logs: ReturnType<typeof event>[], since: number) => E.statsOf(E.decodeTrades(logs), since)
const timeOf = (logs: ReturnType<typeof event>[]) => { const m = new Map(logs.map(l => [parseInt(l.blockNumber, 16), parseInt(l.blockTimestamp, 16) * 1000])); return (b: number) => m.get(b)! }

console.log('the independent check reads the same trades')
{
  const logs = history(60)
  const mine = V.decodeSwapped(logs, timeOf(logs)), theirs = E.decodeTrades(logs)
  check(mine.length === theirs.length && mine.every((t, i) => t.id === theirs[i].id && t.token === theirs[i].token && (t.buy ? 'buy' : 'sell') === theirs[i].side && t.usdc === theirs[i].usdc && t.tokens === theirs[i].tokens && t.at === theirs[i].at), 'its decoder and the engine’s give the same trades')
  const other = { ...logs[0], address: '0x0000000000000000000000000000000000000bad' }
  const coinToCoin = event(999, 30_999_999, true, COINS[0], 5n, 5n, 0n)
  coinToCoin.topics[2] = coinToCoin.topics[3]
  check(V.decodeSwapped([other, coinToCoin, logs[0], logs[0]], timeOf(logs)).length === 1, 'another contract’s event, a coin-for-coin swap and a repeated event are left out')
}

console.log('random histories: the engine matches the exact recomputation, every window')
{
  let windows = 0, ok = 0, maxDiff = 0
  for (let k = 0; k < 120; k++) {
    const logs = history(5 + Math.floor(rnd() * 70))
    const trades = V.decodeSwapped(logs, timeOf(logs))
    const last = trades[trades.length - 1].at
    // A window starting exactly at a trade's time includes that trade.
    for (const since of [0, last - 86_400_000, last - 3_600_000 * Math.floor(1 + rnd() * 30), trades[Math.floor(rnd() * trades.length)].at, last + 1]) {
      windows++
      const exact = V.exactStats(trades, since)
      const f = V.compare(engineStats(logs, since), exact)
      if (f.every(x => x.ok)) ok++
      else console.log('    ', f.filter(x => !x.ok))
      maxDiff = Math.max(maxDiff, Math.abs(Number(BigInt(engineStats(logs, since).realized.replace('.', ''))) - exact.realized.micro()))
    }
  }
  check(ok === windows, `${ok} of ${windows} windows agree (largest realized difference ${maxDiff.toFixed(2)} µUSDC)`)
}

console.log('it catches an engine that is off')
{
  const logs = history(40)
  const trades = V.decodeSwapped(logs, timeOf(logs))
  const exact = V.exactStats(trades, 0)
  const good = engineStats(logs, 0)
  const cent = (d: string, by: bigint) => { const v = BigInt(d.replace('.', '')) + by; const s = (v < 0n ? -v : v).toString().padStart(7, '0'); return `${v < 0n ? '-' : ''}${s.slice(0, -6)}.${s.slice(-6)}` }
  const bad = (patch: Partial<typeof good>) => !V.compare({ ...good, ...patch }, exact).every(x => x.ok)
  check(V.compare(good, exact).every(x => x.ok), 'the engine’s own numbers pass')
  check(bad({ realized: cent(good.realized, 10_000n) }), 'realized a cent high: caught')
  check(bad({ realized: cent(good.realized, -10_000n) }), 'realized a cent low: caught')
  check(bad({ volume: cent(good.volume, 1n) }), 'volume a micro-USDC off: caught')
  check(bad({ trades: good.trades - 1 }) && bad({ sells: good.sells + 1 }) && bad({ counted: good.counted + 1 }), 'a trade, sale or counted sale missing or extra: caught')
  check(bad({ unmatched: cent(good.unmatched, 10_000n) }), 'unmatched proceeds a cent off: caught')
  const shuffled = E.statsOf([...E.decodeTrades(logs)].reverse(), 0)
  check(V.compare(shuffled, exact).every(x => x.ok), 'the engine’s trades handed over in reverse read the same (chain order decides)')
}

console.log('exact fractions')
{
  const t = (block: number, buy: boolean, usdc: bigint, tokens: bigint): Trade => ({ id: `${block}`, block, logIndex: 0, trader: TRADER, token: COINS[0], buy, usdc, tokens, at: block })
  const s = V.exactStats([t(1, true, 100n, 3n), t(2, false, 40n, 1n), t(3, false, 40n, 1n), t(4, false, 40n, 1n)], 0)
  check(s.realized.n === 20n && s.realized.d === 1n, 'three thirds of a $100 cost sold for $40 each: exactly +20')
  const u = V.exactStats([t(1, true, 100n, 2n), t(2, false, 90n, 3n)], 0)
  check(u.realized.n === -40n && u.unmatched.n === 30n && u.counted === 1, 'selling 3 of which 2 were bought here: 60 against 100, 30 unmatched')
}

// ── comments and theses are text ─────────────────────────────────────────────
console.log('user content is shown as text, never as HTML')
{
  const { CommentItem } = await import('../src/arcdex/components/CommentThread')
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">x</a>'
  const html = renderToStaticMarkup(<CommentItem c={{ id: 'c_1', target: 'coin:arc:0x4b93446882d29e094181b2fae14b126577a2676c', author: '0x00000000000000000000000000000000000fa4a1', body: evil, at: Date.now(), deleted: false }} size={28} trader={{ address: null, kind: null, signMessage: async () => '0x' as Hex }} navigate={() => {}} onDelete={() => {}} onError={() => {}} />)
  check(html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&lt;script&gt;'), 'a comment’s markup is escaped')
  check(!/<img[^>]*onerror|<script|href="javascript:/i.test(html), 'no image, script or javascript: link comes out of it')
  check(cleanText('a\u0000b‮c​d\n\n\n\ne', 280) === 'abcd\n\ne', 'control, direction and zero-width characters are stripped before storing')
  for (const f of ['src/arcdex/components/CommentThread.tsx', 'src/arcdex/components/SocialMenu.tsx', 'src/arcdex/components/TokenSocialTabs.tsx', 'src/arcdex/components/FeedList.tsx', 'src/arcdex/components/AdminViews.tsx', 'src/arcdex/pages/TraderPage.tsx', 'src/arcdex/pages/LeaderboardPage.tsx']) {
    check(!/dangerouslySetInnerHTML|innerHTML/.test(readFileSync(f, 'utf8')), `${f}: no raw HTML`)
  }
  check(/\{t\.body\}/.test(readFileSync('src/arcdex/components/TokenSocialTabs.tsx', 'utf8')) && /\{t\.body\}/.test(readFileSync('src/arcdex/pages/TraderPage.tsx', 'utf8')), 'theses are rendered as text nodes')
}

// ── a banned wallet can't post ───────────────────────────────────────────────
console.log('a banned wallet can’t post through /api/social')
{
  const writes: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://supabase.stub')) {
      if ((init?.method ?? 'GET') !== 'GET') writes.push(url)
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  }) as typeof fetch
  const { issueToken } = await import('../api/_session')
  const social = await import('../api/social')
  const BANNED = '0x00000000000000000000000000000000000fa4a1', OK = '0x0000000000000000000000000000000000000b0b'
  social.setSocialGuard(me => (me === BANNED ? 'This wallet can’t post on ARCDEX' : null))
  const post = async (who: string, body: Record<string, unknown>) => social.default(new Request('https://x/api/social', { method: 'POST', headers: { authorization: `Bearer ${(await issueToken(who)).token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  for (const action of ['thesis', 'profile', 'clan.create', 'clan.update', 'transfer.note']) {
    writes.length = 0
    const r = await post(BANNED, { action, token: COINS[0], body: 'buy now', username: 'scammer', slug: 'x', name: 'x', tx_hash: `0x${'1'.repeat(64)}`, note: 'x' })
    check(r.status === 403 && writes.length === 0, `${action}: refused (403), nothing written`)
  }
  writes.length = 0
  const unfollow = await post(BANNED, { action: 'unfollow', target: OK })
  check(unfollow.status === 200, 'it can still unfollow (nobody reads that)')
  const ok = await post(OK, { action: 'unfollow', target: BANNED })
  check(ok.status === 200, 'another wallet isn’t affected')
  social.setSocialGuard(null)
  globalThis.fetch = realFetch
}

// ── the flag ─────────────────────────────────────────────────────────────────
console.log('the comments flag')
{
  check(SITE_FLAGS.comments?.protective === false, 'a site flag /admin can turn off (not a protection)')
  check(/comments:\s*true/.test(readFileSync('src/arcdex/lib/flags.ts', 'utf8')), 'on by default')
  const tabs = readFileSync('src/arcdex/components/TokenSocialTabs.tsx', 'utf8')
  check(/useFlag\('comments'\)/.test(tabs), 'the coin page’s comments follow it')
}

if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
