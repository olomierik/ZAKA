// Which wallets funded the trading wallet (owner decision, 2026-09-26):
// cash can go back to them without the passcode; a withdrawal anywhere else
// (another wallet, another trader, a bridge recipient) needs the passcode —
// so someone holding an unlocked phone can't drain it to their own wallet.
//
// A funder is a wallet (not a contract) that sent the trading wallet a real
// share of its USDC: at least $1 and 5% of everything wallets sent it. The
// share rule stops a dust attack — sending someone $0.01 to later withdraw
// their cash to yourself without the passcode.
//
// On Arc, a native USDC send (what most wallets do) is logged only by the
// system address 0xff…fe (18 decimals); an ERC-20 USDC transfer is logged
// by it *and* by the USDC contract (6 decimals) — counted once per
// transaction here. Coins sold for USDC arrive from contracts (router,
// launchpad) and don't count. A bridge deposit is minted (from 0x0), so the
// bridge page records the wallet that sent it (addFunder).
//
// Recent history (Blockdaemon, fast) is read first; older history fills in
// behind it; results are kept per wallet in this browser.

import { useEffect, useState } from 'react'
import { RECENT_DEPTH, headBlock, rpcBatch, scanLogs, ARCHIVE_RPCS, type RawLog } from '../../../api/_arcLogs'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC = '0x3600000000000000000000000000000000000000'
const NATIVE_USDC_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
/** How far back to look for a wallet whose creation block isn't known. */
const LOOKBACK = 3_000_000 // ~17 days of 0.5s blocks
const OLDER_STEP = 270_000
const MIN_FUNDING_USD = 1
const MIN_FUNDING_SHARE = 0.05

interface Cache {
  newest: number
  oldest: number
  floor: number
  /** USDC each sender sent, by transaction (so a double-logged transfer counts once). */
  sent: Record<string, Record<string, number>>
  /** Senders already checked: true = wallet, false = contract. */
  wallet: Record<string, boolean>
  /** Recorded by the app (bridge deposits), always funders. */
  manual: string[]
}
const key = (w: string) => `arcdex:funders:v2:${w.toLowerCase()}`
const bornKey = (w: string) => `arcdex:wallet-born:v1:${w.toLowerCase()}`
const empty = (floor = 0): Cache => ({ newest: 0, oldest: 0, floor, sent: {}, wallet: {}, manual: [] })

function read(w: string): Cache | null {
  try { return JSON.parse(localStorage.getItem(key(w)) ?? 'null') as Cache | null } catch { return null }
}
function write(w: string, c: Cache) {
  try { localStorage.setItem(key(w), JSON.stringify(c)) } catch { /* storage blocked: rescans next time */ }
}

const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())

function fundersOf(c: Cache | null): Set<string> {
  if (!c) return new Set()
  const totals = Object.entries(c.sent)
    .filter(([a]) => c.wallet[a] === true)
    .map(([a, txs]) => [a, Object.values(txs).reduce((s, v) => s + v, 0)] as const)
  const all = totals.reduce((s, [, v]) => s + v, 0)
  const min = Math.max(MIN_FUNDING_USD, all * MIN_FUNDING_SHARE)
  return new Set([...totals.filter(([, v]) => v >= min).map(([a]) => a), ...c.manual])
}

/** The wallets known to have funded `wallet`, lowercase. */
export function knownFunders(wallet: string | null): Set<string> {
  return wallet ? fundersOf(read(wallet)) : new Set()
}

export function isFunder(wallet: string | null, to: string): boolean {
  return knownFunders(wallet).has(to.toLowerCase())
}

/** Records a wallet that funded `wallet` in a way the chain scan can't see
 * (a bridge deposit is minted from 0x0 on Arc). */
export function addFunder(wallet: string, funder: string) {
  const c = read(wallet) ?? empty()
  const f = funder.toLowerCase()
  if (!c.manual.includes(f)) { c.manual = [...c.manual, f]; write(wallet, c); emit() }
}

/** A trading wallet made here: nothing before this block can have funded it. */
export async function noteWalletBorn(wallet: string) {
  try { localStorage.setItem(bornKey(wallet), String(await headBlock())) } catch { /* the lookback covers it */ }
}

