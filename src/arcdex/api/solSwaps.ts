// Solana swaps straight from the chain (2026-10-05): a coin page's trades within a second or two of landing, where
// GeckoTerminal's come tens of seconds late. The pool's account is watched: its newest transactions
// (getSignaturesForAddress, "confirmed"), each read once (getTransaction, jsonParsed, in one batch request) and
// turned into a trade from what moved:
//
//   the pool's side   the coin and the quote held by accounts the pool owns (pump.fun's curve and PumpSwap's pools
//                     own their vaults); on pump.fun's curve the SOL is the curve account's own lamports. This is
//                     exact, whoever routed the trade (an aggregator, a bot's own program).
//   the signer's side otherwise (LaunchLab, Meteora and Raydium keep their vaults under an authority): the coin and
//                     the quote the signer's own accounts gained or lost, the transaction fee and new token accounts'
//                     rent set aside.
// A transaction that moves no coin for either (an arbitrage leg, a liquidity change) isn't a trade. The trader is
// the transaction's signer.
//
// publicnode's Solana RPC answers browsers (measured 2026-10-05: ~0.3s for the newest signatures, ~0.5s for three
// transactions read in parallel; a batch request may hold only one getTransaction).

import { SOL_RPC_BROWSER, SOL_USDC, WSOL, base58, fromBase64 } from '../../../api/_solCore'
import type { ChainFeed, ChainSwap } from '../lib/useChainTrades'

export interface SolPoolMeta {
  /** The pool's account (GeckoTerminal's pool address: a pump.fun curve, a PumpSwap or Raydium pool…). */
  pool: string
  mint: string
  /** WSOL or USDC: the quotes the trades are priced in. */
  quoteMint: string
}

interface TokenBal { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export interface SolTx {
  slot: number
  blockTime: number | null
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[] | null; postTokenBalances?: TokenBal[] | null; logMessages?: string[] | null } | null
  transaction: { signatures: string[]; message: { accountKeys: ({ pubkey: string } | string)[] } }
}

/** A token account's rent (165 bytes), set aside when the trade opened or closed one. */
const TOKEN_ACCOUNT_RENT = 0.00203928
export const SOL_QUOTES = new Set([WSOL, SOL_USDC])

function delta(tx: SolTx, mint: string, owner: string): number {
  const sum = (list: TokenBal[] | null | undefined) => (list ?? [])
    .filter(b => b.mint === mint && b.owner === owner)
    .reduce((s, b) => s + Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals, 0)
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances)
}

/** One transaction as a trade of the pool's coin, or null. */
export function parseSolSwap(tx: SolTx, m: SolPoolMeta): ChainSwap | null {
  const meta = tx.meta
  if (!meta || meta.err) return null
  const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey))
  const signer = keys[0]
  const sig = tx.transaction.signatures[0]
  if (!signer || !sig) return null
  const sol = m.quoteMint === WSOL

  let tokens = 0, quote = 0, buy = false
  // The pool's side.
  const pc = delta(tx, m.mint, m.pool)
  let pq = delta(tx, m.quoteMint, m.pool)
  const pi = keys.indexOf(m.pool)
  if (sol && pq === 0 && pi >= 0) pq = (meta.postBalances[pi] - meta.preBalances[pi]) / 1e9
  // A pool that holds its own token accounts (PumpSwap, pump.fun's curve) shows every trade in its own balances. One
  // whose balances didn't move wasn't traded in this transaction: an arbitrage bot's transaction can name the pool and
  // trade elsewhere, and its wallet's net change priced ALLOX's "trades" at 2× and 0.03× the market (2026-10-17).
  const owns = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].some(b => b.owner === m.pool && (b.mint === m.mint || b.mint === m.quoteMint))
  if (pc !== 0 && pq !== 0 && Math.sign(pc) !== Math.sign(pq)) {
    buy = pc < 0
    tokens = Math.abs(pc); quote = Math.abs(pq)
  } else if (owns) {
    return null
  } else {
    // The signer's side.
    const sc = delta(tx, m.mint, signer)
    if (sc === 0) return null
    let sq = delta(tx, m.quoteMint, signer)
    if (sol) {
      sq += (meta.postBalances[0] - meta.preBalances[0] + meta.fee) / 1e9
      // Rent for token accounts opened (paid) or closed (returned) isn't part of the price.
      const pre = new Set((meta.preTokenBalances ?? []).filter(b => b.owner === signer).map(b => b.accountIndex))
      const post = new Set((meta.postTokenBalances ?? []).filter(b => b.owner === signer).map(b => b.accountIndex))
      const opened = [...post].filter(i => !pre.has(i)).length
      const closed = [...pre].filter(i => !post.has(i)).length
      sq += (opened - closed) * TOKEN_ACCOUNT_RENT
    }
    if (sq === 0 || Math.sign(sc) === Math.sign(sq)) return null
    buy = sc > 0
    tokens = Math.abs(sc); quote = Math.abs(sq)
  }
  if (!(tokens > 0) || !(quote > 0)) return null
  return {
    id: sig, txHash: sig, time: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    kind: buy ? 'buy' : 'sell', tokenAmount: tokens, quoteAmount: quote, price: quote / tokens, maker: signer,
  }
}

