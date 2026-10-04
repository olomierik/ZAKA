// What a wallet holds on Robinhood Chain, for Portfolio: coins bought from
// this browser and every coin on the Robinhood Chain market list this
// browser last loaded, checked in one multicall, valued at GeckoTerminal's
// prices; and its ETH for gas. The list isn't fetched from here, so an
// Arc-only visitor's Portfolio makes no GeckoTerminal calls for it.
// (Blockscout's token list sits behind a challenge page, so it isn't used.)

import { formatUnits, parseAbi, type Address } from 'viem'
import { cachedRhMarket, getRhCoin, type RhCoin } from '../api/robinhoodMarket'
import { isStockName, rememberedRh, rhClient } from './robinhood'

export interface RhHolding {
  address: string
  symbol: string
  name: string
  image: string | null
  decimals: number
  balance: number
  raw: bigint
  priceUsd: number
  valueUsd: number
  pool: string
  stock: boolean
}

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
])
const MAX_CHECKED = 250

export async function loadRhHoldings(owner: string): Promise<{ coins: RhHolding[]; eth: number }> {
  const market = cachedRhMarket()
  const byAddr = new Map(market.map(c => [c.address, c]))
  const list = [...new Set([...rememberedRh(owner), ...market.map(c => c.address)])].slice(0, MAX_CHECKED)
  const me = owner as Address
  const [eth, balances] = await Promise.all([
    rhClient.getBalance({ address: me }).catch(() => 0n),
    rhClient.multicall({ allowFailure: true, contracts: list.map(a => ({ address: a as Address, abi: ERC20, functionName: 'balanceOf' as const, args: [me] as const })) }),
  ])
  const held = list.map((a, i) => ({ a, raw: balances[i].status === 'success' ? (balances[i].result as bigint) : 0n })).filter(x => x.raw > 0n)

  const coins = await Promise.all(held.map(async ({ a, raw }): Promise<RhHolding> => {
    let c: RhCoin | undefined = byAddr.get(a)
    // A coin bought here that the list doesn't carry: its own page on GeckoTerminal.
    if (!c) c = await getRhCoin(a).then(d => d ?? undefined).catch(() => undefined)
    let decimals = c?.decimals ?? null
    let symbol = c?.symbol ?? ''
    let name = c?.name ?? ''
    if (decimals === null || !symbol) {
      const [d, s, n] = await rhClient.multicall({ allowFailure: true, contracts: [
        { address: a as Address, abi: ERC20, functionName: 'decimals' },
        { address: a as Address, abi: ERC20, functionName: 'symbol' },
        { address: a as Address, abi: ERC20, functionName: 'name' },
      ] })
      decimals = decimals ?? (d.status === 'success' ? Number(d.result) : 18)
      symbol = symbol || (s.status === 'success' ? String(s.result) : '?')
      name = name || (n.status === 'success' ? String(n.result) : symbol)
    }
    const balance = Number(formatUnits(raw, decimals))
    const priceUsd = c?.priceUsd ?? 0
    return { address: a, symbol, name, image: c?.image ?? null, decimals, balance, raw, priceUsd, valueUsd: balance * priceUsd, pool: c?.pool ?? '', stock: c?.stock ?? isStockName(name) }
  }))
  return { coins: coins.sort((x, y) => y.valueUsd - x.valueUsd), eth: Number(formatUnits(eth, 18)) }
}
