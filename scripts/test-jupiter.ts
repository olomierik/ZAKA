// Solana swaps through Jupiter's Swap API V2 (src/arcdex/lib/jupiter.ts, netlify/edge-functions/jupiter.ts). Offline:
// the orders are built from Jupiter's OpenAPI spec (github.com/jup-ag/docs, openapi-spec/swap/v2/swap.yaml); the token
// account vectors are real mainnet accounts from scripts/fixtures/sol-swaps.json; the transactions are built with
// @solana/web3.js the way Jupiter's are (v0 messages).
//   bun scripts/test-jupiter.ts
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { jupiterRequest, executeBody, referralFrom as edgeReferral } from '../netlify/edge-functions/jupiter'
import {
  checkJupOrder, jupOrderPath, referralTokenAccounts, txProblem, txShape, simProblem, watchedAccounts, executeOrder, executeErrorText,
  tokenAmount, getJupOrder, JupiterError, JupiterUnavailable, WSOL, JUP_PROGRAMS, MAX_SOL_COST, type JupAsk, type JupOrder,
} from '../src/arcdex/lib/jupiter'
import { minOutProblem, sizeProblem, driftProblem, GUARDRAILS } from '../src/arcdex/lib/guardrails'
import { flag } from '../src/arcdex/lib/flags'
import { quoteSolanaSwap, isJupiterQuote, providerOf, jupiterProvider, relaySolanaProvider } from '../src/arcdex/lib/execution'
import relaySwap from './fixtures/relay-solswap.json'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const throws = (f: () => unknown, re: RegExp): boolean => { try { f(); return false } catch (e) { return re.test(String((e as Error).message)) } }

const REF = 'HLLmfX1M39GuG5dZf4QEPknFZKtV1cWEwXR55PoyHPir'     // stands in for ARCDEX's referral account
const OTHER_REF = '5JGaah517gVYUkNLJ4Dbm6PEpAcsX6vupRV48jnGa3PY'
const TAKER = 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const COIN = 'DoVAVzViX8Bjy3r15nwikSaSbzE6dV4ovd28aWpJpump'

console.log('the proxy (netlify/edge-functions/jupiter.ts)')
const same = new Headers({ 'sec-fetch-site': 'same-origin' })
const orderUrl = (q: Record<string, string>) => new URL(`https://arcsense.site/jup/swap/v2/order?${new URLSearchParams(q)}`)
const base = { inputMint: WSOL, outputMint: COIN, amount: '100000000', taker: TAKER, swapMode: 'ExactIn' }
let r = jupiterRequest(orderUrl({ ...base, referralAccount: REF, referralFee: '50' }), same, 'GET', REF)
check('path' in r && r.path.startsWith('/order?') && r.path.includes('referralFee=50'), 'an order with ARCDEX’s referral account at 50 bps passes')
r = jupiterRequest(orderUrl(base), new Headers({ 'sec-fetch-site': 'cross-site' }), 'GET', REF)
check('error' in r && r.status === 403, 'another site’s page is refused')
r = jupiterRequest(orderUrl({ ...base, referralAccount: OTHER_REF, referralFee: '50' }), same, 'GET', REF)
check('error' in r && r.status === 400, 'someone else’s referral account is refused')
r = jupiterRequest(orderUrl({ ...base, referralAccount: REF, referralFee: '300' }), same, 'GET', REF)
check('error' in r, 'a fee over Jupiter’s 255 bps is refused')
r = jupiterRequest(orderUrl({ ...base, referralAccount: REF }), same, 'GET', REF)
check('error' in r, 'a referral account without its fee is refused')
r = jupiterRequest(orderUrl({ ...base, receiver: OTHER_REF }), same, 'GET', REF)
check('error' in r && /receiver/.test((r as { error: string }).error), 'a receiver (output to someone else) is refused')
r = jupiterRequest(orderUrl({ ...base, payer: OTHER_REF }), same, 'GET', REF)
check('error' in r, 'an integrator payer is refused')
r = jupiterRequest(orderUrl({ ...base, amount: '0' }), same, 'GET', REF)
check('error' in r, 'a zero amount is refused')
r = jupiterRequest(new URL('https://arcsense.site/jup/swap/v2/build?x=1'), same, 'GET', REF)
check('error' in r && r.status === 404, '/build isn’t served')
r = jupiterRequest(new URL('https://arcsense.site/jup/swap/v2/execute'), same, 'POST', REF)
check('path' in r && r.path === '/execute', 'an execution is passed')
r = jupiterRequest(new URL('https://arcsense.site/jup/swap/v2/execute'), same, 'GET', REF)
check('error' in r, 'a GET to execute is refused')
const signed = Buffer.alloc(400, 7).toString('base64')
check(executeBody(JSON.stringify({ signedTransaction: signed, requestId: 'req-1234-abcd' })) !== null, 'a signed transaction and request id pass')
check(executeBody(JSON.stringify({ signedTransaction: signed, requestId: 'req-1234-abcd', extra: 1 })) === null, 'an extra field is refused')
check(executeBody('{') === null && executeBody(JSON.stringify({ signedTransaction: 'not base64!', requestId: 'req-1234-abcd' })) === null, 'a bad body is refused')
check(edgeReferral('  ' + REF + ' ') === REF && edgeReferral('0x123') === null, 'the referral account from the environment')

