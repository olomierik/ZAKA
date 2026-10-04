// Solana for ARCDEX's pages (2026-10-04): reads through a public RPC (publicnode answers browsers; Solana's own RPC
// refuses them), balances, what a wallet holds, transactions' status, and explorer links. Trading is lib/relay.ts;
// the wallets are lib/solanaWallet.ts; the market list is api/solanaMarket.ts.

import { SOL_RPC_BROWSER, SOL_USDC, isSolAddress, PROGRAMS } from '../../../api/_solCore'

export { isSolAddress }
export const SOL_EXPLORER = 'https://solscan.io'
export const solToken = (mint: string) => `${SOL_EXPLORER}/token/${mint}`
export const solAccount = (a: string) => `${SOL_EXPLORER}/account/${a}`
export const solTx = (sig: string) => `${SOL_EXPLORER}/tx/${sig}`

/** SOL a sale needs for its fees (a signature plus priority, and a token account now and then): about $0.30. */
export const SELL_GAS_SOL = 0.002

let rpcId = 0
/** One JSON-RPC call to Solana, retried once on a throttle. */
export async function solRpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(SOL_RPC_BROWSER, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: signal ?? AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    if (res.status === 429 && attempt === 0) { await new Promise(r => setTimeout(r, 800)); continue }
    const j = await res.json() as { result?: T; error?: { message?: string } }
    if (j.error) throw new Error(j.error.message ?? 'Solana RPC error')
    return j.result as T
  }
}

/** SOL held, in SOL. */
export async function solBalance(owner: string): Promise<number> {
  const r = await solRpc<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }])
  return r.value / 1e9
}

interface ParsedTokenAccount { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmount: number | null } } } } } }

export interface SolHolding { mint: string; raw: bigint; amount: number; decimals: number }

/** Every coin `owner` holds (both token programs), largest balance first; empty accounts left out. */
export async function solHoldings(owner: string): Promise<SolHolding[]> {
  const read = (programId: string) => solRpc<{ value: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  const lists = await Promise.all([read(PROGRAMS.token), read(PROGRAMS.token2022)])
  const by = new Map<string, SolHolding>()
  for (const { value } of lists) {
    for (const a of value) {
      const i = a.account.data.parsed.info
      const raw = BigInt(i.tokenAmount.amount)
      if (raw === 0n) continue
      const prev = by.get(i.mint)
      const total = (prev?.raw ?? 0n) + raw
      by.set(i.mint, { mint: i.mint, raw: total, decimals: i.tokenAmount.decimals, amount: Number(total) / 10 ** i.tokenAmount.decimals })
    }
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount)
}

/** How much of one coin `owner` holds. */
export async function solTokenBalance(owner: string, mint: string): Promise<SolHolding> {
  const r = await solRpc<{ value: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  let raw = 0n, decimals = 0
  for (const a of r.value) { const t = a.account.data.parsed.info.tokenAmount; raw += BigInt(t.amount); decimals = t.decimals }
  if (!r.value.length) decimals = await solMintDecimals(mint).catch(() => 6)
  return { mint, raw, decimals, amount: Number(raw) / 10 ** decimals }
}

const decimalsCache = new Map<string, number>()
export async function solMintDecimals(mint: string): Promise<number> {
  const c = decimalsCache.get(mint)
  if (c !== undefined) return c
  const r = await solRpc<{ value: { data: { parsed?: { info?: { decimals?: number } } } } | null }>('getAccountInfo', [mint, { encoding: 'jsonParsed' }])
  const d = r.value?.data?.parsed?.info?.decimals
  if (typeof d !== 'number') throw new Error('Not a token')
  decimalsCache.set(mint, d)
  return d
}

/** A transaction's fate: confirmed, failed, or not seen yet. */
export async function solTxStatus(sig: string): Promise<'confirmed' | 'failed' | 'unknown'> {
  const r = await solRpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[sig], { searchTransactionHistory: false }])
  const s = r.value[0]
  if (!s) return 'unknown'
  if (s.err) return 'failed'
  return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown'
}

/** Waits until a transaction is confirmed (or failed), up to 90 seconds. */
export async function waitSolTx(sig: string): Promise<'confirmed' | 'failed' | 'unknown'> {
  const until = Date.now() + 90_000
  for (;;) {
    const s = await solTxStatus(sig).catch(() => 'unknown' as const)
    if (s !== 'unknown' || Date.now() > until) return s
    await new Promise(r => setTimeout(r, 1_000))
  }
}

// ── coins bought from this browser (Portfolio checks them first) ─────────

const HELD_KEY = (owner: string) => `arcdex:held-sol:v1:${owner}`
export function rememberSol(owner: string, mint: string) {
  try {
    const list = new Set<string>(JSON.parse(localStorage.getItem(HELD_KEY(owner)) ?? '[]'))
    list.add(mint)
    localStorage.setItem(HELD_KEY(owner), JSON.stringify([...list].slice(-200)))
  } catch { /* storage blocked */ }
}

export { SOL_USDC }
