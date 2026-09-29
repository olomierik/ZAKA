// Which wallets funded the trading wallet: where its funds can be sent
// without the passcode.
//
// The rule (owner decision, 2026-09-26): sending USDC or coins out of the
// trading wallet back to a wallet that funded it needs nothing more. Sending
// anywhere else (withdraw, send cash, bridge out) needs the passcode, and the
// passkey too with 2FA on. A tab left unlocked can then only return funds to
// their owner.
//
// A funding wallet is an ordinary account (no contract code) that sent the
// trading wallet a real share of its USDC: at least $1, and at least 5% of
// everything that funded it. The share stops a dust attack: sending someone
// $0.01 from your own wallet, then using their unlocked phone to "send it
// back" with everything else. It raises the price of that attack rather than
// ruling it out: a wallet that sent 5% still qualifies.
//
// Deposits are read from Arc's USDC Transfer logs. A native USDC send (what
// most wallets do) is logged only by the system address 0xff…fe, in 18
// decimals; an ERC-20 transfer is logged by it and by the USDC contract (6
// decimals), so each (transaction, sender) counts once. USDC a contract pays
// out (a sell, a refund) isn't funding. A bridge arrival is minted (from
// 0x0): it counts toward the total, and the Bridge page records the wallet
// that sent it (addBridgeDeposit), which makes that wallet a funder too.
//
// Scans cover what Blockdaemon serves (~3.5 days; never the archive
// endpoints, which every trade also uses), then only the blocks since. The
// app scans whenever the trading wallet is unlocked (useFundingScan), so a
// deposit is recorded while it's in range. Deposits found are kept in this
// browser, signed by the trading wallet's own key, so nobody can add one by
// editing storage. Not found means the passcode is asked: the safe side.

import { useEffect, useState } from 'react'
import { pad, verifyMessage, type Address, type Hex } from 'viem'
import type { RawLog } from '../../../api/_arcLogs'
import { client } from '../api/launchpad'
import { currentAddress, getEmbeddedWalletClient } from './embeddedWallet'
import { recentLogsSince } from './recentLogs'

const USDC = '0x3600000000000000000000000000000000000000'
/** Arc's system address that logs native USDC sends, in 18 decimals. */
const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'
export const MIN_FUNDING_USD = 1
export const MIN_FUNDING_SHARE = 0.05

/** USDC that reached the trading wallet in one transaction from one sender
 * (`from` is 0x0 for a mint). */
export interface Deposit {
  from: string
  usd: number
  /** A bridge deposit: the Arc transaction that minted it, when known. */
  mintTx?: string
}

/** What's kept for a trading wallet, signed by it. */
export interface Ledger {
  /** The last block scanned. */
  scannedTo: number
  /** Keyed `${tx}:${sender}`; bridge deposits `bridge:${burnTx}`. */
  deposits: Record<string, Deposit>
  /** Senders found to be contracts: their payouts aren't funding. */
  contracts: string[]
}

const storageKey = (wallet: string) => `arcdex:funding:v2:${wallet.toLowerCase()}`
const OLD_KEY = (wallet: string) => `arcdex:funding:v1:${wallet.toLowerCase()}`
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a)
const emptyLedger = (): Ledger => ({ scannedTo: 0, deposits: {}, contracts: [] })

/** What the trading wallet signs to vouch for its ledger. */
export function fundingMessage(wallet: string, ledger: Ledger): string {
  const deposits = Object.keys(ledger.deposits).sort().map(k => {
    const d = ledger.deposits[k]
    return [k, d.from, d.usd, d.mintTx ?? '']
  })
  const body = JSON.stringify({ scannedTo: ledger.scannedTo, deposits, contracts: [...ledger.contracts].sort() })
  return `ARCDEX funding wallets v2\n${wallet.toLowerCase()}\n${body}`
}

/** The rule for one transfer out: `guarded` = the trading wallet is
 * sending. Back to a funding wallet, or to the trading wallet's own address
 * (on another chain), is free; any other destination needs the passcode. */
export function passcodeRule(guarded: boolean, self: string | null, to: string, funders: string[]): { isFunder: boolean; needsPasscode: boolean } {
  const dest = to.trim().toLowerCase()
  const isFunder = guarded && isAddr(dest) && funders.includes(dest)
  return { isFunder, needsPasscode: guarded && dest !== '' && dest !== (self ?? '').toLowerCase() && !isFunder }
}

