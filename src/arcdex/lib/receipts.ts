// A transaction's receipt the moment its block lands.
//
// Arc makes a block about every 0.5s. viem's waitForTransactionReceipt
// watches the block number — every 4s on a chain that doesn't declare its
// block time, which Arc's definition didn't — and on each new block also
// checks whether the transaction was replaced. A trade that had confirmed
// was noticed up to 4s late, twice over for approve + swap.
//
// This asks for the receipt itself every 250ms, from two endpoints at once
// (Arc's public RPC and Blockdaemon), and takes whichever has it first: the
// public RPC's load-balanced nodes can trail by a block. A slow endpoint is
// never asked again while it still owes an answer. When the receipt lands,
// every balance on screen refreshes (lib/balances.ts).

import { formatTransactionReceipt, WaitForTransactionReceiptTimeoutError, type Hash, type TransactionReceipt } from 'viem'
import { RECENT_RPC, rpcCall } from '../../../api/_arcLogs'
import { ARC_RPC } from './rpc'
import { notifyBalances } from './balances'

type RpcReceipt = Parameters<typeof formatTransactionReceipt>[0]

/** Poll delay: fast while a confirmation is due, then easing off. */
const delayAt = (elapsedMs: number) => (elapsedMs < 20_000 ? 250 : elapsedMs < 60_000 ? 1_000 : 3_000)

export function waitForReceipt(hash: Hash, { timeoutMs = 180_000 }: { timeoutMs?: number } = {}): Promise<TransactionReceipt> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const busy = new Set<string>()
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (r: RpcReceipt) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      notifyBalances()
      resolve(formatTransactionReceipt(r))
    }
    const tick = () => {
      if (done) return
      const elapsed = Date.now() - start
      if (elapsed > timeoutMs) {
        done = true
        reject(new WaitForTransactionReceiptTimeoutError({ hash }))
        return
      }
      for (const url of [ARC_RPC, RECENT_RPC]) {
        if (busy.has(url)) continue
        busy.add(url)
        rpcCall<RpcReceipt | null>(url, 'eth_getTransactionReceipt', [hash], 5_000)
          .then(r => { if (r) finish(r) }, () => { /* this endpoint missed a beat; the other is asked too */ })
          .finally(() => busy.delete(url))
      }
      timer = setTimeout(tick, delayAt(elapsed))
    }
    tick()
  })
}
