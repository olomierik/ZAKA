// Live facts about the configured ArcDexSwapRouter, read from the chain so
// the UI always shows the fee that's actually in force: v1 (1%, no
// referrals) until v2 is deployed and configured, then v2 (2%, 15% of the
// fee to referrers) — no redeploy of the site needed to switch.

import { useEffect, useState } from 'react'
import { parseAbi, type Address } from 'viem'
import { client } from '../api/launchpad'

export const SWAP_ROUTER_ADDRESS = String(import.meta.env.VITE_ARCDEX_SWAP_ROUTER_ADDRESS ?? '').trim() as Address
export const routerConfigured = /^0x[0-9a-fA-F]{40}$/.test(SWAP_ROUTER_ADDRESS)

export interface RouterInfo {
  version: 1 | 2
  feeBps: number
  referralShareBps: number // 0 on v1
}

const ABI = parseAbi([
  'function VERSION() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function referralShareBps() view returns (uint256)',
])

let cached: Promise<RouterInfo | null> | null = null

export function loadRouterInfo(): Promise<RouterInfo | null> {
  if (!routerConfigured) return Promise.resolve(null)
  if (!cached) {
    cached = (async () => {
      const feeBps = Number(await client.readContract({ address: SWAP_ROUTER_ADDRESS, abi: ABI, functionName: 'feeBps' }))
      // v1 has no VERSION()/referralShareBps() — the call reverts.
      const v2 = await client.readContract({ address: SWAP_ROUTER_ADDRESS, abi: ABI, functionName: 'VERSION' }).then(v => v >= 2n).catch(() => false)
      const referralShareBps = v2 ? Number(await client.readContract({ address: SWAP_ROUTER_ADDRESS, abi: ABI, functionName: 'referralShareBps' })) : 0
      return { version: v2 ? 2 : 1, feeBps, referralShareBps } as RouterInfo
    })().catch(() => { cached = null; return null })
  }
  return cached
}

export function useRouterInfo(): RouterInfo | null {
  const [info, setInfo] = useState<RouterInfo | null>(null)
  useEffect(() => { void loadRouterInfo().then(setInfo) }, [])
  return info
}

export const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
