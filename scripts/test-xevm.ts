// Paying from Ethereum, Base or Arbitrum, offline (2026-10-16): Relay's quotes for USDC or ETH there into $ARCDEX on Arc
// (and Base USDC into a BNB Chain coin), and back (2026-10-17: the coins into USDC or ETH there), recorded by
// scripts/capture-relay-xevm.ts. Real quotes pass; tampered ones are refused before anything is signed.
// Run: bun scripts/test-xevm.ts

import fx from './fixtures/relay-xevm.json'

const { checkRelayQuote, quoteBody, relayValueUsd, quoteVerdict, ARC_ID, BSC_ID, EVM_NATIVE, RELAY_ARC_DEPOSITORY, RELAY_EVM } = await import('../src/arcdex/lib/relayQuote')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')
const { PAY_CHAINS, payChain } = await import('../src/arcdex/lib/payChains')

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const throws = (f: () => unknown, m: string, want?: RegExp) => {
  try { f() } catch (e) { if (want && !want.test((e as Error).message)) throw new Error(`FAIL: ${m} (threw "${(e as Error).message}")`); console.log('  ✓', m); return }
  throw new Error('FAIL: ' + m + ' (accepted)')
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const F = fx as Record<string, any>
const EVM = FEE_WALLET.toLowerCase()
const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
const LOBSTER = '0xeccbb861c0dda7efd964010085488b69317e4444'
const usdc = (id: number) => payChain(id)!.usdc
const xevm = (fromChain: number, evmChain: number, mint: string, inToken: string, amount: bigint, gasUsd = 0) =>
  ({ side: 'xevm' as const, fromChain, evmChain, mint, inToken, amount, evm: EVM, sol: '', feeBps: 50, ...(gasUsd ? { gasUsd } : {}) })
const reqs = {
  'base-usdc-arc': xevm(8453, ARC_ID, ARCD, usdc(8453), 5_000_000n),
  'base-eth-arc': xevm(8453, ARC_ID, ARCD, EVM_NATIVE, 2_000_000_000_000_000n),
  'arb-usdc-arc': xevm(42161, ARC_ID, ARCD, usdc(42161), 5_000_000n),
  'eth-usdc-arc': xevm(1, ARC_ID, ARCD, usdc(1), 5_000_000n),
  'base-usdc-arc-gas': xevm(8453, ARC_ID, ARCD, usdc(8453), 5_000_000n, 0.5),
  'base-usdc-bsc': xevm(8453, BSC_ID, LOBSTER, usdc(8453), 5_000_000n),
}
type Name = keyof typeof reqs

console.log('the pay chains')
ok(PAY_CHAINS.map(c => c.id).join() === '8453,42161,1', 'Base, Arbitrum and Ethereum')
ok(PAY_CHAINS.every(c => /^0x[0-9a-f]{40}$/.test(c.usdc)), 'each with its USDC address, lower-case')

console.log('the requests')
for (const [name, req] of Object.entries(reqs)) {
  const body = quoteBody(req), rec = F[name].body
  ok(['user', 'recipient', 'originChainId', 'destinationChainId', 'originCurrency', 'destinationCurrency', 'amount'].every(k => String(body[k]).toLowerCase() === String(rec[k]).toLowerCase())
    && JSON.stringify(body.appFees).toLowerCase() === JSON.stringify(rec.appFees).toLowerCase() && body.topupGas === rec.topupGas,
    `${name}: built as recorded (${body.originChainId} → ${body.destinationChainId}), paid and delivered to the same address`)
}

console.log('real quotes pass')
for (const [name, req] of Object.entries(reqs)) {
  const q = checkRelayQuote(req, F[name].quote)
  ok(q.evmTx && !q.solTx && q.signChain === req.fromChain && q.evmTx.call.to === RELAY_ARC_DEPOSITORY, `${name}: signed on chain ${req.fromChain}, into Relay's depository`)
  if (req.inToken === EVM_NATIVE) ok(!q.evmTx!.approve && q.evmTx!.call.value === req.amount, `${name}: ETH goes with the call, exactly the amount, no approval`)
  else ok(q.evmTx!.approve?.amount === req.amount && q.evmTx!.approve.spender === RELAY_ARC_DEPOSITORY && q.evmTx!.approve.token === req.inToken && q.evmTx!.call.value === 0n, `${name}: USDC approved for exactly the amount, to the depository`)
}
const g = checkRelayQuote(reqs['base-usdc-arc-gas'], F['base-usdc-arc-gas'].quote)
ok(g.gasTopupUsd > 0 && g.gasTopupUsd <= 0.75, `the gas top-up is inside Relay's fee ($${g.gasTopupUsd.toFixed(2)})`)

console.log('tampered quotes are refused')
const usdcQ = F['base-usdc-arc'].quote, ethQ = F['base-eth-arc'].quote
const R = reqs['base-usdc-arc'], RE = reqs['base-eth-arc']
const step = (j: any, id: string) => j.steps.find((s: any) => s.id === id).items[0].data
const swapWord = (data: string, i: number, hex64: string) => data.slice(0, 10 + 64 * i) + hex64 + data.slice(10 + 64 * (i + 1))
const addr64 = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const EVIL = '0x1111111111111111111111111111111111111111'
const cases: [string, (j: any) => void, any?][] = [
  ['an approval to another contract', j => { const d = step(j, 'approve'); d.data = swapWord(d.data, 0, addr64(EVIL)) }],
  ['an approval for more than the amount', j => { const d = step(j, 'approve'); d.data = swapWord(d.data, 1, (10n ** 30n).toString(16).padStart(64, '0')) }],
  ['an approval on another token', j => { step(j, 'approve').to = EVIL }],
  ['a deposit into another contract', j => { step(j, 'deposit').to = EVIL }],
  ['a deposit credited to someone else', j => { const d = step(j, 'deposit'); d.data = swapWord(d.data, 0, addr64(EVIL)) }],
  ['a deposit of another token', j => { const d = step(j, 'deposit'); d.data = swapWord(d.data, 1, addr64(EVIL)) }],
  ['a deposit of another amount', j => { const d = step(j, 'deposit'); d.data = swapWord(d.data, 2, (6_000_000n).toString(16).padStart(64, '0')) }],
  ['native funds sent with a USDC deposit', j => { step(j, 'deposit').value = '1' }],
  ['a transaction for another chain', j => { step(j, 'deposit').chainId = 10 }],
  ['an extra step', j => { j.steps.push(clone(j.steps[j.steps.length - 1])) }],
  ['a step Relay doesn’t name', j => { j.steps[0].id = 'permit' }],
  ['paying another address', j => { j.details.recipient = EVIL }],
  ['spending from another address', j => { j.details.sender = EVIL }],
  ['delivering another coin', j => { j.details.currencyOut.currency.address = EVIL }],
  ['delivering on another chain', j => { j.details.currencyOut.currency.chainId = 1 }],
  ['spending another amount', j => { j.details.currencyIn.amount = '6000000' }],
  ['no minimum received', j => { j.details.currencyOut.minimumAmount = '0' }],
  ['without ARCDEX’s fee', j => { delete j.fees.app }],
  ['gas that wasn’t asked for', j => { j.details.currencyGasTopup = { amountUsd: '0.5' } }],
]
for (const [what, mutate] of cases) { const j = clone(usdcQ); mutate(j); throws(() => checkRelayQuote(R, j), `USDC: ${what}`) }
const ethCases: [string, (j: any) => void][] = [
  ['more ETH than asked for', j => { step(j, 'deposit').value = String(RE.amount + 1n) }],
  ['ETH credited to someone else', j => { const d = step(j, 'deposit'); d.data = swapWord(d.data, 0, addr64(EVIL)) }],
  ['ETH into another contract', j => { step(j, 'deposit').to = EVIL }],
  ['another deposit function', j => { const d = step(j, 'deposit'); d.data = '0xe8017952' + d.data.slice(10) }],
  ['an approval slipped in for ETH', j => { j.steps.unshift({ id: 'approve', kind: 'transaction', requestId: j.steps[0].requestId, items: [{ data: { chainId: 8453, to: usdc(8453), value: '0', data: '0x095ea7b3' + addr64(EVIL) + 'f'.repeat(64) } }] }) }],
]
for (const [what, mutate] of ethCases) { const j = clone(ethQ); mutate(j); throws(() => checkRelayQuote(RE, j), `ETH: ${what}`) }
throws(() => checkRelayQuote({ ...R, fromChain: 10 }, usdcQ), 'paying from a chain ARCDEX doesn’t take payments from', /payments/)
throws(() => checkRelayQuote({ ...R, inToken: EVIL }, usdcQ), 'paying with a token other than USDC or ETH', /USDC or ETH/)
throws(() => checkRelayQuote({ ...R, evmChain: 8453 }, usdcQ), 'a coin on a chain ARCDEX doesn’t trade', /doesn’t trade/)
throws(() => checkRelayQuote({ ...R, inToken: usdc(42161) }, usdcQ), 'another chain’s USDC named for Base', /USDC or ETH/)

console.log('the price guard')
const q = checkRelayQuote(R, usdcQ)
const out = Number(q.expectedOut) / 1e18
const marketPrice = q.outUsdRelay / out
const fair = relayValueUsd(q, 5, out * marketPrice)
ok(fair && quoteVerdict(fair) !== 'refuse' && quoteVerdict(fair) !== 'off-market', `a fair route at the market price passes (cost ${(fair!.cost * 100).toFixed(1)}%)`)
const trap = relayValueUsd(q, 5, out * marketPrice * 300)
ok(trap && quoteVerdict(trap) === 'off-market', 'a route paying 300× the market price is refused as off-market')
const bad = relayValueUsd(q, 5, out * marketPrice * 0.4)
ok(bad && quoteVerdict(bad) === 'refuse', 'a route losing 60% is refused')

console.log('selling back to Ethereum, Base or Arbitrum')
const xout = (evmChain: number, toChain: number, mint: string, outToken: string, amount: bigint) =>
  ({ side: 'xevmout' as const, evmChain, toChain, mint, outToken, amount, evm: EVM, sol: '', feeBps: 50 })
const sells = {
  'arc-base-usdc': xout(ARC_ID, 8453, ARCD, usdc(8453), 10n ** 24n),
  'arc-base-eth': xout(ARC_ID, 8453, ARCD, EVM_NATIVE, 10n ** 24n),
  'arc-arb-usdc': xout(ARC_ID, 42161, ARCD, usdc(42161), 10n ** 24n),
  'bsc-base-usdc': xout(BSC_ID, 8453, LOBSTER, usdc(8453), 10n ** 20n),
}
for (const [name, req] of Object.entries(sells)) {
  const body = quoteBody(req), rec = F[name].body
  ok(['user', 'recipient', 'originChainId', 'destinationChainId', 'originCurrency', 'destinationCurrency', 'amount'].every(k => String(body[k]).toLowerCase() === String(rec[k]).toLowerCase())
    && JSON.stringify(body.appFees).toLowerCase() === JSON.stringify(rec.appFees).toLowerCase() && !body.topupGas,
    `${name}: built as recorded (${body.originChainId} → ${body.destinationChainId}), from and to the same address`)
  const q = checkRelayQuote(req, F[name].quote)
  ok(q.evmTx && !q.solTx && q.signChain === req.evmChain && q.evmTx.call.to === RELAY_EVM.approvalProxy && q.evmTx.call.value === 0n,
    `${name}: signed on the coin's chain (${req.evmChain}), through Relay's approval proxy, no native value`)
  ok(q.evmTx!.approve?.token === req.mint && q.evmTx!.approve.spender === RELAY_EVM.approvalProxy && q.evmTx!.approve.amount === req.amount,
    `${name}: the coin approved for exactly the amount, to the approval proxy`)
}
const S = sells['arc-base-usdc'], sQ = F['arc-base-usdc'].quote
const sellCases: [string, (j: any) => void][] = [
  ['an approval to another contract', j => { const d = step(j, 'approve'); d.data = swapWord(d.data, 0, addr64(EVIL)) }],
  ['an approval for more than the amount', j => { const d = step(j, 'approve'); d.data = swapWord(d.data, 1, (10n ** 30n).toString(16).padStart(64, '0')) }],
  ['an approval on another token', j => { step(j, 'approve').to = EVIL }],
  ['the trade through another contract', j => { step(j, 'deposit').to = EVIL }],
  ['native funds sent with the sale', j => { step(j, 'deposit').value = '1' }],
  ['instructions that don’t name the seller', j => { const d = step(j, 'deposit'); d.data = d.data.split(EVM.slice(2)).join(EVIL.slice(2)) }],
  ['a transaction for another chain', j => { step(j, 'deposit').chainId = 8453 }],
  ['paying another address', j => { j.details.recipient = EVIL }],
  ['paying out another token', j => { j.details.currencyOut.currency.address = EVIL }],
  ['paying out on another chain', j => { j.details.currencyOut.currency.chainId = 10 }],
  ['selling another amount', j => { j.details.currencyIn.amount = '1' }],
  ['no minimum received', j => { j.details.currencyOut.minimumAmount = '0' }],
  ['without ARCDEX’s fee', j => { delete j.fees.app }],
  ['an order paying someone else', j => { if (j.protocol?.v2?.orderData) j.protocol.v2.orderData.output.payments[0].recipient = EVIL; else j.details.recipient = EVIL }],
]
for (const [what, mutate] of sellCases) { const j = clone(sQ); mutate(j); throws(() => checkRelayQuote(S, j), `sale: ${what}`) }
throws(() => checkRelayQuote({ ...S, toChain: 10 }, sQ), 'paying out on a chain ARCDEX doesn’t pay out on', /pay out/)
throws(() => checkRelayQuote({ ...S, outToken: EVIL }, sQ), 'paying out a token other than USDC or ETH', /USDC or ETH/)
throws(() => checkRelayQuote({ ...S, evmChain: 8453 }, sQ), 'selling a coin on a chain ARCDEX doesn’t trade', /doesn’t trade/)

console.log('\nall pay-from-another-chain checks passed')
