// RPC settings (2026-10-12, owner: "Data RPC to be fast for all chains"): the nodes ARCDEX reads each chain through
// (balances, quotes, simulations), in order, with a speed test run from this browser, as motion.gift offers.
//
// - The defaults keep the order that was measured and tested (Arc: the dedicated node, Blockdaemon, Arc's public RPC;
//   Robinhood Chain: its own RPC; Solana: PublicNode; BNB Chain: PublicNode) with more public nodes behind them.
// - Anyone can put a faster node first, or add their own (Alchemy, QuickNode, Helius, …). Their own must be HTTPS on a
//   known provider: a node can lie about balances and simulations, so a pasted link from anywhere isn't taken.
// - Only reads follow this order. Transactions are still sent as before (a fallback could send one twice), and the
//   live trade feeds keep their tested endpoints (their log queries depend on each node's limits).
// - A node that throttles, errors or times out is skipped for 30 seconds and the next one answers the same request;
//   a revert is an answer and is never retried elsewhere.

import { useSyncExternalStore } from 'react'
import { http, type Transport } from 'viem'
import { RECENT_RPC } from '../../../api/_arcLogs'
import { RH_RPC_URL } from '../../../api/_rhCore'
import { BSC_RPC_BROWSER } from '../../../api/_bscCore'
import { SOL_RPC_BROWSER } from '../../../api/_solCore'
import { ARC_RPC, FAST_RPC, benchFor, fastUp, benchFast, lagTolerant } from './rpc'

export type RpcChain = 'arc' | 'hood' | 'sol' | 'bnb'
export const RPC_CHAINS: RpcChain[] = ['arc', 'hood', 'sol', 'bnb']
export const OPEN_RPC_SETTINGS = 'arcdex:rpc-settings'

export interface Endpoint {
  url: string
  name: string
  /** 'arcdex': ARCDEX's dedicated node (credits: never polled for the status line). */
  kind: 'default' | 'own' | 'arcdex'
}

const DEFAULTS: Record<RpcChain, Endpoint[]> = {
  arc: [
    ...(FAST_RPC ? [{ url: FAST_RPC, name: 'ARCDEX node', kind: 'arcdex' as const }] : []),
    { url: RECENT_RPC, name: 'Blockdaemon', kind: 'default' },
    { url: ARC_RPC, name: 'Arc public', kind: 'default' },
    { url: 'https://rpc.beamrpc.com', name: 'Beam', kind: 'default' },
    { url: 'https://arc.drpc.org', name: 'dRPC', kind: 'default' },
  ],
  hood: [
    { url: RH_RPC_URL, name: 'Robinhood official', kind: 'default' },
    { url: 'https://robinhood-rpc.publicnode.com', name: 'PublicNode', kind: 'default' },
  ],
  sol: [{ url: SOL_RPC_BROWSER, name: 'PublicNode', kind: 'default' }],
  bnb: [
    { url: BSC_RPC_BROWSER, name: 'PublicNode', kind: 'default' },
    { url: 'https://bsc-dataseed.bnbchain.org', name: 'BNB Chain official', kind: 'default' },
  ],
}

/** Providers whose nodes can be added (host suffixes). */
export const RPC_PROVIDERS = [
  'alchemy.com', 'quiknode.pro', 'quicknode.com', 'infura.io', 'ankr.com', 'drpc.org', 'publicnode.com', 'blastapi.io',
  'chainstack.com', 'getblock.io', 'nodereal.io', 'helius-rpc.com', 'helius.xyz', 'rpcpool.com', 'syndica.io', 'shyft.to',
  'tatum.io', 'onfinality.io', 'llamarpc.com', '1rpc.io', 'blockpi.network', 'blockdaemon.com', 'tenderly.co',
  'thirdweb.com', 'gateway.fm', 'nodies.app', 'lavanet.xyz', 'omniatech.io', 'merkle.io', 'zan.top', 'beamrpc.com',
  'arc.io', 'robinhood.com', 'bnbchain.org', 'binance.org', 'triton.one', 'extrnode.com', 'unifra.io',
]

export const hostOf = (url: string) => { try { return new URL(url).host } catch { return url } }

/** Why a node can't be added, or null. */
export function nodeProblem(url: string): string | null {
  let u: URL
  try { u = new URL(url.trim()) } catch { return 'Not a link' }
  if (u.protocol !== 'https:') return 'The node must use HTTPS'
  const host = u.hostname.toLowerCase()
  if (!RPC_PROVIDERS.some(p => host === p || host.endsWith(`.${p}`))) return 'Only nodes from known providers can be added'
  return null
}

// ── the settings ─────────────────────────────────────────────────────────

