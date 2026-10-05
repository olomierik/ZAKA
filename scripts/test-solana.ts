// Solana on ARCDEX, offline (2026-10-04): the market list's rows and launchpads, the launch curves and mints decoded
// from real accounts (scripts/fixtures/sol-accounts.json), Relay's quotes checked (real ones pass, tampered ones are
// refused), the price guard, stages, safety ratings and routes.
// Run: bun scripts/test-solana.ts

import accounts from './fixtures/sol-accounts.json'
import relayBuy from './fixtures/relay-buy.json'
import relaySell from './fixtures/relay-sell.json'
import relaySwap from './fixtures/relay-solswap.json'
import swapsFx from './fixtures/sol-swaps.json'

const core = await import('../api/_solCore')
const { checkRelayQuote, relayValue, relayValueUsd, quoteVerdict, quoteBody, RELAY_ARC_DEPOSITORY, SOL_NATIVE, SOLANA_ID } = await import('../src/arcdex/lib/relayQuote')
const { solStage, solStageInput } = await import('../src/arcdex/lib/coinStage')
const { solSafety, isListable } = await import('../src/arcdex/lib/safety')
const { pathToPage, pageToPath } = await import('../src/arcdex/lib/router')
const { parseSolSwap } = await import('../src/arcdex/api/solSwaps')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')
import type { GtPools } from '../api/_rhCore'

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const throws = (f: () => unknown, m: string, want?: RegExp) => {
  try { f() } catch (e) { if (want && !want.test((e as Error).message)) throw new Error(`FAIL: ${m} (threw "${(e as Error).message}")`); console.log('  ✓', m); return }
  throw new Error('FAIL: ' + m + ' (accepted)')
}
const H = 3_600_000
const bytes = (k: keyof typeof accounts) => core.fromBase64(accounts[k].data)
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

console.log('the market list')
const pool = (dex: string, base: string, quote: string, extra: Record<string, unknown> = {}) => ({
  id: `solana_P${base.slice(0, 8)}${dex.length}`, type: 'pool',
  attributes: {
    address: `P${base.slice(1, 9)}${dex.slice(0, 4)}PooLaddress1111111111111`, name: 'MEME / SOL', pool_created_at: new Date(Date.now() - 5 * H).toISOString(),
    base_token_price_usd: '0.0001', fdv_usd: '40000', market_cap_usd: null, reserve_in_usd: '12000',
    price_change_percentage: { m5: '1', h1: '2', h24: '30' }, transactions: { h24: { buys: 400, sells: 300, buyers: 120, sellers: 90 } }, volume_usd: { h24: '90000' }, ...extra,
  },
  relationships: { base_token: { data: { id: `solana_${base}` } }, quote_token: { data: { id: `solana_${quote}` } }, dex: { data: { id: dex } } },
})
const MEME = 'MemeMint1111111111111111111111111111111pump'
const OTHER = 'QtherMint111111111111111111111111111111abc'
const list: GtPools = {
  data: [pool('pump-fun', MEME, core.WSOL), pool('raydium', MEME, core.SOL_USDC, { volume_usd: { h24: '10000' } }), pool('raydium', OTHER, core.WSOL), pool('pump-fun', core.SOL_USDC, core.WSOL)] as never,
  included: [{ id: `solana_${MEME}`, type: 'token', attributes: { address: MEME, name: 'Meme Coin', symbol: 'MEME', decimals: 6, image_url: 'https://x/meme.png' } }] as never,
}
const parsed = core.parseSolPools(list)
ok(parsed.length === 3 && parsed.every(r => r.address !== core.SOL_USDC), 'a pool whose coin is a quote (USDC) is left out')
ok(parsed[0].address === MEME && parsed[0].symbol === 'MEME' && parsed[0].launchpad === 'pump.fun', 'a pump.fun pool: its mint, case kept, its launchpad named')
const merged = core.mergeSolCoins(parsed)
const meme = merged.find(r => r.address === MEME)!
ok(merged.length === 2 && meme.volume24h === 100_000 && meme.launchpad === 'pump.fun', 'one row per coin, volume summed over its pools, the launchpad from any of them')
ok(core.listedSol(merged).map(r => r.address).join() === MEME, 'launchpad coins only: a coin with only plain-DEX pools isn’t listed')
ok(core.isWashSol({ ...meme, liquidity: 50, volume24h: 2_000_000 }) && !core.isWashSol(meme), 'wash: millions through a pool with no liquidity')
const paths = core.solListPaths()
ok(Object.keys(core.SOL_LAUNCHPADS).every(d => paths.some(p => p.includes(`/dexes/${d}/pools`))) && paths.length === Object.keys(core.SOL_LAUNCHPADS).length + 3, `a round reads every launchpad venue (${paths.length} calls)`)