// ── pump.fun's and PumpSwap's own events ────────────────────────────────
// Each swap on pump.fun's curve and in a PumpSwap pool logs its own event ("Program data:", Anchor), with the exact SOL
// and coins of that one swap: the engine reads the same (engine/src/trench/sol.ts decodePumpData, whose layouts were
// read from live transactions). Balance changes net a transaction's swaps together: volume bots that buy and sell in
// one transaction read as one trade at 6× or 0.03× the market (ALLOX, 2026-10-17). So where events are logged, each
// swap of this coin's pool is a trade of its own. The event names' hashes are Anchor's sha256("event:<Name>")[0..8].

const EV = { trade: 'bddb7fd34ee661ee', buy: '67f4521f2cf57777', sell: '3e2f370aa503dc2a' }
const hex8 = (b: Uint8Array) => Array.from(b.subarray(0, 8), x => x.toString(16).padStart(2, '0')).join('')
const u64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true)

export type PumpSwapEvent =
  | { k: 'curve'; mint: string; sol: bigint; tok: bigint; buy: boolean; user: string }
  | { k: 'amm'; pool: string; base: bigint; quote: bigint; poolBase: bigint; poolQuote: bigint; buy: boolean; user: string }

/** A "Program data:" payload as a pump.fun trade or a PumpSwap buy or sell, or null. */
export function decodeSwapEvent(b64: string): PumpSwapEvent | null {
  let b: Uint8Array
  try { b = fromBase64(b64) } catch { return null }
  if (b.length < 16) return null
  const d = hex8(b)
  try {
    if (d === EV.trade && b.length >= 129) return { k: 'curve', mint: base58(b.subarray(8, 40)), sol: u64(b, 40), tok: u64(b, 48), buy: b[56] === 1, user: base58(b.subarray(57, 89)) }
    if ((d === EV.buy || d === EV.sell) && b.length >= 184) return { k: 'amm', buy: d === EV.buy, base: u64(b, 16), quote: u64(b, 64), poolBase: u64(b, 48), poolQuote: u64(b, 56), pool: base58(b.subarray(120, 152)), user: base58(b.subarray(152, 184)) }
  } catch { return null }
  return null
}

/** A transaction's swaps of this coin, one per event (pump.fun's curve, PumpSwap pools quoted in SOL); null when it
 * logs none, so the caller reads it from balances. */
export function swapsFromEvents(tx: SolTx, m: SolPoolMeta): ChainSwap[] | null {
  const logs = tx.meta?.logMessages
  const sig = tx.transaction.signatures[0]
  if (!logs?.length || !sig || tx.meta?.err) return null
  const bals = [...(tx.meta?.postTokenBalances ?? []), ...(tx.meta?.preTokenBalances ?? [])]
  const dec = bals.find(b => b.mint === m.mint)?.uiTokenAmount.decimals ?? 6
  // A PumpSwap pool's base can be the coin (most) or SOL (some, as ALLOX's): its reserve in the event matches the
  // pool's vault of that mint in this transaction (before or after the swap).
  const vault = (mint: string) => bals.filter(b => b.owner === m.pool && b.mint === mint).map(b => BigInt(b.uiTokenAmount.amount))
  const near = (x: bigint, list: bigint[]) => list.some(v => v > 0n && (x > v ? x - v : v - x) * 100n <= v)
  const out: ChainSwap[] = []
  let any = false
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue
    const e = decodeSwapEvent(line.slice(14))
    if (!e) continue
    any = true
    let tokRaw: bigint, solRaw: bigint, buy: boolean
    if (e.k === 'curve') {
      if (e.mint !== m.mint) continue
      tokRaw = e.tok; solRaw = e.sol; buy = e.buy
    } else {
      if (e.pool !== m.pool || m.quoteMint !== WSOL) continue
      const coin = vault(m.mint), sol = vault(WSOL)
      const baseIsCoin = near(e.poolBase, coin) || near(e.poolQuote, sol)
      const baseIsSol = near(e.poolBase, sol) || near(e.poolQuote, coin)
      if (baseIsCoin === baseIsSol) continue
      // A Buy event buys the base with the quote: buying the coin when it's the base, selling it when SOL is.
      tokRaw = baseIsCoin ? e.base : e.quote; solRaw = baseIsCoin ? e.quote : e.base; buy = baseIsCoin ? e.buy : !e.buy
    }
    const tok = Number(tokRaw) / 10 ** dec
    const sol = Number(solRaw) / 1e9
    if (!(tok > 0) || !(sol > 0)) continue
    out.push({
      id: out.length ? `${sig}:${out.length}` : sig, txHash: sig, time: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      kind: buy ? 'buy' : 'sell', tokenAmount: tok, quoteAmount: sol, price: sol / tok, maker: e.user,
    })
  }
  return any ? out : null
}

