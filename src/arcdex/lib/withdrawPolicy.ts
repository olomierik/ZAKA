// Withdraw limits for money leaving the trading wallet (the build pack's Phase 1: "withdraw/transfer with validation,
// confirmation, cooldown/limits, notification"; 04 §1: "new-address cooldown, step-up auth, notifications").
//
// They apply where the passcode rule does (lib/funding.ts): the trading wallet, or a Solana wallet's account, sending to
// an address that didn't fund it. Sending back to a funding wallet, or to the wallet's own address on another chain, is
// never limited. An external wallet confirms every transfer itself and isn't limited here.
//
//   - A new address (never paid, or first paid or saved under 24 hours ago) takes at most $250 in a day, all new
//     addresses together. Saving an address starts its 24 hours; the full amount can go once they've passed.
//   - At most $2,500 a day leaves for addresses that didn't fund the wallet.
//
// What was sent is counted from two places, merged by transaction: this browser's record (coins too), signed by the
// trading wallet's own key so an edited record is dropped, and USDC transfers read from Arc (the last ~3.5 days), so
// clearing the browser's storage doesn't reset the count. The limits slow down someone who has the passcode and an
// unlocked device; they can't stop the key's owner, who can export it.

import { useCallback, useEffect, useState } from 'react'
import { isAddress, pad, verifyMessage, type Address, type Hex } from 'viem'
import type { RawLog } from '../../../api/_arcLogs'
import { client } from '../api/launchpad'
import { flag } from './flags'
import { isAccountCode } from './funding'
import { currentAddress, getEmbeddedWalletClient } from './embeddedWallet'
import { t as T } from './i18n'
import { recentLogsSince } from './recentLogs'

export const WITHDRAW_POLICY = {
  /** How long an address counts as new after it's first paid or saved. */
  holdMs: 24 * 3_600_000,
  /** Most that new addresses together can take in a day. */
  newAddressUsd: 250,
  /** Most that can leave in a day for addresses that didn't fund the wallet. */
  dailyUsd: 2_500,
  windowMs: 24 * 3_600_000,
}
export type WithdrawPolicyConfig = typeof WITHDRAW_POLICY

/** A transfer out to an address that didn't fund the wallet. */
export interface PastSend { tx: string; to: string; usd: number; at: number }

/** Addresses (lowercase) and when they were first paid or saved; and the transfers out. */
export interface WithdrawBook { known: Record<string, number>; sends: PastSend[] }

export interface WithdrawVerdict {
  ok: boolean
  /** First paid or saved under 24 hours ago, or never. */
  isNew: boolean
  /** When the address stops counting as new (it was saved or paid), else null. */
  knownFrom: number | null
  dailyLeft: number
  /** Left for new addresses today (Infinity for a known address). */
  newLeft: number
  /** Why not, in words. */
  reason?: string
  /** When the same amount would go through, if it ever will. */
  retryAt?: number
}

