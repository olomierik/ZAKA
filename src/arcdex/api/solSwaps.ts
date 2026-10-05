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

import { SOL_RPC_BROWSER, SOL_USDC, WSOL } from '../../../api/_solCore'
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
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[] | null; postTokenBalances?: TokenBal[] | null } | null
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
  if (pc !== 0 && pq !== 0 && Math.sign(pc) !== Math.sign(pq)) {
    buy = pc < 0
    tokens = Math.abs(pc); quote = Math.abs(pq)
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
  const swaps = txs.map(t => (t ? parseSolSwap(t, m) : null)).filter((s): s is ChainSwap => !!s)
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
        const s = parseSolSwap(tx, m)
        if (s) fresh.push({ ...s, live: true })
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
