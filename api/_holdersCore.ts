// Holder-index helpers shared by /api/holders and its tests. (The leading
// underscore keeps Vercel from deploying this file as its own function.)

import { ARCHIVE_RPCS, hex, rpcCall, type RawLog } from './_arcLogs'

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'
export const BURN = '0x000000000000000000000000000000000000dead'
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** ~47 days. Older tokens (USDC, EURC…) aren't indexed here. */
export const MAX_AGE_BLOCKS = 8_000_000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let probe = 0
async function codeAt(token: string, block: number): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const code = await rpcCall<string>(ARCHIVE_RPCS[probe++ % ARCHIVE_RPCS.length], 'eth_getCode', [token, hex(block)], 6_000)
      return code.length > 2
    } catch (e) {
      if (attempt >= 4) throw e
      await sleep(250 * 2 ** attempt)
    }
  }
}

/** First block with the contract's code: 3 probes per round in parallel. A
 * hint (the pool's creation time) narrows it to a few rounds; it's always
 * verified, so a wrong hint only costs time. */
export async function creationBlock(token: string, head: number, hintSec: number | null): Promise<number | null> {
  let lo = Math.max(0, head - MAX_AGE_BLOCKS) // no code here
  let hi = head                                // code here
  if (hintSec) {
    // Arc: ~0.5s blocks. ±20k blocks (~3h) around the hint.
    const guess = head - Math.round((Date.now() / 1000 - hintSec) / 0.5)
    const a = Math.max(lo, guess - 20_000), b = Math.min(hi, guess + 20_000)
    const [ca, cb] = await Promise.all([codeAt(token, a), codeAt(token, b)])
    if (!ca && cb) { lo = a; hi = b }
  }
  if (lo === Math.max(0, head - MAX_AGE_BLOCKS)) {
    const [cl, ch] = await Promise.all([codeAt(token, lo), codeAt(token, hi)])
    if (!ch || cl) return null // not a contract, or older than we index
  }
  while (hi - lo > 1) {
    const step = (hi - lo) / 4
    const pts = [1, 2, 3].map(k => Math.floor(lo + step * k)).filter((p, i, a) => p > lo && p < hi && a.indexOf(p) === i)
    const has = await Promise.all(pts.map(p => codeAt(token, p)))
    let nlo = lo, nhi = hi
    pts.forEach((p, i) => { if (has[i]) nhi = Math.min(nhi, p); else nlo = Math.max(nlo, p) })
    if (nlo === lo && nhi === hi) break
    lo = nlo; hi = nhi
  }
  return hi
}

/** Net balance change per address over a batch of Transfer logs. */
export function deltasOf(logs: RawLog[]): Map<string, bigint> {
  const m = new Map<string, bigint>()
  for (const l of logs) {
    if (l.topics.length !== 3 || !l.data || l.data.length < 66) continue // ERC-721 etc.
    const v = BigInt(l.data.slice(0, 66))
    if (v === 0n) continue
    const from = '0x' + l.topics[1].slice(26).toLowerCase()
    const to = '0x' + l.topics[2].slice(26).toLowerCase()
    if (from !== ZERO) m.set(from, (m.get(from) ?? 0n) - v)
    if (to !== ZERO) m.set(to, (m.get(to) ?? 0n) + v)
  }
  return m
}

export function mergeDeltas(parts: Map<string, bigint>[]): Record<string, string> {
  const all = new Map<string, bigint>()
  for (const p of parts) for (const [k, v] of p) all.set(k, (all.get(k) ?? 0n) + v)
  const out: Record<string, string> = {}
  for (const [k, v] of all) if (v !== 0n) out[k] = v.toString()
  return out
}

