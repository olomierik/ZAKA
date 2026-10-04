// ARCDEX futures on the site: what the engine serves (status, signed prices, the chart, the
// contract's state, trades), the account's own state read from Arc testnet, and sending
// transactions there from the trading wallet or a connected wallet.
//
// Contracts: contracts/SensePerps.sol (SensePerps, SenseOracle, SenseTestUSDC). The engine
// deploys them on Arc testnet and runs their keeper (engine/src/perps).

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPublicClient, fallback, http, type Address, type Hex } from 'viem'
import { getAccount, switchChain, writeContract } from 'wagmi/actions'
import { PERPS_ABI, TEST_USDC_ABI } from '../../../engine/src/perps/abi'
import {
  TESTNET_RPCS,
  type PerpsBar, type PerpsDeployment, type PerpsPricesResponse, type PerpsStateResponse, type PerpsStatus, type PerpsTf,
  type PerpsTradeView, type Pos, type Req,
} from '../../../engine/src/perps/shared'
import { arcTestnet, wagmiConfig } from '../wagmi'
import { engineApiUrl } from '../api/marketStream'
import { getEmbeddedWalletClientOn } from './embeddedWallet'
import { promptWallet } from './tx'
import { hideWalletPrompt } from './walletPrompt'
import { t as T } from './i18n'
import type { TraderKind } from './identity'

export { PERPS_ABI, TEST_USDC_ABI }

/** Arc testnet's RPCs, or VITE_PERPS_RPC (a local chain standing in for it, in development). */
const RPCS: readonly string[] = (import.meta.env.VITE_PERPS_RPC as string | undefined) ? [import.meta.env.VITE_PERPS_RPC as string] : TESTNET_RPCS

export const perpsClient = createPublicClient({
  chain: arcTestnet,
  transport: fallback(RPCS.map(u => http(u, { timeout: 10_000 }))),
  batch: { multicall: true },
})

// ─── the engine ──────────────────────────────────────────────────────────────

async function engineJson<T>(path: string): Promise<T | null> {
  if (!engineApiUrl) return null
  try {
    const r = await fetch(`${engineApiUrl}${path}`, { signal: AbortSignal.timeout(10_000) })
    return r.ok ? ((await r.json()) as T) : null
  } catch { return null }
}

/** Polls an engine path while the tab is visible. `null` until the first answer. */
function usePoll<T>(path: string | null, everyMs: number): T | null {
  const [v, setV] = useState<T | null>(null)
  useEffect(() => {
    setV(null)
    if (!path) return
    let alive = true
    const load = () => void engineJson<T>(path).then(x => { if (alive && x) setV(x) })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, everyMs)
    return () => { alive = false; clearInterval(id) }
  }, [path, everyMs])
  return v
}

export const usePerpsStatus = () => usePoll<PerpsStatus>('/v1/perps/status', 15_000)
export const usePerpsPrices = () => usePoll<PerpsPricesResponse>('/v1/perps/prices', 3_000)
export const usePerpsState = () => usePoll<PerpsStateResponse>('/v1/perps/state', 5_000)
export function usePerpsTrades(account: string | null) {
  return usePoll<{ trades: PerpsTradeView[] }>(account ? `/v1/perps/trades?account=${account}&limit=50` : '/v1/perps/trades?limit=30', 5_000)?.trades ?? null
}

export async function fetchCandles(feed: string, tf: PerpsTf): Promise<PerpsBar[]> {
  return (await engineJson<{ bars: PerpsBar[] }>(`/v1/perps/candles?feed=${feed}&tf=${tf}&limit=500`))?.bars ?? []
}

// ─── the account, from the chain ─────────────────────────────────────────────

export interface AccountView {
  /** Test USDC (6 decimals), and what the futures contract may take of it. */
  usdc: bigint
  allowance: bigint
  /** Native testnet USDC for gas (18 decimals). */
  gas: bigint
  shares: bigint
  lastDepositAt: number
  lastFaucetAt: number
  positions: [bigint, Pos][]
  requests: [bigint, Req][]
}