console.log('the order path')
const ask: JupAsk = { inputMint: '11111111111111111111111111111111', outputMint: COIN, amount: 100_000_000n, taker: TAKER, outDecimals: 6 }
const path = jupOrderPath(ask, REF, 50)
check(path.startsWith('/jup/swap/v2/order?') && path.includes(`inputMint=${WSOL}`), 'native SOL is asked as wSOL’s mint')
check(path.includes('referralAccount=' + REF) && path.includes('referralFee=50') && path.includes('taker=' + TAKER), 'the taker and ARCDEX’s referral fee are sent')
check(!jupOrderPath(ask, null, 50).includes('referral'), 'no referral account configured: no fee asked')
const edgeOk = jupiterRequest(new URL('https://arcsense.site' + path), same, 'GET', REF)
check('path' in edgeOk, 'the proxy accepts the site’s own order path')

console.log('the order (fields from Jupiter’s OpenAPI spec)')
const order = (over: Record<string, unknown> = {}) => ({
  mode: 'manual', inputMint: WSOL, outputMint: COIN, inAmount: '100000000', outAmount: '220931077991', otherAmountThreshold: '214303145651',
  swapMode: 'ExactIn', slippageBps: 300, priceImpact: -0.42, inUsdValue: 15.2, outUsdValue: 15.05, routePlan: [], referralAccount: REF,
  feeMint: WSOL, feeBps: 50, platformFee: { amount: '500000', feeBps: 0, feeMint: WSOL }, router: 'metis', transaction: 'AQID', taker: TAKER,
  requestId: '019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', gasless: false, signatureFeePayer: TAKER, lastValidBlockHeight: '351234567', ...over,
})
let o = checkJupOrder(order(), ask, REF, 50)
check(o.expectedOut === 220931077991n && o.minOut === 214303145651n && o.arcdexFeeBps === 50, 'a good order: amounts, minimum and ARCDEX’s fee')
check(Math.abs((o.impact ?? 0) - 0.0042) < 1e-9 && Math.abs(o.appFeeUsd - 0.076) < 1e-9, 'Jupiter’s price impact and the fee in dollars')
check(throws(() => checkJupOrder(order({ outputMint: USDC }), ask, REF, 50), /other tokens/), 'another token out is refused')
check(throws(() => checkJupOrder(order({ inAmount: '200000000' }), ask, REF, 50), /another amount/), 'another amount in is refused')
check(throws(() => checkJupOrder(order({ taker: OTHER_REF }), ask, REF, 50), /another wallet/), 'another taker is refused')
check(throws(() => checkJupOrder(order({ otherAmountThreshold: undefined }), ask, REF, 50), /no amount out/), 'no minimum is refused')
check(throws(() => checkJupOrder(order({ otherAmountThreshold: '100000000000' }), ask, REF, 50), /under its price/), 'a minimum 55% under the price breaks the slippage ceiling')
check(throws(() => checkJupOrder(order({ referralAccount: OTHER_REF }), ask, REF, 50), /someone else/), 'someone else’s referral account is refused')
check(throws(() => checkJupOrder(order({ feeBps: 400 }), ask, REF, 50), /higher than shown/), 'a fee far above ARCDEX’s is refused')
o = checkJupOrder(order({ feeBps: 10, platformFee: { feeBps: 10 } }), ask, REF, 50)
check(o.arcdexFeeBps === 0 && o.appFeeUsd === 0, 'Jupiter’s own fallback fee (no referral token account): ARCDEX takes nothing, the trade can go')
o = checkJupOrder(order({ feeBps: 62 }), ask, REF, 50)
check(o.arcdexFeeBps === 50, 'gasless recoup on top of ARCDEX’s 50 bps still counts as ARCDEX’s fee applied')
check(throws(() => checkJupOrder(order({ transaction: '', errorCode: 2, errorMessage: 'Insufficient SOL for gas' }), ask, REF, 50), /SOL for fees/), 'no transaction: Jupiter’s reason in words')
o = checkJupOrder(order({ transaction: null, taker: null }), { ...ask, taker: null }, REF, 50)
check(o.transaction === null, 'a quote without a wallet carries no transaction')
check(throws(() => checkJupOrder({ error: 'Could not find any route' }, ask, REF, 50), /route/), 'Jupiter’s error is passed on')