interface Saved { own: Partial<Record<RpcChain, string[]>>; primary: Partial<Record<RpcChain, string | null>> }
const KEY = 'arcdex:rpc:v1'
const EVENT = 'arcdex:rpc'

function read(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved
    // A node saved before the rules changed is dropped rather than used.
    const own: Saved['own'] = {}
    for (const c of RPC_CHAINS) own[c] = (s.own?.[c] ?? []).filter(u => typeof u === 'string' && !nodeProblem(u)).slice(0, 2)
    return { own, primary: s.primary ?? {} }
  } catch { return { own: {}, primary: {} } }
}
let saved: Saved = read()
let version = 0

function save(next: Saved) {
  saved = next
  version++
  try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* storage blocked: this page only */ }
  window.dispatchEvent(new Event(EVENT))
}

/** The nodes for a chain, in the order reads use them: the chosen first, then the visitor's own, then the defaults. */
export function endpoints(chain: RpcChain): Endpoint[] {
  const own = (saved.own[chain] ?? []).map((url, i): Endpoint => ({ url, name: `Your node ${i + 1}`, kind: 'own' }))
  const all = [...own, ...DEFAULTS[chain]]
  const seen = new Set<string>()
  const list = all.filter(e => (seen.has(e.url) ? false : (seen.add(e.url), true)))
  const first = saved.primary[chain]
  const i = first ? list.findIndex(e => e.url === first) : -1
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list
}
export const primaryOf = (chain: RpcChain) => endpoints(chain)[0]
export const isDefaultOrder = (chain: RpcChain) => !saved.primary[chain] && !(saved.own[chain] ?? []).length

export function setPrimary(chain: RpcChain, url: string | null) { save({ ...saved, primary: { ...saved.primary, [chain]: url } }) }
export function addNode(chain: RpcChain, url: string): string | null {
  const problem = nodeProblem(url)
  if (problem) return problem
  const own = saved.own[chain] ?? []
  if (own.includes(url.trim())) return null
  if (own.length >= 2) return 'Two nodes at most: remove one first'
  save({ ...saved, own: { ...saved.own, [chain]: [...own, url.trim()] } })
  return null
}
export function removeNode(chain: RpcChain, url: string) {
  save({ own: { ...saved.own, [chain]: (saved.own[chain] ?? []).filter(u => u !== url) }, primary: saved.primary[chain] === url ? { ...saved.primary, [chain]: null } : saved.primary })
}
export function resetRpc(chain: RpcChain) { save({ own: { ...saved.own, [chain]: [] }, primary: { ...saved.primary, [chain]: null } }) }

function subscribe(f: () => void) {
  window.addEventListener(EVENT, f)
  return () => window.removeEventListener(EVENT, f)
}
/** Re-renders when the settings change. */
export function useRpcSettings(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0)
}

// ── the read transport ───────────────────────────────────────────────────

const skippedUntil = new Map<string, number>()

/** Reads through the chain's nodes in order: one that throttles, errors or times out is skipped for 30 seconds (the
 * dedicated Arc node keeps its own longer rules) and the next answers. A revert or any other answer ends it. */
export function readTransport(chain: RpcChain): Transport {
  return (opts => {
    const cache = new Map<string, ReturnType<Transport>>()
    const transportFor = (url: string) => {
      let t = cache.get(url)
      if (!t) { t = lagTolerant(http(url, { timeout: 6_000 }))({ ...opts, retryCount: 0 }); cache.set(url, t) }
      return t
    }
    const base = http(endpoints(chain)[0].url)(opts)
    const request = (async (args: unknown, options?: unknown) => {
      const list = endpoints(chain).filter(e => (e.kind === 'arcdex' ? fastUp() : (skippedUntil.get(e.url) ?? 0) <= Date.now()))
      const order = list.length ? list : endpoints(chain).filter(e => e.kind !== 'arcdex')
      let last: unknown = null
      for (const e of order) {
        try { return await (transportFor(e.url).request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options) }
        catch (err) {
          const bench = benchFor(err)
          if (!bench) throw err
          if (e.kind === 'arcdex') benchFast(bench)
          else skippedUntil.set(e.url, Date.now() + Math.min(bench, 30_000))
          last = err
        }
      }
      throw last ?? new Error('No RPC answered')
    }) as typeof base.request
    return { ...base, request }
  }) as Transport
}

