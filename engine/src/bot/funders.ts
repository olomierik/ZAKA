// Who funded a bot's live wallet (2026-09-30, owner: "remove the email
// verification on live trades"). Without an emailed code, a withdrawal goes
// only back to a wallet that funded the bot, and the account passcode is asked
// too: money can only return where it came from, so someone holding a stolen
// session can't send it anywhere else.
//
// A funder is an ordinary wallet (no contract code; EIP-7702 counts) that sent
// the bot's wallet at least $1 and at least 5% of everything ordinary wallets
// sent it. The share stops a dust attack: sending $0.01 from one's own wallet
// to become a "funder" of everything else (the same rule as the site's trading
// wallet, src/arcdex/lib/funding.ts). A contract paying out (a sale through
// the router) isn't funding and doesn't count toward the total.
//
// Deposits are read from both USDC log sources: the USDC contract (6
// decimals) and the native-USDC logger 0xff…fe (18 decimals). An ERC-20
// transfer is logged by both, so each (transaction, sender) counts once.

import { pad } from 'viem'
import { hex, type RawLog } from '../../../api/_arcLogs'
import type { Rpc } from '../chain/http'

const USDC = '0x3600000000000000000000000000000000000000'
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'

export const FUNDER = {
  minUsd: 1,
  minShare: 0.05,
  /** Blocks per getLogs call (every Arc endpoint takes 9k), and calls per batch. */
  slice: 9_000,
  perBatch: 12,
  /** A new wallet's scan starts this far back from when it was made, counting a block per 0.3s (Arc makes one about every 0.48s). */
  msPerBlock: 300,
  margin: 5_000,
}

/** What's been read about a bot wallet's deposits (kept on the wallet). */
export interface FundingLedger {
  /** The last block scanned. */
  scannedTo: number
  /** Keyed `${tx}:${sender}`. */
  deposits: Record<string, { from: string; usd: number }>
  /** Senders with contract code: their payouts aren't funding. */
  contracts: string[]
  /** Senders checked and found to be ordinary wallets. */
  wallets: string[]
}

export const emptyLedger = (): FundingLedger => ({ scannedTo: 0, deposits: {}, contracts: [], wallets: [] })

/** USDC sent to `wallet` in these logs, one entry per transaction and sender. */
export function depositsIn(logs: RawLog[], wallet: string): Record<string, { from: string; usd: number }> {
  const to = pad(wallet.toLowerCase() as `0x${string}`).toLowerCase()
  const out: Record<string, { from: string; usd: number }> = {}
  for (const l of logs) {
    const addr = l.address.toLowerCase()
    if ((addr !== USDC && addr !== NATIVE_LOGGER) || l.topics[0]?.toLowerCase() !== TRANSFER || l.topics[2]?.toLowerCase() !== to) continue
    const from = `0x${l.topics[1]!.slice(26)}`.toLowerCase()
    const key = `${l.transactionHash.toLowerCase()}:${from}`
    if (out[key]) continue
    const raw = BigInt(l.data === '0x' ? 0 : l.data)
    out[key] = { from, usd: Number(raw) / (addr === USDC ? 1e6 : 1e18) }
  }
  return out
}

/** The wallets that funded it, largest first. */
export function fundersOf(l: FundingLedger): { address: string; usd: number }[] {
  const by = new Map<string, number>()
  for (const d of Object.values(l.deposits)) {
    if (d.from === ZERO || l.contracts.includes(d.from)) continue
    by.set(d.from, (by.get(d.from) ?? 0) + d.usd)
  }
  const total = [...by.values()].reduce((s, x) => s + x, 0)
  return [...by].filter(([, usd]) => usd >= FUNDER.minUsd && usd >= FUNDER.minShare * total)
    .map(([address, usd]) => ({ address, usd: Math.round(usd * 100) / 100 }))
    .sort((a, b) => b.usd - a.usd)
}

/** Whether code at an address makes it a contract (an EIP-7702 delegation is still an ordinary wallet). */
export const isContractCode = (code: string | null | undefined) => !!code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100')

/**
 * Brings the ledger up to the chain's head: the deposits since its last
 * scan (from `startBlock` for a new one), and whether each new sender is a
 * contract. Stops at `deadline` with what it finished; the next call goes on.
 */
export async function scanFunding(rpc: Rpc, wallet: string, l: FundingLedger, startBlock: number, deadline = Date.now() + 20_000): Promise<FundingLedger> {
  const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])))
  const next: FundingLedger = { ...l, deposits: { ...l.deposits }, contracts: [...l.contracts], wallets: [...l.wallets] }
  let from = Math.max(l.scannedTo + 1, startBlock)
  const topics = [TRANSFER, null, pad(wallet.toLowerCase() as `0x${string}`)]
  while (from <= head && Date.now() < deadline) {
    const slices: [number, number][] = []
    for (let a = from; a <= head && slices.length < FUNDER.perBatch; a += FUNDER.slice) slices.push([a, Math.min(head, a + FUNDER.slice - 1)])
    const res = await rpc.batch<RawLog[]>(slices.map(([a, b]) => ({ method: 'eth_getLogs', params: [{ address: [USDC, NATIVE_LOGGER], topics, fromBlock: hex(a), toBlock: hex(b) }] })))
    let done = 0
    for (let i = 0; i < slices.length; i++) {
      if (!res[i]) break // the contiguous prefix only: a slice without an answer is read again next time
      Object.assign(next.deposits, depositsIn(res[i]!, wallet))
      done = i + 1
    }
    if (!done) break
    next.scannedTo = slices[done - 1][1]
    from = next.scannedTo + 1
    if (done < slices.length) break
  }
  // Each new sender: a contract (a sale paying out) or an ordinary wallet.
  const unknown = [...new Set(Object.values(next.deposits).map(d => d.from))].filter(a => a !== ZERO && !next.contracts.includes(a) && !next.wallets.includes(a))
  if (unknown.length) {
    const codes = await rpc.batch<string>(unknown.map(a => ({ method: 'eth_getCode', params: [a, 'latest'] })))
    unknown.forEach((a, i) => {
      if (codes[i] === null) return // unanswered: asked again next time, and not a funder meanwhile
      if (isContractCode(codes[i])) next.contracts.push(a)
      else next.wallets.push(a)
    })
  }
  // Only senders known to be ordinary wallets can be funders.
  return next
}

/** Funders among senders known to be ordinary wallets. */
export function knownFunders(l: FundingLedger): { address: string; usd: number }[] {
  return fundersOf({ ...l, contracts: [...l.contracts, ...[...new Set(Object.values(l.deposits).map(d => d.from))].filter(a => !l.wallets.includes(a))] })
}
