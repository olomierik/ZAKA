// Who funded a coin's early buyers. Wallets whose first USDC came from the
// same source are one buyer in several wallets (a cluster: fake demand, and
// one seller later); wallets funded by the coin's creator are the creator
// buying their own launch. A source that has paid dozens of different
// wallets is a hub (an exchange, a faucet, a bridge), not a cluster.
//
// USDC paid out by a contract (the v4 PoolManager on a sell, a launchpad
// curve, a disperse contract) names whoever sent that transaction instead:
// the wallet itself when it sold something (which says nothing about who
// funded it), or the person behind a disperse.

import type { RawLog } from '../../../api/_arcLogs'
import { USDC } from '../../../api/_arcSwaps'
import type { Rpc } from '../chain/http'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
/** Arc logs native USDC sends from this system address (18 decimals). */
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const pad = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const hex = (n: number) => '0x' + n.toString(16)
const ZERO = '0x0000000000000000000000000000000000000000'
/** How far back to look for a wallet's funding (Blockdaemon's getLogs span). */
const LOOKBACK = 99_999
/** A source that paid more wallets than this in the window is a hub, not a cluster. */
export const HUB_WALLETS = 25
/** The shorter window a hub's payments are counted over when the whole one is too much to return. */
const RETRY_SPAN = 10_000

export interface Clusters {
  /** Sources that funded 3 or more of the wallets. */
  groups: { funder: string; wallets: string[] }[]
  /** Wallets the creator funded. */
  creatorFunded: string[]
  /** Wallets funded by the same source as the creator. */
  sameSourceAsCreator: string[]
  /** Wallets whose funding couldn't be read or was found. */
  unknown: number
}

/** The first USDC payment to each wallet: who sent it, in which transaction (pure over logs; exported for tests). */
export function firstFunding(logsByWallet: Map<string, Pick<RawLog, 'topics' | 'blockNumber' | 'logIndex' | 'transactionHash'>[]>): Map<string, { from: string; tx: string } | null> {
  const out = new Map<string, { from: string; tx: string } | null>()
  for (const [w, logs] of logsByWallet) {
    const first = [...logs].sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16))[0]
    out.set(w, first ? { from: ('0x' + first.topics[1].slice(26)).toLowerCase(), tx: first.transactionHash } : null)
  }
  return out
}

/** The first USDC sender to each wallet before `block` (pure over logs; exported for tests). */
export function firstFunders(logsByWallet: Map<string, Pick<RawLog, 'topics' | 'blockNumber' | 'logIndex' | 'transactionHash'>[]>): Map<string, string | null> {
  return new Map([...firstFunding(logsByWallet)].map(([w, f]) => [w, f?.from ?? null]))
}

/**
 * Who really funded each wallet (pure; exported for tests). A payment from a
 * contract names the transaction's sender; the wallet's own transaction (it
 * sold something, or withdrew) says nothing, like a bridge mint (ZERO).
 * `contracts` are the senders with code; `txFrom` maps a transaction to its
 * sender, and a missing one leaves the wallet unknown.
 */
export function resolveFunders(first: Map<string, { from: string; tx: string } | null>, contracts: Set<string>, txFrom: Map<string, string>): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const [w, f] of first) {
    if (!f || !contracts.has(f.from)) { out.set(w, f?.from ?? null); continue }
    const sender = txFrom.get(f.tx)?.toLowerCase()
    out.set(w, sender === undefined ? null : sender === w ? ZERO : sender)
  }
  return out
}

/** Groups (pure; exported for tests). `hubs` are sources known to fund many wallets. */
export function groupFunders(funders: Map<string, string | null>, creator: string | null, creatorFunder: string | null, hubs: Set<string>): Clusters {
  const by = new Map<string, string[]>()
  let unknown = 0
  for (const [w, f] of funders) {
    if (!f) { unknown++; continue }
    if (f === ZERO || hubs.has(f)) continue // a bridge mint or a hub: says nothing
    by.set(f, [...(by.get(f) ?? []), w])
  }
  const c = creator?.toLowerCase() ?? null
  return {
    groups: [...by].filter(([, ws]) => ws.length >= 3).map(([funder, wallets]) => ({ funder, wallets })),
    creatorFunded: c ? by.get(c) ?? [] : [],
    sameSourceAsCreator: creatorFunder && creatorFunder !== ZERO && !hubs.has(creatorFunder) ? (by.get(creatorFunder) ?? []).filter(w => w !== c) : [],
    unknown,
  }
}