const topic = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const fromTopic = (t: string) => ('0x' + t.slice(26)).toLowerCase()
const ZERO = '0x0000000000000000000000000000000000000000'

/** Adds `logs` to the per-sender totals; returns the senders not yet checked. */
function tally(c: Cache, logs: RawLog[]): string[] {
  const fresh = new Set<string>()
  for (const l of logs) {
    const from = fromTopic(l.topics[1] ?? '')
    if (from === ZERO) continue
    const usd = Number(BigInt(l.data)) / (l.address.toLowerCase() === NATIVE_USDC_LOGGER ? 1e18 : 1e6)
    const txs = (c.sent[from] ??= {})
    txs[l.transactionHash] = Math.max(txs[l.transactionHash] ?? 0, usd)
    if (!(from in c.wallet)) fresh.add(from)
  }
  return [...fresh]
}

/** Which senders are wallets, not contracts (an EIP-7702 delegated wallet
 * has code 0xef0100…, and still counts). */
async function classify(c: Cache, senders: string[]) {
  if (!senders.length) return
  const codes = await rpcBatch<string>(ARCHIVE_RPCS[1], senders.map(a => ({ method: 'eth_getCode', params: [a, 'latest'] })))
  senders.forEach((a, i) => {
    const code = codes[i]
    if (typeof code === 'string') c.wallet[a] = code === '0x' || code.startsWith('0xef0100')
  })
}

const running = new Map<string, Promise<void>>()

/** Scans the chain for `wallet`'s funders: new blocks since the last scan,
 * then older history in the background. */
export function refreshFunders(wallet: string): Promise<void> {
  const w = wallet.toLowerCase()
  const inFlight = running.get(w)
  if (inFlight) return inFlight
  const job = (async () => {
    const head = await headBlock()
    const born = Number(localStorage.getItem(bornKey(w)) ?? NaN)
    const floor = Number.isFinite(born) ? born : Math.max(0, head - LOOKBACK)
    const c: Cache = read(w) ?? empty(floor)
    if (!c.newest) { c.newest = Math.max(floor, head - RECENT_DEPTH) - 1; c.oldest = c.newest + 1; c.floor = floor }
    const filter = { address: [USDC, NATIVE_USDC_LOGGER], topics: [TRANSFER, null, topic(w)] }
    const absorb = async (logs: RawLog[]) => {
      await classify(c, tally(c, logs)).catch(() => {})
      write(w, c)
      emit()
    }
    // 1. Everything since the last scan (recent blocks: fast).
    if (c.newest < head) {
      const r = await scanLogs(filter, c.newest + 1, head, { head, reduce: logs => logs, deadline: Date.now() + 20_000 })
      c.newest = r.scannedTo
      await absorb(r.parts.flat())
    }
    // 2. Older history, a slice at a time, down to the floor.
    while (c.oldest > c.floor) {
      const from = Math.max(c.floor, c.oldest - OLDER_STEP)
      const r = await scanLogs(filter, from, c.oldest - 1, { head, reduce: logs => logs, deadline: Date.now() + 25_000 })
      if (r.scannedTo < c.oldest - 1) break // throttled: carry on next time
      c.oldest = from
      await absorb(r.parts.flat())
    }
  })().finally(() => { running.delete(w) })
  running.set(w, job)
  return job
}

/** The funders of `wallet`, kept up to date (scans when first used). */
export function useFunders(wallet: string | null): { funders: Set<string>; scanning: boolean } {
  const [funders, setFunders] = useState(() => knownFunders(wallet))
  const [scanning, setScanning] = useState(false)
  useEffect(() => {
    setFunders(knownFunders(wallet))
    if (!wallet) return
    const upd = () => setFunders(knownFunders(wallet))
    subs.add(upd)
    setScanning(true)
    // The recent part answers within seconds; older history keeps filling in.
    void refreshFunders(wallet).catch(() => {}).finally(() => { setScanning(false); upd() })
    return () => { subs.delete(upd) }
  }, [wallet])
  return { funders, scanning }
}