/** A transaction's trades of the pool's coin: from its events where it logs them, else from what moved. */
export function parseSolSwaps(tx: SolTx, m: SolPoolMeta): ChainSwap[] {
  const ev = swapsFromEvents(tx, m)
  if (ev) return ev
  const one = parseSolSwap(tx, m)
  return one ? [one] : []
}

// ── reading ─────────────────────────────────────────────────────────────

interface SigInfo { signature: string; err: unknown; blockTime: number | null }
const hidden = () => typeof document !== 'undefined' && document.hidden

async function call<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SOL_RPC_BROWSER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 429) throw new Error('429')
  const j = await res.json() as { result?: T; error?: { message?: string } }
  if (j.error) throw new Error(j.error.message ?? 'rpc error')
  return j.result as T
}

/** The transactions, four requests at a time (publicnode takes one getTransaction a request; null for one not
 * readable yet). */
async function transactions(sigs: string[]): Promise<(SolTx | null)[]> {
  const out: (SolTx | null)[] = sigs.map(() => null)
  let i = 0
  let throttled = false
  const worker = async () => {
    while (i < sigs.length && !throttled) {
      const n = i++
      out[n] = await call<SolTx | null>('getTransaction', [sigs[n], { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
        .catch(e => { if (/429/.test(e instanceof Error ? e.message : '')) throttled = true; return null })
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  if (throttled && out.every(t => !t)) throw new Error('429')
  return out
}

const signatures = (pool: string, opts: { limit: number; until?: string }) =>
  call<SigInfo[]>('getSignaturesForAddress', [pool, { ...opts, commitment: 'confirmed' }])

/** The pool's latest trades (its newest 12 transactions read), newest first, and the newest signature seen. */
export async function loadSolSwaps(m: SolPoolMeta): Promise<{ swaps: ChainSwap[]; newest: string | null }> {
  const sigs = await signatures(m.pool, { limit: 40 })
  const ok = sigs.filter(s => !s.err).slice(0, 12).map(s => s.signature)
  const txs = await transactions(ok)
  const swaps = txs.flatMap(t => (t ? parseSolSwaps(t, m) : []))
  return { swaps: swaps.sort((a, b) => b.time - a.time), newest: sigs[0]?.signature ?? null }
}

/** Every new trade, a second or two after it lands, while the tab is visible. Returns a stop function. */
export function watchSolSwaps(m: SolPoolMeta, newest: string | null, known: Iterable<string>, onSwaps: (s: ChainSwap[]) => void, everyMs = 1_500): () => void {
  let stopped = false
  let until = newest
  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  const seen = new Set<string>(known)
  // Signatures seen whose transaction wasn't readable yet: asked again (three times at most).
  const pending = new Map<string, number>()

  const poll = async () => {
    if (stopped || busy || hidden()) return schedule(everyMs)
    busy = true
    const started = Date.now()
    let wait = -1
    try {
      const sigs = await signatures(m.pool, until ? { limit: 30, until } : { limit: 30 })
      if (sigs[0]) until = sigs[0].signature
      for (const s of sigs) if (!s.err && !seen.has(s.signature) && !pending.has(s.signature)) pending.set(s.signature, 0)
      // The newest first, six a poll: a busy pool's oldest unread ones are left to GeckoTerminal.
      const ask = [...pending.keys()].reverse().slice(0, 6)
      for (const s of [...pending.keys()]) if (!ask.includes(s)) pending.delete(s)
      const txs = await transactions(ask)
      const fresh: ChainSwap[] = []
      ask.forEach((sig, i) => {
        const tx = txs[i]
        if (!tx) {
          const tries = (pending.get(sig) ?? 0) + 1
          if (tries >= 3) pending.delete(sig); else pending.set(sig, tries)
          return
        }
        pending.delete(sig)
        seen.add(sig)
        for (const s of parseSolSwaps(tx, m)) fresh.push({ ...s, live: true })
      })
      if (seen.size > 4_000) for (const id of [...seen].slice(0, 2_000)) seen.delete(id)
      if (fresh.length && !stopped) onSwaps(fresh.sort((a, b) => b.time - a.time))
    } catch (e) {
      if (/429|rate/i.test(e instanceof Error ? e.message : '')) wait = 5_000
    } finally {
      busy = false
    }
    schedule(wait >= 0 ? wait : Math.max(300, everyMs - (Date.now() - started)))
  }
  const schedule = (ms: number) => { if (!stopped) { if (timer) clearTimeout(timer); timer = setTimeout(() => void poll(), ms) } }
  const onVisible = () => { if (!hidden()) schedule(0) }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  schedule(everyMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}

/** The pool as a feed for the coin page (lib/useChainTrades.ts). */
export function solFeed(m: SolPoolMeta): ChainFeed<string | null> {
  return {
    key: `sol:${m.pool}:${m.mint}:${m.quoteMint}`,
    load: () => loadSolSwaps(m).then(r => ({ swaps: r.swaps, cursor: r.newest })),
    watch: (newest, known, onSwaps) => watchSolSwaps(m, newest, known, onSwaps),
  }
}
