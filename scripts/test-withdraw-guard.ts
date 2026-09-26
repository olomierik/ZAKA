// Offline test of the withdrawal passcode rule (lib/funding.ts,
// components/WithdrawGuard.tsx): who counts as a funding wallet, that the
// remembered list can't be edited in storage, and the passcode check itself.
// Run: bun scripts/test-withdraw-guard.ts
//
// The chain is stubbed: the recent USDC Transfer logs and getCode.
// The wallet's crypto and signatures are real.

// @ts-expect-error — Bun built-in module; bun-types isn't installed
import { mock } from 'bun:test'

mock.module('../src/arcdex/wagmi', () => ({ arc: { id: 5042, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } }, MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11' }))

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
g.window = { dispatchEvent: () => true }

const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const FUNDER = '0x1111111111111111111111111111111111111111'
const DELEGATED = '0x2222222222222222222222222222222222222222' // EIP-7702 account
const ROUTER = '0x3333333333333333333333333333333333333333'    // contract paying out a sell
const ATTACKER = '0x4444444444444444444444444444444444444444'
const ZERO = '0x0000000000000000000000000000000000000000'
const codes: Record<string, string | undefined> = {
  [FUNDER]: undefined, [DELEGATED]: '0xef0100' + 'ab'.repeat(20), [ROUTER]: '0x6080604052',
}
let senders: string[] = []
let me = ''
let scans = 0

mock.module('../src/arcdex/lib/recentLogs', () => ({
  recentLogs: async (f: { address?: string; topics: (string | null)[] }) => {
    scans++
    if (f.address !== '0x3600000000000000000000000000000000000000' || f.topics[0] !== TRANSFER || f.topics[2] !== pad(me)) throw new Error('unexpected filter')
    return senders.map(s => ({ address: f.address, topics: [TRANSFER, pad(s), pad(me)] }))
  },
}))
mock.module('../src/arcdex/api/launchpad', () => ({
  client: { getCode: async ({ address }: { address: string }) => codes[address.toLowerCase()] },
}))

const w = await import('../src/arcdex/lib/embeddedWallet')
const f = await import('../src/arcdex/lib/funding')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const fails = async (p: Promise<unknown>, want: RegExp, m: string) => {
  try { await p } catch (e) { ok(want.test((e as Error).message), `${m} (${(e as Error).message})`); return }
  throw new Error('FAIL: should have thrown — ' + m)
}

console.log('rule')
ok(!f.passcodeRule(true, '0xaa', FUNDER, [FUNDER]).needsPasscode, 'back to the funding wallet: no passcode')
ok(f.passcodeRule(true, '0xaa', FUNDER.toUpperCase().replace('0X', '0x'), [FUNDER]).isFunder, 'funding wallet matched regardless of case')
ok(f.passcodeRule(true, '0xaa', ATTACKER, [FUNDER]).needsPasscode, 'any other address: passcode')
ok(f.passcodeRule(true, '0xaa', 'So1anaAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', [FUNDER]).needsPasscode, 'a Solana address: passcode')
ok(!f.passcodeRule(true, '0xAA', '0xaa', []).needsPasscode, "the trading wallet's own address (another chain): no passcode")
ok(!f.passcodeRule(false, '0xaa', ATTACKER, []).needsPasscode, 'an external wallet is never asked (it confirms itself)')
ok(!f.passcodeRule(true, '0xaa', '', [FUNDER]).needsPasscode, 'nothing entered yet: nothing asked')

console.log('funding wallets')
me = (await w.createWallet('hunter22')).toLowerCase()
senders = [FUNDER, DELEGATED, ROUTER, ZERO, me]
const found = await f.getFundingWallets(me as `0x${string}`, true)
ok(found.includes(FUNDER), 'an account that sent USDC is a funding wallet')
ok(found.includes(DELEGATED), 'an EIP-7702 account counts too')
ok(!found.includes(ROUTER), 'a contract paying out (a sell) does not')
ok(!found.includes(ZERO) && !found.includes(me), 'mints (bridge arrivals) and the wallet itself do not')
ok(found.length === 2, 'exactly those two')

senders = []
const later = await f.getFundingWallets(me as `0x${string}`, true)
ok(later.includes(FUNDER) && later.includes(DELEGATED), 'remembered once the deposit is older than the scan window')

const key = `arcdex:funding:v1:${me}`
const saved = JSON.parse(store.get(key)!) as { list: string[]; sig: string }
store.set(key, JSON.stringify({ ...saved, list: [...saved.list, ATTACKER] }))
const tampered = await f.getFundingWallets(me as `0x${string}`, true)
ok(!tampered.includes(ATTACKER), 'an address added to storage by hand is not trusted')
ok(tampered.length === 0, 'a tampered list is dropped entirely (passcode asked)')
store.set(key, JSON.stringify(saved))
ok((await f.getFundingWallets(me as `0x${string}`, true)).length === 2, 'the untouched signed list is accepted again')

console.log('passcode')
await w.unlock('hunter22')
await w.verifyPasscode('hunter22')
ok(true, 'the right passcode is accepted')
await fails(w.verifyPasscode('wrong!!'), /Wrong passcode/, 'a wrong passcode is refused')
w.lock()
await fails(w.verifyPasscode('hunter22'), /locked/, 'nothing is sent while the wallet is locked')

// (replaces the stored wallet — last)
const other = await w.importPrivateKey('0x' + '5'.repeat(64), 'another1')
store.set(`arcdex:funding:v1:${other.toLowerCase()}`, JSON.stringify(saved))
ok((await f.getFundingWallets(other, true)).length === 0, "another wallet's signed list is not accepted")

ok(scans > 0, 'the chain was scanned')
console.log('ALL WITHDRAW GUARD CHECKS PASSED')
