// Records real AVNU answers for scripts/test-starknet.ts (quotes and builds only; nothing is signed or sent):
// 10 STRK → ETH without a fee, the same with a 1% integrator fee to a stand-in recipient, and a multi-hop quote.
//   bun scripts/capture-avnu.ts

import { writeFileSync } from 'fs'
import { ETH, STRK } from '../src/arcdex/starknet/net'

const AVNU = 'https://starknet.api.avnu.fi'
const TAKER = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde'
const RECIPIENT = '0x0777777777777777777777777777777777777777777777777777777777777777'
const LORDS = '0x124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49'
const EKUBO = '0x75afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87'

async function quote(sell: string, buy: string, amount: bigint, fee?: number) {
  const p = new URLSearchParams({ sellTokenAddress: sell, buyTokenAddress: buy, sellAmount: `0x${amount.toString(16)}`, takerAddress: TAKER, size: '1' })
  if (fee) { p.set('integratorFees', `0x${fee.toString(16)}`); p.set('integratorFeeRecipient', RECIPIENT); p.set('integratorName', 'ARCDEX') }
  const r = await fetch(`${AVNU}/swap/v3/quotes?${p}`)
  const list = (await r.json()) as { quoteId: string }[]
  if (!list.length) throw new Error('no quote')
  return list[0]
}
async function build(q: { quoteId: string }) {
  const r = await fetch(`${AVNU}/swap/v3/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, takerAddress: TAKER, slippage: 0.01, includeApprove: true }) })
  return (await r.json()) as { calls: unknown[] }
}

const ten = 10n * 10n ** 18n
const plain = await quote(STRK, ETH, ten)
const plainBuild = await build(plain)
const withFee = await quote(STRK, ETH, ten, 100)
const withFeeBuild = await build(withFee)
const multi = await quote(LORDS, EKUBO, 1000n * 10n ** 18n)
writeFileSync('scripts/fixtures/avnu.json', JSON.stringify({ taker: TAKER, recipient: RECIPIENT, at: new Date().toISOString(), plain, plainBuild, withFee, withFeeBuild, multi }, null, 1))
console.log('saved scripts/fixtures/avnu.json')