console.log('launch curves (real accounts)')
const pump = core.decodePumpCurve(bytes('pumpGraduated'))
ok(accounts.pumpGraduated.owner === core.PROGRAMS.pump && pump?.graduated && pump.progress === 100, 'a pump.fun curve that completed: graduated, 100%')
const live = new Uint8Array(bytes('pumpGraduated'))
new DataView(live.buffer).setBigUint64(24, core.PUMP_FOR_SALE / 4n, true); live[48] = 0
ok(core.decodePumpCurve(live)?.progress === 75 && !core.decodePumpCurve(live)?.graduated, 'a quarter of pump.fun’s 793.1M left for sale: 75%, still on the curve')
const ll = core.decodeLaunchLab(bytes('launchLab'))
ok(accounts.launchLab.owner === core.PROGRAMS.launchLab && ll && !ll.graduated && ll.progress > 0 && ll.progress < 100, `LaunchLab: SOL raised over its 85 SOL target (${ll?.progress}%)`)
const dbc = core.decodeDbcPool(bytes('dbcPool'))!
const threshold = core.decodeDbcThreshold(bytes('dbcConfig'))!
ok(dbc.config === accounts.dbcConfig.address && threshold > 0n && !dbc.migrated, 'Meteora DBC: the pool names its config, whose threshold is read')
const dc = core.dbcCurve(dbc, threshold)!
ok(dc.progress > 0 && dc.progress < 100 && !dc.graduated, `Meteora DBC: quote raised over the threshold (${dc.progress}%)`)
ok(core.dbcCurve({ ...dbc, migrated: true }, threshold)?.graduated === true && core.dbcCurve(dbc, null) === null, 'a migrated DBC pool is graduated; one without its threshold isn’t guessed')
// Each account is decoded by its owner.
const fetcher = (async (_u: string, init?: RequestInit) => {
  const keys = (JSON.parse(String(init?.body)) as { params: [string[]] }).params[0]
  const by = new Map(Object.values(accounts).map(a => [a.address, a]))
  return Response.json({ result: { value: keys.map(k => { const a = by.get(k); return a ? { owner: a.owner, data: [a.data, 'base64'] } : null }) } })
}) as typeof fetch
const curves = await core.readCurves([
  { address: 'A', pool: accounts.pumpGraduated.address }, { address: 'B', pool: accounts.launchLab.address }, { address: 'C', pool: accounts.dbcPool.address }, { address: 'D', pool: accounts.mintUsdc.address },
], ['https://rpc'], new Map(), fetcher)
ok(curves.get('A')?.graduated && curves.get('B') && curves.get('C') && !curves.has('D'), 'each pool is decoded by the program that owns it; any other is left unread')
ok(core.batchFor('https://solana-rpc.publicnode.com') === 10 && core.batchFor('https://api.mainnet-beta.solana.com') === 100, 'calls sized per RPC: publicnode takes 10 addresses, Solana’s own 100')

