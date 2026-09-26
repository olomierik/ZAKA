// What a wallet holds on Arc, for Portfolio: every coin with a balance,
// valued at live prices. (USDC cash is lib/usdc.ts.)
//
// A wallet has no list of its tokens, so these are checked:
//  • coins bought from this browser (remembered on every buy),
//  • coins traded through ARCDEX's swap router (the Supabase index),
//  • every coin on the Terminal's market list and every ArcLaunchpad coin,
//  • any token sent to the wallet in the last ~2 days (Transfer logs).
// Their balances come from one multicall per ~150 coins. Prices: the market
// list, the launchpad curve, else GeckoTerminal.

import { formatUnits, pad, parseAbi, type Address } from 'viem'
import { client, getLaunchpadToken } from '../api/launchpad'
import { gtGet } from '../api/gtClient'
import { getTraderPositions } from '../api/social'
import { MULTICALL3 } from '../wagmi'
import { loadLaunchpadCoins } from './launchpadCoins'
import { loadMarket, type TokenMeta } from './tokenMeta'
import { remembered } from './held'
import { recentLogs } from './recentLogs'

export { rememberHolding } from './held'

export interface Holding {
  address: Address
  symbol: string
  name: string
  decimals: number
  image: string | null
  /** Whole tokens. */
  balance: number
  raw: bigint
  /** 0 when no price is known. */
  priceUsd: number
  valueUsd: number
  /** The coin's deepest pool, for its page. */
  pool: string | null
  launchpad: boolean
}

const USDC = '0x3600000000000000000000000000000000000000'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
])
const CHUNK = 150
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a)

// ── tokens sent to the wallet lately ─────────────────────────────────
const recentCache = new Map<string, { at: number; p: Promise<string[]> }>()

/** Contracts that emitted a Transfer to `owner` in the last ~2 days
 * (rescanned at most every 5 minutes; coins bought here are remembered anyway). */
function recentTokensIn(owner: Address): Promise<string[]> {
  const k = owner.toLowerCase()
  const hit = recentCache.get(k)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p
  const p = scanTokensIn(owner)
  recentCache.set(k, { at: Date.now(), p })
  p.catch(() => recentCache.delete(k))
  return p
}

async function scanTokensIn(owner: Address): Promise<string[]> {
  const logs = await recentLogs({ topics: [TRANSFER, null, pad(owner).toLowerCase()] })
  return [...new Set(logs.map(l => l.address.toLowerCase()))]
}

// ── on-chain reads ───────────────────────────────────────────────────
type Call = { address: Address; abi: typeof ERC20; functionName: 'balanceOf' | 'decimals' | 'symbol' | 'name'; args?: readonly [Address] }

async function multi<T>(calls: Call[]): Promise<(T | null)[]> {
  const out: (T | null)[] = []
  for (let i = 0; i < calls.length; i += CHUNK) {
    const part = calls.slice(i, i + CHUNK)
    const res = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0, contracts: part as never })
      .catch(() => part.map(() => ({ status: 'failure' as const })))
    for (const r of res as { status: string; result?: unknown }[]) out.push(r.status === 'success' ? (r.result as T) : null)
  }
  return out
}

interface GeckoToken { price: number; symbol?: string; name?: string; image?: string | null }

/** Prices (and names/images) GeckoTerminal has for these tokens. */
async function geckoTokens(addrs: string[]): Promise<Map<string, GeckoToken>> {
  const out = new Map<string, GeckoToken>()
  for (let i = 0; i < addrs.length; i += 30) {
    const part = addrs.slice(i, i + 30)
    type R = { attributes?: { address?: string; price_usd?: string | null; symbol?: string; name?: string; image_url?: string | null } }
    const d = await gtGet<{ data?: R[] }>(`/networks/arc/tokens/multi/${part.join(',')}`).catch(() => null)
    for (const r of d?.data ?? []) {
      const a = r.attributes
      if (!a?.address) continue
      const img = a.image_url && a.image_url !== 'missing.png' && /^https:\/\//.test(a.image_url) ? a.image_url : null
      out.set(a.address.toLowerCase(), { price: Number(a.price_usd) || 0, symbol: a.symbol, name: a.name, image: img })
    }
  }
  return out
}

/** Every coin `owner` holds (not USDC), most valuable first. */
export async function loadHoldings(owner: Address): Promise<Holding[]> {
  const [market, launchpadSet, positions, recent] = await Promise.all([
    loadMarket().catch(() => [] as TokenMeta[]),
    loadLaunchpadCoins().catch(() => new Set<string>()),
    getTraderPositions(owner).catch(() => []),
    recentTokensIn(owner).catch(() => [] as string[]),
  ])
  const byAddr = new Map(market.map(m => [m.address.toLowerCase(), m]))
  const candidates = [...new Set([
    ...remembered(owner), ...positions.map(p => p.token), ...recent, ...launchpadSet, ...byAddr.keys(),
  ].map(a => a.toLowerCase()))].filter(a => isAddr(a) && a !== USDC)

  const balances = await multi<bigint>(candidates.map(a => ({ address: a as Address, abi: ERC20, functionName: 'balanceOf' as const, args: [owner] as const })))
  const held = candidates.map((a, i) => ({ a, raw: balances[i] ?? 0n })).filter(h => h.raw > 0n)
  if (!held.length) return []

  // Decimals for all (an NFT has none and drops out); symbol/name where the market list doesn't know the coin.
  const unknown = held.filter(h => !byAddr.has(h.a))
  const [decimals, symbols, names] = await Promise.all([
    multi<number>(held.map(h => ({ address: h.a as Address, abi: ERC20, functionName: 'decimals' as const }))),
    multi<string>(unknown.map(h => ({ address: h.a as Address, abi: ERC20, functionName: 'symbol' as const }))),
    multi<string>(unknown.map(h => ({ address: h.a as Address, abi: ERC20, functionName: 'name' as const }))),
  ])
  const chainMeta = new Map(unknown.map((h, i) => [h.a, { symbol: symbols[i], name: names[i] }]))

  // Launchpad coins: priced on their curve.
  const curves = new Map(await Promise.all(held.filter(h => launchpadSet.has(h.a)).map(async h =>
    [h.a, await getLaunchpadToken(h.a as Address).catch(() => null)] as const)))
  // The rest without a market price: GeckoTerminal.
  const needPrice = held.filter(h => !curves.get(h.a) && !(byAddr.get(h.a)?.priceUsd))
  const gecko = needPrice.length ? await geckoTokens(needPrice.map(h => h.a)) : new Map<string, GeckoToken>()

  const out: Holding[] = []
  held.forEach((h, i) => {
    const dec = decimals[i]
    if (dec === null || dec === undefined || Number(dec) > 36) return
    const m = byAddr.get(h.a), c = curves.get(h.a), g = gecko.get(h.a), cm = chainMeta.get(h.a)
    const balance = Number(formatUnits(h.raw, Number(dec)))
    const priceUsd = c?.priceUsd ?? (m?.priceUsd || g?.price || 0)
    out.push({
      address: h.a as Address,
      symbol: m?.symbol ?? c?.symbol ?? g?.symbol ?? cm?.symbol ?? '???',
      name: m?.name ?? c?.name ?? g?.name ?? cm?.name ?? '',
      decimals: Number(dec),
      image: m?.image ?? c?.metadata?.image ?? g?.image ?? null,
      balance, raw: h.raw, priceUsd, valueUsd: balance * priceUsd,
      pool: m?.pool ?? null,
      launchpad: !!c,
    })
  })
  return out.sort((a, b) => b.valueUsd - a.valueUsd || b.balance - a.balance)
}
