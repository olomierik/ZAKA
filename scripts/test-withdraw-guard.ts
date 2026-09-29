// Offline test of the withdrawal passcode rule (lib/funding.ts,
// components/WithdrawGuard.tsx): who counts as a funding wallet, that the
// remembered ledger can't be edited in storage, and the passcode check itself.
// Run: bun scripts/test-withdraw-guard.ts
//
// The chain is stubbed: Blockdaemon's USDC Transfer logs and getCode. The
// log decoding is also checked against a real mainnet transfer (the engine's
// fixture). The wallet's crypto and signatures are real.

// @ts-expect-error — Bun built-in module; bun-types isn't installed
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('../src/arcdex/wagmi', () => ({ arc: { id: 5042, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } }, MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11' }))

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
g.window = { dispatchEvent: () => true }

const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC = '0x3600000000000000000000000000000000000000'
const NATIVE = '0xfffffffffffffffffffffffffffffffffffffffe'
const FUNDER = '0x1111111111111111111111111111111111111111'
const DELEGATED = '0x2222222222222222222222222222222222222222' // EIP-7702 account
const ROUTER = '0x3333333333333333333333333333333333333333'    // contract paying out a sell
const ATTACKER = '0x4444444444444444444444444444444444444444'
const NEWBIE = '0x5555555555555555555555555555555555555555'
const EXT = '0x6666666666666666666666666666666666666666'       // bridged in from Base
const ZERO = '0x0000000000000000000000000000000000000000'
const codes: Record<string, string | undefined> = {
  [FUNDER]: undefined, [DELEGATED]: '0xef0100' + 'ab'.repeat(20), [ROUTER]: '0x6080604052', [ATTACKER]: undefined, [NEWBIE]: undefined,
}
const codeFails = new Set<string>()
let codeCalls: string[] = []

/** The stub chain: USDC arriving at `me`. `erc20` sends log twice (6 and 18 decimals), others natively (18 only). */
type Send = { block: number; tx: string; from: string; usd: number; erc20?: boolean }
let chain: Send[] = []
let me = ''
let head = 100
let prunedBelow = 0
const afters: number[] = []
const txh = (n: number) => '0x' + n.toString(16).padStart(64, '0')

const logsFor = (s: Send) => {
  const native = { address: NATIVE, topics: [TRANSFER, pad(s.from), pad(me)], data: word(BigInt(Math.round(s.usd * 1e6)) * 10n ** 12n), transactionHash: s.tx, blockNumber: '0x' + s.block.toString(16) }
  const erc20 = { address: USDC, topics: [TRANSFER, pad(s.from), pad(me)], data: word(BigInt(Math.round(s.usd * 1e6))), transactionHash: s.tx, blockNumber: '0x' + s.block.toString(16) }
  return s.erc20 ? [erc20, native] : [native]
}

mock.module('../src/arcdex/lib/recentLogs', () => ({
  recentLogs: async () => { throw new Error('funding should resume from its last block') },
  recentLogsSince: async (f: { address?: string | string[]; topics: (string | null)[] }, after: number) => {
    afters.push(after)
    const addrs = Array.isArray(f.address) ? f.address.map(a => a.toLowerCase()) : []
    if (!addrs.includes(USDC) || !addrs.includes(NATIVE) || f.topics[0] !== TRANSFER || f.topics[2] !== pad(me)) throw new Error('unexpected filter')
    const logs = chain.filter(s => s.block > after && s.block <= head && s.block >= prunedBelow).flatMap(logsFor)
    return { logs, scannedTo: Math.max(head, after) }
  },
}))
mock.module('../src/arcdex/api/launchpad', () => ({
  client: {
    getCode: async ({ address }: { address: string }) => {
      const a = address.toLowerCase()
      codeCalls.push(a)
      if (codeFails.has(a)) throw new Error('rpc down')
      return codes[a]
    },
  },
}))

const w = await import('../src/arcdex/lib/embeddedWallet')
const f = await import('../src/arcdex/lib/funding')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const fails = async (p: Promise<unknown>, want: RegExp, m: string) => {
  try { await p } catch (e) { ok(want.test((e as Error).message), `${m} (${(e as Error).message})`); return }
  throw new Error('FAIL: should have thrown — ' + m)
}
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])