console.log('mints (real accounts)')
const mint = (k: keyof typeof accounts) => core.decodeMint(bytes(k), accounts[k].owner)!
const clean = mint('mintPump2022')
ok(clean.token2022 && !clean.mintAuthority && !clean.freezeAuthority && !clean.danger.length && !clean.risky.length, 'a pump.fun coin (Token-2022): every power renounced')
ok(!mint('mintLaunchLab').mintAuthority && !mint('mintLaunchLab').freezeAuthority, 'a LaunchLab coin: renounced too')
ok(mint('mintHook').risky.includes('transfer-hook') && !mint('mintHook').danger.length, 'a transfer hook: risky, not danger')
const pyusd = mint('mintPyusd')
ok(pyusd.danger.includes('permanent-delegate') && pyusd.risky.includes('transfer-fee') && pyusd.mintAuthority && pyusd.freezeAuthority, 'PYUSD: a permanent delegate, a transfer fee, mint and freeze authorities')
ok(mint('mintUsdc').freezeAuthority && mint('mintUsdc').mintAuthority && !mint('mintUsdc').token2022, 'USDC: mint and freeze authorities')

console.log('Relay: a buy (Arc USDC → the coin on Solana)')
const buyReq = { side: 'buy' as const, mint: 'Wu6fhJJKg29iqKtAmDXgJVMhd6xkqKYQpDsJbCvR5dJ', amount: 10_000_000n, evm: FEE_WALLET, sol: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', feeBps: 200 }
const body = quoteBody(buyReq)
ok(body.originChainId === 5042 && body.destinationChainId === SOLANA_ID && body.recipient === buyReq.sol && (body.appFees as { recipient: string; fee: string }[])[0].recipient === FEE_WALLET, 'the request: from Arc to Solana, to the buyer’s Solana address, ARCDEX’s fee to the fee wallet')
ok(!('appFees' in quoteBody({ ...buyReq, side: 'gas' })) && quoteBody({ ...buyReq, side: 'gas' }).destinationCurrency === SOL_NATIVE, 'the SOL top-up: native SOL, no fee')
const bq = checkRelayQuote(buyReq, relayBuy as never)
ok(bq.evmTx?.call.to === RELAY_ARC_DEPOSITORY && bq.evmTx.approve && bq.appFeeUsd > 0, 'a real buy quote passes: an exact approval, then the deposit to Relay’s depository')
const tamperBuy: [string, (j: any) => void, RegExp][] = [
  ['delivered to another Solana address', j => { j.details.recipient = 'Attacker1111111111111111111111111111111111' }, /another Solana address/],
  ['paid by someone else', j => { j.details.sender = '0x1111111111111111111111111111111111111111' }, /isn’t from you/],
  ['another coin', j => { j.details.currencyOut.currency.address = 'QtherMint111111111111111111111111111111abc' }, /another token/],
  ['another amount', j => { j.details.currencyIn.amount = '20000000' }, /another amount/],
  ['an approval to another contract', j => { const s = j.steps.find((x: any) => x.id === 'approve'); s.items[0].data.data = s.items[0].data.data.replace('4cd00e387622c35bddb9b4c962c136462338bc31', '1111111111111111111111111111111111111111') }, /doesn’t know/],
  ['an unlimited approval', j => { const s = j.steps.find((x: any) => x.id === 'approve'); s.items[0].data.data = s.items[0].data.data.slice(0, 74) + 'f'.repeat(64) }, /exactly the amount/],
  ['a deposit to another contract', j => { j.steps.find((x: any) => x.id === 'deposit').items[0].data.to = '0x1111111111111111111111111111111111111111' }, /doesn’t know/],
  ['a deposit of more', j => { const d = j.steps.find((x: any) => x.id === 'deposit').items[0].data; d.data = d.data.slice(0, 138) + (20_000_000).toString(16).padStart(64, '0') + d.data.slice(202) }, /amount asked for/],
  ['a deposit from someone else', j => { const d = j.steps.find((x: any) => x.id === 'deposit').items[0].data; d.data = d.data.slice(0, 10) + '0'.repeat(24) + '1'.repeat(40) + d.data.slice(74) }, /isn’t from you/],
  ['native funds sent', j => { j.steps.find((x: any) => x.id === 'deposit').items[0].data.value = '1' }, /native funds/],
  ['another chain', j => { j.steps.find((x: any) => x.id === 'deposit').items[0].data.chainId = 1 }, /another chain/],
  ['an extra step', j => { j.steps.push({ id: 'swap', kind: 'transaction', items: [{ data: {} }] }) }, /unexpected step/],
  ['a fee that isn’t 2%', j => { j.fees.app.amount = '500000' }, /fee isn’t ARCDEX’s/],
  ['no minimum received', j => { j.details.currencyOut.minimumAmount = '0' }, /minimum/],
]
for (const [what, f, want] of tamperBuy) { const j = clone(relayBuy) as any; f(j); throws(() => checkRelayQuote(buyReq, j), `refused: ${what}`, want) }

console.log('Relay: a sale (the coin on Solana → Arc USDC)')
const sellReq = { side: 'sell' as const, mint: 'Wu6fhJJKg29iqKtAmDXgJVMhd6xkqKYQpDsJbCvR5dJ', amount: 100_000_000_000n, evm: FEE_WALLET, sol: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', feeBps: 200 }
const sq = checkRelayQuote(sellReq, relaySell as never)
ok(sq.solTx && sq.solTx.instructions.length === 4 && sq.solTx.lookupTables.length > 0, 'a real sale quote passes: its instructions and lookup tables')
const ins = (j: any) => j.steps[0].items[0].data.instructions
const tamperSell: [string, (j: any) => void, RegExp][] = [
  ['paid to another Arc address', j => { j.details.recipient = '0x1111111111111111111111111111111111111111' }, /pays another address/],
  ['sold from another wallet', j => { j.details.sender = 'Attacker1111111111111111111111111111111111' }, /isn’t from your Solana wallet/],
  ['another coin', j => { j.details.currencyIn.currency.address = 'QtherMint111111111111111111111111111111abc' }, /spends another token/],
  ['paid in something other than Arc USDC', j => { j.details.currencyOut.currency.chainId = 1 }, /delivers another token/],
  ['a program ARCDEX doesn’t know', j => { ins(j)[1].programId = 'Evil1111111111111111111111111111111111111111' }, /program ARCDEX doesn’t know/],
  ['another signer', j => { ins(j)[1].keys[3] = { pubkey: 'Other11111111111111111111111111111111111111', isSigner: true, isWritable: true } }, /another signer/],
  ['no deposit with Relay', j => { j.steps[0].items[0].data.instructions = ins(j).filter((i: any) => !i.programId.startsWith('DPArt')) }, /deposited with Relay/],
  ['a memo naming another request', j => { const m = ins(j).find((i: any) => i.programId.startsWith('Memo')); m.data = Buffer.from('0x' + 'a'.repeat(64)).toString('hex') }, /memo/],
  ['no fee', j => { j.fees.app.amount = '0' }, /fee isn’t ARCDEX’s/],
]
for (const [what, f, want] of tamperSell) { const j = clone(relaySell) as any; f(j); throws(() => checkRelayQuote(sellReq, j), `refused: ${what}`, want) }

console.log('Relay: a swap on Solana alone (SOL → the coin, for a Solana wallet with no Arc wallet)')
const SWARM = '4waqtABVsAD7u1rtg7hiX6jLuaikU39hBFDZktAHpump'
const swapReq = { side: 'swap' as const, chain: 'solana' as const, mint: SWARM, inToken: SOL_NATIVE, outToken: SWARM, amount: 50_000_000n, evm: '', sol: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa', feeBps: 200 }
const swapBody = quoteBody(swapReq)
ok(swapBody.originChainId === SOLANA_ID && swapBody.destinationChainId === SOLANA_ID && swapBody.user === swapReq.sol && swapBody.recipient === swapReq.sol && swapBody.originCurrency === SOL_NATIVE && swapBody.destinationCurrency === SWARM, 'the request: Solana to Solana, from and to the buyer’s own Solana wallet, SOL for the coin')
const wq = checkRelayQuote(swapReq, relaySwap as never)
ok(wq.solTx && !wq.evmTx && wq.signChain === SOLANA_ID && wq.outDecimals === 6, 'a real swap quote passes: one Solana transaction, nothing to sign on Arc')
const sins = (j: any) => j.steps[0].items[0].data.instructions
const tamperSwap: [string, (j: any) => void, RegExp][] = [
  ['delivered to another wallet', j => { j.details.recipient = 'Attacker1111111111111111111111111111111111' }, /another Solana address|pays another address/],
  ['another coin out', j => { j.details.currencyOut.currency.address = 'QtherMint111111111111111111111111111111abc' }, /delivers another token/],
  ['something other than SOL in', j => { j.details.currencyIn.currency.address = core.SOL_USDC }, /spends another token/],
  ['SOL sent to a stranger', j => { const t = sins(j).find((i: any) => i.programId.startsWith('1111')); t.keys[1].pubkey = 'Attacker1111111111111111111111111111111111' }, /sends SOL/],
  ['more SOL to Relay’s solver than a fee', j => { const t = sins(j).find((i: any) => i.programId.startsWith('1111')); t.data = '02000000' + Buffer.from(new BigUint64Array([50_000_000n]).buffer).toString('hex') }, /more SOL than its fee/],
  ['a program ARCDEX doesn’t know', j => { sins(j)[1].programId = 'Evil1111111111111111111111111111111111111111' }, /program ARCDEX doesn’t know/],
  ['another signer', j => { sins(j)[1].keys[1] = { pubkey: 'Other11111111111111111111111111111111111111', isSigner: true, isWritable: true } }, /another signer/],
  ['a deposit step instead of a swap', j => { j.steps[0].id = 'deposit' }, /unexpected step/],
  ['no minimum received', j => { j.details.currencyOut.minimumAmount = '0' }, /minimum/],
]
for (const [what, f, want] of tamperSwap) { const j = clone(relaySwap) as any; f(j); throws(() => checkRelayQuote(swapReq, j), `refused: ${what}`, want) }
const swapFair = relayValueUsd({ appFeeUsd: 0.12, relayFeeUsd: 0.01 }, 0.05 * 121.5, 303_161.542246 * 0.0000197)
ok(swapFair && quoteVerdict(swapFair) === 'ok', `priced in dollars (SOL at $121.50): impact ${(swapFair!.impact * 100).toFixed(1)}%, ok`)

console.log('the price guard')
const fair = relayValue({ side: 'buy', expectedOut: 1_000_000_000n, outDecimals: 6, appFeeUsd: 0.2, relayFeeUsd: 0.3 }, 10, 0.0095)
ok(fair && quoteVerdict(fair) === 'ok', `a fair buy: impact ${(fair!.impact * 100).toFixed(1)}%, ok`)
const trap = relayValue({ side: 'buy', expectedOut: 5_000_000_000n, outDecimals: 6, appFeeUsd: 0.2, relayFeeUsd: 0.3 }, 10, 0.0095)
ok(quoteVerdict(trap) === 'off-market', 'a buy paying 5× the market price: refused (off-market)')
const thin = relayValue({ side: 'sell', expectedOut: 4_000_000n, outDecimals: 6, appFeeUsd: 0.1, relayFeeUsd: 0.1 }, 1_000_000, 0.00001)
ok(quoteVerdict(thin) === 'refuse', 'a sale losing over half to price impact: refused')

console.log('stages and safety')
const row = (o: Record<string, unknown> = {}) => ({ ...meme, createdAt: Date.now() - 3 * H, marketCap: 40_000, liquidity: 12_000, ...o }) as typeof meme
ok(solStage(row({ graduated: false, curveProgress: 92 })) === 'near', 'on its curve at 92%: Near bond')
ok(solStage(row({ graduated: false, curveProgress: 30 })) === 'bonding', 'at 30%: Bonding')
ok(solStage(row({ graduated: true, curveProgress: 100 })) === 'graduated', 'the chain says graduated: off the curve, whatever the venue')
ok(solStageInput(row({ dex: 'boop-fun' })).onCurve && solStageInput(row({ dex: 'boop-fun' })).progress === null, 'a curve the chain isn’t read for (Boop): Bonding, no percentage')
const safeMint = { mintAuthority: false, freezeAuthority: false, token2022: false, danger: [], risky: [] }
ok(solSafety(row({ mint: { ...safeMint, freezeAuthority: true } })).level === 'danger', 'a freeze authority: Danger')
ok(solSafety(row({ mint: { ...safeMint, mintAuthority: true } })).level === 'danger', 'a mint authority: Danger')
ok(solSafety(row({ mint: { ...safeMint, risky: ['transfer-hook'] } })).level === 'risky', 'a transfer hook: Risky')
ok(solSafety(row({ mint: safeMint, liquidity: 60_000, traders24h: 400, buys24h: 400, sells24h: 300, createdAt: Date.now() - 10 * 24 * H })).level === 'safe', 'everything renounced, a deep pool: Safe')
ok(!isListable({ official: false, marketCapUsd: 14_000, rugged: false }), 'under $15K of market cap: not listed (on Solana too)')

console.log('live trades from the chain (real transactions, scripts/fixtures/sol-swaps.json)')
for (const p of swapsFx.pools as any[]) {
  const meta = { pool: p.pool, mint: p.mint, quoteMint: p.quoteMint }
  const trades = p.txs.map((t: any) => parseSolSwap(t, meta)).filter(Boolean) as NonNullable<ReturnType<typeof parseSolSwap>>[]
  const prices = trades.map(t => t.price).sort((a, b) => a - b)
  const median = prices[Math.floor(prices.length / 2)]
  ok(trades.length > 0 && prices.every(x => x > median * 0.8 && x < median * 1.25), `${p.dex} (${p.symbol}): ${trades.length} trades read, prices together (median ${median.toExponential(3)} SOL)`)
  const signerOf = new Map(p.txs.map((t: any) => [t.transaction.signatures[0], (k => (typeof k === 'string' ? k : k.pubkey))(t.transaction.message.accountKeys[0])]))
  ok(trades.every(t => t.maker === signerOf.get(t.txHash) && t.id === t.txHash && t.time > Date.parse('2026-10-01')), 'each names its signer, its signature and its time')
  const failed = { ...p.txs[0], meta: { ...p.txs[0].meta, err: { InstructionError: [0, 'Custom'] } } }
  ok(parseSolSwap(failed, meta) === null, 'a failed transaction isn’t a trade')
  ok(parseSolSwap(p.txs[0], { ...meta, mint: 'QtherMint111111111111111111111111111111abc' }) === null, 'another coin’s transaction isn’t this coin’s trade')
}

console.log('routes')
const p = pathToPage(`/solana/token/${MEME}`, '?pool=PooLAddr1111111111111111111111111111111111')
ok(p?.name === 'sol-token' && p.address === MEME && p.pool === 'PooLAddr1111111111111111111111111111111111', 'a coin’s link keeps its mint’s case')
ok(pageToPath(p!) === `/solana/token/${MEME}?pool=PooLAddr1111111111111111111111111111111111` && pathToPage('/solana', '')?.name === 'solana', 'and back; /solana is the markets')
ok(pathToPage('/solana/token/0xnotsolana', '')?.name === 'solana', 'a malformed mint opens the markets')

console.log('\nall Solana checks passed')