console.log('fetching an order')
const stub = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
let unavailable = false
try { await getJupOrder(ask, stub(503, { error: 'not configured' })) } catch (e) { unavailable = e instanceof JupiterUnavailable }
check(unavailable, 'no key on the site (503): unavailable, so the form asks Relay')
unavailable = false
try { await getJupOrder(ask, stub(429, {})) } catch (e) { unavailable = e instanceof JupiterUnavailable }
check(unavailable, 'throttled (429): unavailable too')
let refusedErr = false
try { await getJupOrder(ask, stub(400, { error: 'fee not served' })) } catch (e) { refusedErr = e instanceof JupiterError && !(e instanceof JupiterUnavailable) }
check(refusedErr, 'a refused request is an error, not a fallback')

console.log('token accounts (real mainnet accounts)')
const accts = await referralTokenAccounts('HLLmfX1M39GuG5dZf4QEPknFZKtV1cWEwXR55PoyHPir', USDC)
check(accts[0] === 'EdYArNZD8aHN4tS34hU1WpgzyvfR13vJZhxSkWdLFkHQ', 'the token account of an owner for USDC (Token program)')
const accts22 = await referralTokenAccounts(TAKER, COIN)
check(accts22[1] === '4rCJA99DZzZuZpAA3DdE13YwjQ114LEp5bCXDj1bWfRz', 'the token account of an owner for a Token-2022 coin')
const [legacy] = PublicKey.findProgramAddressSync([Buffer.from('referral_ata'), new PublicKey(REF).toBytes(), new PublicKey(USDC).toBytes()], new PublicKey(JUP_PROGRAMS.referral))
check(accts[2] === legacy.toBase58(), 'and the referral program’s older account for it')
const watched = await watchedAccounts(TAKER, { inputMint: WSOL, outputMint: COIN } as JupOrder)
check(watched.length === 5 && watched[0] === TAKER && watched[4] === '4rCJA99DZzZuZpAA3DdE13YwjQ114LEp5bCXDj1bWfRz', 'the simulation watches the taker and both token accounts of each mint')

console.log('the transaction (v0, built with @solana/web3.js)')
const taker = Keypair.generate(), sponsor = Keypair.generate()
const swapProgram = Keypair.generate().publicKey
const feeAcct = new PublicKey((await referralTokenAccounts(REF, WSOL))[0])
const build = (ixs: TransactionInstruction[], payer = taker.publicKey) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message())
const swapIx = (extra: PublicKey[] = []) => new TransactionInstruction({ programId: swapProgram, keys: [{ pubkey: taker.publicKey, isSigner: true, isWritable: true }, ...extra.map(p => ({ pubkey: p, isSigner: false, isWritable: true }))], data: Buffer.from([1, 2, 3]) })
const tok = (code: number, accounts: PublicKey[]) => new TransactionInstruction({ programId: new PublicKey(JUP_PROGRAMS.token), keys: accounts.map((p, i) => ({ pubkey: p, isSigner: i === accounts.length - 1, isWritable: true })), data: Buffer.from([code, 0, 0, 0, 0, 0, 0, 0, 0]) })
const T0 = taker.publicKey.toBase58()
const ord = (over: Partial<JupOrder> = {}) => ({ ...checkJupOrder(order({ taker: T0, signatureFeePayer: T0 }), { ...ask, taker: T0 }, REF, 50), ...over })
let shape = await txShape(build([swapIx([feeAcct])]))
check(shape.feePayer === T0 && shape.signers.includes(T0), 'its shape: fee payer and signers read from the message')
check(txProblem(shape, ord(), T0, [feeAcct.toBase58()]) === null, 'the swap with ARCDEX’s fee account passes')
check(/isn’t ARCDEX’s/.test(txProblem(await txShape(build([swapIx()])), ord(), T0, [feeAcct.toBase58()]) ?? ''), 'ARCDEX’s fee claimed but its account missing: refused')
check(txProblem(await txShape(build([swapIx()])), ord({ arcdexFeeBps: 0 }), T0, null) === null, 'no ARCDEX fee on this trade: no account needed')
const victim = Keypair.generate().publicKey, thief = Keypair.generate().publicKey
check(/someone else/.test(txProblem(await txShape(build([swapIx([feeAcct]), tok(4, [victim, thief, taker.publicKey])])), ord(), T0, [feeAcct.toBase58()]) ?? ''), 'an Approve of the taker’s tokens to someone else is refused')
check(/someone else/.test(txProblem(await txShape(build([swapIx([feeAcct]), tok(6, [victim, taker.publicKey])])), ord(), T0, [feeAcct.toBase58()]) ?? ''), 'a SetAuthority on the taker’s account is refused')
const sponsored = await txShape(build([swapIx([feeAcct])], sponsor.publicKey))
check(/someone else pays/.test(txProblem(sponsored, ord(), T0, [feeAcct.toBase58()]) ?? ''), 'an unnamed fee payer is refused')
check(txProblem(sponsored, ord({ signatureFeePayer: sponsor.publicKey.toBase58(), gasless: true }), T0, [feeAcct.toBase58()]) === null, 'the gas sponsor the order names may pay')
const notSigner = await txShape(build([new TransactionInstruction({ programId: swapProgram, keys: [{ pubkey: feeAcct, isSigner: false, isWritable: true }], data: Buffer.from([1]) })], sponsor.publicKey))
check(/isn’t asked to sign/.test(txProblem(notSigner, ord({ signatureFeePayer: sponsor.publicKey.toBase58() }), T0, null) ?? ''), 'a transaction the taker doesn’t sign is refused')
void SystemProgram

