// ArcLaunchpad index (api/_launchpadCore.ts, api/launchpad.ts).
//   bun scripts/test-launchpad-index.ts
// Decoding and metadata safety offline, then the endpoint end to end against
// Arc mainnet with Supabase writes off (no keys, nothing stored).
process.env.SUPABASE_SECRET_KEY = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''
import { keccak256, toHex } from 'viem'
import { CURVE_TRADE, TOKEN_LAUNCHED, decodeTrade, resolveMeta, sanitizeMeta, safeUrl, statsOf, priceAfter, type TradeRow } from '../api/_launchpadCore'

let fails = 0
const check = (ok: boolean, msg: string, detail = '') => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg, ok ? '' : detail) }

console.log('event topics')
check(TOKEN_LAUNCHED === keccak256(toHex('TokenLaunched(address,address,string,string,string,uint256)')), 'TokenLaunched')
check(CURVE_TRADE === keccak256(toHex('Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)')), 'Trade')

console.log('metadata safety')
check(safeUrl('javascript:alert(1)') === undefined, 'javascript: URLs are dropped')
check(safeUrl('http://example.com/a.png') === undefined, 'plain http is dropped')
check(safeUrl('ipfs://bafyabc/logo.png') === 'https://ipfs.io/ipfs/bafyabc/logo.png', 'ipfs:// goes through a gateway')
const m = sanitizeMeta({ image: 'https://x.io/a.png', twitter: '@moon_coin', telegram: 'not a handle!', website: 'data:text/html,<script>', description: 'hi‮evil\u0007', extra: 'ignored' })
check(m?.image === 'https://x.io/a.png' && m?.twitter === '@moon_coin' && m?.telegram === undefined && m?.website === undefined, 'keeps https/handles, drops the rest', JSON.stringify(m))
check(m?.description === 'hievil', 'strips bidi overrides and control characters', JSON.stringify(m?.description))
check(sanitizeMeta({ nothing: 1 }) === null, 'metadata with nothing usable is null')
const inline = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify({ image: 'https://x.io/ü.png', description: 'Ünïcode ✓' }))))
const r1 = await resolveMeta(inline)
check(r1?.description === 'Ünïcode ✓' && r1?.image === 'https://x.io/ü.png', 'inline base64 metadata (UTF-8)', JSON.stringify(r1))
const hosted = await resolveMeta('https://meta.example/coin.json', (async () => new Response(JSON.stringify({ image: 'https://cdn.example/c.png' }))) as unknown as typeof fetch)
check(hosted?.image === 'https://cdn.example/c.png', 'hosted metadata')
const huge = await resolveMeta('https://meta.example/big.json', (async () => new Response('x'.repeat(70_000))) as unknown as typeof fetch)
check(huge === null, 'oversized metadata is refused')
check(await resolveMeta('http://insecure.example/m.json') === null, 'non-https metadata URLs are not fetched')

console.log('trades')
const row = (isBuy: 0 | 1, usdc: number, ts: number, trader = '0xaa'): TradeRow => ['0xt', trader, isBuy, String(usdc * 1e6), '1000', '0', String(1_000 * 1e6), String(700_000_000n * 10n ** 18n), 1, ts, '0xtx', 0]
const now = 1_790_000_000
const s = statsOf([row(1, 10, now - 90_000), row(1, 5, now - 60, '0xbb'), row(0, 2, now - 30)], now)
check(s.vol24 === 7 && s.buys24 === 1 && s.sells24 === 1 && s.trades === 3 && s.traders === 2, '24h volume, buys, sells, traders', JSON.stringify(s))
check(Math.abs(priceAfter(row(1, 1, now)) - (9_000 / 900_000_000)) < 1e-12, 'curve price from real reserves')
check(decodeTrade({ address: '0x', topics: [CURVE_TRADE], data: '0x', blockNumber: '0x1', transactionHash: '0x', logIndex: '0x0' }) === null, 'malformed Trade logs are ignored')

console.log('endpoint (live, Arc mainnet)')
const { default: handler } = await import('../api/launchpad')
const t0 = Date.now()
const res = await handler(new Request('https://arcdex.online/api/launchpad'))
const body = await res.json() as { complete: boolean; launches: { token: string; symbol: string; name: string; creator: string; meta: { image?: string } | null; stats: { trades: number } }[] }
console.log(`  (${Date.now() - t0}ms, ${body.launches?.length} launches)`)
check(res.status === 200 && body.complete, 'indexes the launchpad from its deploy block to the head', `status ${res.status}`)
const stc = body.launches?.find(l => l.symbol === 'STC')
check(!!stc && stc.name === 'SUITCAT' && /^0x[0-9a-f]{40}$/.test(stc.creator), 'finds STC (SUITCAT) with its creator', JSON.stringify(stc)?.slice(0, 200))
check(!!stc?.meta?.image?.startsWith('https://'), 'resolves its image from the inline metadata', JSON.stringify(stc?.meta))
const t1 = Date.now()
const again = await handler(new Request(`https://arcdex.online/api/launchpad?token=${stc?.token}`))
const b2 = await again.json() as { trades: TradeRow[] }
check(again.status === 200 && Array.isArray(b2.trades) && Date.now() - t1 < 5_000, `a second request only scans new blocks (${Date.now() - t1}ms) and returns the coin's trades (${b2.trades?.length})`)
check((b2.trades ?? []).length === stc?.stats.trades, 'trade list matches the coin\'s stats')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
