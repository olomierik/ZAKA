// GET/POST /api/index-trades
// Copies ArcDexSwapRouter events (v1 and the current router) from Arc into
// Supabase so leaderboards, trader profiles, PnL and referral earnings are
// a fast SQL read instead of thousands of RPC log queries per visitor.
//
// It only ever writes what the router itself emitted on-chain, keyed by
// (tx hash, log index), so it's idempotent: any number of overlapping
// calls produce the same rows. Pages call it opportunistically; each call
// catches up at most ~15 log windows within a time budget and is throttled
// per router, so it can't be used to hammer the RPC.

import { keccak256, stringToBytes } from 'viem'
import { adminReady, db, insertIgnore, json, upsert } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

declare const process: { env: Record<string, string | undefined> }

const RPC = 'https://rpc.mainnet.arc.io'
const USDC = '0x3600000000000000000000000000000000000000'
const WINDOW = 9_000 // Arc's node rejects getLogs ranges of 10,000+ blocks
const BUDGET_MS = 18_000
const THROTTLE_MS = 5_000

const V1 = { address: '0xc519b929981f5375d67ab3930ffb100f0a606088', start: 22_548_761 }

const topic = (sig: string) => keccak256(stringToBytes(sig))
const T_SWAPPED = topic('Swapped(address,address,address,uint256,uint256,address,uint256)')
const T_BOUND = topic('ReferrerBound(address,address)')
const T_PAID = topic('ReferralPaid(address,address,address,uint256)')

interface Log { topics: string[]; data: string; blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string }

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 700 * (i + 1))); continue }
    const j = (await res.json()) as { result?: T; error?: { message: string } }
    if (j.error) {
      if (/rate|limit|busy/i.test(j.error.message)) { await new Promise(r => setTimeout(r, 700 * (i + 1))); continue }
      throw new Error(j.error.message)
    }
    return j.result as T
  }
  throw new Error(`${method}: RPC busy`)
}

const hex = (n: number) => '0x' + n.toString(16)
const word = (data: string, i: number) => '0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1))
const topicAddr = (t: string) => '0x' + t.slice(26).toLowerCase()
const big = (w: string) => BigInt(w)
const usdcUnits = (v: bigint) => (Number(v) / 1e6).toFixed(6)

/** First block where `address` has code (deployment block). */
async function deployBlock(address: string, latest: number): Promise<number> {
  let lo = V1.start, hi = latest
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const code = await rpc<string>('eth_getCode', [address, hex(mid)])
    if (code && code !== '0x') hi = mid
    else lo = mid + 1
  }
  return lo
}

export function decode(router: string, logs: Log[]) {
  const trades: Record<string, unknown>[] = []
  const bound: Record<string, unknown>[] = []
  const paid: Record<string, unknown>[] = []
  for (const l of logs) {
    const time = new Date(parseInt(l.blockTimestamp ?? '0x0', 16) * 1000).toISOString()
    const base = { tx_hash: l.transactionHash.toLowerCase(), log_index: parseInt(l.logIndex, 16) }
    if (l.topics[0] === T_SWAPPED) {
      const trader = topicAddr(l.topics[1]), tokenIn = topicAddr(l.topics[2]), tokenOut = topicAddr(l.topics[3])
      const amountIn = big(word(l.data, 0)), amountOut = big(word(l.data, 1))
      const feeToken = ('0x' + word(l.data, 2).slice(26)).toLowerCase(), fee = big(word(l.data, 3))
      const buy = tokenIn === USDC
      if (!buy && tokenOut !== USDC) continue // no USDC leg — not a coin trade we can price
      trades.push({
        ...base, router, block_number: parseInt(l.blockNumber, 16), block_time: time, trader,
        token: buy ? tokenOut : tokenIn,
        side: buy ? 'buy' : 'sell',
        usdc: usdcUnits(buy ? amountIn : amountOut),
        token_amount: (buy ? amountOut : amountIn).toString(),
        fee_usdc: feeToken === USDC ? usdcUnits(fee) : '0',
      })
    } else if (l.topics[0] === T_BOUND) {
      bound.push({ user_address: topicAddr(l.topics[1]), referrer: topicAddr(l.topics[2]), block_time: time, tx_hash: base.tx_hash })
    } else if (l.topics[0] === T_PAID) {
      const token = topicAddr(l.topics[3]), amount = big(word(l.data, 0))
      paid.push({ ...base, referrer: topicAddr(l.topics[1]), user_address: topicAddr(l.topics[2]), token, amount: token === USDC ? usdcUnits(amount) : amount.toString(), block_time: time })
    }
  }
  return { trades, bound, paid }
}

export default async function handler(): Promise<Response> {
  if (!adminReady) return json(503, { error: 'Indexer not configured (Supabase secret key missing)' })
  const deadline = Date.now() + BUDGET_MS
  const latest = parseInt(await rpc<string>('eth_blockNumber', []), 16)

  const routers = [V1.address]
  const current = (process.env.VITE_ARCDEX_SWAP_ROUTER_ADDRESS ?? '').trim().toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(current) && current !== V1.address) routers.push(current)

  const report: Record<string, unknown>[] = []
  for (const router of routers) {
    const state = (await db<{ last_block: number; updated_at: string }[]>(`arcdex_indexer_state?router=eq.${router}&select=last_block,updated_at`))[0]
    if (state && Date.now() - Date.parse(state.updated_at) < THROTTLE_MS) { report.push({ router, skipped: 'throttled', lastBlock: state.last_block }); continue }

    let from = state ? Number(state.last_block) + 1 : router === V1.address ? V1.start : await deployBlock(router, latest)
    let indexed = 0
    while (from <= latest && Date.now() < deadline) {
      const to = Math.min(from + WINDOW - 1, latest)
      const logs = await rpc<Log[]>('eth_getLogs', [{ address: router, fromBlock: hex(from), toBlock: hex(to), topics: [[T_SWAPPED, T_BOUND, T_PAID]] }])
      const { trades, bound, paid } = decode(router, logs)
      await insertIgnore('arcdex_trades', trades)
      await insertIgnore('arcdex_referrals', bound)
      await insertIgnore('arcdex_referral_payouts', paid)
      await upsert('arcdex_indexer_state', [{ router, last_block: to, updated_at: new Date().toISOString() }], 'router')
      indexed += trades.length
      from = to + 1
    }
    report.push({ router, indexed, lastBlock: from - 1, behind: latest - (from - 1) })
  }
  return json(200, { latest, routers: report })
}
