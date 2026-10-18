// Hyperliquid's top traders (api/hlleaders.ts, 2026-10-11): what's kept of the 39 MB file, display names made safe,
// the first answer waiting for the build, later ones served at once, and the last good copy kept when Hyperliquid
// fails.
import { beforeEach, describe, expect, test } from 'bun:test'
import handler, { _reset, cleanName, summarize, type HlLeaders } from '../../api/hlleaders'
import { setKvStore, type KvStore } from '../../api/_supabaseAdmin'

/** An empty store of last good copies for each case: another test file's createSiteApi installs one for the whole
 * run, and a board saved there by one case would answer the next (CI, 2026-10-18). */
const freshKv = (): KvStore => { const m = new Map<string, { value: unknown; updatedAt: number }>(); return { get: async k => m.get(k) ?? null, set: async (k, value) => { m.set(k, { value, updatedAt: Date.now() }) } } }

const perf = (pnl: number, roi = 0.1, vlm = 1e6) => ({ pnl: String(pnl), roi: String(roi), vlm: String(vlm) })
const row = (i: number, value: number, pnls: [number, number, number, number], name: string | null = null) => ({
  ethAddress: `0x${i.toString(16).padStart(40, '0')}`, accountValue: String(value), displayName: name, prize: 0,
  windowPerformances: [['day', perf(pnls[0])], ['week', perf(pnls[1])], ['month', perf(pnls[2])], ['allTime', perf(pnls[3])]],
})
const file = (rows: unknown[]) => new Response(JSON.stringify({ leaderboardRows: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('what is kept', () => {
  test('the top 100 of each window by P&L, accounts of $10K or more, each trader once', () => {
    const rows = [
      ...Array.from({ length: 150 }, (_, i) => row(i + 1, 50_000, [i, 1000 - i, i * 2, i * 3])),
      row(999, 5_000, [1e9, 1e9, 1e9, 1e9]), // too small to count, however much it made
      row(998, 2e6, [-5, -5, -5, -5]), // lost money: never a leader
    ]
    const s = summarize(rows as never, 1)
    for (const w of ['day', 'week', 'month', 'allTime'] as const) {
      expect(s.top[w]).toHaveLength(100)
      const pnls = s.top[w].map(i => s.rows[i].w[w][0])
      expect(pnls).toEqual([...pnls].sort((a, b) => b - a))
      expect(pnls.every(p => p > 0)).toBe(true)
    }
    expect(s.rows.some(r => r.a.endsWith('3e7'))).toBe(false) // 999
    expect(s.rows.some(r => r.a.endsWith('3e6'))).toBe(false) // 998
    expect(new Set(s.rows.map(r => r.a)).size).toBe(s.rows.length)
    expect(s.traders).toBe(152)
    // day ranks the highest i first, week the lowest: different traders, both kept
    expect(s.rows[s.top.day[0]].a).toBe(`0x${(150).toString(16).padStart(40, '0')}`)
    expect(s.rows[s.top.week[0]].a).toBe(`0x${(1).toString(16).padStart(40, '0')}`)
  })
  test('display names: email addresses and links never show; control characters go; 24 characters at most', () => {
    expect(cleanName('beatmaker1@proton.me')).toBeNull()
    expect(cleanName('visit www.scam.example')).toBeNull()
    expect(cleanName('https://x.com/me')).toBeNull()
    expect(cleanName('mytrades.io')).toBeNull()
    expect(cleanName('Tom\u0000 Riddle')).toBe('Tom Riddle')
    expect(cleanName('A'.repeat(40))).toHaveLength(24)
    expect(cleanName('   ')).toBeNull()
    expect(cleanName(null)).toBeNull()
  })
})

describe('the route', () => {
  beforeEach(() => { _reset(); setKvStore(freshKv()) })
  test('the first answer waits for the file; the next is served from memory without fetching', async () => {
    let fetched = 0
    const f = (async () => { fetched++; return file([row(1, 20_000, [10, 10, 10, 10], 'Alice')]) }) as unknown as typeof fetch
    const a = await handler(undefined, undefined, f)
    expect(a.status).toBe(200)
    const body = (await a.json()) as HlLeaders
    expect(body.rows[0]).toMatchObject({ n: 'Alice', v: 20000 })
    expect(a.headers.get('Cache-Control')).toBe('public, max-age=60')
    await handler(undefined, undefined, f)
    expect(fetched).toBe(1)
  })
  test('a slow first build: "loading" (503, Retry-After) within the wait, the board on the next ask', async () => {
    const f = (async () => { await new Promise(r => setTimeout(r, 150)); return file([row(1, 20_000, [10, 10, 10, 10], 'Bob')]) }) as unknown as typeof fetch
    const first = await handler(undefined, undefined, f, 30)
    expect(first.status).toBe(503)
    expect(first.headers.get('Retry-After')).toBe('10')
    await new Promise(r => setTimeout(r, 250))
    const next = await handler(undefined, undefined, f, 30)
    expect(next.status).toBe(200)
    expect(((await next.json()) as HlLeaders & { complete: boolean })).toMatchObject({ complete: true, rows: [{ n: 'Bob' }] })
  })
  test('nothing at all: 503, not an empty board', async () => {
    const f = (async () => new Response('busy', { status: 502 })) as unknown as typeof fetch
    expect((await handler(undefined, undefined, f)).status).toBe(503)
  })
  test('a failed refresh keeps the last good copy', async () => {
    let ok = true
    const f = (async () => (ok ? file([row(1, 20_000, [10, 10, 10, 10], 'Alice')]) : new Response('down', { status: 500 }))) as unknown as typeof fetch
    expect((await handler(undefined, undefined, f)).status).toBe(200)
    ok = false
    const realNow = Date.now
    Date.now = () => realNow() + 11 * 60_000 // past the 10 minutes: a refresh starts behind the answer
    try {
      const r = await handler(undefined, undefined, f)
      expect(r.status).toBe(200)
      expect(((await r.json()) as HlLeaders).rows[0].n).toBe('Alice')
      await new Promise(res => setTimeout(res, 10))
      const again = await handler(undefined, undefined, f)
      expect(((await again.json()) as HlLeaders).rows[0].n).toBe('Alice')
    } finally { Date.now = realNow }
  })
})
