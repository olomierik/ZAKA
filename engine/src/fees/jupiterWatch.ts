// Jupiter's referral fees for ARCDEX (Solana swaps through Jupiter, src/arcdex/lib/jupiter.ts), for the fee ledger.
// Jupiter pays them into token accounts owned by ARCDEX's referral account (JUP_REFERRAL_ACCOUNT, or the site's
// VITE_JUP_REFERRAL_ACCOUNT): every such account under either token program is followed. The first time an account is
// seen its balance is recorded as opening; after that each transaction touching it is read once, and what it changed
// the account's balance by is a row: 'received' when it grew (a fee), 'claimed' when it fell (the owner claimed).

import type { FeeLedger, FeeRow } from './ledger'
import { log, errMsg } from '../log'

export const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'] as const
const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SETTING = 'fee-ledger-jupiter'

export type SolCall = <T>(method: string, params: unknown[]) => Promise<T>
interface Settings { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }

interface ParsedAccount { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmountString?: string } } } } } }
interface TokenBal { accountIndex: number; mint: string; uiTokenAmount: { amount: string; decimals: number } }
interface ParsedTx {
  blockTime: number | null
  slot: number
  meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] }; signatures: string[] }
}

export interface JupAccount { account: string; mint: string; decimals: number; amount: string }
interface Saved { accounts: Record<string, { mint: string; decimals: number; lastSig: string | null }> }

const fromRaw = (raw: bigint, decimals: number) => {
  const neg = raw < 0n, s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0')
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : ''
  return `${neg ? '-' : ''}${s.slice(0, s.length - decimals)}${frac ? `.${frac}` : ''}`
}

/** What one transaction changed a token account's balance by (0n when it isn't in the transaction or failed). */
export function balanceChange(tx: ParsedTx, account: string): bigint {
  if (!tx.meta || tx.meta.err) return 0n
  const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey))
  const i = keys.indexOf(account)
  if (i < 0) return 0n
  const pre = tx.meta.preTokenBalances?.find(b => b.accountIndex === i)?.uiTokenAmount.amount ?? '0'
  const post = tx.meta.postTokenBalances?.find(b => b.accountIndex === i)?.uiTokenAmount.amount ?? '0'
  return BigInt(post) - BigInt(pre)
}

export class JupiterFeeWatcher {
  private saved: Saved = { accounts: {} }
  private loaded = false
  private busy = false

  constructor(private o: { referral: string; call: SolCall; ledger: FeeLedger; settings: Settings; solUsd?: () => number | null }) {}

  /** The referral account's token accounts now, under both token programs. */
  async accounts(): Promise<JupAccount[]> {
    const lists = await Promise.all(TOKEN_PROGRAMS.map(programId =>
      this.o.call<{ value: ParsedAccount[] }>('getTokenAccountsByOwner', [this.o.referral, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])))
    return lists.flatMap(l => l.value.map(a => {
      const i = a.account.data.parsed.info
      return { account: a.pubkey, mint: i.mint, decimals: i.tokenAmount.decimals, amount: fromRaw(BigInt(i.tokenAmount.amount), i.tokenAmount.decimals) }
    }))
  }

  private usd(mint: string, amount: string): number | null {
    if (mint === USDC) return Math.round(Number(amount) * 100) / 100
    if (mint === WSOL) { const p = this.o.solUsd?.(); return p ? Math.round(Number(amount) * p * 100) / 100 : null }
    return null
  }

  /** New fees and claims since the last read. */
  async tick(now = Date.now()) {
    if (this.busy) return
    this.busy = true
    try {
      if (!this.loaded) {
        const s = await this.o.settings.getSetting(SETTING).catch(() => null)
        if (s) try { this.saved = JSON.parse(s) as Saved } catch { /* start over */ }
        this.loaded = true
      }
      const rows: FeeRow[] = []
      for (const a of await this.accounts()) {
        const known = this.saved.accounts[a.account]
        if (!known) {
          // First sight: its balance is where the ledger starts for it.
          const last = await this.o.call<{ signature: string }[]>('getSignaturesForAddress', [a.account, { limit: 1, commitment: 'confirmed' }])
          this.saved.accounts[a.account] = { mint: a.mint, decimals: a.decimals, lastSig: last[0]?.signature ?? null }
          if (a.amount !== '0') rows.push({ id: `jupiter:opening:${a.account}`, at: now, chain: 'solana', source: 'jupiter', token: a.mint, symbol: a.mint === WSOL ? 'SOL' : a.mint === USDC ? 'USDC' : a.mint.slice(0, 4), amount: a.amount, amountUsd: this.usd(a.mint, a.amount), recipient: a.account, tx: null, block: null, status: 'opening' })
          continue
        }
        const sigs = await this.o.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [a.account, { limit: 100, commitment: 'confirmed', ...(known.lastSig ? { until: known.lastSig } : {}) }])
        // Oldest first, so the last signature read is the newest.
        for (const s of [...sigs].reverse()) {
          if (!s.err) {
            const tx = await this.o.call<ParsedTx | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
            if (!tx) break // not served yet: read again next time
            const d = tx ? balanceChange(tx, a.account) : 0n
            if (d !== 0n) {
              const amount = fromRaw(d, known.decimals)
              rows.push({ id: `jupiter:${s.signature}:${a.account}`, at: (tx.blockTime ?? now / 1000) * 1000, chain: 'solana', source: 'jupiter', token: known.mint, symbol: known.mint === WSOL ? 'SOL' : known.mint === USDC ? 'USDC' : known.mint.slice(0, 4), amount, amountUsd: this.usd(known.mint, amount), recipient: a.account, tx: s.signature, block: tx.slot, status: d > 0n ? 'received' : 'claimed' })
            }
          }
          known.lastSig = s.signature
        }
      }
      await this.o.ledger.record(rows)
      await this.o.settings.setSetting(SETTING, JSON.stringify(this.saved)).catch(() => {})
    } catch (e) {
      log.warn('fee ledger: Jupiter fees not read', { error: errMsg(e) })
    } finally {
      this.busy = false
    }
  }
}
