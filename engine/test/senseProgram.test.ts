// $SENSE buyback and liquidity (engine/src/sense/program.ts): the fee wallet's transactions read
// as fees, buybacks, burns and liquidity; 30% / 70% owed; and a scan against a stand-in RPC.
import { describe, expect, test } from 'bun:test'
import { pad, toHex } from 'viem'
import type { RawLog } from '../../api/_arcLogs'
import type { Rpc } from '../src/chain/http'
import { apply, classify, DEAD, emptyState, FEE_WALLET, FEE_SOURCES, flowsOf, SENSE, SenseProgram, view, type ClassifyCtx } from '../src/sense/program'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const USDC = '0x3600000000000000000000000000000000000000'
const LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const ARGUS = '0x00000000000000000000000000000000000a1905'
const ROUTER = '0x00000000000000000000000000000000000000c1'
const OWNER = '0x414b6be4cf906739fbf7d49165beca5f4ceec3da'
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const FUTURES = '0x00000000000000000000000000000000000fa7e5'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'
let idx = 0
/** A block standing in for the program's first. */
const START = 23_961_256

const t = (token: string, from: string, to: string, amount: bigint, tx = '0xaa', block = START + 10): RawLog => ({
  address: token, topics: [TRANSFER, pad(from as `0x${string}`), pad(to as `0x${string}`)], data: pad(toHex(amount)),
  blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(idx++),
})
/** An ERC-20 USDC transfer, as Arc logs it: by the token (6 decimals) and the native logger (18). */
const usdc = (from: string, to: string, dollars: number, tx = '0xaa', block?: number) => [
  t(USDC, from, to, BigInt(Math.round(dollars * 1e6)), tx, block),
  t(LOGGER, from, to, BigInt(Math.round(dollars * 1e6)) * 10n ** 12n, tx, block),
]
const sense = (from: string, to: string, n: number, tx = '0xaa', block?: number) => t(SENSE, from, to, BigInt(n) * 10n ** 18n, tx, block)
const modify = (delta: bigint, tx = '0xaa'): RawLog => ({
  address: POOL_MANAGER, topics: [MODIFY, pad('0x01'), pad(ROUTER as `0x${string}`)],
  data: `0x${[0n, 0n, BigInt.asUintN(256, delta), 0n].map(x => x.toString(16).padStart(64, '0')).join('')}`,
  blockNumber: toHex(START + 10), transactionHash: tx, logIndex: toHex(idx++),
})

const ctx: ClassifyCtx = {
  feeWallet: FEE_WALLET, sense: SENSE, feeSources: new Set([ROUTER]), liquidityTargets: new Set([FUTURES]),
  priceOf: tok => (tok === USDC ? 1 : tok === SENSE ? 0.000002 : tok === ARGUS ? 0.5 : null),
  decimals: tok => (tok === USDC ? 6 : 18),
}
const someone = '0x00000000000000000000000000000000000000b0'

