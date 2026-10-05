// Solana wallets trading the EVM chains, offline (2026-10-05): Relay's quotes for SOL or USDC on Solana into coins on
// Arc, BNB Chain and Robinhood Chain (and the gas top-up), those coins sold back for SOL, and USDC bridged both ways,
// recorded by scripts/capture-relay-xsol.ts; plus today's Solana sale (scripts/fixtures/relay-sell-v2.json). Real
// quotes pass; tampered ones are refused. Also the ARCDEX account derived from a Solana wallet's signature.
// Run: bun scripts/test-xsol.ts

import fx from './fixtures/relay-xsol.json'
import sellV2 from './fixtures/relay-sell-v2.json'

const { checkRelayQuote, quoteBody, relayValueUsd, quoteVerdict, SOL_NATIVE, SOL_USDC, ARC_ID, BSC_ID, RH_ID, RELAY_EVM, RELAY_ARC_DEPOSITORY } = await import('../src/arcdex/lib/relayQuote')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')
const { solAccountMessage, deriveAccountKey } = await import('../src/arcdex/lib/solAccount')

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const throws = (f: () => unknown, m: string, want?: RegExp) => {
  try { f() } catch (e) { if (want && !want.test((e as Error).message)) throw new Error(`FAIL: ${m} (threw "${(e as Error).message}")`); console.log('  ✓', m); return }
  throw new Error('FAIL: ' + m + ' (accepted)')
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const F = fx as Record<string, any>
const SOL_USER = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa'
const EVM = FEE_WALLET
const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
const LOBSTER = '0xeccbb861c0dda7efd964010085488b69317e4444'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
const xin = (evmChain: number, mint: string, inToken: string, amount: bigint, feeBps = 200, gasUsd = 0) => ({ side: 'xin' as const, evmChain, mint, inToken, amount, evm: EVM, sol: SOL_USER, feeBps, ...(gasUsd ? { gasUsd } : {}) })
const xout = (evmChain: number, mint: string, outToken: string, amount: bigint, feeBps = 200) => ({ side: 'xout' as const, evmChain, mint, outToken, amount, evm: EVM, sol: SOL_USER, feeBps })
const reqs: Record<string, ReturnType<typeof xin> | ReturnType<typeof xout>> = {
  'sol-arc': xin(ARC_ID, ARCD, SOL_NATIVE, 50_000_000n),
  'usdc-arc': xin(ARC_ID, ARCD, SOL_USDC, 5_000_000n),
  'sol-arc-gas': xin(ARC_ID, ARCD, SOL_NATIVE, 50_000_000n, 200, 0.5),
  'sol-bsc': xin(BSC_ID, LOBSTER, SOL_NATIVE, 50_000_000n),
  'sol-bsc-gas': xin(BSC_ID, LOBSTER, SOL_NATIVE, 50_000_000n, 200, 0.5),
  'sol-rh': xin(RH_ID, F.rhMeme, SOL_NATIVE, 50_000_000n),
  'arc-sol': xout(ARC_ID, ARCD, SOL_NATIVE, 10n ** 24n),
  'bsc-sol': xout(BSC_ID, LOBSTER, SOL_NATIVE, 10n ** 20n),
  'rh-sol': xout(RH_ID, F.rhMeme, SOL_NATIVE, 10n ** 19n),
  'bridge-in': xin(ARC_ID, ARC_USDC, SOL_USDC, 10_000_000n, 50),
  'bridge-out': xout(ARC_ID, ARC_USDC, SOL_USDC, 10_000_000n, 50),
}

console.log('the requests')
for (const [name, req] of Object.entries(reqs)) {
  const body = quoteBody(req)
  const rec = F[name].body
  ok(['user', 'recipient', 'originChainId', 'destinationChainId', 'originCurrency', 'destinationCurrency', 'amount'].every(k => String(body[k]) === String(rec[k])) && JSON.stringify(body.appFees) === JSON.stringify(rec.appFees) && body.topupGas === rec.topupGas,
    `${name}: built as recorded (${body.originChainId} → ${body.destinationChainId})`)
}

console.log('real quotes pass')
for (const [name, req] of Object.entries(reqs)) {
  const q = checkRelayQuote(req, F[name].quote)
  if (req.side === 'xin') ok(q.solTx && !q.evmTx && q.signChain === 792703809, `${name}: one Solana transaction, signed in the Solana wallet`)
  else ok(q.evmTx && !q.solTx && q.signChain === req.evmChain && q.evmTx.approve?.amount === req.amount, `${name}: an exact approval and the deposit, signed on chain ${req.evmChain}`)
}
const ao = checkRelayQuote(reqs['arc-sol'], F['arc-sol'].quote)
ok(ao.evmTx!.call.to === RELAY_EVM.approvalProxy && ao.evmTx!.approve!.spender === RELAY_EVM.approvalProxy, 'an Arc coin goes through Relay’s approval proxy, as on BNB Chain and Robinhood Chain')
const bo = checkRelayQuote(reqs['bridge-out'], F['bridge-out'].quote)
ok(bo.evmTx!.call.to === RELAY_ARC_DEPOSITORY && bo.evmTx!.approve!.spender === RELAY_ARC_DEPOSITORY, 'Arc’s USDC goes into Relay’s depository, word by word')
const gq = checkRelayQuote(reqs['sol-arc-gas'], F['sol-arc-gas'].quote)
ok(gq.gasTopupUsd > 0.45 && gq.gasTopupUsd < 0.55 && gq.relayFeeUsd - gq.gasTopupUsd < 0.1, `the $0.50 of gas is inside Relay’s fee ($${gq.relayFeeUsd.toFixed(2)}), and arrives: $${gq.gasTopupUsd.toFixed(2)}`)
const sv = sellV2 as any
ok(checkRelayQuote({ ...sv.req, amount: BigInt(sv.req.amount) }, sv.quote).solTx, 'today’s Solana sale into Arc USDC still passes (the older deposit, with its memo)')

console.log('tampered quotes are refused')
const ins = (j: any) => j.steps[0].items[0].data.instructions
const dep = (j: any) => ins(j).find((i: any) => i.programId === '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2')
const tamper: [string, string, (j: any) => void, RegExp][] = [
  ['sol-arc', 'the deposit funds another order', j => { const d = dep(j); d.data = d.data.slice(0, 32) + 'ab'.repeat(32) }, /another order/],
  ['sol-arc', 'a different deposit amount', j => { const d = dep(j); d.data = d.data.slice(0, 16) + '00e1f50500000000' + d.data.slice(32) }, /amount/],
  ['sol-arc', 'the order pays another address', j => { j.protocol.v2.orderData.output.payments[0].recipient = '0x1111111111111111111111111111111111111111' }, /pays another address/],
  ['sol-arc', 'the order delivers another token', j => { j.protocol.v2.orderData.output.payments[0].currency = '0x2222222222222222222222222222222222222222' }, /another token/],
  ['sol-arc', 'the order makes a call', j => { j.protocol.v2.orderData.output.calls = [{ to: '0x1111111111111111111111111111111111111111', data: '0x' }] }, /calls/],
  ['sol-arc', 'a refund to someone else', j => { j.protocol.v2.orderData.inputs[0].refunds[0].recipient = 'Attacker1111111111111111111111111111111111' }, /refunds another/],
  ['sol-arc', 'delivered to another account', j => { j.details.recipient = '0x1111111111111111111111111111111111111111' }, /pays another address/],
  ['sol-arc', 'another signer', j => { dep(j).keys[1].pubkey = 'Other11111111111111111111111111111111111111' }, /another signer/],
  ['sol-arc', 'a program ARCDEX doesn’t know', j => { dep(j).programId = 'Evil1111111111111111111111111111111111111111' }, /program ARCDEX doesn’t know/],
  ['sol-arc', 'no deposit at all', j => { j.steps[0].items[0].data.instructions = ins(j).filter((i: any) => i.programId !== '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2') }, /deposited with Relay|no instructions/],
  ['sol-arc', 'gas that wasn’t asked for', j => { j.details.currencyGasTopup = F['sol-arc-gas'].quote.details.currencyGasTopup }, /gas that wasn’t asked/],
  ['sol-arc-gas', 'ten times the gas asked for', j => { j.details.currencyGasTopup.amountUsd = '5' }, /more gas than was asked/],
  ['sol-arc', 'no fee', j => { j.fees.app.amount = '0' }, /fee isn’t ARCDEX’s/],
  ['usdc-arc', 'spends SOL instead of USDC', j => { j.details.currencyIn.currency.address = SOL_NATIVE }, /spends another token/],
  ['sol-bsc', 'another coin', j => { j.details.currencyOut.currency.address = '0x3333333333333333333333333333333333334444' }, /delivers another token/],
  ['arc-sol', 'paid to another Solana address', j => { j.details.recipient = 'Attacker1111111111111111111111111111111111' }, /another Solana address/],
  ['arc-sol', 'an approval to another spender', j => { const a = j.steps.find((x: any) => x.id === 'approve').items[0].data; a.data = a.data.replace(RELAY_EVM.approvalProxy.slice(2), '1111111111111111111111111111111111111111') }, /doesn’t know/],
  ['arc-sol', 'an unlimited approval', j => { const a = j.steps.find((x: any) => x.id === 'approve').items[0].data; a.data = a.data.slice(0, 74) + 'f'.repeat(64) }, /exactly the amount/],
  ['arc-sol', 'the deposit to another contract', j => { j.steps.find((x: any) => x.id === 'deposit').items[0].data.to = '0x1111111111111111111111111111111111111111' }, /doesn’t know/],
  ['arc-sol', 'the order pays another Solana address', j => { j.protocol.v2.orderData.output.payments[0].recipient = 'Attacker1111111111111111111111111111111111' }, /pays another address/],
  ['rh-sol', 'native funds sent', j => { j.steps.find((x: any) => x.id === 'deposit').items[0].data.value = '1' }, /native funds/],
  ['bridge-out', 'a deposit of more', j => { const d = j.steps.find((x: any) => x.id === 'deposit').items[0].data; d.data = d.data.slice(0, 138) + (20_000_000).toString(16).padStart(64, '0') + d.data.slice(202) }, /amount asked for/],
]
for (const [name, what, f, want] of tamper) {
  const j = clone(F[name].quote)
  f(j)
  throws(() => checkRelayQuote(reqs[name], j), `refused (${name}): ${what}`, want)
}
throws(() => checkRelayQuote({ ...reqs['sol-arc'], evmChain: 1 }, F['sol-arc'].quote), 'refused: a chain ARCDEX doesn’t trade with Solana', /chain ARCDEX doesn’t trade/)
throws(() => checkRelayQuote({ ...reqs['sol-arc'], inToken: ARCD } as never, F['sol-arc'].quote), 'refused: anything but SOL or USDC going in', /only SOL or USDC/)

console.log('the price guard, in dollars')
const fair = relayValueUsd({ appFeeUsd: 0.12, relayFeeUsd: 0.02 }, 6, 5.75)
ok(fair && quoteVerdict(fair) === 'ok', `SOL into an Arc coin at its market price: ${(fair!.impact * 100).toFixed(1)}% impact, ok`)
ok(quoteVerdict(relayValueUsd({ appFeeUsd: 0.12, relayFeeUsd: 0.02 }, 6, 30)) === 'off-market', 'a quote paying 5× the market: refused')

console.log('the ARCDEX account from a Solana wallet')
const msg = solAccountMessage(SOL_USER)
ok(msg.includes(SOL_USER) && msg.includes('arcsense.site') && /only sign/i.test(msg), 'the message names the wallet and the site, and says to sign it nowhere else')
const sig = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 255)
const k1 = await deriveAccountKey(sig), k2 = await deriveAccountKey(sig.slice())
const other = await deriveAccountKey(sig.map((b, i) => (i === 0 ? b ^ 1 : b)))
ok(/^0x[0-9a-f]{64}$/.test(k1) && k1 === k2 && k1 !== other, 'the same signature always gives the same key; another gives another')

console.log('\nall Solana-wallet checks passed')
