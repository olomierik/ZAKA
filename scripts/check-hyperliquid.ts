// Live checks against Hyperliquid mainnet, with nothing at stake: a throwaway key with no account signs real actions
// (an order, a cancel, a builder-fee approval). The venue refuses them because the account doesn't exist, and its
// error names the address it recovered from the signature: the same address as the key's means the signing is right.
// Then the WebSocket's message shapes the client's router relies on.
//   VITE_HL_TRADING=on bun scripts/check-hyperliquid.ts
// (The client sends nothing to /exchange unless trading is switched on; these actions can't trade: no account.)

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { HL_API, HL_TRADING, hlExchange, hlInfo } from '../src/arcdex/hl/client'
import { signL1, signUserAction, type TypedDataSigner } from '../src/arcdex/hl/signing'
import { ASSET, cancelAction, marketPrice, orderAction, orderWire, newCloid, roundSize } from '../src/arcdex/hl/wire'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }

const account = privateKeyToAccount(generatePrivateKey())
const signer: TypedDataSigner = { address: account.address, signTypedData: td => account.signTypedData(td as Parameters<typeof account.signTypedData>[0]) }
const me = account.address.toLowerCase()
const names = (e: unknown) => String((e as Error).message ?? e).toLowerCase()

if (!HL_TRADING) { console.error('Run it with VITE_HL_TRADING=on: the client refuses /exchange otherwise.'); process.exit(2) }
console.log(`throwaway signer ${account.address} against ${HL_API}`)

console.log('an order, signed (L1)')
{
  const [meta, ctxs] = await hlInfo<[{ universe: { name: string; szDecimals: number }[] }, { midPx: string | null; markPx: string }[]]>({ type: 'metaAndAssetCtxs' })
  const btc = meta.universe.findIndex(u => u.name === 'BTC')
  const mid = Number(ctxs[btc].midPx ?? ctxs[btc].markPx)
  const px = marketPrice(mid * 0.7, true, 0, meta.universe[btc].szDecimals, true) // post-only, far under the market
  const sz = roundSize(11 / px, meta.universe[btc].szDecimals)
  const action = orderAction([orderWire({ asset: btc, isBuy: true, px, sz, reduceOnly: false, type: { limit: { tif: 'Alo' } }, cloid: newCloid() })])
  const nonce = Date.now()
  try {
    await hlExchange({ action, nonce, signature: await signL1(signer, action, nonce, true) })
    ok(false, 'the venue refused an order from an account that does not exist')
  } catch (e) {
    console.log(`    venue: ${(e as Error).message}`)
    ok(names(e).includes(me), 'the venue recovered our address from the order\'s signature')
  }
}

console.log('an outcome order and a cancel, signed (L1)')
{
  const om = await hlInfo<{ outcomes: { outcome: number }[] }>({ type: 'outcomeMeta' })
  const o = om.outcomes[0].outcome
  const action = orderAction([orderWire({ asset: ASSET.outcome(o, 0), isBuy: true, px: 0.01, sz: 1000, reduceOnly: false, type: { limit: { tif: 'Alo' } } })])
  const nonce = Date.now() + 1
  try { await hlExchange({ action, nonce, signature: await signL1(signer, action, nonce, true) }); ok(false, 'refused') } catch (e) {
    console.log(`    venue: ${(e as Error).message}`)
    ok(names(e).includes(me), `an outcome side (#${10 * o}) order recovers our address`)
  }
  const cancel = cancelAction([{ asset: 0, oid: 1 }])
  const n2 = Date.now() + 2
  try { await hlExchange({ action: cancel, nonce: n2, signature: await signL1(signer, cancel, n2, true) }); ok(false, 'refused') } catch (e) {
    console.log(`    venue: ${(e as Error).message}`)
    ok(names(e).includes(me), 'a cancel recovers our address')
  }
}

console.log('a builder-fee approval, signed (user-signed)')
{
  const nonce = Date.now() + 3
  const action = { type: 'approveBuilderFee', hyperliquidChain: 'Mainnet', signatureChainId: '0x13b2', maxFeeRate: '0.1%', builder: '0x274262a0321a0701b0a46a3576e07ae881c286bb', nonce }
  try { await hlExchange({ action, nonce, signature: await signUserAction(signer, 'HyperliquidTransaction:ApproveBuilderFee', action) }); ok(false, 'refused') } catch (e) {
    console.log(`    venue: ${(e as Error).message}`)
    ok(names(e).includes(me) || /deposit/i.test((e as Error).message), 'the approval is read as ours (or refused for having no deposit)')
  }
}

console.log('WebSocket message shapes')
{
  const got: Record<string, unknown> = {}
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws')
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')) })
  ws.onmessage = ev => {
    const m = JSON.parse(String(ev.data)) as { channel: string; data: unknown }
    const k = m.channel === 'allMids' ? `allMids:${'dex' in (m.data as object) ? (m.data as { dex: string }).dex : '(no dex field)'}` : m.channel
    if (!(k in got)) got[k] = m.data
  }
  for (const sub of [{ type: 'allMids' }, { type: 'allMids', dex: 'xyz' }, { type: 'l2Book', coin: 'BTC' }, { type: 'trades', coin: 'xyz:TSLA' }, { type: 'candle', coin: 'BTC', interval: '1m' }]) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: sub }))
  }
  await new Promise(r => setTimeout(r, 6_000))
  ws.close()
  for (const [k, v] of Object.entries(got)) console.log(`    ${k}: ${JSON.stringify(v).slice(0, 160)}`)
  ok('l2Book' in got && (got.l2Book as { coin: string }).coin === 'BTC', 'books carry their coin')
  ok('candle' in got && (got.candle as { s: string; i: string }).s === 'BTC', 'candles carry their coin (s) and interval (i)')
  const mids = Object.keys(got).filter(k => k.startsWith('allMids'))
  ok(mids.length > 0, `allMids arrives (${mids.join(', ')})`)
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall live Hyperliquid checks passed')
