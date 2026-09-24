// Which Argus launches have graduated ("bonded") vs are still on their
// launch curve — for the fomo-style Graduated / Bonding lists. Server-only
// (underscore = not a route). Two multicalls for the whole market list:
// 1) launches(token) on all 8 Portals, 2) bonded() on each launch's hook.
// A token has a record in exactly one Portal; per-Portal ABIs decode it.

import { createPublicClient, http, parseAbi, type Address } from 'viem'

const client = createPublicClient({ transport: http('https://rpc.mainnet.arc.io', { retryCount: 2, timeout: 8_000 }) })
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address
const ZERO = '0x0000000000000000000000000000000000000000'

const LEGACY = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, int24 tickBond, bool tokenIsToken0, bool bonded, address pool, address processor, address tracker, address locker, uint256 positionId)'])
const H9 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId)'])
const H10 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond)'])
const H11 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)'])
const P8 = parseAbi(['function launches(address) view returns (address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond, bool tokenIsToken0)'])
const HOOK = parseAbi(['function bonded() view returns (bool)'])

const PORTALS = [
  { address: '0x0F1C7Cb26D6cD36BD4189E41947658b39437587A' as Address, abi: LEGACY, kind: 'legacy' },
  { address: '0xBed9880A0ba12722ba4b8791c0B6F8c74338246C' as Address, abi: LEGACY, kind: 'legacy' },
  { address: '0x7A17Ab0106C46C0be30623F3EB7F299CC0058338' as Address, abi: H9, kind: 'hooked' },
  { address: '0xa36c443A797771Df82533B8B4A86F0AFfd970862' as Address, abi: H10, kind: 'hooked' },
  { address: '0x07a688a001f416cC433c68Ff56Aa26bC5131Cc6E' as Address, abi: H10, kind: 'hooked' },
  { address: '0xA5628A11c412596E1f63b75a2C0284F843C549d6' as Address, abi: H11, kind: 'hooked' },
  { address: '0xB021Be536808f551b31789422Fd28a6c9c6e97Da' as Address, abi: H11, kind: 'hooked' },
  { address: '0xeed7559B8A6ABf64427dc41Cb5cc6400109C5D93' as Address, abi: P8, kind: 'portal8' },
] as const

/** token (lowercase) → bonded flag; tokens that aren't Argus launches are absent. */
export async function bondedFlags(tokens: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (tokens.length === 0) return out
  const calls = tokens.flatMap(t => PORTALS.map(p => ({ address: p.address, abi: p.abi, functionName: 'launches' as const, args: [t as Address] })))
  type R = { status: 'success' | 'failure'; result?: unknown }
  const res = (await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: calls as never, batchSize: 0 })) as R[]

  const needHook: { token: string; hook: Address }[] = []
  tokens.forEach((t, ti) => {
    for (let pi = 0; pi < PORTALS.length; pi++) {
      const r = res[ti * PORTALS.length + pi]
      if (r.status !== 'success') continue
      const rec = r.result as readonly unknown[]
      const p = PORTALS[pi]
      if (p.kind === 'legacy') { if (rec[0] !== ZERO) { out.set(t, rec[4] as boolean); return } }
      else if (p.kind === 'hooked') { if (rec[0] !== ZERO) { needHook.push({ token: t, hook: rec[4] as Address }); return } }
      else if (rec[0] !== ZERO) { needHook.push({ token: t, hook: rec[0] as Address }); return }
    }
  })

  if (needHook.length) {
    const hooks = (await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0,
      contracts: needHook.map(h => ({ address: h.hook, abi: HOOK, functionName: 'bonded' as const })) as never,
    })) as R[]
    needHook.forEach((h, i) => { if (hooks[i].status === 'success') out.set(h.token, hooks[i].result as boolean) })
  }
  return out
}
