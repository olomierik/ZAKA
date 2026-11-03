// Polymarket from the trading wallet (2026-11-03): Polymarket's own SDK (@polymarket/client, pinned exactly), loaded
// only when live BTC Up/Down trading is used. The trading wallet trades as a plain wallet (Polymarket's "EOA" account):
// it holds pUSD on Polygon itself and signs every order here, without a pop-up. The SDK makes its API credentials from
// one signature of Polymarket's sign-in message, kept in memory only.
//
// Orders are fill-and-kill at a worst price: a buy pays at most the engine's price, a sale takes at least its floor, and
// whatever can't fill there is cancelled at once (nothing rests on the book, so no heartbeat is needed).
// Approvals and redemptions are on-chain transactions from this wallet, paid in POL.

import { createPublicClient, http, parseAbi, formatUnits, type Address } from 'viem'
import { polygon } from 'viem/chains'
import { currentAddress, getEmbeddedWalletClientOn, isUnlocked } from './embeddedWallet'

export const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com'
export const PUSD: Address = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
export const USDCE: Address = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
export const OFFRAMP: Address = '0x2957922Eb93258b93368531d39fAcCA3B4dC5854'

type Sdk = typeof import('@polymarket/client')
type Secure = Awaited<ReturnType<Sdk['createSecureClient']>>

let sdk: Promise<Sdk> | null = null
const loadSdk = () => (sdk ??= import('@polymarket/client'))
let cached: { addr: string; client: Promise<Secure> } | null = null
let publicClient: Promise<ReturnType<Sdk['createPublicClient']>> | null = null
const publicSdk = () => (publicClient ??= loadSdk().then(m => m.createPublicClient()))

const pub = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) })

/** The secure client for the unlocked trading wallet, made once per wallet per page. */
export async function polyClient(): Promise<Secure> {
  const addr = currentAddress()
  if (!addr || !isUnlocked()) throw new Error('Unlock your trading wallet first.')
  if (cached?.addr === addr) return cached.client
  const client = (async () => {
    const [{ createSecureClient }, { signerFrom }] = await Promise.all([loadSdk(), import('@polymarket/client/viem')])
    const wallet = getEmbeddedWalletClientOn(polygon, http(POLYGON_RPC))
    return createSecureClient({ signer: signerFrom(wallet as never), wallet: addr })
  })()
  cached = { addr, client }
  client.catch(() => { if (cached?.client === client) cached = null })
  return client
}

export interface PolyAccount {
  address: string
  pusd: number
  pol: number
  usdce: number
  approved: boolean | null
}

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'])

/** Balances on Polygon (read from the chain) and whether Polymarket's trading approvals are in place. */
export async function polyAccount(): Promise<PolyAccount> {
  const address = currentAddress()
  if (!address) throw new Error('Unlock your trading wallet first.')
  const [pusd, usdce, pol] = await Promise.all([
    pub.readContract({ address: PUSD, abi: ERC20, functionName: 'balanceOf', args: [address] }),
    pub.readContract({ address: USDCE, abi: ERC20, functionName: 'balanceOf', args: [address] }),
    pub.getBalance({ address }),
  ])
  // Read without signing in: making API credentials is left to the first trade.
  let approved: boolean | null = null
  try { approved = (await (await publicSdk()).fetchTradingApprovalsState({ user: address })).isFullyApproved } catch { approved = null }
  return { address, pusd: Number(formatUnits(pusd, 6)), usdce: Number(formatUnits(usdce, 6)), pol: Number(formatUnits(pol, 18)), approved }
}

/** Polymarket's trading approvals (pUSD and the outcome tokens to its exchange), sent from this wallet in POL. */
export async function polySetup(): Promise<void> {
  await (await polyClient()).setupTradingApprovals()
}

/** Polymarket's deposit addresses for this wallet: USDC sent there from Base, Arbitrum, Polygon, Ethereum (EVM) or
 *  Solana (SVM) arrives as pUSD in this wallet. */
export async function polyDepositAddresses(): Promise<{ evm?: string; svm?: string }> {
  const address = currentAddress()
  if (!address) throw new Error('Unlock your trading wallet first.')
  const r = await fetch('https://bridge.polymarket.com/deposit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }), signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Polymarket's bridge answered ${r.status}`)
  const j = await r.json() as { address?: { evm?: string; svm?: string } } & { evm?: string; svm?: string }
  const a = j.address ?? j
  return { evm: a.evm, svm: a.svm }
}

export interface Fill { ok: true; shares: number; usd: number; orderId: string } // usd: paid (buy) or received (sale)
export type OrderResult = Fill | { ok: false; why: string }

/** A fill-and-kill buy of `usd` (fees included) at no more than `maxPrice` a share. */
export async function polyBuy(asset: string, usd: number, maxPrice: number): Promise<OrderResult> {
  const [{ OrderSide, OrderType }, client] = await Promise.all([loadSdk(), polyClient()])
  const r = await client.placeMarketOrder({ assetId: asset, side: OrderSide.BUY, amount: usd, maxSpend: usd, maxPrice, orderType: OrderType.FAK })
  if (!r.ok) return { ok: false, why: r.message || String(r.code) }
  const shares = Number(r.takingAmount), paid = Number(r.makingAmount)
  return shares > 0 ? { ok: true, shares, usd: paid, orderId: r.orderId } : { ok: false, why: 'nothing left at the price' }
}

/** A fill-and-kill sale of `shares` at no less than `minPrice` a share. */
export async function polySell(asset: string, shares: number, minPrice: number): Promise<OrderResult> {
  const [{ OrderSide, OrderType }, client] = await Promise.all([loadSdk(), polyClient()])
  const r = await client.placeMarketOrder({ assetId: asset, side: OrderSide.SELL, shares: Math.floor(shares * 100) / 100, minPrice, orderType: OrderType.FAK })
  if (!r.ok) return { ok: false, why: r.message || String(r.code) }
  const sold = Number(r.makingAmount), got = Number(r.takingAmount)
  return sold > 0 ? { ok: true, shares: sold, usd: got, orderId: r.orderId } : { ok: false, why: 'no bid at the floor' }
}

/** Collects a resolved window's winning shares as pUSD (an on-chain transaction, in POL). */
export async function polyRedeem(conditionId: string): Promise<void> {
  const h = await (await polyClient()).redeemPositions({ conditionId })
  await h.wait()
}

/** pUSD back to USDC.e on Polygon, to this wallet (an approval and the offramp's unwrap, in POL). */
export async function polyUnwrap(amount: number): Promise<string> {
  const address = currentAddress()
  if (!address) throw new Error('Unlock your trading wallet first.')
  const wallet = getEmbeddedWalletClientOn(polygon, http(POLYGON_RPC))
  const units = BigInt(Math.floor(amount * 1e6))
  const a = await wallet.writeContract({ address: PUSD, abi: ERC20, functionName: 'approve', args: [OFFRAMP, units], chain: polygon, account: wallet.account! })
  await pub.waitForTransactionReceipt({ hash: a })
  const h = await wallet.writeContract({ address: OFFRAMP, abi: parseAbi(['function unwrap(address _asset, address _to, uint256 _amount)']), functionName: 'unwrap', args: [USDCE, address, units], chain: polygon, account: wallet.account! })
  await pub.waitForTransactionReceipt({ hash: h })
  return h
}
