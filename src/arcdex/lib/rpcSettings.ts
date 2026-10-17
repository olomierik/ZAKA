// RPC settings (2026-10-12, owner: "Data RPC to be fast for all chains"): the nodes ARCDEX reads each chain through
// (balances, quotes, simulations), with a speed test run from this browser, as motion.gift offers.
//
// - The defaults: Arc (the dedicated node, Blockdaemon, Arc's public RPC, Beam, dRPC), Robinhood Chain (its own RPC,
//   PublicNode), Solana (PublicNode), BNB Chain (PublicNode, BNB Chain's own).
// - Alchemy (2026-10-12, the owner's account): in production every chain also has ARCDEX's Alchemy node, reached through
//   the site's own /rpc/<chain> (netlify/edge-functions/rpc.ts keeps the key server-side). It serves only the methods
//   in ALCHEMY_METHODS: anything else goes to the next node. Until the key is set in Netlify it answers "unconfigured"
//   and steps aside for 10 minutes.
// - Fastest first: each visitor's browser measures every node (a head read each, every 2 minutes while the chain is in
//   use) and reads through the fastest one that is up to date. A node that hasn't answered a measurement yet stays
//   behind those that have, so an unproven node (Alchemy before its first answer) is never first.
// - Anyone can still pin a node first, or add their own (Alchemy, QuickNode, Helius, …). Their own must be HTTPS on a
//   known provider: a node can lie about balances and simulations, so a pasted link from anywhere isn't taken.
// - Only reads follow this order. EVM transactions are still sent as before (a fallback could send one twice), and the
//   live trade feeds keep their tested endpoints (their log queries depend on each node's limits).
// - A node that throttles, errors or times out is skipped for 30 seconds and the next one answers the same request;
//   a revert is an answer and is never retried elsewhere.

import { useEffect, useSyncExternalStore } from 'react'
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
  /** 'arcdex': the dedicated Arc node; 'alchemy': ARCDEX's Alchemy node through /rpc (both paid by the call: never
   * polled for the status line's block). */
  kind: 'default' | 'own' | 'arcdex' | 'alchemy'
}

// ── Alchemy, through the site ────────────────────────────────────────────

type Env = { PROD?: boolean; VITE_ALCHEMY?: string }
const ENV: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}
/** On in production builds; in local dev with VITE_ALCHEMY=on (vite.config.ts proxies /rpc with ALCHEMY_API_KEY). */
export const ALCHEMY_ON = ENV.PROD === true || ENV.VITE_ALCHEMY === 'on'

/** The methods ARCDEX's Alchemy node serves (the same lists as netlify/edge-functions/rpc.ts). */
export const ALCHEMY_METHODS: Record<'evm' | 'sol', readonly string[]> = {
  evm: [
    'eth_blockNumber', 'eth_chainId', 'net_version', 'eth_call', 'eth_estimateGas', 'eth_createAccessList', 'eth_getBalance',
    'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  ],
  sol: [
    'getSlot', 'getBlockHeight', 'getHealth', 'getVersion', 'getEpochInfo', 'getBalance', 'getAccountInfo', 'getMultipleAccounts',
    'getTokenAccountsByOwner', 'getTokenAccountBalance', 'getTokenSupply', 'getLatestBlockhash', 'isBlockhashValid',
    'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees', 'simulateTransaction',
    'sendTransaction', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction',
  ],
}
const familyOf = (chain: RpcChain) => (chain === 'sol' ? 'sol' : 'evm')
/** Whether a node takes a method (only ARCDEX's Alchemy node has a list). */
export const serves = (e: Endpoint, chain: RpcChain, method: string) => e.kind !== 'alchemy' || ALCHEMY_METHODS[familyOf(chain)].includes(method)

const origin = () => (typeof location !== 'undefined' ? location.origin : 'https://arcsense.site')
export const alchemyUrl = (chain: RpcChain | 'starknet') => `${origin()}/rpc/${chain}`

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
const defaultsOf = (chain: RpcChain): Endpoint[] => (ALCHEMY_ON ? [...DEFAULTS[chain], { url: alchemyUrl(chain), name: 'Alchemy', kind: 'alchemy' }] : DEFAULTS[chain])

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
const emit = () => { version++; if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT)) }

function save(next: Saved) {
  saved = next
  try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* storage blocked: this page only */ }
  emit()
}

// ── what each node did (measurements and real reads) ────────────────────