console.log('the simulation')
const acct = (lamports: number, amount?: bigint) => ({ lamports, data: [amount === undefined ? '' : (() => { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return b.toString('base64') })(), 'base64'] as [string, string] })
check(tokenAmount(acct(0, 12345n).data[0]) === 12345n && tokenAmount(null) === 0n, 'a token account’s amount read from its data')
const buy = ord() // 0.1 SOL in, at least 214303145651 of the coin out
const sim = (before: ReturnType<typeof acct>[], after: ReturnType<typeof acct>[], err: unknown = null) => simProblem({ before, after, err, logs: ['Program log: Error: slippage tolerance exceeded'] }, buy)
const SOL = 1_000_000_000
check(sim([acct(2 * SOL), acct(0), acct(0), acct(0), acct(0, 0n)], [acct(2 * SOL - 100_005_000), acct(0), acct(0), acct(0), acct(0, 220_000_000_000n)]) === null, 'a buy: 0.1 SOL plus fees out, more than the minimum in')
check(/more SOL/.test(sim([acct(2 * SOL), acct(0), acct(0), acct(0), acct(0, 0n)], [acct(2 * SOL - 100_000_000 - Number(MAX_SOL_COST) - 1), acct(0), acct(0), acct(0), acct(0, 220_000_000_000n)]) ?? ''), 'one lamport over the amount plus 0.01 SOL: refused')
check(/less than its minimum/.test(sim([acct(2 * SOL), acct(0), acct(0), acct(0), acct(0, 0n)], [acct(2 * SOL - 100_005_000), acct(0), acct(0), acct(0), acct(0, 214_303_145_650n)]) ?? ''), 'one unit under the minimum: refused')
check(/would fail/.test(sim([acct(2 * SOL)], [acct(2 * SOL)], { InstructionError: [3, { Custom: 6001 }] }) ?? ''), 'a failing simulation: refused with its log')
const sell = { ...buy, inputMint: COIN, outputMint: WSOL, inputAmount: 220_000_000_000n, minOut: 95_000_000n }
const simSell = (afterLamports: number, afterCoin: bigint) => simProblem({ before: [acct(SOL), acct(0), acct(0, 300_000_000_000n), acct(0), acct(0)], after: [acct(afterLamports), acct(0), acct(0, afterCoin), acct(0), acct(0)], err: null, logs: [] }, sell)
check(simSell(SOL + 99_000_000, 80_000_000_000n) === null, 'a sale: the coin out, SOL in above the minimum less fees')
check(/more than the amount/.test(simSell(SOL + 99_000_000, 70_000_000_000n) ?? ''), 'a sale taking more coin than asked: refused')
check(/less than its minimum/.test(simSell(SOL + 80_000_000, 80_000_000_000n) ?? ''), 'a sale paying too little SOL: refused')

