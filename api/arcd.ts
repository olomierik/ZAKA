// GET /api/arcd — everything the landing page and burn dashboard show
// about $ARCD, ARCDEX's official coin, in one CDN-cached response:
//   market   price, FDV, liquidity, volume, 24h change (GeckoTerminal)
//   burned   $ARCD held by the burn address 0x…dEaD (gone forever)
//   feeWallet  USDC waiting to buy back + $ARCD bought but not yet burned
//   burns    recent transfers into the burn address (Arc RPC logs)
//   fees     swap-router fees generated / paid to referrers (Supabase)
// Every number is public and verifiable on-chain; this just gathers them.

import { GT_BASE, gtHeaders } from './_geckoterminal'
import { adminReady, db } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
const POOL = '0x87b65f8831a8f3ba17da44003fae5294476b9a5c7ac5da53485a44dd12af9897'
const FEE_WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const DEAD = '0x000000000000000000000000000000000000dead'
const USDC = '0x3600000000000000000000000000000000000000'
const RPC = 'https://rpc.mainnet.arc.io'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SPAN = 9_000       // Arc RPC's max getLogs range
const SPANS = 40         // ~2 days of blocks for the recent-burns list
const SUPPLY = 1_000_000_000

const pad = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json() as { result?: T; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result as T
}
async function balanceOf(token: string, who: string, decimals: number): Promise<number> {
  const hex = await rpc<string>('eth_call', [{ to: token, data: '0x70a08231' + pad(who).slice(2) }, 'latest'])
  return Number(BigInt(hex)) / 10 ** decimals
}

interface Burn { tx: string; from: string; amount: number; time: number | null; block: number }
async function recentBurns(): Promise<Burn[]> {
  const latest = Number(BigInt(await rpc<string>('eth_blockNumber', [])))
  const spans = Array.from({ length: SPANS }, (_, i) => [Math.max(0, latest - (i + 1) * SPAN + 1), latest - i * SPAN] as const)
  const out: Burn[] = []
  for (let i = 0; i < spans.length; i += 10) {
    const batch = await Promise.all(spans.slice(i, i + 10).map(([from, to]) =>
      rpc<{ transactionHash: string; topics: string[]; data: string; blockNumber: string; blockTimestamp?: string }[]>('eth_getLogs', [{
        address: ARCD, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER, null, pad(DEAD)],
      }]).catch(() => [])))
    for (const l of batch.flat()) {
      out.push({
        tx: l.transactionHash,
        from: '0x' + l.topics[1].slice(26),
        amount: Number(BigInt(l.data)) / 1e18,
        time: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) * 1000 : null,
        block: Number(BigInt(l.blockNumber)),
      })
    }
  }
  return out.filter(b => b.amount >= 0.000001).sort((a, b) => b.block - a.block).slice(0, 50)
}

async function market() {
  const r = await fetch(`${GT_BASE}/networks/arc/pools/${POOL}?include=base_token`, { headers: gtHeaders() })
  if (!r.ok) throw new Error('gecko ' + r.status)
  const j = await r.json() as { data: { attributes: Record<string, unknown> }; included?: { attributes: Record<string, unknown> }[] }
  const a = j.data.attributes
  const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
  const img = j.included?.[0]?.attributes?.image_url as string | undefined
  return {
    priceUsd: num(a.base_token_price_usd),
    fdvUsd: num(a.fdv_usd),
    liquidityUsd: num(a.reserve_in_usd),
    volume24h: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
    change24h: num((a.price_change_percentage as Record<string, unknown> | undefined)?.h24),
    image: img && !img.includes('missing') ? img : null,
  }
}

async function fees() {
  if (!adminReady) return null
  const rows = await db<{ fees_usdc: number; fees_24h: number; referral_paid: number; trades: number; traders: number }[]>('rpc/arcdex_fee_stats', { method: 'POST', body: {} })
  const r = rows[0]
  return r ? { feesUsdc: Number(r.fees_usdc), fees24h: Number(r.fees_24h), referralPaid: Number(r.referral_paid), trades: Number(r.trades), traders: Number(r.traders) } : null
}

export default async function handler(): Promise<Response> {
  const [m, dead, walletUsdc, walletArcd, burns, f] = await Promise.allSettled([
    market(), balanceOf(ARCD, DEAD, 18), balanceOf(USDC, FEE_WALLET, 6), balanceOf(ARCD, FEE_WALLET, 18), recentBurns(), fees(),
  ])
  const val = <T>(p: PromiseSettledResult<T>) => (p.status === 'fulfilled' ? p.value : null)
  const burned = val(dead)
  const body = {
    token: { address: ARCD, symbol: 'ARCD', name: 'ARCDEX', supply: SUPPLY, decimals: 18, pool: POOL },
    market: val(m),
    burned,
    burnedPct: burned === null ? null : (burned / SUPPLY) * 100,
    burnAddress: DEAD,
    feeWallet: { address: FEE_WALLET, usdc: val(walletUsdc), arcd: val(walletArcd) },
    burns: val(burns) ?? [],
    fees: val(f),
    updatedAt: Date.now(),
  }
  const partial = [m, dead, walletUsdc, walletArcd, burns].some(p => p.status === 'rejected')
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': partial ? 's-maxage=15' : 's-maxage=60, stale-while-revalidate=300',
    },
  })
}