export interface NodeStat { ms: number; head: number | null; at: number }
const stats = new Map<string, NodeStat>()
const skippedUntil = new Map<string, number>()
const skipped = (url: string) => (skippedUntil.get(url) ?? 0) > Date.now()
/** How far behind the newest head a node may be and still count as up to date (about 5–10 seconds of blocks). */
export const HEAD_SLACK: Record<RpcChain, number> = { arc: 20, hood: 60, sol: 25, bnb: 10 }

/** A real read's time, folded into the node's figure (so the status line shows what reads actually take). A node that
 * answers is healthy again at once, even inside its time aside (when every node was failing, the one that answered). */
function observe(url: string, ms: number) {
  skippedUntil.delete(url)
  const s = stats.get(url)
  stats.set(url, { ms: s ? s.ms * 0.7 + ms * 0.3 : ms, head: s?.head ?? null, at: Date.now() })
  bump()
}
let bumpTimer: ReturnType<typeof setTimeout> | null = null
function bump() { if (!bumpTimer) bumpTimer = setTimeout(() => { bumpTimer = null; emit() }, 500) }

/** The order reads use: a pinned node first (unless it's failing), then the measured nodes fastest first (those more
 * than HEAD_SLACK behind the newest head after the rest), then the unmeasured in their listed order (ARCDEX's
 * Alchemy node last of those: it must answer before it leads), then any node that is stepping aside. */
export function orderNodes(chain: RpcChain, list: Endpoint[], pinned: string | null, now = Date.now()): Endpoint[] {
  const fresh = (e: Endpoint) => { const s = stats.get(e.url); return s && now - s.at < 10 * 60_000 ? s : null }
  const top = Math.max(0, ...list.map(e => fresh(e)?.head ?? 0))
  const rank = (e: Endpoint) => {
    if ((skippedUntil.get(e.url) ?? 0) > now) return [4, 0] as const
    const s = fresh(e)
    if (!s) return [e.kind === 'alchemy' ? 3 : 2, 0] as const
    const behind = s.head !== null && top > 0 && top - s.head > HEAD_SLACK[chain]
    return [behind ? 1.5 : 1, s.ms] as const
  }
  const indexed = list.map((e, i) => ({ e, i, r: rank(e) }))
  indexed.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
  const ordered = indexed.map(x => x.e)
  const p = pinned ? ordered.findIndex(e => e.url === pinned) : -1
  return p > 0 && !((skippedUntil.get(pinned!) ?? 0) > now) ? [ordered[p], ...ordered.slice(0, p), ...ordered.slice(p + 1)] : ordered
}

/** The nodes for a chain: the visitor's own, then the defaults (each once). */
function listOf(chain: RpcChain): Endpoint[] {
  const own = (saved.own[chain] ?? []).map((url, i): Endpoint => ({ url, name: `Your node ${i + 1}`, kind: 'own' }))
  const seen = new Set<string>()
  return [...own, ...defaultsOf(chain)].filter(e => (seen.has(e.url) ? false : (seen.add(e.url), true)))
}

/** The nodes for a chain, in the order reads use them. */
export function endpoints(chain: RpcChain): Endpoint[] {
  touch(chain)
  return orderNodes(chain, listOf(chain), saved.primary[chain] ?? null)
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
/** Re-renders when the settings or the nodes' figures change. */
export function useRpcSettings(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0)
}

// ── measuring the nodes (in the browser, while a chain is in use) ───────

const lastProbe = new Map<RpcChain, number>()
const PROBE_EVERY = 120_000

/** A chain's reads keep its measurements fresh: one round every 2 minutes while it's in use. */
function touch(chain: RpcChain) {
  if (typeof document === 'undefined' || document.hidden) return
  if (Date.now() - (lastProbe.get(chain) ?? 0) < PROBE_EVERY) return
  lastProbe.set(chain, Date.now())
  setTimeout(() => { void probeNow(chain) }, 0)
}

/** One head read from every node of a chain at once: the answer time and the head, or the node steps aside. */
export async function probeNow(chain: RpcChain): Promise<void> {
  const sol = chain === 'sol'
  await Promise.all(listOf(chain).map(async e => {
    if (e.kind === 'arcdex' && !fastUp()) return
    if (skipped(e.url)) return
    try {
      const r = await call(e.url, sol ? 'getSlot' : 'eth_blockNumber', sol ? [{ commitment: 'confirmed' }] : [])
      stats.set(e.url, { ms: r.ms, head: sol ? Number(r.result) : parseInt(String(r.result), 16), at: Date.now() })
      skippedUntil.delete(e.url)
    } catch (err) {
      stats.delete(e.url)
      stepAside(e, err)
    }
  }))
  emit()
}