console.log('rule')
ok(!f.passcodeRule(true, '0xaa', FUNDER, [FUNDER]).needsPasscode, 'back to the funding wallet: no passcode')
ok(f.passcodeRule(true, '0xaa', FUNDER.toUpperCase().replace('0X', '0x'), [FUNDER]).isFunder, 'funding wallet matched regardless of case')
ok(f.passcodeRule(true, '0xaa', ATTACKER, [FUNDER]).needsPasscode, 'any other address: passcode')
ok(f.passcodeRule(true, '0xaa', 'So1anaAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', [FUNDER]).needsPasscode, 'a Solana address: passcode')
ok(!f.passcodeRule(true, '0xAA', '0xaa', []).needsPasscode, "the trading wallet's own address (another chain): no passcode")
ok(!f.passcodeRule(false, '0xaa', ATTACKER, []).needsPasscode, 'an external wallet is never asked (it confirms itself)')
ok(!f.passcodeRule(true, '0xaa', '', [FUNDER]).needsPasscode, 'nothing entered yet: nothing asked')

console.log('reading deposits')
{
  // A real ERC-20 USDC transfer on Arc mainnet: logged by the USDC contract (6 decimals) and 0xff…fe (18).
  const fixture = JSON.parse(readFileSync(new URL('../engine/test/fixtures/mainnet.json', import.meta.url), 'utf8')) as unknown
  const real: { address: string; topics: string[]; data: string; transactionHash: string }[] = []
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk)
    else if (o && typeof o === 'object') {
      const l = o as { address?: string; topics?: string[]; transactionHash?: string }
      if (l.transactionHash && l.topics?.[0] === TRANSFER && [USDC, NATIVE].includes(String(l.address).toLowerCase())) real.push(o as never)
      Object.values(o).forEach(walk)
    }
  }
  walk(fixture)
  const pair = real.find(l => l.address.toLowerCase() === USDC && real.some(n => n !== l && n.transactionHash === l.transactionHash && n.address.toLowerCase() === NATIVE && n.topics[2] === l.topics[2]))!
  const to = '0x' + pair.topics[2].slice(26)
  const got = [...f.depositsIn(real, to).values()].filter(d => d.from === ('0x' + pair.topics[1].slice(26)).toLowerCase())
  ok(got.length === 1 && Math.abs(got[0].usd - Number(BigInt(pair.data)) / 1e6) < 1e-9, `a real mainnet transfer's two logs count once ($${got[0]?.usd})`)
}
me = '0x9999999999999999999999999999999999999999'
{
  const d = f.depositsIn(logsFor({ block: 1, tx: txh(1), from: FUNDER, usd: 12.5 }), me)
  ok(d.size === 1 && [...d.values()][0].usd === 12.5, 'a native send (only 0xff…fe, 18 decimals) is read')
  const other = { address: '0x7777777777777777777777777777777777777777', topics: [TRANSFER, pad(FUNDER), pad(me)], data: word(10n ** 24n), transactionHash: txh(2) }
  const nft = { address: USDC, topics: [TRANSFER, pad(FUNDER), pad(me), word(7n)], data: '0x', transactionHash: txh(3) }
  const out = { address: USDC, topics: [TRANSFER, pad(me), pad(FUNDER)], data: word(5_000_000n), transactionHash: txh(4) }
  ok(f.depositsIn([other, nft, out], me).size === 0, 'other tokens, NFTs and transfers out are not deposits')
  const two = f.depositsIn([...logsFor({ block: 1, tx: txh(5), from: FUNDER, usd: 3, erc20: true }), ...logsFor({ block: 1, tx: txh(5), from: ATTACKER, usd: 4 })], me)
  ok(two.size === 2, 'two senders in one transaction are two deposits')
}

