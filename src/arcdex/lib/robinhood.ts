// Robinhood Chain (chain 4663): an Arbitrum Orbit L2 with ETH for gas and
// ~100ms blocks. ARCSENSE lists its coins and Robinhood's stock tokens, and
// trades them from Arc through Across (lib/across.ts): a buy is paid in USDC
// on Arc and the coin arrives at the same address on Robinhood Chain; a sale
// is signed there (a few cents of ETH for gas) and the USDC lands on Arc.
// Nothing here touches Arc's own markets.

import { createPublicClient, formatUnits, getAddress, parseAbi, type Address, type Hex } from 'viem'
import { robinhood } from 'viem/chains'
import { chainTransport } from './rpc'

export { robinhood }

export const RH_ID = robinhood.id // 4663
export const RH_RPC = robinhood.rpcUrls.default.http[0]
export const RH_EXPLORER = 'https://robinhoodchain.blockscout.com'
export const rhTx = (hash: string) => `${RH_EXPLORER}/tx/${hash}`
export const rhAddress = (a: string) => `${RH_EXPLORER}/address/${a}`

/** Paxos's Global Dollar, Robinhood Chain's dollar (6 decimals). */
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
export const NATIVE = '0x0000000000000000000000000000000000000000'
/** Quotes, never listed as coins of their own. */
export const RH_QUOTES = new Set([USDG, WETH, NATIVE])
export const QUOTE_SYMBOLS: Record<string, string> = { [USDG]: 'USDG', [WETH]: 'WETH', [NATIVE]: 'ETH' }

/** Lag-tolerant reads on Robinhood Chain's public RPC, batched by multicall. */
export const rhClient = createPublicClient({ chain: robinhood, transport: chainTransport(RH_RPC), batch: { multicall: true } })

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
])

// ── stock tokens ─────────────────────────────────────────────────────────

/** Robinhood's stock tokens name themselves "<Company> • Robinhood Token"
 * ("NVIDIA • Robinhood Token"). */
export const isStockName = (name: string | null | undefined) => /•\s*Robinhood Token/i.test(name ?? '')

/** "NVIDIA • Robinhood Token" → "NVIDIA". */
export const stockCompany = (name: string) => name.replace(/\s*•\s*Robinhood Token\s*$/i, '').trim()

/** Every stock token is a beacon proxy on Robinhood's one beacon (EIP-1967's beacon slot). */
export const STOCK_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00'
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

const stockCheck = new Map<string, Promise<boolean>>()

/** Whether `token` is one of Robinhood's stock tokens, from its own storage
 * (a name can be copied; the beacon can't). Cached per token. */
export function isStockToken(token: string): Promise<boolean> {
  const k = token.toLowerCase()
  let p = stockCheck.get(k)
  if (!p) {
    p = rhClient.getStorageAt({ address: k as Address, slot: BEACON_SLOT })
      .then(v => !!v && `0x${v.slice(-40)}`.toLowerCase() === STOCK_BEACON)
    p.catch(() => stockCheck.delete(k))
    stockCheck.set(k, p)
  }
  return p
}

/** Where Robinhood's stock tokens may not be offered: the United States
 * (they're not for US persons), Canada, the United Kingdom, Switzerland, the
 * UAE (Robinhood's own terms), and sanctioned countries. Viewing stays open
 * everywhere; buying needs a country outside this list and the trader's word
 * (`StockGate`). Location can be hidden, so this is a filter, not a guarantee. */
export const STOCK_RESTRICTED = new Set(['US', 'CA', 'GB', 'CH', 'AE', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY'])

// ── balances ─────────────────────────────────────────────────────────────

export interface RhBalance { raw: bigint; amount: number; decimals: number }

/** A token's balance on Robinhood Chain (0 for an address with none). */
export async function rhTokenBalance(token: string, owner: string, decimals?: number): Promise<RhBalance> {
  const [raw, dec] = await Promise.all([
    rhClient.readContract({ address: token as Address, abi: ERC20, functionName: 'balanceOf', args: [owner as Address] }),
    decimals ?? rhClient.readContract({ address: token as Address, abi: ERC20, functionName: 'decimals' }).then(Number),
  ])
  return { raw, amount: Number(formatUnits(raw, dec)), decimals: dec }
}

/** ETH on Robinhood Chain, for gas. */
export async function rhEthBalance(owner: string): Promise<RhBalance> {
  const raw = await rhClient.getBalance({ address: owner as Address })
  return { raw, amount: Number(formatUnits(raw, 18)), decimals: 18 }
}

/** Gas for one sale and its approval, with room to spare: Robinhood Chain's
 * gas costs about 0.02 gwei, so ~1M gas is ~0.00002 ETH (a few cents). */
export const SELL_GAS_ETH = 0.00003

/** A token's name, symbol and decimals, read on-chain. */
export async function rhTokenInfo(token: string): Promise<{ name: string; symbol: string; decimals: number } | null> {
  try {
    const a = token as Address
    const [name, symbol, decimals] = await Promise.all([
      rhClient.readContract({ address: a, abi: ERC20, functionName: 'name' }),
      rhClient.readContract({ address: a, abi: ERC20, functionName: 'symbol' }),
      rhClient.readContract({ address: a, abi: ERC20, functionName: 'decimals' }),
    ])
    return { name, symbol, decimals: Number(decimals) }
  } catch { return null }
}

/** Code on Arc or Robinhood Chain that isn't an EIP-7702 delegation: a
 * contract wallet, which may not exist at the same address on the other chain. */
export const isContractCode = (code: Hex | undefined) => !!code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100')

// ── coins traded from this browser ───────────────────────────────────────

const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a)
const heldKey = (owner: string) => `arcdex:held-rh:v1:${owner.toLowerCase()}`

/** Robinhood Chain coins `owner` bought from this browser (Portfolio checks
 * these; kept apart from Arc's list in lib/held.ts). */
export function rememberedRh(owner: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(heldKey(owner)) ?? '[]') as unknown
    return Array.isArray(v) ? v.map(a => String(a).toLowerCase()).filter(isAddr) : []
  } catch { return [] }
}

export function rememberRh(owner: string | null | undefined, token: string) {
  if (!owner || !isAddr(token.toLowerCase())) return
  try {
    const list = [token.toLowerCase(), ...rememberedRh(owner).filter(a => a !== token.toLowerCase())].slice(0, 200)
    localStorage.setItem(heldKey(owner), JSON.stringify(list))
  } catch { /* storage blocked */ }
}

export const checksum = (a: string) => { try { return getAddress(a) } catch { return a } }
