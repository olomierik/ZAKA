// Anti-MEV on Solana (src/arcdex/lib/jito.ts): the tip and where it goes, the send as a bundle only, and which answers
// move on to the next block engine. `--live` sends a tipped transaction from a throwaway, unfunded key to Jito's real
// block engine: it must be accepted (a signature back), and can't land (the key has nothing to pay with).
//   bun scripts/test-jito.ts [--live]
import { clampTip, hasJitoTip, JITO_ENGINES, JITO_TIP, JITO_TIP_ACCOUNTS, JitoError, pickTipAccount, sendViaJito, tipInstruction } from '../src/arcdex/lib/jito'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

let n = 0
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); n++; console.log('  ✓', m) }

console.log('the tip')
ok(clampTip(0) === JITO_TIP.min && clampTip(5e9) === JITO_TIP.max && clampTip(NaN) === JITO_TIP.default && clampTip(50_000.4) === 50_000, 'kept between Jito’s minimum and 0.001 SOL; a bad setting is the default')
ok(new Set(Array.from({ length: 64 }, (_, i) => pickTipAccount(() => i / 64))).size === JITO_TIP_ACCOUNTS.length, 'any of Jito’s eight tip accounts, picked at random')
const payer = Keypair.generate()
const ix = await tipInstruction(payer.publicKey, 50_000, () => 0.3)
ok(ix.programId.equals(SystemProgram.programId), 'a plain System Program transfer')
ok(ix.keys[0].pubkey.equals(payer.publicKey) && ix.keys[0].isSigner && (JITO_TIP_ACCOUNTS as readonly string[]).includes(ix.keys[1].pubkey.toBase58()), 'from the trader, to a Jito tip account')
ok(ix.data.readUInt32LE(0) === 2 && ix.data.readBigUInt64LE(4) === 50_000n, 'for exactly the tip (transfer, 50,000 lamports)')
const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message()
ok(hasJitoTip(msg.staticAccountKeys.map(k => k.toBase58())) && !hasJitoTip([payer.publicKey.toBase58()]), 'a compiled transaction carries the tip account as a static key (not in a lookup table)')

console.log('sending')
const seen: string[] = []
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const sig = await sendViaJito('AAAA', async (url, init) => {
  seen.push(url)
  const b = JSON.parse(String(init.body)) as { method: string; params: [string, { encoding: string }] }
  ok(b.method === 'sendTransaction' && b.params[0] === 'AAAA' && b.params[1].encoding === 'base64', 'sendTransaction with the signed transaction, base64')
  return seen.length === 1 ? reply(429, { error: { message: 'rate limited' } }) : reply(200, { jsonrpc: '2.0', result: '5sig', id: 1 })
})
ok(sig === '5sig' && seen.length === 2, 'a busy block engine (429): the next one takes it')
ok(seen.every(u => u.endsWith('/api/v1/transactions?bundleOnly=true')) && seen[0].startsWith(JITO_ENGINES[0]) && seen[1].startsWith(JITO_ENGINES[1]), 'always as a bundle only, never forwarded to the public network')
let tries = 0
const refused = await sendViaJito('AAAA', async () => { tries++; return reply(400, { error: { code: -32602, message: 'Failed to deserialize packet' } }) }).catch(e => e)
ok(refused instanceof JitoError && tries === 1 && /deserialize/.test(refused.message), 'a transaction Jito refuses: no other engine is asked, and the reason comes back')
tries = 0
const down = await sendViaJito('AAAA', async () => { tries++; throw new Error('network down') }).catch(e => e)
ok(down instanceof JitoError && tries === JITO_ENGINES.length, 'every engine unreachable: an error, after each was tried')

if (process.argv.includes('--live')) {
  console.log('live (a throwaway, unfunded key; nothing can land)')
  const rpc = async (method: string, params: unknown[]) => ((await (await fetch('https://solana-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: { value: { blockhash: string } } }).result
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const key = Keypair.generate()
  const m = new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: value.blockhash, instructions: [await tipInstruction(key.publicKey, JITO_TIP.min)] }).compileToV0Message()
  const tx = new VersionedTransaction(m)
  tx.sign([key])
  const got = await sendViaJito(Buffer.from(tx.serialize()).toString('base64')).catch(e => e as Error)
  console.log('   Jito answered:', got instanceof Error ? `refused: ${got.message}` : got)
  ok(typeof got === 'string' && got.length > 40, 'Jito’s real block engine takes a tipped, bundle-only transaction and returns its signature')
}

console.log(`\nall ${n} checks passed`)
