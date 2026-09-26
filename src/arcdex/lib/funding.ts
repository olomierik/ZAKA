// Which wallets funded the trading wallet: where its funds can be sent
// without the passcode.
//
// The rule (owner decision, 2026-09-26): sending USDC or coins out of the
// trading wallet back to a wallet that funded it needs nothing more. Sending
// anywhere else (withdraw, send cash, bridge out) needs the passcode, and the
// passkey too with 2FA on. A tab left unlocked can then only return funds to
// their owner.
//
// A funding wallet is an ordinary account (no contract code) that sent USDC
// to the trading wallet, found in Arc's USDC Transfer logs. Mints (a bridge
// arriving, from 0x0) and USDC paid out by a contract (the launchpad or the
// swap router on a sell) don't count. The scan covers the last ~2 days.
// Wallets it finds are also kept in this browser, signed by the trading
// wallet's own key, so an older funding wallet is still recognized and
// nobody can add one by editing storage. Not found means the passcode is
// asked for, which is the safe side.

import { useEffect, useState } from 'react'
import { pad, verifyMessage, type Address, type Hex } from 'viem'
import { client } from '../api/launchpad'
import { currentAddress, getEmbeddedWalletClient } from './embeddedWallet'
import { recentLogs } from './recentLogs'

const USDC = '0x3600000000000000000000000000000000000000'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'

const storageKey = (wallet: string) => `arcdex:funding:v1:${wallet.toLowerCase()}`
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a)

/** What the trading wallet signs to vouch for its list of funding wallets. */
export function fundingMessage(wallet: string, list: string[]): string {
  return `ARCDEX funding wallets\n${wallet.toLowerCase()}\n${[...list].map(a => a.toLowerCase()).sort().join('\n')}`
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

/** Senders in USDC Transfer logs, minus mints and the wallet itself. */
export function sendersOf(topics: string[][], wallet: string): string[] {
  const me = wallet.toLowerCase()
  const out = new Set<string>()
  for (const t of topics) {
    const from = t[1] ? ('0x' + t[1].slice(26)).toLowerCase() : ''
    if (isAddr(from) && from !== ZERO && from !== me) out.add(from)
  }
  return [...out]
}

async function readSigned(wallet: Address): Promise<string[]> {
  try {
    const raw = localStorage.getItem(storageKey(wallet))
    if (!raw) return []
    const s = JSON.parse(raw) as { list?: unknown; sig?: unknown }
    if (!Array.isArray(s.list) || typeof s.sig !== 'string') return []
    const list = s.list.map(a => String(a).toLowerCase()).filter(isAddr)
    const ok = await verifyMessage({ address: wallet, message: fundingMessage(wallet, list), signature: s.sig as Hex })
    return ok ? list : []
  } catch { return [] }
}

async function writeSigned(wallet: Address, list: string[]): Promise<void> {
  // Only the unlocked trading wallet itself can vouch for its list.
  if (currentAddress()?.toLowerCase() !== wallet.toLowerCase()) return
  try {
    const sig = await getEmbeddedWalletClient().signMessage({ message: fundingMessage(wallet, list) })
    localStorage.setItem(storageKey(wallet), JSON.stringify({ list, sig }))
  } catch { /* storage blocked: the chain scan still finds recent ones */ }
}

/** Who sent USDC to `wallet` over the last ~2 days. */
async function scanSenders(wallet: Address): Promise<string[]> {
  const logs = await recentLogs({ address: USDC, topics: [TRANSFER, null, pad(wallet).toLowerCase()] })
  return sendersOf(logs.map(l => l.topics), wallet)
}

const cache = new Map<string, Promise<string[]>>()

/** The wallets that funded `wallet` (lowercase). Never throws: on any
 * failure it returns what it could confirm, possibly nothing. */
export function getFundingWallets(wallet: Address, fresh = false): Promise<string[]> {
  const k = wallet.toLowerCase()
  const hit = cache.get(k)
  if (hit && !fresh) return hit
  const p = (async () => {
    const [signed, scanned] = await Promise.all([readSigned(wallet), scanSenders(wallet).catch(() => [] as string[])])
    const unknown = scanned.filter(a => !signed.includes(a))
    // Contracts paying out (a sell's USDC, a refund) aren't anyone's wallet.
    const accounts = (await Promise.all(unknown.map(async a => {
      try { return isAccountCode(await client.getCode({ address: a as Address })) ? a : null } catch { return null }
    }))).filter((a): a is string => a !== null)
    const all = [...new Set([...signed, ...accounts])]
    if (accounts.length) await writeSigned(wallet, all)
    return all
  })()
  cache.set(k, p)
  p.catch(() => cache.delete(k))
  return p
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
