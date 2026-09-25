// Pool registry: for every pool that swaps, which token is the base, which
// is the quote, and their decimals — resolved once, then cached.
//
// ── Blockchain specifics ────────────────────────────────────────────────
// v4 pools are learned from PoolManager `Initialize` events as they happen.
// Older ones are resolved through the v4 PositionManager's
// poolKeys(bytes25) (every Argus launch mints its liquidity through it) and
// checked: keccak256(abi.encode(PoolKey)) must equal the PoolId, so a
// wrong key can never be attached to a pool.
// v3 pools: token0()/token1()/fee() on the pool, then the Uniswap v3
// factory's getPool(token0, token1, fee) must return that same address —
// any contract can emit a Swap-shaped event, only factory pools count.
// A pair is only tracked when one side is a known quote (USDC — ERC-20 or
// native —, EURC, WETH, ARGUS): that's what makes a USD price possible.

import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { ARGUS, NATIVE, POOL_MANAGER, POSITION_MANAGER, QUOTE_PRIORITY, USDC, V3_FACTORY, V4_INITIALIZE, topicAddress, word, type SwapLogLike } from '../../../api/_arcSwaps'
import type { Rpc } from '../chain/http'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'

export interface PoolInfo {
  pool: string
  dex: 'uniswap-v4' | 'uniswap-v3'
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number | null
  hooks: string | null
  base: string
  quote: string
  baseIs0: boolean
  baseDecimals: number
  quoteDecimals: number
  /** Initial pool price (quote per base), when known from Initialize. */
  initialPrice?: number | null
}

const PM_ABI = parseAbi(['function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'])
const V3_ABI = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)'])
const FACTORY_ABI = parseAbi(['function getPool(address, address, uint24) view returns (address)'])
const ERC20_DECIMALS = '0x313ce567'

export type FindInitialize = (poolId: string) => Promise<SwapLogLike | null>

/** Base and quote of a pair, or null if neither side is a known quote. */
export function pickQuote(c0: string, c1: string): { base: string; quote: string } | null {
  const r0 = QUOTE_PRIORITY.indexOf(c0), r1 = QUOTE_PRIORITY.indexOf(c1)
  if (r0 < 0 && r1 < 0) return null
  if (r1 >= 0 && (r0 < 0 || r1 < r0)) return { base: c0, quote: c1 }
  return { base: c1, quote: c0 }
}

export class PoolRegistry {
  private pools = new Map<string, PoolInfo>()
  private misses = new Map<string, number>() // pool → when it failed to resolve
  private inflight = new Map<string, Promise<PoolInfo | null>>()
  private decimals = new Map<string, number>([[NATIVE, 18], [USDC, 6], [ARGUS, 18]])

  constructor(
    private rpc: Rpc,
    private opts: { onNewPool?: (p: PoolInfo) => void; findInitialize?: FindInitialize } = {},
  ) {}

  get(pool: string) { return this.pools.get(pool.toLowerCase()) }
  get size() { return this.pools.size }
  all() { return [...this.pools.values()] }

  /** Warm start from Redis/DB. */
  seed(list: PoolInfo[]) { for (const p of list) this.pools.set(p.pool, p) }

  /** A PoolManager Initialize log → a registered pool (or null if it can't be priced). */
  async fromInitialize(l: SwapLogLike): Promise<PoolInfo | null> {
    if (l.address.toLowerCase() !== POOL_MANAGER || l.topics[0] !== V4_INITIALIZE || l.topics.length < 4) return null
    const pool = l.topics[1].toLowerCase()
    const c0 = topicAddress(l.topics[2]), c1 = topicAddress(l.topics[3])
    const fee = Number(BigInt('0x' + word(l.data, 0)))
    const tickSpacing = Number(BigInt.asIntN(24, BigInt('0x' + word(l.data, 1))))
    const hooks = ('0x' + word(l.data, 2).slice(24)).toLowerCase()
    const sqrtPriceX96 = BigInt('0x' + word(l.data, 3))
    return this.register({ pool, dex: 'uniswap-v4', c0, c1, fee, tickSpacing, hooks, sqrtPriceX96 })
  }

