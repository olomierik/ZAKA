// What each launcher did with its last coins (2026-10-02, owner: "let it learn ... to improve its settings and
// performance"). Most snipes are a serial launcher's coin: it buys about $2,500 at launch and, on some coins, sells all
// of it within minutes, a −75% gap no stop catches at live speed. Some launchers do it on most coins (0x70fc3d32's "SI"
// coins on 2 October: 5 of 7 dumped 27–32s after launch, each a rug for the live bots that bought at ~21s).
//
// A coin is an early dump when its creator's first sale is at least 80% of its first buy, within 5 minutes of the
// launch; it's a clean coin once 5 minutes pass without one (40+ trades, a launch buy seen). Live bots sit out a snipe
// whose launcher's dump rate over its last 10 such coins, (dumps + 1) / (coins + 4), is over 25%: a new launcher
// passes, one that dumped its last coin doesn't, until three clean coins bring it back.
//
// Replayed on 11 hours of production's trades (the snipe rule of 2 October, its quick exits, the signal 1.2s after the
// rule is met), learning only from coins finished before each signal: 170 trades, +1.46% a trade (+0.99% and +1.94% in
// the two halves) without it; 126 trades, +1.75% (+1.72% and +1.77%) with it, 3 rugs instead of 4. It doesn't promise
// anything: a launcher can change its pattern, and a new one dumps once before it's known.

export const CREATOR_MEMORY = {
  /** An early dump: the creator's first sale, within this long of the launch… */
  windowMs: 300_000,
  /** …of at least this share of its first buy. */
  dumpShare: 0.8,
  /** A coin counts once it has this many trades (one that never traded says nothing). */
  minTrades: 40,
  /** The launcher's last coins read. */
  last: 10,
  /** Live bots sit out a snipe whose launcher's rate is over this. */
  maxRate: 0.25,
  /** Launchers not seen for this long are forgotten. */
  keepMs: 3 * 86_400_000,
  maxCreators: 5_000,
}

interface CoinOutcome { token: string; at: number; early: boolean }

/** A launcher's dump rate from its last coins: a prior of one dump in four, so a new launcher sits at the limit. */
export const launcherRate = (dumps: number, coins: number) => (dumps + 1) / (coins + 4)

export class CreatorMemory {
  private by = new Map<string, CoinOutcome[]>()
  /** Coins whose outcome is decided (recorded, or the creator's first sale wasn't a dump). */
  private decided = new Set<string>()
  dirty = false

  /**
   * A creator's sale. Only its first sale on a coin is judged: a dump if it's 80%+ of its first buy within 5 minutes of
   * the launch. Returns true when it recorded an early dump.
   */
  noteSale(o: { creator: string; token: string; launchedAt: number; at: number; saleUsd: number; buyUsd: number | null }): boolean {
    if (this.decided.has(o.token)) return false
    if (!o.buyUsd || o.buyUsd <= 0) return false
    this.decided.add(o.token)
    if (o.at - o.launchedAt > CREATOR_MEMORY.windowMs || o.saleUsd < CREATOR_MEMORY.dumpShare * o.buyUsd) return false
    this.push(o.creator, { token: o.token, at: o.at, early: true })
    return true
  }

  /** A coin 5+ minutes old with no early dump: clean, if it traded and its creator's launch buy was seen. */
  settle(o: { creator: string; token: string; launchedAt: number; now: number; trades: number; creatorBought: boolean }): boolean {
    if (o.now - o.launchedAt < CREATOR_MEMORY.windowMs) return false
    const known = this.by.get(o.creator.toLowerCase())?.some(c => c.token === o.token)
    if (known) return false
    if (!o.creatorBought || o.trades < CREATOR_MEMORY.minTrades) return false
    this.decided.add(o.token)
    this.push(o.creator, { token: o.token, at: o.launchedAt + CREATOR_MEMORY.windowMs, early: false })
    return true
  }

  /** The launcher's last coins decided by `now`: how many, and how many it dumped early. */
  record(creator: string | null | undefined, now: number): { coins: number; dumps: number } {
    const list = creator ? (this.by.get(creator.toLowerCase()) ?? []).filter(c => c.at <= now).slice(-CREATOR_MEMORY.last) : []
    return { coins: list.length, dumps: list.filter(c => c.early).length }
  }

  /** Forgets launchers not seen for 3 days, and the oldest beyond the cap. */
  prune(now: number) {
    for (const [k, list] of this.by) if (now - (list[list.length - 1]?.at ?? 0) > CREATOR_MEMORY.keepMs) this.by.delete(k)
    if (this.by.size > CREATOR_MEMORY.maxCreators) {
      const old = [...this.by.entries()].sort((a, b) => (a[1][a[1].length - 1]?.at ?? 0) - (b[1][b[1].length - 1]?.at ?? 0))
      for (const [k] of old.slice(0, this.by.size - CREATOR_MEMORY.maxCreators)) this.by.delete(k)
    }
    if (this.decided.size > 50_000) this.decided = new Set([...this.decided].slice(-20_000))
  }

  get size() { return this.by.size }

  toJSON(): Record<string, CoinOutcome[]> { return Object.fromEntries(this.by) }

  /** Loads what was saved (the settings' 'creator-memory'); anything unreadable is skipped. */
  load(raw: string | null) {
    if (!raw) return
    try {
      const data = JSON.parse(raw) as Record<string, CoinOutcome[]>
      for (const [k, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue
        const ok = list.filter(c => c && typeof c.token === 'string' && typeof c.at === 'number' && typeof c.early === 'boolean').slice(-CREATOR_MEMORY.last)
        if (!ok.length) continue
        this.by.set(k.toLowerCase(), ok)
        for (const c of ok) this.decided.add(c.token)
      }
    } catch { /* a bad save starts empty */ }
  }

  private push(creator: string, c: CoinOutcome) {
    const k = creator.toLowerCase()
    const list = this.by.get(k) ?? []
    list.push(c)
    list.sort((a, b) => a.at - b.at)
    if (list.length > CREATOR_MEMORY.last) list.splice(0, list.length - CREATOR_MEMORY.last)
    this.by.set(k, list)
    this.dirty = true
  }
}
