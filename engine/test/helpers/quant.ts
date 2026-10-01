// Synthetic trades and launches for the signal engine's tests (engine/src/quant).
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'

export const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
export const TOKEN = '0x' + 'c0'.repeat(20)
export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0)

export function launch(o: Partial<LaunchInfo> = {}): LaunchInfo {
  return { token: TOKEN, name: 'Coin', symbol: 'COIN', decimals: 18, creator: A(0xc4ea), txHash: '0x1', blockNumber: 1_000, timestamp: T0, pool: 'pool', quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE', ...o }
}

let seq = 0
/** A trade: `price` in USD, `usd` traded, `liquidity` the pool's depth after it. */
export function trade(o: { token?: string; side?: 'BUY' | 'SELL'; usd?: number; price: number; at: number; wallet?: string | null; liquidity?: number | null; pool?: string; id?: string; block?: number; log?: number }): Trade {
  seq++
  const usd = o.usd ?? 50
  return {
    tradeId: o.id ?? `0x${seq.toString(16)}:0`, chain: 'ARC', token: o.token ?? TOKEN, pair: 'COIN/USDC', pool: o.pool ?? 'pool', quote: '0x3600000000000000000000000000000000000000',
    side: o.side ?? 'BUY', baseAmount: usd / o.price, quoteAmount: usd, tokenAmount: usd / o.price, price: o.price, priceUsd: o.price, usdValue: usd,
    wallet: o.wallet === undefined ? A(10_000 + seq) : o.wallet, txHash: `0x${seq.toString(16)}`, blockNumber: o.block ?? 1_000 + seq, logIndex: o.log ?? 0,
    timestamp: o.at, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: o.liquidity === undefined ? 20_000 : o.liquidity,
  }
}

/** `n` buys by distinct wallets from `from`, `gap` ms apart, the price rising by `step` each. */
export function crowd(n: number, o: { from: number; price: number; step?: number; usd?: number; gap?: number; wallet0?: number; liquidity?: number; token?: string }): Trade[] {
  return Array.from({ length: n }, (_, i) => trade({ token: o.token, price: o.price * (1 + (o.step ?? 0.002)) ** i, usd: o.usd ?? 40, at: o.from + i * (o.gap ?? 1_000), wallet: A((o.wallet0 ?? 50_000) + i), liquidity: o.liquidity ?? 20_000 }))
}
