// ARCSENSE futures: what the engine and the site share (no Bun or Node APIs here; the site
// imports this file too).
//
// Futures run on Arc testnet first (owner, 2026-10-03: "a USDC pool, BTC/ETH/SOL up to 10x,
// testnet first, audit before mainnet"). Prices are RedStone's signed oracle prices
// (contracts/SensePerps.sol, SenseOracle): free, no key, signed every 10 seconds by five nodes.

// Nothing is imported here: the site imports this file, and an import of 'viem' from engine/
// would bundle the engine's own copy of viem into the site.

export const ARC_TESTNET = {
  id: 5042002,
  name: 'Arc Testnet',
  // As on mainnet: the wallet-level unit of native USDC is 18 decimals (wagmi.ts explains why).
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  blockTime: 500,
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const } },
} as const

export const TESTNET_RPCS = [
  'https://rpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
] as const

/** Circle's faucet: testnet USDC for gas on Arc testnet. */
export const CIRCLE_FAUCET = 'https://faucet.circle.com'

/** Every pair the futures screen shows, against USDC. */
export const FEEDS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'AVAX', 'LINK', 'DOGE'] as const
export type Feed = (typeof FEEDS)[number]

/** The markets the contract is deployed with, in market-id order (0 = BTC). */
export const MARKET_FEEDS = ['BTC', 'ETH', 'SOL'] as const satisfies readonly Feed[]

/** RedStone's "redstone-primary-prod" service: its signers (any 3 of the 5) and gateways. */
export const REDSTONE = {
  dataService: 'redstone-primary-prod',
  signers: [
    '0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774',
    '0xdEB22f54738d54976C4c0fe5ce6d408E40d88499',
    '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
    '0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE',
    '0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de',
  ],
  threshold: 3,
  gateways: [
    'https://oracle-gateway-1.a.redstone.finance',
    'https://oracle-gateway-2.a.redstone.finance',
  ],
} as const

/** Who owns the contracts (the owner's deploy wallet, as for the launchpad and routers) and
 * where ARCSENSE's fees go (the platform's one fee wallet, unchanged). */
export const PERPS_OWNER = '0x414B6Be4CF906739FbF7D49165beCa5F4CeEC3dA'
export const FEE_WALLET = '0x274262A0321A0701b0A46a3576e07aE881c286Bb'

/** Each market as deployed: 10x, 0.08% to open and to close, liquidated below 1% of size,
 * 0.0025% of size an hour to borrow, open interest capped per side. */
export const MARKET_DEFAULTS = {
  maxLeverage: 10,
  openFeeBps: 8,
  closeFeeBps: 8,
  liquidationBps: 100,
  borrowRatePerHour: 25_000_000_000_000n, // 0.0025% (1e18 = 100%)
  maxOiLong: 250_000_000_000n, // 250,000 USDC
  maxOiShort: 250_000_000_000n,
} as const

/** The pool's first liquidity on testnet (test USDC), deposited by the keeper at deployment. */
export const TESTNET_SEED_USDC = 1_000_000_000_000n // 1,000,000

export const PRICE_DECIMALS = 8

/** A RedStone feed id: the symbol's bytes, left-aligned in 32 bytes ("BTC" → 0x425443…00). */
export function feedIdOf(symbol: string): `0x${string}` {
  let hex = ''
  for (let i = 0; i < symbol.length; i++) hex += symbol.charCodeAt(i).toString(16).padStart(2, '0')
  return `0x${hex.padEnd(64, '0')}`
}

export function symbolOf(feedId: string): string {
  const hex = feedId.replace(/^0x/, '')
  let s = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16)
    if (!c) break
    s += String.fromCharCode(c)
  }
  return s
}

// ─── what the engine serves (GET /v1/perps/…) ──────────────────────────────

export type PerpsTf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export const PERPS_TFS: PerpsTf[] = ['1m', '5m', '15m', '1h', '4h', '1d']
/** [time (ms), open, high, low, close] */
export type PerpsBar = [number, number, number, number, number]

export interface PerpsFeedPrice {
  price: number
  /** The signed prices' time (ms). */
  ts: number
  open24h: number | null
  high24h: number | null
  low24h: number | null
  change24h: number | null
}

export interface PerpsPricesResponse {
  ts: number | null
  feeds: Partial<Record<Feed, PerpsFeedPrice>>
}

export interface PerpsDeployment {
  chainId: number
  usdc: string | null
  oracle: string | null
  perps: string | null
  /** The block the futures contract was deployed in: where to read its events from. */
  block: number | null
  seeded: boolean
  at: number | null
}

export interface PerpsStatus {
  enabled: boolean
  chainId: number
  deployment: PerpsDeployment | null
  /** What's left before futures can trade, in words (null when nothing is). */
  waiting: string | null
  keeper: { address: string | null; gasUsdc: number | null; lastRun: number | null; executed: number; errors: number; lastError: string | null }
  oracle: { lastTs: number | null; ageSec: number | null; fetchedAt: number | null; errors: number; gateway: string | null }
}

