// Every way to trade or move money on ARCDEX, in one list (2026-10-11, the build pack's "transparent supported-route
// registry"): what goes in and out, through which provider, ARCDEX's fee, the usual time, the limits, and whether it's
// live. Shown on /routes (pages/RoutesPage.tsx) with each provider's health, checked from the visitor's browser.
// Anything not listed here isn't supported. Keep this in step when a route is added or changed.

import { N_ } from './i18n'
import { HL_TRADING } from '../hl/client'
import { BRIDGE_NETWORKS } from './bridgeChains'
import type { Page } from '../App'

export type RouteGroup = 'spot' | 'cross' | 'bridge' | 'futures'
export type RouteStatus = 'live' | 'off' | 'testnet'
export type ProviderId = 'arc' | 'relay' | 'across' | 'circle' | 'hyperliquid' | 'robinhood' | 'solana' | 'bsc' | 'engine'

export interface SupportedRoute {
  id: string
  group: RouteGroup
  from: string
  to: string
  provider: string
  /** ARCDEX's own fee (the provider's and the network's come on top, and each quote shows them). */
  fee: string
  time: string
  notes: string
  status: RouteStatus
  page: Page | null
  providers: ProviderId[]
}

export const GROUP_LABEL: Record<RouteGroup, string> = {
  spot: N_('Spot on Arc'),
  cross: N_('Cross-chain trades'),
  bridge: N_('Bridge'),
  futures: N_('Futures and predictions'),
}

const SECONDS = N_('Seconds')
const ABOUT_2S = N_('About 2 seconds')
const evmBridge = BRIDGE_NETWORKS.filter(n => n.evm).map(n => n.label).join(', ')

