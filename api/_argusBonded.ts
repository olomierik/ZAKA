// Which Argus launches have graduated ("bonded") vs are still on their
// launch curve, and how far along it they are — for the Graduated / Bonding
// lists and the coin board's Near bond column. Server-only (underscore = not
// a route). Three multicalls for the whole market list: 1) launches(token) on
// all 8 Portals, 2) bonded() and poolId() on each launch's hook, 3) the
// launch pool's current tick for the coins still bonding. A token has a record
// in exactly one Portal; per-Portal ABIs decode it. Progress is how far the
// pool's tick has moved from the launch's start tick to its bond tick, as the
// on-chain reader (src/arcdex/api/argus.ts) works it out.

import { createPublicClient, http, parseAbi, type Address } from 'viem'

const client = createPublicClient({ transport: http('https://rpc.mainnet.arc.io', { retryCount: 2, timeout: 8_000 }) })
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address
const ZERO = '0x0000000000000000000000000000000000000000'

const LEGACY = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, int24 tickBond, bool tokenIsToken0, bool bonded, address pool, address processor, address tracker, address locker, uint256 positionId)'])
const H9 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId)'])
const H10 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond)'])
const H11 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)'])
const P8 = parseAbi(['function launches(address) view returns (address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond, bool tokenIsToken0)'])
const HOOK = parseAbi(['function bonded() view returns (bool)', 'function poolId() view returns (bytes32)'])
/** v4's StateView on Arc: a pool's price and tick by pool id. */
const STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as Address
const SV = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'])
const V3 = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'])

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

export interface LaunchStatus {
  bonded: boolean
  /** 0–100 along the launch curve (null when the launch has no bond tick, or its pool couldn't be read); 100 once bonded. */
  progress: number | null
}

/** Each hook's pool id (it never changes), so it's read once. */
const poolIds = new Map<string, `0x${string}`>()

/** Progress from the start tick to the bond tick, clamped for display (a tick retreat doesn't clear bonded). */
export function progressOf(tick: number, tickStart: number, tickBond: number): number | null {
  const span = tickBond - tickStart
  if (span === 0) return null
  return Math.max(0, Math.min(100, ((tick - tickStart) / span) * 100))
}

type R = { status: 'success' | 'failure'; result?: unknown }
interface Rec { token: string; kind: 'legacy' | 'hooked' | 'portal8'; bonded: boolean | null; hook: Address | null; pool: Address | null; tickStart: number; tickBond: number | null }

/** token (lowercase) → whether it graduated and how far along its curve it is; tokens that aren't Argus launches are absent. */
export async function launchStatus(tokens: string[]): Promise<Map<string, LaunchStatus>> {
  const out = new Map<string, LaunchStatus>()
  if (tokens.length === 0) return out
  const calls = tokens.flatMap(t => PORTALS.map(p => ({ address: p.address, abi: p.abi, functionName: 'launches' as const, args: [t as Address] })))
  const res = (await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: calls as never, batchSize: 0 })) as R[]

  const recs: Rec[] = []
  tokens.forEach((t, ti) => {
    for (let pi = 0; pi < PORTALS.length; pi++) {
      const r = res[ti * PORTALS.length + pi]
      if (r.status !== 'success') continue
      const rec = r.result as readonly unknown[]
      const p = PORTALS[pi]
      if (p.kind === 'legacy') {
        // (creator, tickStart, tickBond, tokenIsToken0, bonded, pool, …)
        if (rec[0] !== ZERO) { recs.push({ token: t, kind: 'legacy', bonded: rec[4] as boolean, hook: null, pool: rec[5] as Address, tickStart: Number(rec[1]), tickBond: Number(rec[2]) }); return }
      } else if (p.kind === 'hooked') {
        // (creator, tickStart, tokenIsToken0, locker, hook, splitter, buyTax, sellTax, positionId[, tickBond[, quoteAsset]])
        if (rec[0] !== ZERO) { recs.push({ token: t, kind: 'hooked', bonded: null, hook: rec[4] as Address, pool: null, tickStart: Number(rec[1]), tickBond: rec.length > 9 ? Number(rec[9]) : null }); return }
      } else if (rec[0] !== ZERO) {
        // Portal 8: (hook, escrow, locker, positionId, tickStart, tickBond, tokenIsToken0)
        recs.push({ token: t, kind: 'portal8', bonded: null, hook: rec[0] as Address, pool: null, tickStart: Number(rec[4]), tickBond: Number(rec[5]) }); return
      }
    }
  })

  // Hooked launches: bonded() on the hook, and the hook's pool id the first time it's seen.
  const hooked = recs.filter(r => r.hook)
  const needId = hooked.filter(r => !poolIds.has(r.hook!.toLowerCase()))
  if (hooked.length) {
    const res2 = (await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0,
      contracts: [
        ...hooked.map(h => ({ address: h.hook!, abi: HOOK, functionName: 'bonded' as const })),
        ...needId.map(h => ({ address: h.hook!, abi: HOOK, functionName: 'poolId' as const })),
      ] as never,
    })) as R[]
    hooked.forEach((h, i) => { if (res2[i].status === 'success') h.bonded = res2[i].result as boolean })
    needId.forEach((h, i) => { const r = res2[hooked.length + i]; if (r.status === 'success') poolIds.set(h.hook!.toLowerCase(), r.result as `0x${string}`) })
  }

  // The pool's tick, for the launches still bonding.
  const bonding = recs.filter(r => r.bonded === false && r.tickBond !== null && (r.pool || (r.hook && poolIds.has(r.hook.toLowerCase()))))
  const ticks = new Map<string, number>()
  if (bonding.length) {
    const res3 = (await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0,
      contracts: bonding.map(b => (b.pool
        ? { address: b.pool, abi: V3, functionName: 'slot0' as const }
        : { address: STATE_VIEW, abi: SV, functionName: 'getSlot0' as const, args: [poolIds.get(b.hook!.toLowerCase())!] })) as never,
    })) as R[]
    bonding.forEach((b, i) => { if (res3[i].status === 'success') ticks.set(b.token, Number((res3[i].result as readonly unknown[])[1])) })
  }

  for (const r of recs) {
    if (r.bonded === null) continue
    const tick = ticks.get(r.token)
    out.set(r.token, { bonded: r.bonded, progress: r.bonded ? 100 : tick === undefined || r.tickBond === null ? null : progressOf(tick, r.tickStart, r.tickBond) })
  }
  return out
}

/** token (lowercase) → bonded flag; tokens that aren't Argus launches are absent. */
export async function bondedFlags(tokens: string[]): Promise<Map<string, boolean>> {
  return new Map([...(await launchStatus(tokens))].map(([t, s]) => [t, s.bonded]))
}