/** No code, or an EIP-7702 delegation (an ordinary account with a smart-account upgrade). */
export function isAccountCode(code: Hex | undefined): boolean {
  return !code || code === '0x' || code.toLowerCase().startsWith('0xef0100')
}

/** USDC sent to `wallet` in these Transfer logs, by `${tx}:${sender}`: an
 * ERC-20 transfer's two logs (6 and 18 decimals) count once. */
export function depositsIn(logs: Pick<RawLog, 'address' | 'topics' | 'data' | 'transactionHash'>[], wallet: string): Map<string, Deposit> {
  const me = wallet.toLowerCase()
  const out = new Map<string, Deposit>()
  for (const l of logs) {
    const at = l.address.toLowerCase()
    if ((at !== USDC && at !== NATIVE_USDC) || l.topics[0] !== TRANSFER || l.topics.length !== 3 || !/^0x[0-9a-f]+$/i.test(l.data)) continue
    const from = ('0x' + l.topics[1].slice(26)).toLowerCase()
    const to = ('0x' + l.topics[2].slice(26)).toLowerCase()
    if (to !== me || from === me || !isAddr(from)) continue
    const usd = Number(BigInt(l.data)) / (at === NATIVE_USDC ? 1e18 : 1e6)
    const k = `${l.transactionHash.toLowerCase()}:${from}`
    out.set(k, { from, usd: Math.max(out.get(k)?.usd ?? 0, usd) })
  }
  return out
}

/** The funding wallets among these deposits: senders (not mints) of at
 * least $1 and 5% of the total. */
export function fundersOf(deposits: Deposit[]): string[] {
  const bySender = new Map<string, number>()
  let total = 0
  for (const d of deposits) {
    total += d.usd
    if (d.from !== ZERO) bySender.set(d.from, (bySender.get(d.from) ?? 0) + d.usd)
  }
  const min = Math.max(MIN_FUNDING_USD, total * MIN_FUNDING_SHARE)
  return [...bySender].filter(([, usd]) => usd >= min).map(([a]) => a)
}

async function readLedger(wallet: Address): Promise<Ledger> {
  try {
    const raw = localStorage.getItem(storageKey(wallet))
    if (!raw) return emptyLedger()
    const s = JSON.parse(raw) as { ledger?: Ledger; sig?: unknown }
    const l = s.ledger
    if (!l || typeof s.sig !== 'string' || typeof l.scannedTo !== 'number' || typeof l.deposits !== 'object' || !Array.isArray(l.contracts)) return emptyLedger()
    const ok = await verifyMessage({ address: wallet, message: fundingMessage(wallet, l), signature: s.sig as Hex })
    return ok ? l : emptyLedger()
  } catch { return emptyLedger() }
}

async function writeLedger(wallet: Address, ledger: Ledger): Promise<void> {
  // Only the unlocked trading wallet itself can vouch for its ledger.
  if (currentAddress()?.toLowerCase() !== wallet.toLowerCase()) return
  try {
    const sig = await getEmbeddedWalletClient().signMessage({ message: fundingMessage(wallet, ledger) })
    localStorage.setItem(storageKey(wallet), JSON.stringify({ ledger, sig }))
    localStorage.removeItem(OLD_KEY(wallet)) // v1: addresses without amounts, rescanned instead
  } catch { /* storage blocked: the next scan finds what's still in range */ }
}

/** Adds the deposits since the last scan. If a sender can't be checked,
 * the scan resumes from the same block next time. */
async function scan(wallet: Address, ledger: Ledger): Promise<void> {
  const { logs, scannedTo } = await recentLogsSince({ address: [USDC, NATIVE_USDC], topics: [TRANSFER, null, pad(wallet).toLowerCase()] }, ledger.scannedTo)
  const found = depositsIn(logs, wallet)
  const bridgedMints = new Set(Object.values(ledger.deposits).map(d => d.mintTx).filter(Boolean))
  const accounts = new Set(Object.values(ledger.deposits).map(d => d.from))
  const unknown = [...new Set([...found.values()].map(d => d.from))].filter(a => a !== ZERO && !accounts.has(a) && !ledger.contracts.includes(a))
  let unchecked = false
  await Promise.all(unknown.map(async a => {
    try {
      if (isAccountCode(await client.getCode({ address: a as Address }))) accounts.add(a)
      else ledger.contracts.push(a)
    } catch { unchecked = true }
  }))
  for (const [k, d] of found) {
    if (d.from === ZERO ? bridgedMints.has(k.split(':')[0]) : !accounts.has(d.from)) continue
    ledger.deposits[k] = { from: d.from, usd: Math.max(ledger.deposits[k]?.usd ?? 0, d.usd) }
  }
  if (!unchecked) ledger.scannedTo = scannedTo
}

