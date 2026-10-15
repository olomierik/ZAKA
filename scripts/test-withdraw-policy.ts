// The withdraw limits (src/arcdex/lib/withdrawPolicy.ts): new addresses, the daily limit, USDC sends read from Arc's
// logs, the signed record's message, the address checks and the flag. Offline.
//   bun scripts/test-withdraw-policy.ts
import { pad } from 'viem'
import { flag } from '../src/arcdex/lib/flags'
import { bookMessage, destinationProblem, mergeBooks, sendsIn, withdrawVerdict, WITHDRAW_POLICY, type WithdrawBook } from '../src/arcdex/lib/withdrawPolicy'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 15, 12)
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20)
const book = (known: Record<string, number>, sends: WithdrawBook['sends'] = []): WithdrawBook => ({ known, sends })

console.log('new addresses')
let v = withdrawVerdict(book({}), A, 200, NOW)
check(v.ok && v.isNew && v.newLeft === 250, 'a never-paid address takes up to $250')
v = withdrawVerdict(book({}), A, 251, NOW)
check(!v.ok && v.isNew && /new/i.test(v.reason ?? '') && /Save it/.test(v.reason ?? '') && v.retryAt === undefined, '$251 to it is refused, with a way forward: save it')
v = withdrawVerdict(book({ [A]: NOW - 2 * H }), A, 1000, NOW)
check(!v.ok && v.retryAt === NOW - 2 * H + 24 * H, 'saved 2 hours ago: the full amount from 24 hours after saving')
v = withdrawVerdict(book({ [A]: NOW - 25 * H }), A, 1000, NOW)
check(v.ok && !v.isNew && v.newLeft === Infinity, 'saved 25 hours ago: no longer new')
v = withdrawVerdict(book({ [B]: NOW - 10 * H }, [{ tx: '0x1', to: B, usd: 200, at: NOW - 10 * H }]), A, 100, NOW)
check(!v.ok && v.newLeft === 50, 'new addresses share the $250: $200 to one leaves $50 for another')
v = withdrawVerdict(book({ [B]: NOW - 40 * H }, [{ tx: '0x1', to: B, usd: 200, at: NOW - 3 * H }]), A, 240, NOW)
check(v.ok, 'a send to a known address doesn’t use the new-address allowance')
v = withdrawVerdict(book({ [A]: NOW - 20 * H }), A.toUpperCase().replace('0X', '0x'), 10, NOW)
check(v.isNew && v.knownFrom === NOW + 4 * H, 'addresses match whatever their case')

console.log('the daily limit')
const day = [{ tx: '0x1', to: C, usd: 1500, at: NOW - 20 * H }, { tx: '0x2', to: C, usd: 900, at: NOW - 5 * H }]
v = withdrawVerdict(book({ [C]: NOW - 50 * H, [A]: NOW - 50 * H }, day), A, 100, NOW)
check(v.ok && Math.abs(v.dailyLeft - 100) < 1e-9, '$2,400 sent today leaves $100')
v = withdrawVerdict(book({ [C]: NOW - 50 * H, [A]: NOW - 50 * H }, day), A, 600, NOW)
check(!v.ok && v.retryAt === NOW - 20 * H + 24 * H && /Daily limit/.test(v.reason ?? ''), '$600 more waits until the $1,500 send is a day old')
v = withdrawVerdict(book({ [A]: NOW - 50 * H }), A, 2600, NOW)
check(!v.ok && v.retryAt === undefined && /in parts/.test(v.reason ?? ''), 'more than the whole limit: told to send it in parts')
v = withdrawVerdict(book({ [C]: NOW - 50 * H, [A]: NOW - 50 * H }, [{ tx: '0x1', to: C, usd: 2500, at: NOW - 25 * H }]), A, 2500, NOW)
check(v.ok, 'a send over a day old no longer counts')
v = withdrawVerdict(book({ [A]: NOW - 50 * H }), A, 2500, NOW, { ...WITHDRAW_POLICY, dailyUsd: 100 })
check(!v.ok, 'the limits come from the policy passed in')

