// ── Launchpad trust score — bundling / wallet-cluster heuristics ───────
// Every ARCDEX launchpad token already gets the same on-chain floor from
// ArcLaunchpad.sol itself: anti-snipe ($2k/tx for 10min), anti-bundle
// ($5k/block across ALL wallets), anti-bot (tx.origin), and a curve design
// with no owner withdrawal path — see AGENTS.md. Those are guarantees, the
// same for every token, so they aren't a per-token score.
//
// What varies per token is whether its *early buyers* look independent or
// coordinated — a human clicking "buy" from several of their own wallets
// isn't something any smart contract can see. That's the same limit every
// wallet-cluster tool (Bubblemaps, RugCheck, InsightX) runs into, and they
// all converge on the same heuristic for it: walk each early holder's
// funding history looking for a shared upstream sender, temporal
// correlation, and wallets with no independent activity of their own.
// This is that heuristic, run against Arc's own chain data — no indexer,
// no third-party API (Arc's explorer sits behind a Cloudflare bot-check
// that blocks plain fetches, so this reads straight from the RPC node
// this app already uses for everything else).
//
// It is a probabilistic signal, not proof. A well-resourced actor can
// still break the funding-ancestor signal (e.g. routing each wallet
// through a different exchange). Say so in the UI rather than presenting
// a score as a guarantee.

import { type Address, parseAbi } from 'viem'
import { client, getRecentTrades, getDevHoldingPct, getLaunchBlock, type CurveState, type CurveTrade } from './launchpad'

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as Address
const USDC_TRANSFER_EVENT = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0]

// Bounds so a single token page load stays cheap regardless of how much
// activity the token has: ~25 early buyers, each one funding lookback
// capped to 5,000 blocks before their first buy (comfortably covers the
// contract's own 10-minute anti-snipe window on any realistic block time).
const MAX_EARLY_BUYERS = 25
const FUNDING_LOOKBACK_BLOCKS = 5_000n

export interface FundingCluster {
  funder: Address
  wallets: Address[]
}

export interface TrustReport {
  score: number // 0-100, 100 = no red flags found
  devHoldingPct: number
  earlyBuyerCount: number
  freshWalletCount: number
  sameBlockGroups: number
  clusters: FundingCluster[]
  flags: string[]
}

async function findFundingSender(wallet: Address, beforeBlock: bigint): Promise<Address | null> {
  try {
    const fromBlock = beforeBlock > FUNDING_LOOKBACK_BLOCKS ? beforeBlock - FUNDING_LOOKBACK_BLOCKS : 0n
    const logs = await client.getLogs({
      address: USDC_ADDRESS,
      event: USDC_TRANSFER_EVENT,
      args: { to: wallet },
      fromBlock,
      toBlock: beforeBlock,
    })
    if (logs.length === 0) return null
    // earliest incoming transfer in the window — the wallet's funding source
    return (logs[0].args as { from?: Address }).from ?? null
  } catch {
    return null
  }
}

async function isFreshWallet(wallet: Address, atBlock: bigint): Promise<boolean> {
  try {
    const count = await client.getTransactionCount({ address: wallet, blockNumber: atBlock })
    return count <= 1 // 0 or 1 prior tx (their funding tx itself) before this buy
  } catch {
    return false
  }
}

export async function computeTrustReport(token: Address, curve: CurveState): Promise<TrustReport> {
  const flags: string[] = []
  const devHoldingPct = await getDevHoldingPct(token, curve.creator).catch(() => 0)

  const launchBlock = await getLaunchBlock(token).catch(() => null)
  const scanFrom = launchBlock ?? undefined
  const trades: CurveTrade[] = await getRecentTrades(token, scanFrom).catch(() => [])

  // getRecentTrades returns newest-first; walk oldest-first and keep each
  // wallet's FIRST buy only — that's the moment its funding matters.
  const chronological = [...trades].reverse().filter(t => t.isBuy)
  const seen = new Set<string>()
  const earlyBuyers: CurveTrade[] = []
  for (const t of chronological) {
    const key = t.trader.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    earlyBuyers.push(t)
    if (earlyBuyers.length >= MAX_EARLY_BUYERS) break
  }

  if (earlyBuyers.length === 0) {
    return { score: 100, devHoldingPct, earlyBuyerCount: 0, freshWalletCount: 0, sameBlockGroups: 0, clusters: [], flags: ['No trades yet.'] }
  }

  const [funders, freshFlags] = await Promise.all([
    Promise.all(earlyBuyers.map(b => findFundingSender(b.trader, b.blockNumber))),
    Promise.all(earlyBuyers.map(b => isFreshWallet(b.trader, b.blockNumber))),
  ])

  // same-block clustering: blocks where >1 distinct wallet bought
  const byBlock = new Map<string, Set<string>>()
  for (const b of earlyBuyers) {
    const key = b.blockNumber.toString()
    if (!byBlock.has(key)) byBlock.set(key, new Set())
    byBlock.get(key)!.add(b.trader.toLowerCase())
  }
  const sameBlockGroups = [...byBlock.values()].filter(s => s.size > 1).length

  // funding-ancestor clustering
  const byFunder = new Map<string, Set<Address>>()
  earlyBuyers.forEach((b, i) => {
    const funder = funders[i]
    if (!funder) return
    const key = funder.toLowerCase()
    if (!byFunder.has(key)) byFunder.set(key, new Set())
    byFunder.get(key)!.add(b.trader)
  })
  const clusters: FundingCluster[] = [...byFunder.entries()]
    .filter(([, wallets]) => wallets.size > 1)
    .map(([funder, wallets]) => ({ funder: funder as Address, wallets: [...wallets] }))

  const freshWalletCount = freshFlags.filter(Boolean).length

  let score = 100

  if (devHoldingPct > 20) { score -= 30; flags.push(`Creator still holds ${devHoldingPct.toFixed(1)}% of supply.`) }
  else if (devHoldingPct > 8) { score -= 15; flags.push(`Creator holds ${devHoldingPct.toFixed(1)}% of supply.`) }

  if (clusters.length > 0) {
    const clusterWallets = clusters.reduce((s, c) => s + c.wallets.length, 0)
    score -= Math.min(35, clusters.length * 15)
    flags.push(`${clusterWallets} early-buyer wallet(s) across ${clusters.length} group(s) share a common USDC funding source — a common bundling pattern.`)
  }

  if (sameBlockGroups > 0) {
    score -= Math.min(15, sameBlockGroups * 5)
    flags.push(`${sameBlockGroups} block(s) had multiple distinct wallets buying simultaneously.`)
  }

  const freshPct = earlyBuyers.length ? (freshWalletCount / earlyBuyers.length) * 100 : 0
  if (freshPct > 50 && earlyBuyers.length >= 5) {
    score -= 15
    flags.push(`${freshPct.toFixed(0)}% of early buyers were freshly-funded wallets with no prior on-chain history.`)
  }

  score = Math.max(0, Math.min(100, score))
  if (flags.length === 0) flags.push('No bundling or funding-cluster patterns detected among early buyers, based on public on-chain data.')

  return { score, devHoldingPct, earlyBuyerCount: earlyBuyers.length, freshWalletCount, sameBlockGroups, clusters, flags }
}
