// The prediction pool on Arc testnet (contracts/ArcdexPredictPool.sol, engine/src/predictpool): papertrade.xyz's
// pool for Hyperliquid's prediction markets, with test USDC. What the engine serves (status, the pool, fills), the
// account's own state read from the chain, and sending its transactions (lib/perps.ts sendTestnet: the trading wallet
// signs with no pop-up, a connected wallet is put on Arc testnet first).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { PREDICT_POOL_ABI, PREDICT_TOKEN_ABI } from '../../../engine/src/predictpool/abi'
import { POOL_LIMITS, REJECT_REASON, type PoolFill, type PoolMarketView, type PoolStateView, type PredictPoolDeployment, type PredictPoolStatus } from '../../../engine/src/predictpool/shared'
import { engineApiUrl } from '../api/marketStream'
import { perpsClient, sendTestnet, TEST_USDC_ABI } from './perps'
import { t as T } from './i18n'
import type { TraderKind } from './identity'

export { PREDICT_POOL_ABI, POOL_LIMITS, REJECT_REASON }
export type { PoolFill, PoolMarketView, PoolStateView, PredictPoolDeployment, PredictPoolStatus }

/** The pool needs the engine (its keeper fills every trade). */
export const poolAvailable = Boolean(engineApiUrl)

async function engineJson<T>(path: string): Promise<T | null> {
  if (!engineApiUrl) return null
  try {
    const r = await fetch(`${engineApiUrl}${path}`, { signal: AbortSignal.timeout(10_000) })
    return r.ok ? ((await r.json()) as T) : null
  } catch { return null }
}

function usePoll<T>(path: string | null, everyMs: number, tick = 0): T | null {
  const [v, setV] = useState<T | null>(null)
  useEffect(() => {
    if (!path) { setV(null); return }
    let alive = true
    const load = () => void engineJson<T>(path).then(x => { if (alive && x) setV(x) })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, everyMs)
    return () => { alive = false; clearInterval(id) }
  }, [path, everyMs, tick])
  return v
}

export const usePoolStatus = () => usePoll<PredictPoolStatus>(poolAvailable ? '/v1/predict/pool/status' : null, 10_000)
export const usePoolState = () => usePoll<{ state: PoolStateView | null; markets: PoolMarketView[] }>(poolAvailable ? '/v1/predict/pool/state' : null, 5_000)
export function usePoolFills(account: string | null, tick = 0) {
  return usePoll<{ fills: PoolFill[] }>(poolAvailable ? (account ? `/v1/predict/pool/fills?account=${account}&limit=100` : '/v1/predict/pool/fills?limit=30') : null, 4_000, tick)?.fills ?? null
}

// ── the account, from the chain ─────────────────────────────────────────

export interface PoolPosition { outcome: number; side: 0 | 1; contracts: bigint; cost: bigint; selling: bigint }
export interface PoolRequest { id: bigint; outcome: number; side: 0 | 1; buy: boolean; amount: bigint; limitPx: bigint; createdAt: number }
export interface PoolMarketOnChain { state: 0 | 1 | 2; fraction: bigint; readyAt: number }

export interface PoolAccount {
  /** Test USDC in the wallet (6 decimals), what the pool may take of it, and the trading balance in the pool. */
  wallet: bigint
  allowance: bigint
  balance: bigint
  /** Native testnet USDC for gas (18 decimals). */
  gas: bigint
  lastFaucetAt: number
  positions: PoolPosition[]
  requests: PoolRequest[]
  /** What the pool owes in the queue. */
  queued: bigint
  /** tPOOL (18 decimals): held, staked, and USDC rewards waiting to be claimed. */
  token: bigint
  staked: bigint
  reward: bigint
  /** The state of every market held. */
  markets: Map<number, PoolMarketOnChain>
  requestTimeout: number
}