  private async register(p: { pool: string; dex: PoolInfo['dex']; c0: string; c1: string; fee: number; tickSpacing: number | null; hooks: string | null; sqrtPriceX96?: bigint }): Promise<PoolInfo | null> {
    const existing = this.pools.get(p.pool)
    if (existing) return existing
    const q = pickQuote(p.c0, p.c1)
    if (!q) { this.misses.set(p.pool, Date.now()); metrics.inc('pools_unpriceable'); return null }
    const [d0, d1] = await Promise.all([this.tokenDecimals(p.c0), this.tokenDecimals(p.c1)])
    if (d0 === null || d1 === null) { this.misses.set(p.pool, Date.now()); return null }
    const baseIs0 = q.base === p.c0
    const info: PoolInfo = {
      pool: p.pool, dex: p.dex, currency0: p.c0, currency1: p.c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks,
      base: q.base, quote: q.quote, baseIs0, baseDecimals: baseIs0 ? d0 : d1, quoteDecimals: baseIs0 ? d1 : d0,
      initialPrice: null,
    }
    if (p.sqrtPriceX96) {
      const s = Number(p.sqrtPriceX96) / 2 ** 96, raw = s * s, scale = 10 ** (info.baseDecimals - info.quoteDecimals)
      info.initialPrice = baseIs0 ? raw * scale : raw > 0 ? scale / raw : null
    }
    this.pools.set(p.pool, info)
    metrics.set('pools_known', this.pools.size)
    this.opts.onNewPool?.(info)
    return info
  }

  /** The pool a Swap log came from, resolving it on first sight. */
  resolve(pool: string): Promise<PoolInfo | null> {
    const key = pool.toLowerCase()
    const hit = this.pools.get(key)
    if (hit) return Promise.resolve(hit)
    const missAt = this.misses.get(key)
    if (missAt && Date.now() - missAt < 3_600_000) return Promise.resolve(null)
    let p = this.inflight.get(key)
    if (!p) {
      p = (key.length === 66 ? this.resolveV4(key) : this.resolveV3(key))
        .catch(e => { log.debug('pool resolve failed', { pool: key, error: errMsg(e) }); return null })
        .then(r => { if (!r) this.misses.set(key, Date.now()); return r })
        .finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
  }

  private async resolveV4(poolId: string): Promise<PoolInfo | null> {
    const data = encodeFunctionData({ abi: PM_ABI, functionName: 'poolKeys', args: [poolId.slice(0, 52) as `0x${string}`] })
    const raw = await this.rpc.call<`0x${string}`>('eth_call', [{ to: POSITION_MANAGER, data }, 'latest'])
    const [c0, c1, fee, tickSpacing, hooks] = decodeFunctionResult({ abi: PM_ABI, functionName: 'poolKeys', data: raw })
    const id = keccak256(encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [c0, c1, fee, tickSpacing, hooks],
    ))
    if (id.toLowerCase() === poolId) {
      return this.register({ pool: poolId, dex: 'uniswap-v4', c0: c0.toLowerCase(), c1: c1.toLowerCase(), fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: hooks.toLowerCase() })
    }
    // Not minted through the PositionManager: look for its Initialize log.
    const init = await this.opts.findInitialize?.(poolId)
    return init ? this.fromInitialize(init) : null
  }

  private async resolveV3(pool: string): Promise<PoolInfo | null> {
    const call = (fn: 'token0' | 'token1' | 'fee') => ({ method: 'eth_call', params: [{ to: pool, data: encodeFunctionData({ abi: V3_ABI, functionName: fn }) }, 'latest'] })
    const [r0, r1, rf] = await this.rpc.batch<`0x${string}`>([call('token0'), call('token1'), call('fee')])
    if (!r0 || !r1 || !rf || r0 === '0x' || r1 === '0x') return null
    const t0 = decodeFunctionResult({ abi: V3_ABI, functionName: 'token0', data: r0 }).toLowerCase()
    const t1 = decodeFunctionResult({ abi: V3_ABI, functionName: 'token1', data: r1 }).toLowerCase()
    const fee = decodeFunctionResult({ abi: V3_ABI, functionName: 'fee', data: rf })
    const check = await this.rpc.call<`0x${string}`>('eth_call', [{ to: V3_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'getPool', args: [t0 as `0x${string}`, t1 as `0x${string}`, fee] }) }, 'latest'])
    const real = decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'getPool', data: check }).toLowerCase()
    if (real !== pool) { metrics.inc('pools_rejected_not_factory'); return null }
    return this.register({ pool, dex: 'uniswap-v3', c0: t0, c1: t1, fee: Number(fee), tickSpacing: null, hooks: null })
  }

  /** decimals() of a token (cached; null if it doesn't answer sensibly). */
  async tokenDecimals(token: string): Promise<number | null> {
    const t = token.toLowerCase()
    const hit = this.decimals.get(t)
    if (hit !== undefined) return hit
    try {
      const r = await this.rpc.call<string>('eth_call', [{ to: t, data: ERC20_DECIMALS }, 'latest'])
      const d = r && r !== '0x' ? Number(BigInt(r)) : NaN
      if (!Number.isInteger(d) || d < 0 || d > 36) return null
      this.decimals.set(t, d)
      return d
    } catch { return null }
  }
}
