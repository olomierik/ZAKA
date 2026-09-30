// Who holds a young coin: every balance, rebuilt from its Transfer logs
// since launch (a few thousand blocks for a coin minutes or hours old).
// Contracts that hold a coin for trading (the pool manager, a curve, the
// launchpad) and burn addresses aren't holders.

import { scanLogs, type RawLog } from '../../../api/_arcLogs'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'])
const addr = (topic: string) => ('0x' + topic.slice(26)).toLowerCase()

export interface Holders {
  holders: number
  /** Share of supply held by the ten largest holders, trading contracts and burns excluded. */
  top10Pct: number
  creatorPct: number
  top: { address: string; pct: number }[]
}

/** Balances from Transfer logs (pure; exported for tests). */
export function holdersFromLogs(logs: Pick<RawLog, 'topics' | 'data'>[], supply: number, decimals: number, o: { exclude: Set<string>; creator: string | null }): Holders {
  const bal = new Map<string, bigint>()
  for (const l of logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue
    const v = BigInt(l.data)
    const from = addr(l.topics[1]), to = addr(l.topics[2])
    bal.set(from, (bal.get(from) ?? 0n) - v)
    bal.set(to, (bal.get(to) ?? 0n) + v)
  }
  const scale = 10 ** decimals
  const rows = [...bal].filter(([a, b]) => b > 0n && !BURN.has(a) && !o.exclude.has(a))
    .map(([address, b]) => ({ address, pct: (Number(b) / scale / supply) * 100 }))
    .sort((a, b) => b.pct - a.pct)
  const creator = o.creator?.toLowerCase()
  return {
    holders: rows.length,
    top10Pct: rows.slice(0, 10).reduce((s, r) => s + r.pct, 0),
    creatorPct: rows.find(r => r.address === creator)?.pct ?? 0,
    top: rows.slice(0, 10),
  }
}

/** A coin's holders since `fromBlock`; null if its logs couldn't all be read in time. */
export async function holdersOf(token: string, fromBlock: number, head: number, supply: number, decimals: number, o: { exclude: Set<string>; creator: string | null }): Promise<Holders | null> {
  const r = await scanLogs<RawLog[]>({ address: token, topics: [TRANSFER] }, fromBlock, head, { head, reduce: l => l, deadline: Date.now() + 15_000 })
  if (r.scannedTo < head) return null
  return holdersFromLogs(r.parts.flat(), supply, decimals, o)
}