// One read-modify-write at a time per wallet (a scan and a bridge deposit
// could otherwise overwrite each other).
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(wallet: string, job: () => Promise<T>): Promise<T> {
  const k = wallet.toLowerCase()
  const run = (locks.get(k) ?? Promise.resolve()).catch(() => {}).then(job)
  locks.set(k, run)
  return run
}

const FRESH_MS = 15_000
const cache = new Map<string, { at: number; p: Promise<string[]> }>()

/** The wallets that funded `wallet` (lowercase), after scanning the blocks
 * since the last scan. Never throws: on any failure it returns what it could
 * confirm, possibly nothing. */
export function getFundingWallets(wallet: Address, fresh = false): Promise<string[]> {
  const k = wallet.toLowerCase()
  const hit = cache.get(k)
  if (hit && !fresh && Date.now() - hit.at < FRESH_MS) return hit.p
  const p = withLock(k, async () => {
    const ledger = await readLedger(wallet)
    const before = fundingMessage(wallet, ledger)
    await scan(wallet, ledger).catch(() => {})
    if (fundingMessage(wallet, ledger) !== before) await writeLedger(wallet, ledger)
    return fundersOf(Object.values(ledger.deposits))
  })
  cache.set(k, { at: Date.now(), p })
  p.catch(() => cache.delete(k))
  return p
}

/** Records a bridge deposit into the trading wallet: `from` burned USDC on
 * another chain and it was minted to the wallet on Arc, where the logs only
 * show a mint. Needs the trading wallet unlocked (it signs the ledger). */
export function addBridgeDeposit(wallet: Address, d: { from: string; usd: number; burnTx: string; mintTx?: string }): Promise<void> {
  const from = d.from.toLowerCase()
  if (!isAddr(from) || from === wallet.toLowerCase() || !(d.usd > 0) || !d.burnTx) return Promise.resolve()
  return withLock(wallet, async () => {
    const ledger = await readLedger(wallet)
    const mintTx = d.mintTx?.toLowerCase()
    ledger.deposits[`bridge:${d.burnTx.toLowerCase()}`] = { from, usd: d.usd, ...(mintTx ? { mintTx } : {}) }
    if (mintTx) delete ledger.deposits[`${mintTx}:${ZERO}`] // already counted as a mint: count it once
    await writeLedger(wallet, ledger)
    cache.delete(wallet.toLowerCase())
  })
}

/** Funding wallets for the trading wallet `address` (none for an external
 * wallet: it confirms every transfer itself). */
export function useFundingWallets(address: string | null, isTradingWallet: boolean): { wallets: string[]; loading: boolean } {
  const [state, setState] = useState<{ wallets: string[]; loading: boolean }>({ wallets: [], loading: false })
  useEffect(() => {
    if (!address || !isTradingWallet) { setState({ wallets: [], loading: false }); return }
    let alive = true
    setState(s => ({ wallets: s.wallets, loading: true }))
    void getFundingWallets(address as Address).then(w => { if (alive) setState({ wallets: w, loading: false }) })
    return () => { alive = false }
  }, [address, isTradingWallet])
  return state
}

const SCAN_EVERY_MS = 5 * 60_000

/** While the trading wallet is unlocked, keeps its deposits recorded: a scan
 * now, then every 5 minutes the tab is visible (one call for the new blocks). */
export function useFundingScan(address: string | null): void {
  useEffect(() => {
    if (!address) return
    void getFundingWallets(address as Address)
    const id = setInterval(() => { if (!document.hidden) void getFundingWallets(address as Address) }, SCAN_EVERY_MS)
    return () => clearInterval(id)
  }, [address])
}
