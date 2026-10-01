// The site's traffic counter (owner, 2026-10-01: "a small card that could show
// the live count of online users, people who have visited and those who are
// online, like a traffic counter"). Every open page of arcdex.online (the
// landing and the app) beats every 30 seconds with a random id its browser
// keeps (localStorage). No cookie, and no IP or anything else about the
// visitor is stored.
//
//   online   ids heard from in the last 75 seconds
//   today    distinct ids seen since midnight UTC
//   total    distinct ids since counting began (2026-10-01)
//
// One IP can bring at most 20 new ids an hour, so a script can't run the counts
// up by much, and an id is written at most every 30 minutes however often it beats.

export interface VisitorStore {
  /** A visitor was here at `at` (first seen, or seen again). */
  visitorSeen(id: string, at: number): void
  /** Distinct visitors ever, and those seen since `dayStart`. */
  visitorCounts(dayStart: number): Promise<{ total: number; today: number }>
}

export interface TrafficCounts { online: number; today: number; total: number; at: number }

export const TRAFFIC = { onlineMs: 75_000, newIdsPerIpHour: 20, writeEveryMs: 30 * 60_000, countsEveryMs: 15_000 }
const ID = /^[A-Za-z0-9-]{16,64}$/
const dayStart = (t: number) => t - (t % 86_400_000)

export class Traffic {
  private online = new Map<string, number>()
  /** When each id was last written (this process), to write it at most every 30 minutes. */
  private written = new Map<string, number>()
  private newIds = new Map<string, { hour: number; n: number }>()
  private cached: { at: number; day: number; total: number; today: number } | null = null
  private reading: Promise<void> | null = null
  private prunedAt = 0

  constructor(private store: VisitorStore) {}

  /** A page's heartbeat. False when it isn't counted (a malformed id, or too many new ids from one IP). */
  beat(id: string, ip: string, now = Date.now()): boolean {
    if (!ID.test(id)) return false
    if (!this.online.has(id) && !this.written.has(id)) {
      const hour = Math.floor(now / 3_600_000)
      const seen = this.newIds.get(ip)
      const n = seen && seen.hour === hour ? seen.n : 0
      if (n >= TRAFFIC.newIdsPerIpHour) return false
      if (this.newIds.size > 50_000) this.newIds.clear()
      this.newIds.set(ip, { hour, n: n + 1 })
    }
    this.online.set(id, now)
    const w = this.written.get(id)
    if (w === undefined || w < dayStart(now) || now - w >= TRAFFIC.writeEveryMs) {
      this.written.set(id, now)
      this.store.visitorSeen(id, now)
      // Maybe a new visitor, or a first visit today: read the counts again soon.
      if ((w === undefined || w < dayStart(now)) && this.cached) this.cached.at = Math.min(this.cached.at, now - TRAFFIC.countsEveryMs + 2_000)
    }
    return true
  }

  /** Online now, visitors today and ever. The stored counts are read at most every 15 seconds. */
  async counts(now = Date.now()): Promise<TrafficCounts> {
    for (const [id, t] of this.online) if (now - t > TRAFFIC.onlineMs) this.online.delete(id)
    if (now - this.prunedAt > 60_000) {
      this.prunedAt = now
      for (const [id, t] of this.written) if (now - t > 86_400_000) this.written.delete(id)
    }
    const day = dayStart(now)
    if (!this.cached || this.cached.day !== day || now - this.cached.at >= TRAFFIC.countsEveryMs) {
      this.reading ??= this.store.visitorCounts(day).then(c => { this.cached = { at: now, day, ...c } }, () => {}).finally(() => { this.reading = null })
      await this.reading
    }
    const online = this.online.size
    const c = this.cached && this.cached.day === day ? this.cached : { today: 0, total: this.cached?.total ?? 0 }
    // A write not read back yet still counts: never fewer visitors than people online.
    return { online, today: Math.max(c.today, online), total: Math.max(c.total, online), at: now }
  }
}
