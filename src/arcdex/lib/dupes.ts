// Same-ticker coins (2026-10-04, owner: "if a coin has duplicates launched by the same creator, flag the duplicates and
// show the real one labelled OG"): in each group of listed coins with one ticker, the earliest launched is the OG and the
// others are duplicates; a duplicate whose creator also launched the OG says so. Coins too small or rugged to list are
// left out before this runs, so the OG is the oldest that's still alive.

export interface DupInfo {
  /** The earliest launched of its ticker (only when the ticker has duplicates). */
  og: boolean
  /** A later coin with an OG's ticker. */
  dup: boolean
  /** A duplicate launched by the OG's own creator. */
  sameCreator: boolean
}

export const tickerKey = (symbol: string) => symbol.trim().replace(/^\$/, '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function markDupes<T>(rows: T[], o: { key: (r: T) => string; symbol: (r: T) => string; launchedAt: (r: T) => number; creator: (r: T) => string | null }): Map<string, DupInfo> {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const k = tickerKey(o.symbol(r))
    if (!k) continue
    const g = groups.get(k)
    if (g) g.push(r); else groups.set(k, [r])
  }
  const out = new Map<string, DupInfo>()
  for (const g of groups.values()) {
    if (g.length < 2) continue
    // Unknown launch times count as newest: a coin can't be the OG on a guess.
    const at = (r: T) => o.launchedAt(r) || Infinity
    const og = g.reduce((a, b) => (at(b) < at(a) ? b : a))
    const ogCreator = o.creator(og)?.toLowerCase() ?? null
    for (const r of g) {
      const c = o.creator(r)?.toLowerCase() ?? null
      out.set(o.key(r), r === og ? { og: true, dup: false, sameCreator: false } : { og: false, dup: true, sameCreator: !!c && c === ogCreator })
    }
  }
  return out
}
