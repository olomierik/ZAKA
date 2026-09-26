// Finding a coin the way Argus's search does: by name, by ticker (with or
// without the $) or by its contract address, best matches first.

export interface Searchable { address: string; name: string; symbol: string }

/** The query trimmed and lowercased, without a leading $. */
export function normQuery(q: string): string {
  return q.trim().toLowerCase().replace(/^\$+/, '').trim()
}

/** How well a coin matches a normalized query, 0 for not at all: exact
 * ticker or address first, then ticker and name prefixes, then anywhere in
 * them, then part of the address (from its start, or 6+ hex characters from
 * anywhere, for a pasted tail). */
export function matchScore(c: Searchable, q: string): number {
  if (!q) return 0
  const sym = c.symbol.toLowerCase(), name = c.name.toLowerCase(), addr = c.address.toLowerCase()
  if (sym === q || addr === q) return 6
  if (name === q) return 5
  if (sym.startsWith(q)) return 4
  if (name.startsWith(q) || name.split(/\s+/).some(w => w.startsWith(q))) return 3
  if (sym.includes(q) || name.includes(q)) return 2
  if ((/^0x[0-9a-f]{2,}$/.test(q) && addr.startsWith(q)) || (/^[0-9a-f]{6,}$/.test(q) && addr.includes(q))) return 1
  return 0
}

/** The coins matching `query`, best first; ties go to the higher `rank`. */
export function searchCoins<T extends Searchable>(coins: readonly T[], query: string, rank: (c: T) => number = () => 0): T[] {
  const q = normQuery(query)
  if (!q) return []
  return coins
    .map(c => ({ c, s: matchScore(c, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || rank(b.c) - rank(a.c))
    .map(x => x.c)
}