/** The contract's state as the engine last read it, for the screen: each market and the pool. */
export interface PerpsMarketView {
  id: number
  feed: string
  enabled: boolean
  maxLeverage: number
  openFeeBps: number
  closeFeeBps: number
  liquidationBps: number
  borrowRatePerHour: string
  maxOiLong: string
  maxOiShort: string
  oiLong: string
  oiShort: string
}

export interface PerpsPoolView {
  poolAmount: string
  totalReserved: string
  totalCollateral: string
  totalSupply: string
  paused: boolean
  execFee: string
  minCollateral: string
  requestTimeout: number
  maxPriceAge: number
  lpCooldown: number
}

/** One open or close (engine/src/perps/events.ts), amounts as integer strings. */
export interface PerpsTradeView {
  kind: 'opened' | 'closed' | 'liquidated' | 'takeProfit' | 'stopLoss' | 'cancelled'
  positionId: string | null
  requestId: string | null
  trader: string
  market: string | null
  isLong: boolean | null
  size: string | null
  collateral: string | null
  price: string | null
  pnl: string | null
  fees: string | null
  payout: string | null
  reason: string | null
  block: number
  tx: string
  at: number
}

export interface PerpsStateResponse {
  at: number
  perps: string | null
  markets: PerpsMarketView[]
  pool: PerpsPoolView | null
}

// ─── the contract's types and math (SensePerps.sol), shared by the keeper and the screen ──────

type Hex = `0x${string}`

export const KIND = { None: 0, Open: 1, Close: 2, Deposit: 3, Withdraw: 4 } as const

export interface Req {
  kind: number
  isLong: boolean
  marketId: number
  createdAt: bigint
  account: Hex
  amount: bigint
  size: bigint
  acceptablePrice: bigint
  triggerPrice: bigint
  positionId: bigint
  tp: bigint
  sl: bigint
  execFee: bigint
}

export interface Pos {
  trader: Hex
  marketId: number
  isLong: boolean
  openedAt: bigint
  tpSlSetAt: bigint
  size: bigint
  collateral: bigint
  entryPrice: bigint
  borrowIndex: bigint
  maxProfit: bigint
  tp: bigint
  sl: bigint
}

export interface Side { oi: bigint; sizeOverEntry: bigint; collateral: bigint; reserved: bigint }

export interface MarketOnChain {
  p: {
    feedId: Hex
    enabled: boolean
    maxLeverage: number
    openFeeBps: number
    closeFeeBps: number
    liquidationBps: number
    borrowRatePerHour: bigint
    maxOiLong: bigint
    maxOiShort: bigint
  }
  borrowIndex: bigint
  lastBorrowUpdate: bigint
  long_: Side
  short_: Side
}

const BPS = 10_000n
const E18 = 10n ** 18n
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** The market's borrow index at `nowSec`, as the contract would accrue it. */
export function borrowIndexAt(m: MarketOnChain, nowSec: number): bigint {
  const elapsed = BigInt(Math.max(0, nowSec - Number(m.lastBorrowUpdate)))
  return m.borrowIndex + (m.p.borrowRatePerHour * elapsed) / 3600n
}

/** The contract's own close math (SensePerps._values / _close) at `price`: P&L (capped), fees,
 * equity, what the trader would get, and whether it would be liquidated instead. */
export function positionAt(pos: Pos, m: MarketOnChain, price: bigint, nowSec: number) {
  const entry = pos.entryPrice
  const up = price >= entry
  const move = up ? price - entry : entry - price
  let pnl = pos.isLong === up ? (pos.size * move) / entry : -ceilDiv(pos.size * move, entry)
  if (pnl > pos.maxProfit) pnl = pos.maxProfit
  const borrowFee = ceilDiv(pos.size * (borrowIndexAt(m, nowSec) - pos.borrowIndex), E18)
  const closeFee = (pos.size * BigInt(m.p.closeFeeBps)) / BPS
  const equity = pos.collateral + pnl - borrowFee
  const liquidatable = equity < (pos.size * BigInt(m.p.liquidationBps)) / BPS + closeFee
  const payout = liquidatable || equity <= closeFee ? 0n : equity - closeFee
  return { pnl, borrowFee, closeFee, equity, liquidatable, payout }
}

/** The price at which a position is liquidated, with its borrow fee as of `nowSec`. */
export function liquidationPriceOf(pos: Pos, m: MarketOnChain, nowSec: number): bigint {
  const borrowFee = ceilDiv(pos.size * (borrowIndexAt(m, nowSec) - pos.borrowIndex), E18)
  const need = (pos.size * BigInt(m.p.liquidationBps)) / BPS + (pos.size * BigInt(m.p.closeFeeBps)) / BPS + borrowFee
  if (pos.collateral <= need) return pos.entryPrice
  const move = (pos.entryPrice * (pos.collateral - need)) / pos.size
  return pos.isLong ? (pos.entryPrice > move ? pos.entryPrice - move : 0n) : pos.entryPrice + move
}