console.log('share rule')
ok(f.fundersOf([{ from: ATTACKER, usd: 0.01 }]).length === 0, 'dust ($0.01) is not funding, even as the only deposit')
ok(same(f.fundersOf([{ from: FUNDER, usd: 950 }, { from: ATTACKER, usd: 2 }]), [FUNDER]), '$2 of $952 (under 5%) is not funding')
ok(same(f.fundersOf([{ from: FUNDER, usd: 950 }, { from: ATTACKER, usd: 50 }]), [FUNDER, ATTACKER]), '$50 of $1,000 (5%) is')
ok(same(f.fundersOf([{ from: ZERO, usd: 900 }, { from: FUNDER, usd: 60 }, { from: ATTACKER, usd: 40 }]), [FUNDER]), 'a mint counts toward the total but is nobody: $40 of $1,000 is not funding')
ok(same(f.fundersOf([{ from: ATTACKER, usd: 20 }, { from: ATTACKER, usd: 20 }, { from: FUNDER, usd: 900 }]), [FUNDER]), "one sender's deposits add up ($40 of $940 is under 5%)")
ok(same(f.fundersOf([{ from: ATTACKER, usd: 30 }, { from: ATTACKER, usd: 30 }, { from: FUNDER, usd: 900 }]), [FUNDER, ATTACKER]), '… and $60 of $960 is over it')

console.log('funding wallets')
me = (await w.createWallet('hunter22')).toLowerCase()
chain = [
  { block: 10, tx: txh(10), from: FUNDER, usd: 100 },                  // native send
  { block: 11, tx: txh(11), from: DELEGATED, usd: 20, erc20: true },   // ERC-20, logged twice
  { block: 12, tx: txh(12), from: ROUTER, usd: 500 },                  // a sell paying out: not funding
  { block: 13, tx: txh(13), from: ATTACKER, usd: 0.01 },               // dust
  { block: 14, tx: txh(14), from: ZERO, usd: 60 },                     // a bridge arrival (mint)
  { block: 15, tx: txh(15), from: me, usd: 7 },                        // itself
]
let found = await f.getFundingWallets(me as `0x${string}`, true)
ok(found.includes(FUNDER), 'an account that sent a real share is a funding wallet')
ok(found.includes(DELEGATED), "an EIP-7702 account counts too — $20 of $180, where the router's $500 would have sunk it below 5%")
ok(!found.includes(ROUTER), 'a contract paying out (a sell) does not')
ok(!found.includes(ATTACKER), 'a dust sender ($0.01) does not')
ok(!found.includes(ZERO) && !found.includes(me), 'mints and the wallet itself do not')
ok(found.length === 2, 'exactly those two')
ok(afters[afters.length - 1] === 0, 'the first scan reads everything Blockdaemon serves')

const codeChecks = codeCalls.length
head = 120
chain.push({ block: 116, tx: txh(116), from: ROUTER, usd: 3 })
found = await f.getFundingWallets(me as `0x${string}`, true)
ok(afters[afters.length - 1] === 100, 'the next scan starts after the last block scanned')
ok(codeCalls.length === codeChecks, 'senders already checked are not looked up again')

prunedBelow = 117 // the deposits have aged out of Blockdaemon's range
head = 130
ok(same(await f.getFundingWallets(me as `0x${string}`, true), [FUNDER, DELEGATED]), 'remembered once the deposits are older than the scan window')

chain.push({ block: 131, tx: txh(131), from: NEWBIE, usd: 90 })
head = 140
codeFails.add(NEWBIE)
found = await f.getFundingWallets(me as `0x${string}`, true)
ok(!found.includes(NEWBIE), "a sender that can't be checked yet is not trusted")
head = 145
codeFails.clear()
found = await f.getFundingWallets(me as `0x${string}`, true)
ok(afters[afters.length - 1] === 130, '… and the scan resumes from before its deposit')
ok(found.includes(NEWBIE), '… which counts once the check works')