describe('reading the fee wallet', () => {
  test('a USDC transfer logged twice counts once', () => {
    const f = flowsOf(usdc(ROUTER, FEE_WALLET, 2.5), FEE_WALLET, ctx.decimals)
    expect(f.usdc.in).toBe(2.5)
    expect(f.usdcSenders.get(ROUTER)).toBe(2.5)
  })

  test('fees: USDC ARCSENSE\'s contracts paid, not a person\'s transfer', () => {
    expect(classify(someone, usdc(ROUTER, FEE_WALLET, 2), ctx)).toEqual([{ kind: 'fee', usd: 2 }])
    expect(classify(OWNER, usdc(OWNER, FEE_WALLET, 500), ctx)).toEqual([])
    // A plain native transfer from someone's wallet (as on 2026-10-03: $11.95 from 0x90a9…7799).
    expect(classify(someone, [t(LOGGER, someone, FEE_WALLET, 1195n * 10n ** 16n)], ctx)).toEqual([])
    // The real fee contracts: the swap routers, the curve router, the launchpad and the Universal Router.
    expect(FEE_SOURCES).toContain('0xd07583f7db671521aacfda2b4612ad187aa2924e')
    expect(FEE_SOURCES.length).toBe(6)
    // A native-only payment (the curve router pays in native USDC): the logger alone.
    expect(classify(someone, [t(LOGGER, ROUTER, FEE_WALLET, 3n * 10n ** 18n)], ctx)).toEqual([{ kind: 'fee', usd: 3 }])
    // Liquidity coming back from the futures pool isn't a fee.
    expect(classify(someone, usdc(FUTURES, FEE_WALLET, 100), ctx)).toEqual([{ kind: 'unliquidity', usd: 100 }])
  })

  test('a buyback: USDC out, $SENSE in, the router\'s fee back to itself netted', () => {
    const logs = [...usdc(FEE_WALLET, ROUTER, 10), ...usdc(ROUTER, FEE_WALLET, 0.2), sense(POOL_MANAGER, FEE_WALLET, 4_000_000)]
    expect(classify(FEE_WALLET, logs, ctx)).toEqual([{ kind: 'buyback', usd: 9.8, sense: 4_000_000 }])
  })

  test('a buyback paid in ARGUS is valued at its price, and stays a buyback when the pool\'s hook touches liquidity', () => {
    const logs = [t(ARGUS, FEE_WALLET, POOL_MANAGER, 20n * 10n ** 18n), sense(POOL_MANAGER, FEE_WALLET, 5_000_000), modify(10n ** 18n)]
    expect(classify(FEE_WALLET, logs, ctx)).toEqual([{ kind: 'buyback', usd: 10, sense: 5_000_000 }])
  })

  test('a burn: $SENSE to the dead address', () => {
    expect(classify(FEE_WALLET, [sense(FEE_WALLET, DEAD, 3_000_000)], ctx)).toEqual([{ kind: 'burn', usd: 6, sense: 3_000_000 }])
    // Sent anywhere else, it isn't a burn.
    expect(classify(FEE_WALLET, [sense(FEE_WALLET, someone, 3_000_000)], ctx)).toEqual([])
  })

  test('liquidity: added to a pool at its value, taken back out against it', () => {
    const add = [modify(10n ** 18n), sense(FEE_WALLET, POOL_MANAGER, 10_000_000), t(ARGUS, FEE_WALLET, POOL_MANAGER, 40n * 10n ** 18n)]
    expect(classify(FEE_WALLET, add, ctx)).toEqual([{ kind: 'liquidity', usd: 40 }]) // $20 of SENSE + $20 of ARGUS
    const remove = [modify(-(10n ** 18n)), ...usdc(POOL_MANAGER, FEE_WALLET, 15)]
    expect(classify(FEE_WALLET, remove, ctx)).toEqual([{ kind: 'unliquidity', usd: 15 }])
    // USDC into the futures pool.
    expect(classify(FEE_WALLET, usdc(FEE_WALLET, FUTURES, 70), ctx)).toEqual([{ kind: 'liquidity', usd: 70 }])
    // Anything else the wallet does (paying a bill, moving money) isn't counted.
    expect(classify(FEE_WALLET, usdc(FEE_WALLET, someone, 50), ctx)).toEqual([])
  })

  test('30% owed to the buyback, 70% to liquidity, and what\'s still pending', () => {
    const at = Date.UTC(2026, 9, 3, 12)
    const s = apply(emptyState(), [
      { kind: 'fee', usd: 100, tx: '0x1', block: 1, at },
      { kind: 'fee', usd: 50, tx: '0x2', block: 2, at: at + 86_400_000 },
      { kind: 'buyback', usd: 30, sense: 1_000_000, tx: '0x3', block: 3, at },
      { kind: 'burn', usd: 2, sense: 1_000_000, tx: '0x4', block: 4, at },
      { kind: 'liquidity', usd: 80, tx: '0x5', block: 5, at },
      { kind: 'unliquidity', usd: 10, tx: '0x6', block: 6, at },
    ])
    const v = view(s, 1_234)
    expect(v.totals).toMatchObject({ feesUsd: 150, buybackOwedUsd: 45, buybackUsd: 30, senseBought: 1_000_000, senseBurned: 1_000_000, liquidityOwedUsd: 105, liquidityUsd: 70, deadBalance: 1_234 })
    expect(v.pending).toEqual({ buybackUsd: 15, liquidityUsd: 35 })
    expect(v.feeDays).toEqual([{ day: '2026-10-03', usd: 100 }, { day: '2026-10-04', usd: 50 }])
    expect(v.actions.map(a => a.kind)).toEqual(['unliquidity', 'liquidity', 'burn', 'buyback'])
    expect(v.program).toMatchObject({ buybackPct: 30, liquidityPct: 70, started: false, since: '2026-10-04T00:00:00Z' })
  })
})