const lower = (a: string) => a.trim().toLowerCase()
const money = (n: number) => `$${(Math.floor(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Whether `usd` may go to `to` now, given what was sent and which addresses are known. */
export function withdrawVerdict(book: WithdrawBook, to: string, usd: number, now: number, p: WithdrawPolicyConfig = WITHDRAW_POLICY): WithdrawVerdict {
  const dest = lower(to)
  const seen = book.known[dest]
  const isNewAt = (addr: string, at: number) => { const k = book.known[addr]; return k === undefined || at - k < p.holdMs }
  const isNew = isNewAt(dest, now)
  const recent = book.sends.filter(s => s.at > now - p.windowMs && s.at <= now).sort((a, b) => a.at - b.at)
  const dailyUsed = recent.reduce((s, x) => s + x.usd, 0)
  const newUsed = recent.filter(s => isNewAt(lower(s.to), s.at)).reduce((s, x) => s + x.usd, 0)
  const dailyLeft = Math.max(0, p.dailyUsd - dailyUsed)
  const newLeft = isNew ? Math.max(0, p.newAddressUsd - newUsed) : Infinity
  const knownFrom = seen === undefined ? null : seen + p.holdMs
  const v: WithdrawVerdict = { ok: true, isNew, knownFrom, dailyLeft, newLeft }
  const amt = Math.max(0, usd)
  if (amt > dailyLeft + 1e-9) {
    v.ok = false
    if (amt > p.dailyUsd) {
      v.reason = T('Over the daily limit of {limit}: send it in parts, or back to the wallet that funded this one.', { limit: money(p.dailyUsd) })
    } else {
      // The earliest moment enough of today's transfers fall out of the window.
      let used = dailyUsed
      for (const s of recent) { used -= s.usd; if (used + amt <= p.dailyUsd + 1e-9) { v.retryAt = s.at + p.windowMs; break } }
      v.reason = T('Daily limit: {left} left until {time}. Sending back to the wallet that funded this one has no limit.', { left: money(dailyLeft), time: v.retryAt ? when(v.retryAt) : '—' })
    }
    return v
  }
  if (isNew && amt > newLeft + 1e-9) {
    v.ok = false
    if (knownFrom !== null) v.retryAt = knownFrom
    v.reason = knownFrom !== null
      ? T('This address is new: {left} can go now, the full amount from {time}.', { left: money(newLeft), time: when(knownFrom) })
      : T('This address is new: {left} can go now. Save it to send the full amount 24 hours from now.', { left: money(newLeft) })
  }
  return v
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

/** What's wrong with sending to `to` on Arc, in words, or null. `tokens` are contracts that are never a destination. */
export function destinationProblem(to: string, self: string | null, tokens: string[]): string | null {
  const a = to.trim()
  if (!a) return null
  if (!isAddress(a, { strict: false })) return T('Enter an Arc address: 0x and 40 letters or numbers.')
  const l = a.toLowerCase()
  if (l === ZERO_ADDR) return T('That’s the zero address: anything sent there is lost.')
  if (self && l === self.toLowerCase()) return T('That’s this wallet’s own address.')
  if (tokens.some(t => t.toLowerCase() === l)) return T('That’s a token’s contract, not a wallet: anything sent there is lost.')
  return null
}

// ── This browser's record, signed by the trading wallet ──────────────────

const storageKey = (wallet: string) => `arcdex:withdraw-book:v1:${wallet.toLowerCase()}`
const empty = (): WithdrawBook => ({ known: {}, sends: [] })
const KEEP_MS = 8 * 24 * 3_600_000

/** What the trading wallet signs to vouch for its record. */
export function bookMessage(wallet: string, b: WithdrawBook): string {
  const known = Object.keys(b.known).sort().map(k => [k, b.known[k]])
  const sends = [...b.sends].sort((x, y) => x.at - y.at || x.tx.localeCompare(y.tx)).map(s => [s.tx, lower(s.to), s.usd, s.at])
  return `ARCDEX withdraw record v1\n${wallet.toLowerCase()}\n${JSON.stringify({ known, sends })}`
}

async function readBook(wallet: Address): Promise<WithdrawBook> {
  try {
    const raw = localStorage.getItem(storageKey(wallet))
    if (!raw) return empty()
    const s = JSON.parse(raw) as { book?: WithdrawBook; sig?: unknown }
    const b = s.book
    if (!b || typeof s.sig !== 'string' || typeof b.known !== 'object' || !Array.isArray(b.sends)) return empty()
    return (await verifyMessage({ address: wallet, message: bookMessage(wallet, b), signature: s.sig as Hex })) ? b : empty()
  } catch { return empty() }
}

async function writeBook(wallet: Address, b: WithdrawBook): Promise<void> {
  if (currentAddress()?.toLowerCase() !== wallet.toLowerCase()) return // only the unlocked wallet vouches for its record
  const now = Date.now()
  const pruned: WithdrawBook = { known: b.known, sends: b.sends.filter(s => s.at > now - KEEP_MS) }
  try {
    const sig = await getEmbeddedWalletClient().signMessage({ message: bookMessage(wallet, pruned) })
    localStorage.setItem(storageKey(wallet), JSON.stringify({ book: pruned, sig }))
  } catch { /* storage blocked: the chain still counts USDC sent */ }
}

// ── What Arc shows was sent ──────────────────────────────────────────────

const USDC = '0x3600000000000000000000000000000000000000'
const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** USDC sent by `wallet` in these Transfer logs, one per (transaction, recipient): an ERC-20 transfer's two logs (6 and
 * 18 decimals) count once. Contracts and `skip` (funding wallets, the wallet itself) are left out by the caller. */
export function sendsIn(logs: Pick<RawLog, 'address' | 'topics' | 'data' | 'transactionHash' | 'blockNumber' | 'blockTimestamp'>[], wallet: string): (Omit<PastSend, 'at'> & { block: number; at?: number })[] {
  const me = wallet.toLowerCase()
  const out = new Map<string, Omit<PastSend, 'at'> & { block: number; at?: number }>()
  for (const l of logs) {
    const at = l.address.toLowerCase()
    if ((at !== USDC && at !== NATIVE_USDC) || l.topics[0] !== TRANSFER || l.topics.length !== 3 || !/^0x[0-9a-f]+$/i.test(l.data)) continue
    const from = ('0x' + l.topics[1].slice(26)).toLowerCase()
    const to = ('0x' + l.topics[2].slice(26)).toLowerCase()
    if (from !== me || to === me) continue
    const usd = Number(BigInt(l.data)) / (at === NATIVE_USDC ? 1e18 : 1e6)
    const k = `${l.transactionHash.toLowerCase()}:${to}`
    const ts = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) * 1000 : undefined
    out.set(k, { tx: l.transactionHash.toLowerCase(), to, usd: Math.max(out.get(k)?.usd ?? 0, usd), block: Number(BigInt(l.blockNumber)), ...(ts ? { at: ts } : {}) })
  }
  return [...out.values()]
}

/** Merges two records: addresses keep their earliest time, transfers are kept once per transaction and address. */
export function mergeBooks(a: WithdrawBook, b: WithdrawBook): WithdrawBook {
  const known: Record<string, number> = { ...a.known }
  for (const [k, t] of Object.entries(b.known)) known[k] = known[k] === undefined ? t : Math.min(known[k], t)
  const sends = new Map<string, PastSend>()
  for (const s of [...b.sends, ...a.sends]) sends.set(`${s.tx}:${lower(s.to)}`, s) // `a` (this browser's) wins: it has coins' values
  return { known, sends: [...sends.values()] }
}

const codeCache = new Map<string, Promise<boolean>>()
const isAccount = (a: string) => {
  let p = codeCache.get(a)
  if (!p) { p = client.getCode({ address: a as Address }).then(isAccountCode, () => true); codeCache.set(a, p) }
  return p
}

/** USDC the wallet sent to ordinary accounts other than `skip`, from Arc, as a record. Never throws. */
async function chainBook(wallet: Address, skip: string[]): Promise<WithdrawBook> {
  try {
    const { logs } = await recentLogsSince({ address: [USDC, NATIVE_USDC], topics: [TRANSFER, pad(wallet).toLowerCase(), null] }, 0)
    const found = sendsIn(logs, wallet).filter(s => !skip.includes(s.to))
    const ordinary = await Promise.all(found.map(s => isAccount(s.to)))
    const kept = found.filter((_, i) => ordinary[i])
    const blocks = [...new Set(kept.filter(s => !s.at).map(s => s.block))]
    const times = new Map(await Promise.all(blocks.map(async b => [b, Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp) * 1000] as const)))
    const sends = kept.map(s => ({ tx: s.tx, to: s.to, usd: s.usd, at: s.at ?? times.get(s.block) ?? Date.now() }))
    const known: Record<string, number> = {}
    for (const s of sends) known[s.to] = Math.min(known[s.to] ?? Infinity, s.at)
    return { known, sends }
  } catch { return empty() }
}

// ── For the forms ────────────────────────────────────────────────────────

const CHANGED = 'arcdex:withdraw-book'
const changed = () => { try { window.dispatchEvent(new Event(CHANGED)) } catch { /* not a browser */ } }

/** Limits are on unless VITE_FLAG_WITHDRAW_LIMITS is "off". */
export const withdrawLimitsOn = () => flag('withdrawLimits')

/** The record for `wallet` (this browser's and Arc's), kept fresh; `skip` = funding wallets. */
export function useWithdrawBook(wallet: string | null, skip: string[], active: boolean): { book: WithdrawBook | null; reload: () => void } {
  const [book, setBook] = useState<WithdrawBook | null>(null)
  const [n, setN] = useState(0)
  const skipKey = skip.join(',')
  useEffect(() => {
    if (!wallet || !active) { setBook(null); return }
    let alive = true
    const load = () => {
      void Promise.all([readBook(wallet as Address), chainBook(wallet as Address, skipKey ? skipKey.split(',') : [])])
        .then(([mine, chain]) => { if (alive) setBook(mergeBooks(mine, chain)) })
    }
    load()
    window.addEventListener(CHANGED, load)
    return () => { alive = false; window.removeEventListener(CHANGED, load) }
  }, [wallet, active, skipKey, n])
  const reload = useCallback(() => setN(x => x + 1), [])
  return { book, reload }
}

/** Records a transfer out (after it went through) and tells the owner. */
export async function recordWithdrawal(wallet: string, send: PastSend, label: string): Promise<void> {
  const b = await readBook(wallet as Address)
  const to = lower(send.to)
  b.known[to] = Math.min(b.known[to] ?? Infinity, send.at)
  b.sends.push({ ...send, to })
  await writeBook(wallet as Address, b)
  notifyOwner(wallet, T('{what} sent to {to}', { what: label, to: `${to.slice(0, 6)}…${to.slice(-4)}` }),
    T('From your ARCDEX trading wallet. If this wasn’t you, move the rest of your funds back to the wallet that funded it now.'))
  changed()
}

/** Saves an address: its 24 hours start now. */
export async function saveWithdrawAddress(wallet: string, to: string): Promise<number> {
  const b = await readBook(wallet as Address)
  const dest = lower(to)
  const at = Math.min(b.known[dest] ?? Infinity, Date.now())
  b.known[dest] = at
  await writeBook(wallet as Address, b)
  notifyOwner(wallet, T('New withdrawal address saved: {to}', { to: `${dest.slice(0, 6)}…${dest.slice(-4)}` }),
    T('It can take the full amount from {time}. If this wasn’t you, move your funds back to the wallet that funded this one now.', { time: when(at + WITHDRAW_POLICY.holdMs) }))
  changed()
  return at
}

/** A system notification when the browser allows them, and a record for Portfolio's list (written before the change
 * event goes out, so the list reads it). */
function notifyOwner(wallet: string, title: string, body: string) {
  try {
    const list = JSON.parse(localStorage.getItem('arcdex:withdraw-notices') ?? '[]') as WithdrawNotice[]
    list.unshift({ at: Date.now(), wallet: lower(wallet), title, body })
    localStorage.setItem('arcdex:withdraw-notices', JSON.stringify(list.slice(0, 20)))
  } catch { /* storage blocked */ }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, icon: '/icon-192.png', tag: title })
  } catch { /* not allowed here */ }
}

export interface WithdrawNotice { at: number; wallet?: string; title: string; body: string }
/** The notices for `wallet`, newest first. */
export function withdrawNotices(wallet: string): WithdrawNotice[] {
  try {
    const list = JSON.parse(localStorage.getItem('arcdex:withdraw-notices') ?? '[]') as WithdrawNotice[]
    return list.filter(n => n.wallet === lower(wallet))
  } catch { return [] }
}
