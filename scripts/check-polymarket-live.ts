// Checks live Polymarket trading end to end with a throwaway, never-funded key: nothing can fill.
// Signs in to Polymarket's CLOB as an EOA (the L1 signature makes the API credentials), reads the pUSD balance and the
// trading approvals, then places a $1 fill-and-kill buy on the live BTC 5-minute window. Polymarket must refuse it for
// want of balance or allowance; that proves the order was built, signed and read as this wallet's.
// Run: bun scripts/check-polymarket-live.ts   (from a country Polymarket doesn't block; it checks first)
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http } from 'viem'
import { polygon } from 'viem/chains'
import { AssetType, createSecureClient, OrderSide, OrderType } from '@polymarket/client'
import { fetchBalanceAllowance } from '@polymarket/client/actions'
import { signerFrom } from '@polymarket/client/viem'

const geo = await (await fetch('https://polymarket.com/api/geoblock')).json() as { blocked: boolean; country: string }
console.log('geoblock', geo)
if (geo.blocked) { console.log('Polymarket blocks orders from here; run it from an allowed country'); process.exit(1) }

const account = privateKeyToAccount(generatePrivateKey())
const wallet = createWalletClient({ account, chain: polygon, transport: http('https://polygon-bor-rpc.publicnode.com') })
console.log('throwaway', account.address)
const t0 = Date.now()
const client = await createSecureClient({ signer: signerFrom(wallet), wallet: account.address })
console.log('signed in', Date.now() - t0, 'ms', client.account)

const start = Math.floor(Date.now() / 1000 / 300) * 300
const ev = await (await fetch(`https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${start}`)).json() as { markets: { clobTokenIds: string; conditionId: string }[] }[]
const [up] = JSON.parse(ev[0].markets[0].clobTokenIds) as string[]
console.log('window', start, 'up token', up.slice(0, 12) + '…')

const ok: string[] = []
try {
  const bal = await fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL })
  console.log('balance', bal); ok.push('balance')
} catch (e) { console.log('balance failed:', (e as Error).message) }
try {
  const st = await client.fetchTradingApprovalsState()
  console.log('approvals', JSON.stringify(st).slice(0, 300)); ok.push('approvals')
} catch (e) { console.log('approvals failed:', (e as Error).message) }
try {
  const r = await client.placeMarketOrder({ assetId: up, side: OrderSide.BUY, amount: 1, maxPrice: 0.99, orderType: OrderType.FAK })
  if (r.ok) console.log('ORDER ACCEPTED (unexpected for an unfunded key)', r)
  else {
    console.log('order refused:', r.code, r.message)
    if (/balance|allowance|not enough|insufficient/i.test(`${r.code} ${r.message}`)) ok.push('order refused for want of funds')
  }
} catch (e) {
  const msg = (e as Error).message
  console.log('order refused:', msg)
  if (/balance|allowance|not enough|insufficient/i.test(msg)) ok.push('order refused for want of funds')
}
console.log(ok.length === 3 ? 'PASS' : 'CHECK BY HAND', ok)
process.exit(0)