/** A node that failed steps aside: ARCDEX's Alchemy node for 10 minutes when it isn't set up yet, the dedicated Arc
 * node by its own rules, any other for 30 seconds. */
function stepAside(e: Endpoint, err: unknown, benchMs = 30_000) {
  if (e.kind === 'arcdex') { benchFast(benchMs); return }
  const unconfigured = (err as { unconfigured?: boolean } | null)?.unconfigured === true
  skippedUntil.set(e.url, Date.now() + (unconfigured ? 10 * 60_000 : Math.min(benchMs, 30_000)))
}

// ── the read transport ───────────────────────────────────────────────────

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
    const base = http(listOf(chain)[0].url)(opts)
    const request = (async (args: { method: string }, options?: unknown) => {
      const all = endpoints(chain).filter(e => serves(e, chain, args.method))
      const list = all.filter(e => (e.kind === 'arcdex' ? fastUp() : !skipped(e.url)))
      const order = list.length ? list : all.filter(e => e.kind !== 'arcdex' && e.kind !== 'alchemy')
      let last: unknown = null
      for (const e of order) {
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
        try {
          const res = await (transportFor(e.url).request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options)
          observe(e.url, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
          return res
        } catch (err) {
          const bench = e.kind === 'alchemy' && (err as { status?: number })?.status === 503 ? 600_000 : benchFor(err)
          if (!bench) throw err
          stepAside(e, e.kind === 'alchemy' && bench === 600_000 ? { unconfigured: true } : err, bench)
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
    if (!serves(e, chain, method)) continue
    if (e.kind === 'arcdex' ? !fastUp() : skipped(e.url)) continue
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      const r = await fetch(e.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: signal ?? AbortSignal.timeout(timeoutMs) })
      if (r.headers.get('x-arcdex-rpc') === 'unconfigured') { stepAside(e, { unconfigured: true }); last = new Error('Alchemy is not set up'); continue }
      if (r.status === 429 || r.status >= 500 || r.status === 401 || r.status === 403) { stepAside(e, null); last = new Error(`HTTP ${r.status}`); continue }
      const j = (await r.json()) as { result?: T; error?: { code?: number; message?: string } }
      if (j.error) {
        if (j.error.code === 429 || /rate|limit|too many/i.test(j.error.message ?? '')) { stepAside(e, null); last = new Error(j.error.message); continue }
        throw Object.assign(new Error(j.error.message ?? 'RPC error'), { code: j.error.code })
      }
      observe(e.url, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
      return j.result as T
    } catch (err) {
      if ((err as { code?: number }).code !== undefined || signal?.aborted) throw err
      stepAside(e, null)
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
  if (r.headers.get('x-arcdex-rpc') === 'unconfigured') throw Object.assign(new Error('Alchemy is not set up yet'), { unconfigured: true })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } }
  if (j.error) throw new Error(j.error.message ?? 'RPC error')
  return { ms: performance.now() - t0, result: j.result }
}

/** The chain's head from its first free node (ARCDEX's dedicated and Alchemy nodes are paid by the call, so the
 * status line's block number never polls them), and how long the answer took. */
export async function headOf(chain: RpcChain): Promise<{ head: number; ms: number; node: string }> {
  const sol = chain === 'sol'
  let last: unknown = null
  for (const e of endpoints(chain).filter(x => x.kind !== 'arcdex' && x.kind !== 'alchemy')) {
    if (skipped(e.url)) continue
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
  stats.set(url, { ms: heads[1], head, at: Date.now() })
  emit()
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
/** The chain's head block (slot on Solana), every 3 seconds while shown. */
export function useHead(chain: RpcChain): HeadReading | null {
  return useSyncExternalStore(f => subscribeHead(chain, f), () => heads.get(chain) ?? null, () => null)
}

/** The node reads go through now and its time: real reads' times as they happen, else its last measurement. */
export function readSpeed(chain: RpcChain): { node: string; ms: number | null; kind: Endpoint['kind'] } {
  const e = orderNodes(chain, listOf(chain), saved.primary[chain] ?? null)[0]
  return { node: e.name, ms: stats.get(e.url)?.ms ?? null, kind: e.kind }
}
/** readSpeed, re-rendered as reads and measurements come in; while shown it keeps the chain's measurements fresh. */
export function useReadSpeed(chain: RpcChain): ReturnType<typeof readSpeed> {
  useRpcSettings()
  useEffect(() => {
    touch(chain)
    const id = setInterval(() => touch(chain), 30_000)
    return () => clearInterval(id)
  }, [chain])
  return readSpeed(chain)
}