console.log('USDC sent, read from Arc’s logs')
const ME = '0x' + '11'.repeat(20)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const log = (address: string, from: string, to: string, value: bigint, tx: string, block = 100, ts?: number) =>
  ({ address, topics: [TRANSFER, pad(from as `0x${string}`), pad(to as `0x${string}`)], data: '0x' + value.toString(16), transactionHash: tx, blockNumber: '0x' + block.toString(16), ...(ts ? { blockTimestamp: '0x' + ts.toString(16) } : {}) })
const USDC = '0x3600000000000000000000000000000000000000', NATIVE = '0xfffffffffffffffffffffffffffffffffffffffe'
const sends = sendsIn([
  log(USDC, ME, A, 5_000_000n, '0xaa', 100, 1_760_000_000),          // an ERC-20 transfer of $5 …
  log(NATIVE, ME, A, 5_000_000_000_000_000_000n, '0xaa', 100, 1_760_000_000), // … logged twice: once
  log(NATIVE, ME, B, 2_500_000_000_000_000_000n, '0xbb', 101),       // a native send of $2.50, no block time
  log(USDC, A, ME, 9_000_000n, '0xcc'),                               // money in: not a send
  log(USDC, ME, ME, 1_000_000n, '0xdd'),                              // to itself: not a send
  log('0x' + '99'.repeat(20), ME, A, 1n, '0xee'),                     // another token: not USDC
], ME)
check(sends.length === 2, 'two sends: the ERC-20 transfer once, and the native one')
check(sends.find(s => s.to === A)?.usd === 5 && sends.find(s => s.to === A)?.at === 1_760_000_000_000, '$5 in 6 decimals, with its block’s time')
check(sends.find(s => s.to === B)?.usd === 2.5 && sends.find(s => s.to === B)?.at === undefined && sends.find(s => s.to === B)?.block === 101, '$2.50 in 18 decimals; a log without a time keeps its block for the caller to read')

console.log('the record')
const mine = book({ [A]: NOW - 5 * H }, [{ tx: '0xaa', to: A, usd: 7, at: NOW - 5 * H }])
const chain = book({ [A]: NOW - 30 * H, [B]: NOW - H }, [{ tx: '0xaa', to: A, usd: 5, at: NOW - 5 * H }, { tx: '0xbb', to: B, usd: 2.5, at: NOW - H }])
const merged = mergeBooks(mine, chain)
check(merged.known[A] === NOW - 30 * H && merged.known[B] === NOW - H, 'merged: each address keeps its earliest time')
check(merged.sends.length === 2 && merged.sends.find(s => s.tx === '0xaa')?.usd === 7, 'merged: a transfer counts once, this browser’s value kept')
check(bookMessage(ME, book({ [B]: 2, [A]: 1 }, [{ tx: '0x2', to: B, usd: 1, at: 5 }, { tx: '0x1', to: A, usd: 1, at: 4 }])) === bookMessage(ME, book({ [A]: 1, [B]: 2 }, [{ tx: '0x1', to: A, usd: 1, at: 4 }, { tx: '0x2', to: B, usd: 1, at: 5 }])), 'the signed message doesn’t depend on order')
check(bookMessage(ME, mine) !== bookMessage(ME, { ...mine, known: { [A]: NOW - 30 * H } }), 'backdating an address changes the signed message')

console.log('address checks')
check(destinationProblem('', ME, [USDC]) === null, 'nothing typed: nothing to say')
check(/40/.test(destinationProblem('0x123', ME, [USDC]) ?? ''), 'too short')
check(/zero address/.test(destinationProblem('0x' + '0'.repeat(40), ME, [USDC]) ?? ''), 'the zero address')
check(/own address/.test(destinationProblem(ME.toUpperCase().replace('0X', '0x'), ME, [USDC]) ?? ''), 'the wallet itself')
check(/token’s contract/.test(destinationProblem(USDC, ME, [USDC]) ?? ''), 'USDC’s own contract')
check(destinationProblem(A, ME, [USDC]) === null, 'an ordinary address passes')

console.log('the flag')
check(flag('withdrawLimits', {}) === true && flag('withdrawLimits', { VITE_FLAG_WITHDRAW_LIMITS: 'off' }) === false, 'on by default; VITE_FLAG_WITHDRAW_LIMITS=off turns it off')
check(flag('privy', {}) === false && flag('privy', { VITE_FLAG_PRIVY: 'on' }) === true, 'Privy off by default')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