console.log('executing')
let calls = 0
const exec = (answers: (() => Response)[]) => (async () => { const a = answers[Math.min(calls, answers.length - 1)]; calls++; return a() }) as unknown as typeof fetch
calls = 0
let res = await executeOrder(signed, buy, exec([() => new Response(JSON.stringify({ status: 'Success', signature: 'sig1', totalOutputAmount: '220000000000' }))]))
check(res.signature === 'sig1' && res.outAmount === 220_000_000_000n && calls === 1, 'success: the signature and what arrived')
calls = 0
res = await executeOrder(signed, buy, exec([() => new Response('{}', { status: 500 }), () => new Response(JSON.stringify({ status: 'Success', signature: 'sig2' }))]))
check(res.signature === 'sig2' && calls === 2, 'a 500 then success: the same signed transaction sent again (never re-signed)')
calls = 0
res = await executeOrder(signed, buy, exec([() => { throw new TypeError('network') }, () => new Response(JSON.stringify({ status: 'Success', signature: 'sig3' }))]))
check(res.signature === 'sig3', 'a lost answer: sent again')
calls = 0
let failMsg = ''
try { await executeOrder(signed, buy, exec([() => new Response(JSON.stringify({ status: 'Failed', code: -1000, error: 'Failed to land' }))])) } catch (e) { failMsg = (e as Error).message }
check(/didn’t land/.test(failMsg) && calls === 1, 'a failed landing: told in words, not retried blindly')
calls = 0
failMsg = ''
try { await executeOrder(signed, buy, exec([() => new Response(JSON.stringify({ status: 'Success' }))])) } catch (e) { failMsg = (e as Error).message || 'thrown' }
check(failMsg !== '', '“Success” without a signature isn’t taken as done')
check(/expired/.test(executeErrorText(-2003, '')) && /rejected/.test(executeErrorText(-2004, '')), 'expired and rejected quotes in words')

console.log('guardrails')
check(minOutProblem(1000n, 850n) === null && minOutProblem(1000n, 849n) !== null, 'the slippage ceiling is 15%')
check(minOutProblem(1000n, 0n) !== null && minOutProblem(1000n, 1001n) !== null && minOutProblem(0n, 0n) !== null, 'no minimum, a minimum above the quote, or nothing out: refused')
check(sizeProblem(GUARDRAILS.maxTradeUsd) === null && sizeProblem(GUARDRAILS.maxTradeUsd + 1) !== null && sizeProblem(null) === null, 'the size cap: $25,000 a trade; unknown values aren’t held against a trade')
check(driftProblem(1000n, 970n) === null && driftProblem(1000n, 969n) === 'worse' && driftProblem(1000n, 1251n) === 'changed', 'a fresh quote 3% worse or 25% better stops the trade')

console.log('picking the provider (lib/execution.ts)')
const SWARM = '4waqtABVsAD7u1rtg7hiX6jLuaikU39hBFDZktAHpump'
const swapAsk = { relay: { side: 'swap' as const, chain: 'solana' as const, mint: SWARM, inToken: '11111111111111111111111111111111', outToken: SWARM, amount: 50_000_000n, evm: '', sol: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa', feeBps: 200 }, taker: null, outDecimals: 6, inputUsd: null }
const realFetch = globalThis.fetch
const asked: string[] = []
const answer = (jup: () => Response) => { globalThis.fetch = (async (u: string | URL) => { const url = String(u); asked.push(url.includes('/jup/') ? 'jupiter' : 'relay'); return url.includes('/jup/') ? jup() : new Response(JSON.stringify(relaySwap)) }) as typeof fetch }
answer(() => new Response(JSON.stringify(order({ inputMint: WSOL, outputMint: SWARM, inAmount: '50000000', outAmount: '127000000000', otherAmountThreshold: '125000000000', transaction: null, taker: null, referralAccount: undefined, feeBps: 10 })), { status: 200 }))
let q = await quoteSolanaSwap(swapAsk)
check(isJupiterQuote(q) && providerOf(q) === jupiterProvider && asked.join() === 'jupiter', 'Jupiter serves it: a Jupiter quote, and Relay isn’t asked')
asked.length = 0
answer(() => new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }))
q = await quoteSolanaSwap(swapAsk)
check(!isJupiterQuote(q) && providerOf(q) === relaySolanaProvider && asked.join() === 'jupiter,relay', 'no key on the site: Relay quotes instead')
asked.length = 0
q = await quoteSolanaSwap(swapAsk)
check(!isJupiterQuote(q) && asked.join() === 'relay', 'and for the next five minutes Relay alone is asked')
globalThis.fetch = realFetch

console.log('the flag')
check(flag('jupiter', {}) === true && flag('jupiter', { VITE_FLAG_JUPITER: 'off' }) === false, 'on by default; VITE_FLAG_JUPITER=off sends Solana swaps through Relay')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