/** The account's balances, positions, requests and tPOOL, every 3 seconds (and on `refresh`). */
export function usePoolAccount(address: Address | null, dep: PredictPoolDeployment | null) {
  const [view, setView] = useState<PoolAccount | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(x => x + 1), [])
  const key = `${address}:${dep?.pool}`
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => { setView(null) }, [key])
  useEffect(() => {
    if (!address || !dep?.pool || !dep.usdc || !dep.token) return
    const p = { address: dep.pool as Address, abi: PREDICT_POOL_ABI } as const
    const u = { address: dep.usdc as Address, abi: TEST_USDC_ABI } as const
    const t = { address: dep.token as Address, abi: PREDICT_TOKEN_ABI } as const
    let alive = true
    const load = async () => {
      try {
        const [wallet, allowance, gas, lastFaucetAt, balance, pos, reqs, queued, token, staked, reward, timeout] = await Promise.all([
          perpsClient.readContract({ ...u, functionName: 'balanceOf', args: [address] }),
          perpsClient.readContract({ ...u, functionName: 'allowance', args: [address, p.address] }),
          perpsClient.getBalance({ address }),
          perpsClient.readContract({ ...u, functionName: 'lastFaucetAt', args: [address] }).catch(() => 0n),
          perpsClient.readContract({ ...p, functionName: 'balances', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'positionsOf', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'requestsOf', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'queuedOf', args: [address] }),
          perpsClient.readContract({ ...t, functionName: 'balanceOf', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'stakeOf', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'pendingReward', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'requestTimeout' }),
        ])
        const [keys, list] = pos
        const positions: PoolPosition[] = keys.map((k, i) => ({
          outcome: Number(k / 2n), side: Number(k % 2n) as 0 | 1, contracts: list[i].contracts, cost: list[i].cost, selling: list[i].selling,
        })).filter(x => x.contracts > 0n)
        const [ids, rs] = reqs
        const requests: PoolRequest[] = ids.map((id, i) => ({
          id, outcome: Number(rs[i].outcome), side: Number(rs[i].side) as 0 | 1, buy: rs[i].buy, amount: rs[i].amount, limitPx: BigInt(rs[i].limitPx), createdAt: Number(rs[i].createdAt),
        }))
        const outcomes = [...new Set(positions.map(x => x.outcome))]
        const ms = await Promise.all(outcomes.map(o => perpsClient.readContract({ ...p, functionName: 'markets', args: [o] })))
        const markets = new Map<number, PoolMarketOnChain>()
        outcomes.forEach((o, i) => { const m = ms[i]; markets.set(o, { state: Number(m[4]) as 0 | 1 | 2, fraction: BigInt(m[5]), readyAt: Number(m[6]) }) })
        if (!alive || keyRef.current !== key) return
        setView({ wallet, allowance, balance, gas, lastFaucetAt: Number(lastFaucetAt), positions, requests, queued, token, staked, reward, markets, requestTimeout: Number(timeout) })
      } catch { /* the next read */ }
    }
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 3_000)
    return () => { alive = false; clearInterval(id) }
  }, [key, tick, address, dep?.pool, dep?.usdc, dep?.token])
  return { view, refresh }
}

// ── sending ─────────────────────────────────────────────────────────────

export const poolCall = (kind: TraderKind | null, dep: PredictPoolDeployment, functionName: string, args: readonly unknown[]) =>
  sendTestnet(kind, { address: dep.pool as Address, abi: PREDICT_POOL_ABI, functionName, args })

/** Test USDC from the wallet into the pool: an approval of exactly the amount (when needed), then the deposit. */
export async function poolDeposit(kind: TraderKind | null, dep: PredictPoolDeployment, amount: bigint, allowance: bigint) {
  if (allowance < amount) await sendTestnet(kind, { address: dep.usdc as Address, abi: TEST_USDC_ABI, functionName: 'approve', args: [dep.pool, amount] })
  return poolCall(kind, dep, 'deposit', [amount])
}

export const poolFaucet = (kind: TraderKind | null, dep: PredictPoolDeployment) =>
  sendTestnet(kind, { address: dep.usdc as Address, abi: TEST_USDC_ABI, functionName: 'faucet', args: [] })

/** A buy's worst price: the mid shown, `bandPct` higher, inside 1–99¢ (1e6 = $1). */
export function buyLimit(mid: number, bandPct = POOL_LIMITS.defaultBandPct): bigint {
  return BigInt(Math.round(Math.min(POOL_LIMITS.maxBuyPx, mid * (1 + bandPct / 100)) * 1e6))
}
/** A sale's worst price: the mid shown, `bandPct` lower. */
export function sellLimit(mid: number, bandPct = POOL_LIMITS.defaultBandPct): bigint {
  return BigInt(Math.max(0, Math.round(mid * (1 - bandPct / 100) * 1e6)))
}

/** A revert from the pool, in words. */
export function poolErrorText(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  const known: [RegExp, string][] = [
    [/rejected|denied|cancel/i, T('You cancelled the transaction.')],
    [/insufficient funds|exceeds the balance|gas required exceeds/i, T('Not enough testnet USDC for gas: get some from Circle’s faucet.')],
    [/IsPaused/, T('The pool is paused: new buys can’t start right now. Sales and withdrawals still work.')],
    [/MarketClosed/, T('This market is settling or halted in the pool.')],
    [/BadAmount/, T('Check the amount: at least $1, and no more than your pool balance (or what you hold).')],
    [/TooEarly/, T('A request can be cancelled once its time to fill has passed.')],
    [/NothingHeld/, T('Nothing left to pay out here.')],
    [/NotSettled/, T('This market isn’t settled in the pool yet.')],
    [/TooSoon/, T('The faucet gives 1,000 test USDC once a day.')],
    [/ERC20InsufficientBalance|transfer amount exceeds balance/i, T('Not enough test USDC: get some from the faucet.')],
  ]
  for (const [re, text] of known) if (re.test(m)) return text
  return m.split('\n')[0].slice(0, 200)
}

export const usdOf = (v: bigint | string) => Number(v) / 1e6
