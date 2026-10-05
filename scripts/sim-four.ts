// four.meme's curve, simulated on BNB Chain mainnet (2026-10-05): nothing is sent and no key is used. A throwaway
// address is given 1 BNB by a state override and buys a live curve coin with the exact call ARCDEX sends
// (lib/fourMeme.ts `fourBuyCall`), then approves exactly the tokens to TokenManager2. A wallet that bought the coin
// earlier sells half its tokens with the exact sale call (`fourSellCall`). Each must succeed, and each is refused with a
// minimum of twice the quote.
// Run: bun scripts/sim-four.ts [token]

import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEther, type Address } from 'viem'
import { bsc } from 'viem/chains'
import { FOUR, BNB_NATIVE, readFour } from '../api/_bscCore'

const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org']
const c = createPublicClient({ chain: bsc, transport: http(RPCS[0], { timeout: 20_000 }) })
const { fourBuyCall, fourSellCall, fourMinOut, fourQuoteBuy, fourQuoteSell } = await import('../src/arcdex/lib/fourMeme')

const ok = (v: unknown, m: string) => { if (!v) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

async function pickCoin(): Promise<string> {
  if (process.argv[2]) return process.argv[2].toLowerCase()
  const r = await fetch('https://api.geckoterminal.com/api/v2/networks/bsc/dexes/four-meme/pools?sort=h24_tx_count_desc&include=base_token', { headers: { accept: 'application/json' } })
  const d = await r.json() as { data: { relationships: { base_token: { data: { id: string } } } }[] }
  const cands = d.data.map(p => p.relationships.base_token.data.id.replace('bsc_', '').toLowerCase()).filter(a => /4444$/.test(a))
  const four = await readFour(cands, RPCS)
  const live = cands.find(a => { const f = four.get(a); return f && !f.graduated && f.quote === BNB_NATIVE && f.progress > 5 })
  if (!live) throw new Error('no live BNB-quoted curve coin found')
  return live
}

const token = await pickCoin()
console.log('coin', token)
const who = '0x00000000000000000000000000000000000f0e1e' as Address
const funds = parseEther('0.01')
const bq = await fourQuoteBuy(token, funds)
ok(bq.quote === BNB_NATIVE && bq.value === bq.funds && bq.tokens > 0n, `a buy of 0.01 BNB quotes ${Number(bq.tokens) / 1e18} tokens, the BNB sent as value`)
const minTokens = fourMinOut(bq, 500)
const buy = fourBuyCall(bq, minTokens)
const sq = await fourQuoteSell(token, minTokens)
const sell = fourSellCall(sq, fourMinOut(sq, 500))
const approve = { to: token as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FOUR.manager as Address, minTokens] }) }

// four.meme refuses a sale in the block its tokens were bought in ("GW"), and the public RPC can't simulate two blocks,
// so the buy and the sale are simulated apart: the buy from the throwaway address, the sale from a wallet that bought
// the coin earlier (its latest buyer still holding), with exactly its tokens approved first.
const boughtFirst = await c.simulateCalls({ account: who, calls: [buy, approve], stateOverrides: [{ address: who, balance: parseEther('1') }] })
boughtFirst.results.forEach((r, i) => console.log('   ', ['buy', 'approve'][i], r.status, r.status === 'failure' ? r.error?.message?.slice(0, 160) : `gas ${r.gasUsed}`))
ok(boughtFirst.results.every(r => r.status === 'success'), 'the buy goes through, then the exact approval')
const sameBlock = await c.simulateCalls({ account: who, calls: [buy, approve, sell], stateOverrides: [{ address: who, balance: parseEther('1') }] })
ok(sameBlock.results[2].status === 'failure', 'four.meme refuses a sale in the buy’s own block (so a buy can’t be flipped at once)')

// The coin's latest buyers, from GeckoTerminal's trades (public RPCs serve too few blocks of logs to find them).
const gtTrades = await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${token}/pools?page=1`, { headers: { accept: 'application/json' } })
  .then(r => r.json() as Promise<{ data: { attributes: { address: string } }[] }>)
  .then(d => fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${d.data[0].attributes.address}/trades`, { headers: { accept: 'application/json' } }))
  .then(r => r.json() as Promise<{ data: { attributes: { kind: string; tx_from_address: string } }[] }>)
const logs = gtTrades.data.filter(t => t.attributes.kind === 'buy').map(t => ({ args: { to: t.attributes.tx_from_address as Address } })).reverse()
let holder: Address | null = null, held = 0n
for (const l of [...logs].reverse()) {
  const to = l.args.to as Address
  if (!to || (await c.getCode({ address: to }))) continue
  const bal = await c.readContract({ address: token as Address, abi: erc20Abi, functionName: 'balanceOf', args: [to] })
  if (bal > 0n) { holder = to; held = bal; break }
}
ok(holder, `a holder who bought earlier: ${holder}`)
const part = held / 2n
const hq = await fourQuoteSell(token, part)
const hApprove = { to: token as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FOUR.manager as Address, part] }) }
const sold = await c.simulateCalls({ account: holder!, calls: [hApprove, fourSellCall(hq, fourMinOut(hq, 500))], stateOverrides: [{ address: holder!, balance: parseEther('1') }] })
sold.results.forEach((r, i) => console.log('   ', ['approve', 'sell'][i], r.status, r.status === 'failure' ? r.error?.message?.slice(0, 160) : `gas ${r.gasUsed}`))
ok(sold.results.every(r => r.status === 'success'), `a sale of half its tokens for ≈${Number(hq.funds) / 1e18} BNB goes through after an exact approval`)
const noApproval = await c.simulateCalls({ account: holder!, calls: [fourSellCall(hq, fourMinOut(hq, 500))], stateOverrides: [{ address: holder!, balance: parseEther('1') }] })
const greedySell = await c.simulateCalls({ account: holder!, calls: [hApprove, fourSellCall(hq, hq.funds * 2n)], stateOverrides: [{ address: holder!, balance: parseEther('1') }] })
ok(greedySell.results[1].status === 'failure', 'the sale is refused when its minimum is twice the quote')

const greedy = await c.simulateCalls({ account: who, calls: [fourBuyCall(bq, bq.tokens * 2n)], stateOverrides: [{ address: who, balance: parseEther('1') }] })
ok(greedy.results[0].status === 'failure', 'the buy is refused when its minimum is twice the quote')
ok(noApproval.results[0].status === 'failure' || (await c.readContract({ address: token as Address, abi: erc20Abi, functionName: 'allowance', args: [holder!, FOUR.manager as Address] })) >= part, 'the sale is refused without the approval (unless the holder approved four.meme itself)')
console.log('\nfour.meme simulation passed')
