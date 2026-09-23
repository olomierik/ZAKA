// ── Token curation ──────────────────────────────────────────────────
// Anyone can deploy an ERC20 called "PEPE" — permissionless launchpads
// get flooded with copycat contracts reusing a hyped ticker to ride its
// search traffic. DexScreener doesn't hide these (there's no reliable way
// to prove which "PEPE" is the "real" one), but it does keep the noisiest
// duplicates from drowning out everything else: the highest-liquidity
// contract for a ticker sorts to the top, the rest are still reachable
// but don't each take up their own row in the default view.
//
// This applies the same idea: group by ticker, keep the strongest
// contract per group visible by default, and fold the rest behind a
// per-group expand so a search for "PEPE" still finds all of them.

import type { ArcToken } from '../api/radardex'

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** A token with zero signal on every axis — no liquidity, no volume, no
 * holders, no age data — is almost certainly a dead/spam deployment, not
 * a token someone will actually want to trade. Filtered from the default
 * view entirely (not even folded into a group) rather than just sorted low. */
function isDeadEntry(t: ArcToken): boolean {
  return t.liquidity <= 0 && t.volume24h <= 0 && t.holderCount <= 0 && t.marketCap <= 0
}

function qualityScore(t: ArcToken): number {
  // Liquidity is the strongest signal a contract is a real, tradeable
  // market rather than a copy deployed to squat on a name — weighted
  // heaviest. Volume and holders back that up.
  return t.liquidity * 3 + t.volume24h + t.holderCount * 50
}

export interface CuratedGroup {
  primary: ArcToken
  duplicates: ArcToken[]   // same ticker, lower quality — hidden by default
}

export interface CurationResult {
  groups: CuratedGroup[]
  hiddenDuplicateCount: number
  deadFilteredCount: number
}

export function curateTokens(tokens: ArcToken[]): CurationResult {
  const live = tokens.filter(t => !isDeadEntry(t))
  const deadFilteredCount = tokens.length - live.length

  const bySymbol = new Map<string, ArcToken[]>()
  for (const t of live) {
    const key = normalizeSymbol(t.symbol) || t.address.toLowerCase()
    const group = bySymbol.get(key)
    if (group) group.push(t)
    else bySymbol.set(key, [t])
  }

  let hiddenDuplicateCount = 0
  const groups: CuratedGroup[] = []
  for (const tokensForSymbol of bySymbol.values()) {
    if (tokensForSymbol.length === 1) {
      groups.push({ primary: tokensForSymbol[0], duplicates: [] })
      continue
    }
    const sorted = [...tokensForSymbol].sort((a, b) => qualityScore(b) - qualityScore(a))
    const [primary, ...duplicates] = sorted
    hiddenDuplicateCount += duplicates.length
    groups.push({ primary, duplicates })
  }

  return { groups, hiddenDuplicateCount, deadFilteredCount }
}
