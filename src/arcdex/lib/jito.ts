// Anti-MEV mode on Solana, through Jito (owner, 2026-10-17: "anti-MEV mode: why not use Jito to prevent bots from
// sandwich attacks? Make it possible").
//
// A sandwich needs the trade to be seen before it lands: a bot buys just ahead of it and sells just after. Sent to a
// public Solana node, a transaction is passed around before a leader takes it. Sent to Jito's block engine as a bundle
// only (`bundleOnly=true`), it goes to Jito's validators alone, as one all-or-nothing bundle, and isn't forwarded to the
// public network: nobody can place their trades around it inside the bundle, and a bundle that would fail lands nothing.
// It carries a tip to one of Jito's tip accounts, in the same transaction (a bundle without one is ignored).
//
// What it can't do: a validator that runs its own private mempool still sees what it's given, and a trade is only
// bundled when the slot's leader runs Jito (most stake does, not all), so a busy moment can take longer to land.
//
// Where it applies (lib/relay.ts): Solana transactions ARCDEX builds and sends itself (Relay's sales, swaps and
// cross-chain buys paid with SOL or Solana USDC). Jupiter's swaps are sent by Jupiter (`/execute`), which lands them
// itself with its own priority fees and Jito tips (lib/jupiter.ts).
//
// Jito's block engine answers browsers (CORS) from any origin; its tip-floor feed doesn't, so the tip is a setting
// (Settings → Trading), 50,000 lamports by default (~0.00005 SOL), about the 75th percentile of landed tips when built.

import type { PublicKey as PublicKeyT, TransactionInstruction as TxIx } from '@solana/web3.js'

/** Jito's tip accounts (its getTipAccounts, 2026-10-17). One is picked at random per transaction, as Jito asks. */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
] as const

/** Jito's block engines, the global one first, then its regions (another is tried when one is busy). */
export const JITO_ENGINES = [
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
] as const

export const JITO_TIP = {
  /** Jito's minimum for a bundle. */
  min: 1_000,
  default: 50_000,
  /** The most the setting allows: 0.001 SOL. */
  max: 1_000_000,
  choices: [10_000, 50_000, 200_000] as const,
}

export class JitoError extends Error {}

export const clampTip = (lamports: number) => Math.round(Math.min(JITO_TIP.max, Math.max(JITO_TIP.min, Number.isFinite(lamports) ? lamports : JITO_TIP.default)))

export function pickTipAccount(rand = Math.random): string {
  return JITO_TIP_ACCOUNTS[Math.floor(rand() * JITO_TIP_ACCOUNTS.length) % JITO_TIP_ACCOUNTS.length]
}

/** The tip, as the transaction's last instruction: a plain SOL transfer from the trader to a Jito tip account. */
export async function tipInstruction(from: PublicKeyT, lamports: number, rand = Math.random): Promise<TxIx> {
  const { PublicKey, SystemProgram } = await import('@solana/web3.js')
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(pickTipAccount(rand)), lamports: clampTip(lamports) })
}

/** Whether a transaction (its account keys and instructions, already compiled) tips Jito: it must, or the bundle is
 * dropped. */
export function hasJitoTip(staticKeys: string[]): boolean {
  return staticKeys.some(k => (JITO_TIP_ACCOUNTS as readonly string[]).includes(k))
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Sends a signed transaction (base64) to Jito as a bundle only; its signature, or JitoError. Busy (429) or down, the
 * next block engine is tried. Never sent to a public node from here. */
export async function sendViaJito(signedB64: string, f: Fetch = fetch): Promise<string> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [signedB64, { encoding: 'base64' }] })
  let last = ''
  for (const engine of JITO_ENGINES) {
    let r: Response
    try {
      r = await f(`${engine}/api/v1/transactions?bundleOnly=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) })
    } catch (e) { last = e instanceof Error ? e.message : String(e); continue }
    const j = await r.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null
    if (r.ok && typeof j?.result === 'string') return j.result
    last = j?.error?.message ?? `HTTP ${r.status}`
    // A refusal of the transaction itself (not a busy engine) won't change at another engine.
    if (r.status !== 429 && r.status < 500 && j?.error) break
  }
  throw new JitoError(last || 'Jito didn’t answer')
}