export const ROUTES: SupportedRoute[] = [
  { id: 'arc-spot', group: 'spot', from: N_('USDC on Arc'), to: N_('Launchpad and established coins on Arc'), provider: N_('ARCDEX swap router (Uniswap v4 and v3)'), fee: '2%', time: SECONDS, notes: N_('Exact approvals; every trade is simulated before you sign it.'), status: 'live', page: { name: 'terminal' }, providers: ['arc'] },
  { id: 'arc-curves', group: 'spot', from: N_('USDC on Arc'), to: N_('Mercuri and SolonPad coins on their curve'), provider: N_('ARCDEX curve router'), fee: '2%', time: SECONDS, notes: N_('Until the coin graduates to its pool.'), status: 'live', page: { name: 'terminal' }, providers: ['arc'] },
  { id: 'arc-native', group: 'spot', from: N_('USDC on Arc'), to: N_('Coins in native-USDC pools (Minara, SolonPad instant)'), provider: N_('Uniswap Universal Router'), fee: '2%', time: SECONDS, notes: N_('The fee is taken in the same transaction.'), status: 'live', page: { name: 'terminal' }, providers: ['arc'] },
  { id: 'rh', group: 'cross', from: N_('USDC on Arc'), to: N_('Robinhood Chain coins and stock tokens, and back'), provider: 'Across', fee: '2%', time: ABOUT_2S, notes: N_('Stock tokens can’t be bought from restricted countries. Selling is signed on Robinhood Chain and needs a little ETH there.'), status: 'live', page: { name: 'robinhood' }, providers: ['across', 'robinhood'] },
  { id: 'sol', group: 'cross', from: N_('USDC on Arc, SOL or Solana USDC'), to: N_('Solana launchpad coins, and back'), provider: 'Relay', fee: '2%', time: ABOUT_2S, notes: N_('Sales are signed on Solana.'), status: 'live', page: { name: 'solana' }, providers: ['relay', 'solana'] },
  { id: 'bsc', group: 'cross', from: N_('USDC on Arc, BNB or USDT'), to: N_('BNB Chain coins that left four.meme’s curve, and back'), provider: 'Relay', fee: '2%', time: ABOUT_2S, notes: N_('Sales are signed on BNB Chain and need a little BNB there.'), status: 'live', page: { name: 'bsc' }, providers: ['relay', 'bsc'] },
  { id: 'four', group: 'cross', from: N_('BNB or USDT on BNB Chain'), to: N_('four.meme coins still on their curve'), provider: N_('four.meme’s own contract'), fee: '0%', time: SECONDS, notes: N_('four.meme’s own fee applies. A coin can’t be sold in the block it was bought in.'), status: 'live', page: { name: 'bsc' }, providers: ['bsc'] },
  { id: 'sol-wallet', group: 'cross', from: N_('SOL or Solana USDC'), to: N_('Coins on Arc, BNB Chain and Robinhood Chain, and back'), provider: 'Relay', fee: '2%', time: ABOUT_2S, notes: N_('Held by an account your Solana wallet opens; Robinhood’s stock tokens have no route.'), status: 'live', page: { name: 'terminal' }, providers: ['relay', 'solana'] },
  { id: 'cctp', group: 'bridge', from: N_('USDC on Arc'), to: evmBridge, provider: 'Circle CCTP v2', fee: N_('0.5% ($0.05 to $50)'), time: N_('About a minute (Ethereum longer)'), notes: N_('Both ways. Only USDC moves.'), status: 'live', page: { name: 'bridge' }, providers: ['circle', 'arc'] },
  { id: 'cctp-sol', group: 'bridge', from: N_('USDC on Arc'), to: N_('USDC on Solana'), provider: 'Circle CCTP v2', fee: N_('0.5% ($0.05 to $50)'), time: N_('About a minute'), notes: N_('Solana is a destination only here; to come back, use Relay.'), status: 'live', page: { name: 'bridge' }, providers: ['circle', 'solana'] },
  { id: 'relay-sol', group: 'bridge', from: N_('SOL or Solana USDC'), to: N_('USDC on Arc, and back'), provider: 'Relay', fee: '0.5%', time: SECONDS, notes: N_('From a Solana wallet.'), status: 'live', page: { name: 'bridge', dir: 'in' }, providers: ['relay', 'solana'] },
  { id: 'hl-fund', group: 'futures', from: N_('USDC on Arc'), to: N_('Your Hyperliquid account, and back'), provider: 'Relay', fee: '0%', time: SECONDS, notes: N_('Opens with trading on Hyperliquid.'), status: HL_TRADING ? 'live' : 'off', page: { name: 'perps' }, providers: ['relay', 'hyperliquid'] },
  { id: 'hl-perps', group: 'futures', from: N_('Your Hyperliquid account'), to: N_('Futures on crypto, stocks, indices, commodities and FX'), provider: 'Hyperliquid', fee: N_('0.05% (once active)'), time: N_('Instant'), notes: N_('Not for US persons, Ontario or sanctioned regions.'), status: HL_TRADING ? 'live' : 'off', page: { name: 'perps' }, providers: ['hyperliquid'] },
  { id: 'hl-predict', group: 'futures', from: N_('Your Hyperliquid account'), to: N_('Prediction markets'), provider: 'Hyperliquid', fee: N_('0.1% on sells (once active)'), time: N_('Instant'), notes: N_('Settled by Hyperliquid. Not for US persons, Ontario or sanctioned regions.'), status: HL_TRADING ? 'live' : 'off', page: { name: 'predict' }, providers: ['hyperliquid'] },
  { id: 'testnet', group: 'futures', from: N_('Test USDC on Arc testnet'), to: N_('BTC, ETH and SOL futures, up to 10×'), provider: N_('ARCDEX futures contract'), fee: N_('Test funds'), time: N_('15 to 30 seconds'), notes: N_('No real money. Mainnet only after an independent audit.'), status: 'testnet', page: { name: 'futures' }, providers: ['engine'] },
]

/** What isn't supported, said plainly (the build pack: don't imply every coin or chain works). */
export const NOT_SUPPORTED: string[] = [
  N_('Tokens other than USDC through the bridge'),
  N_('Coins on Base, Ethereum and the other bridge networks: only their USDC moves'),
  N_('Starknet'),
  N_('Hyperliquid’s spot tokens and vaults'),
]
