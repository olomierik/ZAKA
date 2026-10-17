// The wallet tracker (owner, 2026-10-16: GMGN's wallet tracking): follow any wallet and see its trades on Arc,
// Robinhood Chain, Solana and BNB Chain as they happen. The wallets followed live in this browser (with a label each and
// whether to be alerted); their trades come from the engine (api/_trenchProtocol.ts, "the wallet tracker"): the
// `wallet` channel live, GET /v1/wallet/<address> for its record per chain and the trades kept so far.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isEvmWallet, isSolWallet, type TrenchChain, type WalletRecordWire, type WalletTradeWire, type WalletView } from '../../../api/_trenchProtocol'
import { engineApiUrl, marketStream } from '../api/marketStream'
import type { Page } from '../App'

export interface TrackedWallet {
  /** EVM lower case; Solana as written (base58 is case-sensitive). */
  address: string
  label: string
  added: number
  /** A notice (and a system notification, when allowed) for each of its trades while ARCDEX is open. */
  alerts: boolean
}

export const TRACK_LIMIT = 50
const KEY = 'arcdex:tracked:v1'
const EVENT = 'arcdex:tracked'

/** A wallet address as kept: EVM lower case, Solana as is; null for anything else. */
export function normWallet(v: string): string | null {
  const s = v.trim()
  if (isEvmWallet(s)) return s.toLowerCase()
  if (isSolWallet(s)) return s
  return null
}

function load(): TrackedWallet[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    const out: TrackedWallet[] = []
    for (const r of raw as Partial<TrackedWallet>[]) {
      const a = typeof r?.address === 'string' ? normWallet(r.address) : null
      if (!a || out.some(w => w.address === a)) continue
      out.push({ address: a, label: typeof r.label === 'string' ? r.label.slice(0, 32) : '', added: Number(r.added) || 0, alerts: r.alerts !== false })
    }
    return out.slice(0, TRACK_LIMIT)
  } catch { return [] }
}

let state: TrackedWallet[] = typeof localStorage === 'undefined' ? [] : load()
function save(next: TrackedWallet[]) {
  state = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* storage blocked: this page only */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}
const subscribe = (f: () => void) => { window.addEventListener(EVENT, f); window.addEventListener('storage', f); return () => { window.removeEventListener(EVENT, f); window.removeEventListener('storage', f) } }

/** The wallets followed in this browser. */
export function useTracked(): TrackedWallet[] {
  return useSyncExternalStore(subscribe, () => state, () => state)
}
export const getTracked = () => state
export const isTracked = (address: string) => { const a = normWallet(address); return !!a && state.some(w => w.address === a) }

/** Follows a wallet. Throws (in words) on an address that's neither EVM nor Solana, or past the limit. */
export function trackWallet(address: string, label = ''): TrackedWallet {
  const a = normWallet(address)
  if (!a) throw new Error('not a wallet address')
  const have = state.find(w => w.address === a)
  if (have) { if (label && label !== have.label) save(state.map(w => (w.address === a ? { ...w, label: label.slice(0, 32) } : w))); return have }
  if (state.length >= TRACK_LIMIT) throw new Error('limit')
  const w: TrackedWallet = { address: a, label: label.trim().slice(0, 32), added: Date.now(), alerts: true }
  save([w, ...state])
  return w
}
export function untrackWallet(address: string) { const a = normWallet(address); save(state.filter(w => w.address !== a)) }
export function updateTracked(address: string, patch: Partial<Pick<TrackedWallet, 'label' | 'alerts'>>) {
  const a = normWallet(address)
  save(state.map(w => (w.address === a ? { ...w, ...patch, label: (patch.label ?? w.label).slice(0, 32) } : w)))
}

// ── the engine ─────────────────────────────────────────────────────────────

export async function getWalletView(address: string, signal?: AbortSignal): Promise<WalletView | null> {
  if (!engineApiUrl) return null
  const r = await fetch(`${engineApiUrl}/v1/wallet/${encodeURIComponent(address)}`, { signal: signal ?? AbortSignal.timeout(10_000) })
  return r.ok ? ((await r.json()) as WalletView) : null
}

/** A trade on the tracker's feed: the wire trade, and whether it arrived live (after the page opened). */
export interface FeedItem extends WalletTradeWire { key: string; live: boolean }
const itemKey = (t: WalletTradeWire) => `${t.c}:${t.w.toLowerCase()}:${t.t}:${t.ts}:${t.side}:${t.u}`

/** Live trades of `wallets` as they happen (the `wallet` channel), each wallet's handler called once per trade. */
export function onWalletTrades(wallets: string[], handler: (t: WalletTradeWire) => void): () => void {
  const offs = wallets.map(w => marketStream.subscribe({ channel: 'wallet', wallet: w }, m => { if (m.t === 'WTRADE') handler(m.d) }))
  return () => offs.forEach(f => f())
}

/** The followed wallets' trades, newest first: what the engine kept, then each live trade at the top; and each wallet's
 * record per chain. Read again every 60 seconds. */
export function useTrackerFeed(wallets: string[]): { items: FeedItem[]; records: Map<string, WalletRecordWire[]>; loading: boolean } {
  const key = wallets.join(',')
  const [items, setItems] = useState<FeedItem[]>([])
  const [records, setRecords] = useState<Map<string, WalletRecordWire[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    let alive = true
    seen.current = new Set()
    setItems([])
    if (!wallets.length) { setLoading(false); return }
    setLoading(true)
    const merge = (list: FeedItem[]) => setItems(prev => {
      const add = list.filter(i => !seen.current.has(i.key))
      for (const i of add) seen.current.add(i.key)
      return add.length ? [...add, ...prev].sort((a, b) => b.ts - a.ts).slice(0, 400) : prev
    })
    const read = () => Promise.all(wallets.map(w => getWalletView(w).catch(() => null))).then(views => {
      if (!alive) return
      const rec = new Map<string, WalletRecordWire[]>()
      const list: FeedItem[] = []
      views.forEach((v, i) => {
        if (!v) return
        rec.set(wallets[i], v.records)
        for (const t of v.trades) list.push({ ...t, key: itemKey(t), live: false })
      })
      setRecords(rec)
      merge(list)
    }).finally(() => { if (alive) setLoading(false) })
    void read()
    const off = onWalletTrades(wallets, t => { if (alive) merge([{ ...t, key: itemKey(t), live: true }]) })
    const id = setInterval(() => { if (!document.hidden) void read() }, 60_000)
    return () => { alive = false; off(); clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => ({ items, records, loading }), [items, records, loading])
}

/** Which wallet a trade belongs to among the followed (EVM case-insensitively). */
export const ownerOf = (t: Pick<WalletTradeWire, 'w' | 'c'>, list: TrackedWallet[]) =>
  list.find(w => (t.c === 'sol' ? w.address === t.w : w.address === t.w.toLowerCase())) ?? null

/** The coin page a trade's coin opens on, by chain. */
export function coinPageOf(c: TrenchChain, token: string): Page {
  if (c === 'arc') return { name: 'argus', address: token.toLowerCase(), pool: '' }
  if (c === 'hood') return { name: 'rh-token', address: token.toLowerCase() }
  if (c === 'sol') return { name: 'sol-token', address: token }
  return { name: 'bsc-token', address: token.toLowerCase() }
}

export const CHAIN_LABEL: Record<TrenchChain, string> = { arc: 'Arc', hood: 'Robinhood', sol: 'Solana', bnb: 'BNB' }
