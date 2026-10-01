// The site's traffic counter (traffic.ts): online now, visitors today and ever.
import { describe, expect, test } from 'bun:test'
import { MemoryBotStore } from '../src/bot/store'
import { Traffic, TRAFFIC } from '../src/traffic'

const day = Date.UTC(2026, 9, 1)
const id = (n: number) => `v-${String(n).padStart(20, '0')}`

/** A store that counts its writes. */
function counting() {
  const store = new MemoryBotStore()
  let writes = 0
  const seen = store.visitorSeen.bind(store)
  store.visitorSeen = (v, at) => { writes++; seen(v, at) }
  return { store, writes: () => writes }
}

describe('the traffic counter', () => {
  test('online: pages heard from in the last 75 seconds; visitors: distinct ids today and ever', async () => {
    const { store } = counting()
    const t = new Traffic(store)
    const now = day + 10 * 3_600_000
    t.beat(id(1), '1.1.1.1', now)
    t.beat(id(2), '2.2.2.2', now)
    t.beat(id(1), '1.1.1.1', now + 30_000) // the same tab again: one visitor
    expect(await t.counts(now + 30_000)).toMatchObject({ online: 2, today: 2, total: 2 })
    // id 2's tab closed: gone from online 75 seconds after its last beat; still a visitor today.
    expect(await t.counts(now + TRAFFIC.onlineMs + 5_000)).toMatchObject({ online: 1, today: 2, total: 2 })
  })
  test('a new day: today starts over, the total keeps counting', async () => {
    const { store } = counting()
    const t = new Traffic(store)
    t.beat(id(1), '1.1.1.1', day + 3_600_000)
    t.beat(id(2), '1.1.1.1', day + 3_600_000)
    const next = day + 86_400_000 + 3_600_000
    t.beat(id(2), '1.1.1.1', next) // came back the next day
    t.beat(id(3), '3.3.3.3', next)
    expect(await t.counts(next)).toMatchObject({ online: 2, today: 2, total: 3 })
  })
  test('an id is written at most every 30 minutes, however often it beats', async () => {
    const { store, writes } = counting()
    const t = new Traffic(store)
    const now = day + 3_600_000
    for (let k = 0; k < 60; k++) t.beat(id(1), '1.1.1.1', now + k * 30_000) // 30 minutes of beats
    expect(writes()).toBe(1)
    t.beat(id(1), '1.1.1.1', now + TRAFFIC.writeEveryMs)
    expect(writes()).toBe(2)
  })
  test('malformed ids are refused, and one IP brings at most 20 new ids an hour', async () => {
    const { store } = counting()
    const t = new Traffic(store)
    const now = day + 3_600_000
    expect(t.beat('', '1.1.1.1', now)).toBe(false)
    expect(t.beat('short', '1.1.1.1', now)).toBe(false)
    expect(t.beat('x'.repeat(16) + '<script>', '1.1.1.1', now)).toBe(false)
    for (let n = 0; n < TRAFFIC.newIdsPerIpHour; n++) expect(t.beat(id(n), '6.6.6.6', now)).toBe(true)
    expect(t.beat(id(99), '6.6.6.6', now)).toBe(false) // the 21st new id from one IP this hour
    expect(t.beat(id(0), '6.6.6.6', now + 30_000)).toBe(true) // ids it already has still beat
    expect(t.beat(id(99), '7.7.7.7', now)).toBe(true) // another IP
    expect(t.beat(id(100), '6.6.6.6', now + 3_600_000)).toBe(true) // the next hour
    expect(await t.counts(now + 3_600_000)).toMatchObject({ total: 22 })
  })
  test('the stored counts are read at most every 15 seconds, and never show fewer visitors than people online', async () => {
    const store = new MemoryBotStore()
    let reads = 0
    const read = store.visitorCounts.bind(store)
    store.visitorCounts = d => { reads++; return read(d) }
    const t = new Traffic(store)
    const now = day + 3_600_000
    t.beat(id(1), '1.1.1.1', now)
    await Promise.all([t.counts(now), t.counts(now), t.counts(now + 1_000)])
    expect(reads).toBe(1)
    await t.counts(now + TRAFFIC.countsEveryMs + 1)
    expect(reads).toBe(2)
    // A store that answers late or fails: online still counts.
    store.visitorCounts = async () => { throw new Error('down') }
    t.beat(id(2), '2.2.2.2', now + 20_000)
    expect(await t.counts(now + 40_000)).toMatchObject({ online: 2, today: 2, total: 2 })
  })
})
