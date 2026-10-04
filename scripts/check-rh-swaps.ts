// Live check of api/rhSwaps.ts against GeckoTerminal on Robinhood Chain's busiest pools:
// the chain's swaps (read the way the coin page reads them) must be GeckoTerminal's trades,
// with the same side, coin amount and dollar value. Nothing is sent.
//   bun scripts/check-rh-swaps.ts

import { loadRhSwaps, rhEthUsd, rhQuoteUsd, rhDecimals, watchRhSwaps, type RhPoolMeta } from '../src/arcdex/api/rhSwaps'
import { NATIVE, USDG, WETH } from '../src/arcdex/lib/robinhood'

const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood'
const get = async (path: string) => { const r = await fetch(GT + path, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json() as Promise<any> }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const id = (s: string) => s.replace(/^robinhood_/, '').toLowerCase()
let failed = 0
const check = (ok: boolean, what: string) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed++ }

const eth = await rhEthUsd()
check(!!eth && eth > 500 && eth < 20_000, `ETH from the WETH/USDG pool: $${eth?.toFixed(2)}`)

const pools = (await get('/pools?page=1&include=base_token,quote_token')).data as any[]
// One v4 pool and one v3 pool, each quoted in USDG, WETH or ETH, with trades.
const pick = (v4: boolean) => pools.find(p => (p.attributes.address.length === 66) === v4
  && [USDG, WETH, NATIVE].includes(id(p.relationships.quote_token.data.id)) && ![USDG, WETH, NATIVE].includes(id(p.relationships.base_token.data.id)))
for (const p of [pick(true), pick(false)].filter(Boolean)) {
  const coin = id(p.relationships.base_token.data.id), quote = id(p.relationships.quote_token.data.id)
  const coinDecimals = await rhDecimals(coin), quoteDecimals = await rhDecimals(quote)
  const meta: RhPoolMeta = { pool: p.attributes.address.toLowerCase(), coin, quote, coinDecimals: coinDecimals!, quoteDecimals: quoteDecimals! }
  console.log(`\n${p.attributes.name} (${meta.pool.length === 66 ? 'v4' : 'v2/v3'}) ${meta.pool}`)
  const t0 = Date.now()
  const { swaps, head } = await loadRhSwaps(meta)
  check(swaps.length > 0, `${swaps.length} swaps from the chain in ${Date.now() - t0} ms (head ${head})`)
  await sleep(2_100)
  const trades = (await get(`/pools/${meta.pool}/trades`)).data as any[]
  const qUsd = (await rhQuoteUsd(quote))!
  const byTx = new Map(swaps.map(s => [s.txHash, s]))
  const oldest = swaps.length ? swaps[swaps.length - 1].time : Infinity
  const inWindow = trades.filter(t => Date.parse(t.attributes.block_timestamp) > oldest + 60_000)
  let matched = 0, sideOk = 0, amountOk = 0, usdOk = 0, timeOk = 0
  for (const t of inWindow) {
    const a = t.attributes
    const s = byTx.get(a.tx_hash.toLowerCase())
    if (!s) continue
    matched++
    const bought = (a.to_token_address ?? '').toLowerCase() === coin
    if ((s.kind === 'buy') === bought) sideOk++
    const amt = Number(bought ? a.to_token_amount : a.from_token_amount)
    if (Math.abs(s.tokenAmount - amt) / amt < 0.001) amountOk++
    const usd = Number(a.volume_in_usd)
    if (usd > 0.5 && Math.abs(s.quoteAmount * qUsd - usd) / usd < 0.05) usdOk++
    else if (usd <= 0.5) usdOk++
    if (Math.abs(s.time - Date.parse(a.block_timestamp)) < 20_000) timeOk++
  }
  check(inWindow.length > 0 && matched >= inWindow.length * 0.95, `GeckoTerminal's trades in the window found on the chain: ${matched} of ${inWindow.length}`)
  check(sideOk === matched, `buy or sell the same: ${sideOk} of ${matched}`)
  check(amountOk === matched, `coin amount the same: ${amountOk} of ${matched}`)
  check(usdOk >= matched * 0.95, `dollar value within 5%: ${usdOk} of ${matched}`)
  check(timeOk >= matched * 0.95, `time within 20 s: ${timeOk} of ${matched}`)

  // New swaps as they land, for up to 40 s.
  const seenAt: number[] = []
  // The first poll catches up on swaps since `head` (this check waited on GeckoTerminal meanwhile): not counted.
  const watchFrom = Date.now()
  const stop = watchRhSwaps(meta, head, swaps.map(s => s.id), fresh => { if (Date.now() - watchFrom > 2_000) for (const s of fresh) seenAt.push(Date.now() - s.time) })
  for (let i = 0; i < 40 && seenAt.length < 3; i++) await sleep(1_000)
  stop()
  // A swap's time is counted back from the head block as it arrived (rhSwaps.ts), so this is how long after its block it showed.
  const avg = seenAt.length ? Math.round(seenAt.reduce((a, b) => a + b, 0) / seenAt.length) : 0
  if (seenAt.length) check(avg < 1_500, `${seenAt.length} new swaps live, ${avg} ms after their block on average`)
  else console.log('· no new swap in 40 s (a quiet pool)')
  await sleep(2_100)
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
