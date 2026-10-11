// Community sentiment on each coin, as DexScreener shows it (2026-10-06): 🚀 🔥 💩 🚩.
// Every coin page on every chain shows the counts; a visitor picks one, can switch, or take it back by picking it
// again. The visitor is the random id their browser keeps for the traffic counter (traffic.ts): no account, no
// cookie, nothing else about them stored.
//
// It's a sentiment signal, not a vote anyone can rely on: a script can make new ids. One IP gets at most 30 votes
// an hour, and only the site's own pages count, which keeps casual stuffing small.

export const VOTE_KINDS = ['rocket', 'fire', 'poop', 'flag'] as const
export type VoteKind = (typeof VOTE_KINDS)[number]
export type VoteCounts = Record<VoteKind, number>

export interface VoteStore {
  /** The voter's vote on the coin: a kind, or null to take it back. */
  voteSet(chain: string, address: string, voter: string, kind: VoteKind | null, at: number): Promise<void>
  voteCounts(chain: string, address: string): Promise<VoteCounts>
}

export const VOTES = { perIpHour: 30, cacheMs: 15_000, maxCached: 5_000 }

const CHAINS = new Set(['arc', 'solana', 'bsc', 'robinhood'])
const VOTER = /^[A-Za-z0-9-]{16,64}$/
const EVM = /^0x[0-9a-fA-F]{40}$/
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const emptyCounts = (): VoteCounts => ({ rocket: 0, fire: 0, poop: 0, flag: 0 })
export const isVoteKind = (k: unknown): k is VoteKind => typeof k === 'string' && (VOTE_KINDS as readonly string[]).includes(k)

/** The coin as stored: a known chain and a valid address (EVM addresses lower-cased, Solana's kept as written). */
export function coinOf(chain: unknown, address: unknown): { chain: string; address: string } | null {
  if (typeof chain !== 'string' || typeof address !== 'string' || !CHAINS.has(chain)) return null
  if (chain === 'solana') return SOL.test(address) ? { chain, address } : null
  return EVM.test(address) ? { chain, address: address.toLowerCase() } : null
}

export class Votes {
  private cache = new Map<string, { at: number; counts: VoteCounts }>()
  private reading = new Map<string, Promise<VoteCounts>>()
  private perIp = new Map<string, { hour: number; n: number }>()

  constructor(private store: VoteStore) {}

  /** The coin's counts, read from the store at most every 15 seconds. Null for a malformed coin. */
  async counts(chain: unknown, address: unknown, now = Date.now()): Promise<VoteCounts | null> {
    const coin = coinOf(chain, address)
    if (!coin) return null
    const key = `${coin.chain}:${coin.address}`
    const hit = this.cache.get(key)
    if (hit && now - hit.at < VOTES.cacheMs) return hit.counts
    return this.read(key, coin, now)
  }

  /** A visitor's vote (a kind, or null to take it back). The coin's counts after it, or why it wasn't taken. */
  async vote(chain: unknown, address: unknown, voter: unknown, kind: unknown, ip: string, now = Date.now()): Promise<{ counts: VoteCounts } | { error: string }> {
    const coin = coinOf(chain, address)
    if (!coin) return { error: 'unknown coin' }
    if (typeof voter !== 'string' || !VOTER.test(voter)) return { error: 'bad voter' }
    if (kind !== null && !isVoteKind(kind)) return { error: 'bad vote' }
    const hour = Math.floor(now / 3_600_000)
    const seen = this.perIp.get(ip)
    const n = seen && seen.hour === hour ? seen.n : 0
    if (n >= VOTES.perIpHour) return { error: 'too many votes from here, try again later' }
    if (this.perIp.size > 50_000) this.perIp.clear()
    this.perIp.set(ip, { hour, n: n + 1 })
    await this.store.voteSet(coin.chain, coin.address, voter, kind, now)
    const key = `${coin.chain}:${coin.address}`
    this.cache.delete(key)
    return { counts: await this.read(key, coin, now) }
  }

  private read(key: string, coin: { chain: string; address: string }, now: number): Promise<VoteCounts> {
    const busy = this.reading.get(key)
    if (busy) return busy
    const p = this.store.voteCounts(coin.chain, coin.address).then(counts => {
      if (this.cache.size >= VOTES.maxCached) this.cache.clear()
      this.cache.set(key, { at: now, counts })
      return counts
    }).finally(() => { this.reading.delete(key) })
    this.reading.set(key, p)
    return p
  }
}

/** Votes kept in memory (dev, tests). */
export class MemoryVoteStore implements VoteStore {
  private rows = new Map<string, Map<string, VoteKind>>()
  async voteSet(chain: string, address: string, voter: string, kind: VoteKind | null) {
    const key = `${chain}:${address}`
    const m = this.rows.get(key) ?? this.rows.set(key, new Map()).get(key)!
    if (kind) m.set(voter, kind)
    else m.delete(voter)
  }
  async voteCounts(chain: string, address: string) {
    const c = emptyCounts()
    for (const k of this.rows.get(`${chain}:${address}`)?.values() ?? []) c[k]++
    return c
  }
}