/** Funding of `wallets` (each looked up before `block`), and of the creator. */
export async function clustersOf(rpc: Rpc, wallets: string[], creator: string | null, block: number): Promise<Clusters> {
  const who = [...new Set([...wallets, ...(creator ? [creator] : [])].map(w => w.toLowerCase()))]
  const res = await rpc.batch<RawLog[]>(who.map(w => ({
    method: 'eth_getLogs',
    params: [{ address: [USDC, NATIVE_LOGGER], topics: [TRANSFER, null, pad(w)], fromBlock: hex(Math.max(0, block - LOOKBACK)), toBlock: hex(block) }],
  })))
  const logs = new Map<string, RawLog[]>()
  who.forEach((w, i) => { if (res[i]) logs.set(w, res[i]!) })
  const first = firstFunding(logs)
  for (const w of who) if (!logs.has(w)) first.set(w, null)
  // Payments from contracts: who sent those transactions?
  const senders = [...new Set([...first.values()].flatMap(f => f && f.from !== ZERO ? [f.from] : []))]
  const codes = senders.length ? await rpc.batch<string>(senders.map(a => ({ method: 'eth_getCode', params: [a, 'latest'] }))) : []
  // EIP-7702 accounts (0xef0100…) are people; an unreadable one is left as sent.
  const contracts = new Set(senders.filter((_, i) => { const c = codes[i]; return !!c && c !== '0x' && !c.startsWith('0xef0100') }))
  const viaContract = [...new Set([...first.values()].flatMap(f => f && contracts.has(f.from) ? [f.tx] : []))]
  const txs = viaContract.length ? await rpc.batch<{ from: string }>(viaContract.map(h => ({ method: 'eth_getTransactionByHash', params: [h] }))) : []
  const txFrom = new Map<string, string>()
  viaContract.forEach((h, i) => { const t = txs[i]; if (t?.from) txFrom.set(h, t.from.toLowerCase()) })
  const funders = resolveFunders(first, contracts, txFrom)
  // Sources shared by 3+ wallets: are they hubs? (How many wallets they paid in the window.)
  const counts = new Map<string, number>()
  for (const [w, f] of funders) if (f && w !== creator?.toLowerCase()) counts.set(f, (counts.get(f) ?? 0) + 1)
  const shared = [...counts].filter(([f, n]) => n >= 3 && f !== ZERO).map(([f]) => f)
  const hubs = new Set<string>()
  if (shared.length) {
    const paid = (who: string[], from: number) => rpc.batch<RawLog[]>(who.map(f => ({
      method: 'eth_getLogs',
      params: [{ address: [USDC, NATIVE_LOGGER], topics: [TRANSFER, pad(f)], fromBlock: hex(Math.max(0, from)), toBlock: hex(block) }],
    })))
    const sent = await paid(shared, block - LOOKBACK)
    // No answer over the whole window usually means too many transfers to
    // return; count the last stretch instead, and if even that fails, it's a hub.
    const retry = shared.filter((_, i) => !sent[i])
    const short = retry.length ? await paid(retry, block - RETRY_SPAN) : []
    shared.forEach((f, i) => {
      const logs = sent[i] ?? (retry.includes(f) ? short[retry.indexOf(f)] : null) ?? null
      if (!logs || new Set(logs.map(l => l.topics[2])).size > HUB_WALLETS) hubs.add(f)
    })
  }
  const c = creator?.toLowerCase() ?? null
  const creatorFunder = c ? funders.get(c) ?? null : null
  if (c) funders.delete(c)
  return groupFunders(funders, c, creatorFunder, hubs)
}