/** A JSON-RPC call to the chain's nodes in order (for code that doesn't use viem: Solana). */
export async function rpcRequest<T>(chain: RpcChain, method: string, params: unknown[] = [], timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
  let last: unknown = null
  for (const e of endpoints(chain)) {
    if (e.kind === 'arcdex' ? !fastUp() : (skippedUntil.get(e.url) ?? 0) > Date.now()) continue
    try {
      const r = await fetch(e.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: signal ?? AbortSignal.timeout(timeoutMs) })
      if (r.status === 429 || r.status >= 500 || r.status === 401 || r.status === 403) { skippedUntil.set(e.url, Date.now() + 30_000); last = new Error(`HTTP ${r.status}`); continue }
      const j = (await r.json()) as { result?: T; error?: { code?: number; message?: string } }
      if (j.error) {
        if (j.error.code === 429 || /rate|limit|too many/i.test(j.error.message ?? '')) { skippedUntil.set(e.url, Date.now() + 30_000); last = new Error(j.error.message); continue }
        throw Object.assign(new Error(j.error.message ?? 'RPC error'), { code: j.error.code })
      }
      return j.result as T
    } catch (err) {
      if ((err as { code?: number }).code !== undefined || signal?.aborted) throw err
      skippedUntil.set(e.url, Date.now() + 30_000)
      last = err
    }
  }
  throw last ?? new Error('No RPC answered')
}

// ── the speed test ───────────────────────────────────────────────────────

export interface NodeSpeed { latencyMs: number; callMs: number; head: number }

async function call(url: string, method: string, params: unknown[]): Promise<{ ms: number; result: unknown }> {
  const t0 = performance.now()
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8_000), cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } }
  if (j.error) throw new Error(j.error.message ?? 'RPC error')
  return { ms: performance.now() - t0, result: j.result }
}

/** The chain's head from its first node that isn't ARCDEX's dedicated one (the status line polls it, and that node
 * is paid by the call), and how long the answer took. */
export async function headOf(chain: RpcChain): Promise<{ head: number; ms: number; node: string }> {
  const sol = chain === 'sol'
  let last: unknown = null
  for (const e of endpoints(chain).filter(x => x.kind !== 'arcdex')) {
    if ((skippedUntil.get(e.url) ?? 0) > Date.now()) continue
    try {
      const r = await call(e.url, sol ? 'getSlot' : 'eth_blockNumber', sol ? [{ commitment: 'confirmed' }] : [])
      return { head: sol ? Number(r.result) : parseInt(String(r.result), 16), ms: r.ms, node: e.name }
    } catch (err) { skippedUntil.set(e.url, Date.now() + 30_000); last = err }
  }
  throw last ?? new Error('No RPC answered')
}

/** Three head reads (the middle one's time is the latency) and one balance read, from this browser now. */
export async function measureNode(chain: RpcChain, url: string): Promise<NodeSpeed> {
  const sol = chain === 'sol'
  const heads: number[] = []
  let head = 0
  for (let i = 0; i < 3; i++) {
    const r = await call(url, sol ? 'getSlot' : 'eth_blockNumber', sol ? [{ commitment: 'confirmed' }] : [])
    heads.push(r.ms)
    head = sol ? Number(r.result) : parseInt(String(r.result), 16)
  }
  const bal = await call(url, sol ? 'getBalance' : 'eth_getBalance', sol ? ['11111111111111111111111111111111'] : ['0x0000000000000000000000000000000000000000', 'latest'])
  heads.sort((a, b) => a - b)
  return { latencyMs: heads[1], callMs: bal.ms, head }
}

// ── the head, shared: one poll per chain however many places show it ────

export interface HeadReading { head: number; ms: number; node: string; at: number }
const heads = new Map<RpcChain, HeadReading>()
const headSubs = new Map<RpcChain, Set<() => void>>()
const headTimers = new Map<RpcChain, ReturnType<typeof setInterval>>()

function pollHead(chain: RpcChain) {
  if (document.hidden) return
  void headOf(chain).then(h => {
    heads.set(chain, { ...h, at: Date.now() })
    for (const f of headSubs.get(chain) ?? []) f()
  }).catch(() => {})
}
function subscribeHead(chain: RpcChain, f: () => void) {
  let subs = headSubs.get(chain)
  if (!subs) { subs = new Set(); headSubs.set(chain, subs) }
  subs.add(f)
  if (!headTimers.has(chain)) { pollHead(chain); headTimers.set(chain, setInterval(() => pollHead(chain), 3_000)) }
  return () => {
    subs!.delete(f)
    if (!subs!.size) { clearInterval(headTimers.get(chain)); headTimers.delete(chain) }
  }
}
/** The chain's head block (slot on Solana), its first node's answer time and name, every 3 seconds while shown. */
export function useHead(chain: RpcChain): HeadReading | null {
  return useSyncExternalStore(f => subscribeHead(chain, f), () => heads.get(chain) ?? null, () => null)
}
