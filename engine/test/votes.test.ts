// Community sentiment on each coin (votes.ts): one vote per visitor per coin, switch or take it back, rate-limited,
// and only from the site's own pages (the route).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { MemoryVoteStore, Votes, VOTES, coinOf } from '../src/votes'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('error')
const ARC = '0x' + 'a'.repeat(40)
const SOL = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'
const voter = (n: number) => `v-${String(n).padStart(20, '0')}`

describe('votes', () => {
  test('one vote per visitor per coin: switching moves it, the same pick again takes it back', async () => {
    const v = new Votes(new MemoryVoteStore())
    expect(await v.vote('arc', ARC, voter(1), 'rocket', '1.1.1.1')).toEqual({ counts: { rocket: 1, fire: 0, poop: 0, flag: 0 } })
    expect(await v.vote('arc', ARC, voter(2), 'rocket', '2.2.2.2')).toEqual({ counts: { rocket: 2, fire: 0, poop: 0, flag: 0 } })
    expect(await v.vote('arc', ARC, voter(1), 'flag', '1.1.1.1')).toEqual({ counts: { rocket: 1, fire: 0, poop: 0, flag: 1 } })
    expect(await v.vote('arc', ARC, voter(1), null, '1.1.1.1')).toEqual({ counts: { rocket: 1, fire: 0, poop: 0, flag: 0 } })
    // An address in capitals is the same coin.
    expect(await v.counts('arc', ARC.toUpperCase().replace('0X', '0x'))).toEqual({ rocket: 1, fire: 0, poop: 0, flag: 0 })
    // Another chain's coin is its own.
    expect(await v.counts('solana', SOL)).toEqual({ rocket: 0, fire: 0, poop: 0, flag: 0 })
  })
  test('malformed coins, voters and votes are refused', async () => {
    const v = new Votes(new MemoryVoteStore())
    expect(await v.vote('eth', ARC, voter(1), 'rocket', 'ip')).toEqual({ error: 'unknown coin' })
    expect(await v.vote('arc', '0x12', voter(1), 'rocket', 'ip')).toEqual({ error: 'unknown coin' })
    expect(await v.vote('solana', '0x' + 'a'.repeat(40), voter(1), 'rocket', 'ip')).toEqual({ error: 'unknown coin' })
    expect(await v.vote('arc', ARC, 'short', 'rocket', 'ip')).toEqual({ error: 'bad voter' })
    expect(await v.vote('arc', ARC, voter(1), 'moon', 'ip')).toEqual({ error: 'bad vote' })
    expect(await v.counts('arc', 'nope')).toBeNull()
    expect(coinOf('solana', SOL)?.address).toBe(SOL) // Solana addresses keep their case
  })
  test('one IP gets 30 votes an hour', async () => {
    const v = new Votes(new MemoryVoteStore())
    const t = Date.UTC(2026, 9, 6, 10)
    for (let i = 0; i < VOTES.perIpHour; i++) expect('counts' in await v.vote('arc', ARC, voter(i), 'fire', '9.9.9.9', t)).toBe(true)
    expect(await v.vote('arc', ARC, voter(99), 'fire', '9.9.9.9', t)).toEqual({ error: 'too many votes from here, try again later' })
    expect('counts' in await v.vote('arc', ARC, voter(99), 'fire', '8.8.8.8', t)).toBe(true) // another IP
    expect('counts' in await v.vote('arc', ARC, voter(99), 'fire', '9.9.9.9', t + 3_600_000)).toBe(true) // the next hour
  })
  test('counts are read from the store at most every 15 seconds, and at once after a vote', async () => {
    const store = new MemoryVoteStore()
    let reads = 0
    const read = store.voteCounts.bind(store)
    store.voteCounts = (c, a) => { reads++; return read(c, a) }
    const v = new Votes(store)
    const t = 1_000_000
    await Promise.all([v.counts('arc', ARC, t), v.counts('arc', ARC, t), v.counts('arc', ARC, t + 1_000)])
    expect(reads).toBe(1)
    await v.vote('arc', ARC, voter(1), 'poop', 'ip', t + 2_000)
    expect(reads).toBe(2)
    expect(await v.counts('arc', ARC, t + 3_000)).toEqual({ rocket: 0, fire: 0, poop: 1, flag: 0 })
    expect(reads).toBe(2)
    await v.counts('arc', ARC, t + 2_000 + VOTES.cacheMs + 1)
    expect(reads).toBe(3)
  })
})

describe('the votes route', () => {
  const cfg = { role: 'all', port: 0, allowedOrigins: ['https://arcsense.site'], metricsToken: 'secret', maxConnsPerIp: 3, maxMsgsPerSec: 5, maxSubsPerConn: 4, restRatePerSec: 50 } as unknown as Config
  let srv: ReturnType<typeof startServer>
  let base = ''
  beforeAll(() => {
    const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
    api.votes = new Votes(new MemoryVoteStore())
    srv = startServer({ cfg, api, health: () => ({ status: 'ok' }) })
    base = `http://127.0.0.1:${srv.server.port}`
  })
  afterAll(() => srv.stop())
  const post = (body: unknown, origin: string | null = 'https://arcsense.site') =>
    fetch(`${base}/v1/votes`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })

  test('a vote from the site counts, and the counts read back', async () => {
    const r = await post({ chain: 'arc', address: ARC, id: voter(1), vote: 'rocket' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ counts: { rocket: 1, fire: 0, poop: 0, flag: 0 } })
    const g = await fetch(`${base}/v1/votes?chain=arc&address=${ARC}`)
    expect(await g.json()).toEqual({ counts: { rocket: 1, fire: 0, poop: 0, flag: 0 } })
  })
  test('a vote from another site, or from no page at all, is refused', async () => {
    expect((await post({ chain: 'arc', address: ARC, id: voter(2), vote: 'poop' }, 'https://evil.example')).status).toBe(403)
    expect((await post({ chain: 'arc', address: ARC, id: voter(2), vote: 'poop' }, null)).status).toBe(403)
    expect(await (await fetch(`${base}/v1/votes?chain=arc&address=${ARC}`)).json()).toEqual({ counts: { rocket: 1, fire: 0, poop: 0, flag: 0 } })
  })
  test('bad requests', async () => {
    expect((await post({ chain: 'arc', address: 'nope', id: voter(3), vote: 'fire' })).status).toBe(400)
    expect((await fetch(`${base}/v1/votes?chain=arc&address=nope`)).status).toBe(400)
  })
})