describe('scanning the chain', () => {
  test('finds its first block, reads the fee wallet\'s transactions from it, and resumes where it stopped', async () => {
    const B = START
    const feeTx = '0xf1', buyTx = '0xb1', burnTx = '0xd1', outside = '0xee'
    const all: RawLog[] = [
      ...usdc(ROUTER, FEE_WALLET, 4, feeTx, B + 5),
      ...usdc(FEE_WALLET, ROUTER, 1, buyTx, B + 20_000),
      sense(POOL_MANAGER, FEE_WALLET, 400_000, buyTx, B + 20_000),
      sense(FEE_WALLET, DEAD, 400_000, burnTx, B + 20_001),
      ...usdc(ROUTER, FEE_WALLET, 9, outside, B - 5), // before the program
    ]
    const senders: Record<string, string> = { [feeTx]: someone, [buyTx]: FEE_WALLET, [burnTx]: FEE_WALLET, [outside]: someone }
    let head = B + 15_000
    const settings = new Map<string, string>()
    const rpc = {
      call: async (method: string, params: unknown[]) => {
        if (method === 'eth_blockNumber') return toHex(head)
        if (method === 'eth_call') return toHex(5n * 10n ** 18n)
        if (method === 'eth_getBlockByNumber') return { timestamp: toHex(1_790_985_600 + Number(BigInt(params[0] as string)) - B) }
        throw new Error(method)
      },
      batch: async (calls: { method: string; params: unknown[] }[]) => calls.map(c => {
        const p = c.params[0] as Record<string, unknown> & string
        if (c.method === 'eth_getLogs') {
          const from = Number(BigInt(p.fromBlock as string)), to = Number(BigInt(p.toBlock as string))
          const [, a, b] = p.topics as (string | null)[]
          return all.filter(l => {
            const n = Number(BigInt(l.blockNumber))
            const addrs = (p.address as string[]).map(x => x.toLowerCase())
            return n >= from && n <= to && addrs.includes(l.address.toLowerCase()) && (a == null || l.topics[1] === a) && (b == null || l.topics[2] === b)
          })
        }
        if (c.method === 'eth_getTransactionByHash') return { from: senders[c.params[0] as string] }
        if (c.method === 'eth_getTransactionReceipt') return { logs: all.filter(l => l.transactionHash === c.params[0]) }
        if (c.method === 'eth_getBlockByNumber') return { timestamp: toHex(1_790_985_600 + Number(BigInt(c.params[0] as string)) - B) }
        if (c.method === 'eth_call') return toHex(18)
        return null
      }),
    } as unknown as Rpc
    const p = new SenseProgram({ rpc, settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } }, priceOf: tok => (tok === SENSE ? 0.0000025 : null), feeSources: [ROUTER], since: '2026-10-03T00:00:00Z' })
    await p.tick()
    expect(p.state.startBlock).toBe(B)
    expect(p.state.scannedTo).toBe(head)
    expect(p.view().totals).toMatchObject({ feesUsd: 4, buybackUsd: 0, senseBurned: 0 })
    expect(p.view().fees[0]).toMatchObject({ kind: 'fee', usd: 4, tx: feeTx, at: 1_790_985_605_000 })
    head = B + 30_000
    await p.tick()
    expect(p.view().totals).toMatchObject({ feesUsd: 4, buybackUsd: 1, senseBought: 400_000, senseBurned: 400_000, deadBalance: 5 })
    expect(p.view().pending).toEqual({ buybackUsd: 0.2, liquidityUsd: 2.8 })
    // Saved, and picked up by a fresh ledger.
    const q = new SenseProgram({ rpc, settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } }, priceOf: () => null, since: '2026-10-03T00:00:00Z' })
    await q.start()
    q.stop()
    expect(q.state.scannedTo).toBe(head)
    expect(q.state.feesUsd).toBe(4)
  })
})
