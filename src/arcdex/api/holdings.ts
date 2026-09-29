// What a wallet holds, for the Portfolio.
//
// No indexer lists a wallet's coins on Arc, so the candidates come from
// everywhere ARCDEX knows coins: the market list, Arc's blue chips,
// launchpad coins, the coins this wallet traded on ARCDEX, and any token
// sent to it lately (Transfer logs, recent blocks). Their balances are read
// in one multicall and valued at the live price.

import { erc20Abi, type Address } from 'viem'
import { client, getAllLaunchpadTokens } from './launchpad'
import { getTraderPositions } from './social'
import { loadBlueChips, loadMarket } from '../lib/tokenMeta'
import { MULTICALL3 } from '../wagmi'
import { RECENT_DEPTH, headBlock, scanLogs } from '../../../api/_arcLogs'

export interface Holding {
  address: string
  symbol: string
  name: string
  image: string | null
  amount: number
  priceUsd: number
  valueUsd: number
  change24h: number | null
  pool: string | null
  launchpad: boolean
}

interface Meta { symbol: string; name: string; image: string | null; priceUsd: number; change24h: number | null; pool: string | null; launchpad: boolean }

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
/** Cash, not a holding: USDC and its native-transfer logger. */
const NOT_COINS = new Set(['0x3600000000000000000000000000000000000000', '0xfffffffffffffffffffffffffffffffffffffffe'])
const topic = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** ERC-20s sent to `owner` in the recent blocks (ERC-721s have a 4th topic). */
async function recentlyReceived(owner: string): Promise<string[]> {
  const head = await headBlock()
  const r = await scanLogs({ topics: [TRANSFER, null, topic(owner)] }, Math.max(0, head - RECENT_DEPTH), head, {
    head, deadline: Date.now() + 8_000,
    reduce: logs => logs.filter(l => l.topics.length === 3).map(l => l.address.toLowerCase()),
  })
  return [...new Set(r.parts.flat())]
}

export async function loadHoldings(owner: string): Promise<Holding[]> {
  const meta = new Map<string, Meta>()
  const [market, chips, launches, positions, received] = await Promise.all([
    loadMarket().catch(() => []),
    loadBlueChips().catch(() => []),
    getAllLaunchpadTokens().catch(() => []),
    getTraderPositions(owner).catch(() => []),
    recentlyReceived(owner).catch(() => [] as string[]),
  ])
  for (const t of [...chips, ...market]) {
    meta.set(t.address.toLowerCase(), { symbol: t.symbol, name: t.name, image: t.image, priceUsd: t.priceUsd, change24h: t.change24h, pool: t.pool || null, launchpad: false })
  }
  for (const t of launches) {
    meta.set(t.address.toLowerCase(), { symbol: t.symbol, name: t.name, image: t.metadata?.image ?? null, priceUsd: t.priceUsd, change24h: null, pool: null, launchpad: true })
  }
  const candidates = [...new Set([...meta.keys(), ...positions.map(p => p.token.toLowerCase()), ...received])].filter(a => !NOT_COINS.has(a)) as Address[]
  if (!candidates.length) return []

  const balances = await client.multicall({
    contracts: candidates.map(address => ({ address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner as Address] })),
    allowFailure: true, multicallAddress: MULTICALL3, batchSize: 24_000,
  })
  const held = candidates.map((a, i) => ({ a, raw: balances[i].status === 'success' ? (balances[i].result as bigint) : 0n })).filter(x => x.raw > 0n)
  if (!held.length) return []

  // Decimals for every coin held (blue chips aren't all 18), plus symbol and
  // name for coins no list knows.
  const unknown = held.filter(x => !meta.has(x.a))
  const [decs, info] = await Promise.all([
    client.multicall({ contracts: held.map(x => ({ address: x.a, abi: erc20Abi, functionName: 'decimals' as const })), allowFailure: true, multicallAddress: MULTICALL3 }),
    client.multicall({ contracts: unknown.flatMap(x => [{ address: x.a, abi: erc20Abi, functionName: 'symbol' as const }, { address: x.a, abi: erc20Abi, functionName: 'name' as const }]), allowFailure: true, multicallAddress: MULTICALL3 }),
  ])
  unknown.forEach((x, i) => {
    const sym = info[i * 2]?.status === 'success' ? String(info[i * 2].result) : '???'
    const name = info[i * 2 + 1]?.status === 'success' ? String(info[i * 2 + 1].result) : sym
    meta.set(x.a, { symbol: sym.slice(0, 16), name: name.slice(0, 40), image: null, priceUsd: 0, change24h: null, pool: null, launchpad: false })
  })

  return held.map((x, i) => {
    const m = meta.get(x.a)!
    const decimals = decs[i]?.status === 'success' ? Number(decs[i].result) : 18
    const amount = Number(x.raw) / 10 ** decimals
    return { address: x.a, symbol: m.symbol, name: m.name, image: m.image, amount, priceUsd: m.priceUsd, valueUsd: amount * m.priceUsd, change24h: m.change24h, pool: m.pool, launchpad: m.launchpad }
  }).sort((a, b) => b.valueUsd - a.valueUsd || b.amount - a.amount)
}
