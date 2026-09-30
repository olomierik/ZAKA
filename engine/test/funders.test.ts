// Who funded a bot's live wallet: where money may go back without an emailed code.

import { describe, expect, test } from 'bun:test'
import { pad, toHex, type Hex } from 'viem'
import type { RawLog } from '../../api/_arcLogs'
import type { Rpc } from '../src/chain/http'
import { depositsIn, emptyLedger, FUNDER, fundersOf, isContractCode, knownFunders, scanFunding } from '../src/bot/funders'

const USDC = '0x3600000000000000000000000000000000000000'
const NATIVE = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const BOT = '0x' + 'b0'.repeat(20)
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20)
const log = (o: { address?: string; from: string; to?: string; raw: bigint; tx: string }): RawLog => ({
  address: o.address ?? USDC, topics: [TRANSFER, pad(o.from as Hex), pad((o.to ?? BOT) as Hex)], data: toHex(o.raw), blockNumber: '0x1', transactionHash: o.tx, logIndex: '0x0',
})

describe('deposits', () => {
  test('an ERC-20 transfer, logged by USDC and the native logger, counts once; native sends in 18 decimals', () => {
    const d = depositsIn([
      log({ from: A, raw: 25_000_000n, tx: '0x1' }),
      log({ address: NATIVE, from: A, raw: 25n * 10n ** 18n, tx: '0x1' }),
      log({ address: NATIVE, from: B, raw: 5n * 10n ** 17n, tx: '0x2' }),
      log({ from: A, to: '0x' + '99'.repeat(20), raw: 1_000_000n, tx: '0x3' }), // to someone else
    ], BOT)
    expect(d).toEqual({ [`0x1:${A}`]: { from: A, usd: 25 }, [`0x2:${B}`]: { from: B, usd: 0.5 } })
  })
})

describe('funders', () => {
  const ledger = (deposits: [string, number][], contracts: string[] = []) => ({ ...emptyLedger(), deposits: Object.fromEntries(deposits.map(([from, usd], i) => [`0x${i}:${from}`, { from, usd }])), contracts, wallets: deposits.map(([f]) => f) })
  test('at least $1 and at least 5% of what ordinary wallets sent', () => {
    expect(fundersOf(ledger([[A, 100], [B, 4]]))).toEqual([{ address: A, usd: 100 }])
    expect(fundersOf(ledger([[A, 100], [B, 6]])).map(f => f.address)).toEqual([A, B])
    expect(fundersOf(ledger([[A, 0.9]]))).toEqual([]) // under $1
  })
  test('a contract paying out (a sale) is neither a funder nor part of the total', () => {
    expect(fundersOf(ledger([[A, 3], [B, 1_000]], [B]))).toEqual([{ address: A, usd: 3 }])
  })
  test('a sender not yet checked for code is no funder', () => {
    const l = { ...ledger([[A, 10], [B, 10]]), wallets: [A] }
    expect(knownFunders(l)).toEqual([{ address: A, usd: 10 }])
  })
  test('code: an EIP-7702 delegation is still an ordinary wallet', () => {
    expect(isContractCode('0x')).toBe(false)
    expect(isContractCode('0xef0100' + 'ab'.repeat(20))).toBe(false)
    expect(isContractCode('0x6080604052')).toBe(true)
  })
})

describe('scanning the chain', () => {
  test('9k-block slices from the start, the contiguous prefix kept, senders checked for code', async () => {
    const asked: [number, number][] = []
    let fail = 3
    const rpc: Rpc = {
      call: async <T>() => toHex(40_000) as T,
      batch: async <T>(calls: { method: string; params: unknown[] }[]) => calls.map(c => {
        if (c.method === 'eth_getCode') return ((c.params[0] as string) === B ? '0x6080' : '0x') as T
        const f = c.params[0] as { fromBlock: string; toBlock: string }
        const r: [number, number] = [Number(f.fromBlock), Number(f.toBlock)]
        asked.push(r)
        if (r[0] === 1 + 3 * FUNDER.slice && fail-- > 0) return null as T // one slice unanswered, once
        return (r[0] === 1 ? [log({ from: A, raw: 7_000_000n, tx: '0xa' }), log({ from: B, raw: 90_000_000n, tx: '0xb' })] : []) as T
      }),
    }
    const first = await scanFunding(rpc, BOT, emptyLedger(), 1)
    expect(first.scannedTo).toBe(3 * FUNDER.slice) // stopped before the unanswered slice
    expect(first.wallets).toEqual([A])
    expect(first.contracts).toEqual([B])
    expect(knownFunders(first)).toEqual([{ address: A, usd: 7 }])
    fail = 0
    const next = await scanFunding(rpc, BOT, first, 1)
    expect(next.scannedTo).toBe(40_000)
    expect(asked.filter(([a]) => a === 1)).toHaveLength(1) // never read twice
  })
})