console.log('bridge deposits')
// $300 burned on Base by EXT, minted to the trading wallet on Arc in tx 146.
chain.push({ block: 146, tx: txh(146), from: ZERO, usd: 300 })
head = 150
await f.getFundingWallets(me as `0x${string}`, true) // the mint is seen first, as 0x0
await f.addBridgeDeposit(me as `0x${string}`, { from: EXT, usd: 300, burnTx: '0xbeef', mintTx: txh(146) })
found = await f.getFundingWallets(me as `0x${string}`, true)
ok(found.includes(EXT), 'the wallet that bridged it in is a funding wallet')
// Total: 100 + 20 + 0.01 + 60 + 90 + 300 = 570.01 (the mint and the bridge record are one deposit).
const saved_ = () => (JSON.parse(store.get(`arcdex:funding:v2:${me}`)!) as { ledger: { deposits: Record<string, { usd: number }> } }).ledger
const total = () => Object.values(saved_().deposits).reduce((s, d) => s + d.usd, 0)
ok(Math.abs(total() - 570.01) < 1e-9, `the bridged $300 counts once, not also as a mint (total $${total().toFixed(2)})`)
ok(!found.includes(DELEGATED), 'shares follow the total: $20 of $570 is under 5% now')
// The usual order: recorded when the mint confirms, and the next scan sees the mint.
await f.addBridgeDeposit(me as `0x${string}`, { from: EXT, usd: 100, burnTx: '0xcafe', mintTx: txh(152) })
chain.push({ block: 152, tx: txh(152), from: ZERO, usd: 100 })
head = 160
await f.getFundingWallets(me as `0x${string}`, true)
ok(Math.abs(total() - 670.01) < 1e-9, `… and a mint scanned after its bridge record isn't counted again (total $${total().toFixed(2)})`)
const ledger = saved_()
await f.addBridgeDeposit(me as `0x${string}`, { from: me, usd: 5, burnTx: '0xf00d' })
await f.addBridgeDeposit(me as `0x${string}`, { from: 'not an address', usd: 5, burnTx: '0xf00e' })
await f.addBridgeDeposit(me as `0x${string}`, { from: ATTACKER, usd: 0, burnTx: '0xf00f' })
ok(Object.keys((JSON.parse(store.get(`arcdex:funding:v2:${me}`)!) as { ledger: { deposits: object } }).ledger.deposits).length === Object.keys(ledger.deposits).length, 'bridging from itself, from a non-address or $0 records nothing')
await f.addBridgeDeposit(me as `0x${string}`, { from: ATTACKER, usd: 1, burnTx: '0xd05e' })
ok(!(await f.getFundingWallets(me as `0x${string}`, true)).includes(ATTACKER), 'a small bridge deposit is held to the share rule too')

console.log('tamper-proof storage')
const key = `arcdex:funding:v2:${me}`
const saved = store.get(key)!
const edit = (fn: (l: { deposits: Record<string, { from: string; usd: number }>; scannedTo: number }) => void) => {
  const s = JSON.parse(saved) as { ledger: { deposits: Record<string, { from: string; usd: number }>; scannedTo: number }; sig: string }
  fn(s.ledger)
  store.set(key, JSON.stringify(s))
}
edit(l => { l.deposits[`${txh(999)}:${ATTACKER}`] = { from: ATTACKER, usd: 1e6 } })
const beforeScan = afters.length
found = await f.getFundingWallets(me as `0x${string}`, true)
ok(!found.includes(ATTACKER), 'a deposit added to storage by hand is not trusted')
ok(afters[beforeScan] === 0 && !found.includes(FUNDER), 'a tampered ledger is dropped entirely and rescanned (aged-out funders need the passcode)')
edit(l => { l.deposits[`${txh(13)}:${ATTACKER}`] = { from: ATTACKER, usd: 5000 } })
ok(!(await f.getFundingWallets(me as `0x${string}`, true)).includes(ATTACKER), 'an amount raised by hand is not trusted')
store.set(key, saved)
const restored = await f.getFundingWallets(me as `0x${string}`, true)
ok(restored.includes(FUNDER) && restored.includes(EXT), 'the untouched signed ledger is accepted again')

console.log('passcode')
await w.unlock('hunter22')
await w.verifyPasscode('hunter22')
ok(true, 'the right passcode is accepted')
await fails(w.verifyPasscode('wrong!!'), /Wrong passcode/, 'a wrong passcode is refused')
w.lock()
await fails(w.verifyPasscode('hunter22'), /locked/, 'nothing is sent while the wallet is locked')
await f.addBridgeDeposit(me as `0x${string}`, { from: ATTACKER, usd: 1e6, burnTx: '0xabad' })
ok(store.get(key) === saved, 'a locked wallet records nothing (it has to sign)')

// (replaces the stored wallet — last)
const other = await w.importPrivateKey('0x' + '5'.repeat(64), 'another1')
me = other.toLowerCase()
chain = []
prunedBelow = 0
store.set(`arcdex:funding:v2:${me}`, saved)
ok((await f.getFundingWallets(other, true)).length === 0, "another wallet's signed ledger is not accepted")

console.log('ALL WITHDRAW GUARD CHECKS PASSED')