/** The account's balances, positions and requests, every 4 seconds (and on `refresh`). */
export function useAccountPerps(address: Address | null, dep: PerpsDeployment | null) {
  const [view, setView] = useState<AccountView | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(x => x + 1), [])
  const key = `${address}:${dep?.perps}:${dep?.usdc}`
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => { setView(null) }, [key])
  useEffect(() => {
    if (!address || !dep?.perps || !dep.usdc) return
    const perps = dep.perps as Address
    const usdc = dep.usdc as Address
    let alive = true
    const load = async () => {
      try {
        const p = { address: perps, abi: PERPS_ABI } as const
        const u = { address: usdc, abi: TEST_USDC_ABI } as const
        const [bal, allowance, gas, shares, lastDepositAt, lastFaucetAt, posIds, reqIds] = await Promise.all([
          perpsClient.readContract({ ...u, functionName: 'balanceOf', args: [address] }),
          perpsClient.readContract({ ...u, functionName: 'allowance', args: [address, perps] }),
          perpsClient.getBalance({ address }),
          perpsClient.readContract({ ...p, functionName: 'balanceOf', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'lastDepositAt', args: [address] }),
          perpsClient.readContract({ ...u, functionName: 'lastFaucetAt', args: [address] }).catch(() => 0n),
          perpsClient.readContract({ ...p, functionName: 'positionIdsOf', args: [address] }),
          perpsClient.readContract({ ...p, functionName: 'requestIdsOf', args: [address] }),
        ])
        const [poss, reqs] = await Promise.all([
          posIds.length ? perpsClient.readContract({ ...p, functionName: 'getPositions', args: [posIds] }) : Promise.resolve([]),
          reqIds.length ? perpsClient.readContract({ ...p, functionName: 'getRequests', args: [reqIds] }) : Promise.resolve([]),
        ])
        if (!alive || keyRef.current !== key) return
        setView({
          usdc: bal, allowance, gas, shares, lastDepositAt: Number(lastDepositAt), lastFaucetAt: Number(lastFaucetAt),
          positions: posIds.map((id, i) => [id, poss[i] as unknown as Pos] as [bigint, Pos]).filter(([, x]) => Number(x.size) > 0),
          requests: reqIds.map((id, i) => [id, reqs[i] as unknown as Req] as [bigint, Req]).filter(([, x]) => x.kind !== 0),
        })
      } catch { /* the next read */ }
    }
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 4_000)
    return () => { alive = false; clearInterval(id) }
  }, [key, tick, address, dep?.perps, dep?.usdc])
  return { view, refresh }
}

// ─── sending ─────────────────────────────────────────────────────────────────

export interface TestnetCall {
  address: Address
  abi: typeof PERPS_ABI | typeof TEST_USDC_ABI
  functionName: string
  args?: readonly unknown[]
}

/** Puts a connected wallet on Arc testnet (adding it if the wallet doesn't know it). */
async function ensureTestnet() {
  const { connector, chainId } = getAccount(wagmiConfig)
  if (!connector) throw new Error(T('Connect a wallet first'))
  let current = chainId
  try { current = await connector.getChainId() } catch { /* keep wagmi's view */ }
  if (current !== arcTestnet.id) await switchChain(wagmiConfig, { chainId: arcTestnet.id })
}

/** Sends `call` on Arc testnet and waits until it's mined. Returns the transaction hash. */
export async function sendTestnet(kind: TraderKind | null, call: TestnetCall): Promise<Hex> {
  let hash: Hex
  if (kind === 'trading-wallet') {
    const w = getEmbeddedWalletClientOn(arcTestnet, http(RPCS[0]))
    hash = await w.writeContract(call as never)
  } else {
    await ensureTestnet()
    const prompted = await promptWallet()
    try {
      hash = await writeContract(wagmiConfig, { ...call, chainId: arcTestnet.id } as never)
    } finally {
      if (prompted) hideWalletPrompt()
    }
  }
  const r = await perpsClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 500 })
  if (r.status !== 'success') throw new Error(T('The transaction failed on-chain.'))
  return hash
}

/** A revert from the futures contract, in words. */
export function perpsErrorText(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  const known: [RegExp, string][] = [
    [/rejected|denied|cancel/i, T('You cancelled the transaction.')],
    [/insufficient funds|exceeds the balance|gas required exceeds/i, T('Not enough testnet USDC for gas: get some from Circle’s faucet.')],
    [/IsPaused/, T('Futures are paused: new positions can’t open right now.')],
    [/BadAmount/, T('Check the amount and leverage: at least the minimum margin, and no more than the market’s leverage.')],
    [/ClosePending/, T('A close for this position is already on its way.')],
    [/TooEarly/, T('Too early: a market request can be cancelled once its time to execute has passed.')],
    [/Cooldown/, T('Shares can leave 15 minutes after your last deposit.')],
    [/TooSoon/, T('The faucet gives 1,000 test USDC once a day.')],
    [/ERC20InsufficientBalance|transfer amount exceeds balance/i, T('Not enough test USDC: get some from the faucet.')],
    [/ERC20InsufficientAllowance|exceeds allowance/i, T('The futures contract needs your approval first: try again.')],
  ]
  for (const [re, text] of known) if (re.test(m)) return text
  return m.split('\n')[0].slice(0, 200)
}

// ─── numbers ─────────────────────────────────────────────────────────────────

export const usd = (v: bigint) => Number(v) / 1e6
export const px = (v: bigint) => Number(v) / 1e8
export const toUsdc = (n: number) => BigInt(Math.round(n * 1e6))
export const toPrice = (n: number) => BigInt(Math.round(n * 1e8))

/** Decimal places for a price of this size. */
export const dpOf = (price: number) => (price >= 1000 ? 2 : price >= 10 ? 3 : price >= 1 ? 4 : 5)
