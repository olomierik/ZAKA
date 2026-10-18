// The prediction pool end to end on a local chain (anvil, as chain 5042002): the engine deploys the build on the
// futures' test USDC, traders deposit and trade, and the keeper fills every request at the mid it's given, signed
// with its own key; a win the empty pool can't pay waits in the queue and a later loss pays it; a market with no
// price is refunded; a settled market is proposed, waits its delay and is paid out. Skipped where anvil isn't
// installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, getAddress, http, type Address, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { PREDICT_POOL_ABI, PREDICT_TOKEN_ABI } from '../src/predictpool/abi'
import { deployPool, verifyPool, type PoolDeployStore } from '../src/predictpool/deploy'
import { PredictPoolKeeper, type PoolMarketData } from '../src/predictpool/keeper'
import type { PredictPoolDeployment } from '../src/predictpool/shared'
import { TEST_USDC_ABI } from '../src/perps/abi'
import { TEST_USDC_BYTECODE } from '../src/perps/build'
import { ARC_TESTNET } from '../src/perps/shared'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil'
const ANVIL = [join(homedir(), '.foundry', 'bin', exe)].find(p => existsSync(p)) ?? (Bun.which('anvil') ?? null)
const PORT = 8598
const RPC = `http://127.0.0.1:${PORT}`
// anvil's well-known development keys; bob's is made here and funded with anvil_setBalance.
const KEEPER_PK: `0x${string}` = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ALICE_PK: `0x${string}` = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const BOB_PK = generatePrivateKey() // funded in beforeAll

describe.skipIf(!ANVIL)('the prediction pool on a local chain', () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let client: PublicClient
  const chain = { ...ARC_TESTNET, rpcUrls: { default: { http: [RPC] } } }
  const keeperAcc = privateKeyToAccount(KEEPER_PK)
  const alice = privateKeyToAccount(ALICE_PK)
  const bob = privateKeyToAccount(BOB_PK)
  const wallet = (pk: `0x${string}`) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) })
  const keeperWallet = wallet(KEEPER_PK)
  let usdc: Address
  let dep: PredictPoolDeployment
  let keeper: PredictPoolKeeper
  let offset = 0 // ms the chain's clock is ahead of ours (evm_increaseTime)

  // The market data the keeper reads: mids and settlements the test sets.
  const mids = new Map<string, number>()
  const settled = new Map<number, number>()
  const data: PoolMarketData = {
    tradeableMid: async (o, s) => mids.get(`${o}:${s}`) ?? null,
    settlementOf: async o => settled.get(o) ?? null,
    specOf: () => null,
  }

  const rpc = (method: string, params: unknown[] = []) => client.request({ method: method as never, params: params as never })
  /** Moves the chain's clock (and the keeper's) forward. */
  async function later(sec: number) {
    await rpc('evm_increaseTime', [sec])
    await rpc('evm_mine')
    offset += sec * 1000
  }
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: dep.pool as Address, abi: PREDICT_POOL_ABI, functionName: functionName as never, args: args as never }) as Promise<T>
  async function send(pk: `0x${string}`, address: Address, abi: typeof PREDICT_POOL_ABI | typeof TEST_USDC_ABI, functionName: string, args: unknown[]) {
    const hash = await wallet(pk).writeContract({ address, abi, functionName, args } as never)
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success')
  }
  const pool = (pk: `0x${string}`, fn: string, args: unknown[]) => send(pk, dep.pool as Address, PREDICT_POOL_ABI, fn, args)
  const bal = (a: Address) => read<bigint>('balances', [a])
  /** A request, then the keeper's pass a second later (the fill must be signed after the request's second). */
  async function trade(pk: `0x${string}`, fn: 'requestBuy' | 'requestSell', args: unknown[]) {
    await pool(pk, fn, args)
    await keeper.run()
    await later(1)
    await keeper.run()
  }

  beforeAll(async () => {
    proc = Bun.spawn([ANVIL!, '--port', String(PORT), '--chain-id', String(ARC_TESTNET.id), '--silent'], { stdout: 'ignore', stderr: 'ignore' })
    client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient
    for (let i = 0; i < 100; i++) {
      try { await client.getChainId(); break } catch { await Bun.sleep(100) }
    }
    const hash = await keeperWallet.deployContract({ abi: TEST_USDC_ABI, bytecode: TEST_USDC_BYTECODE, args: [keeperAcc.address, 0n] })
    usdc = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!)
    let saved: PredictPoolDeployment | null = null
    const store: PoolDeployStore = { get: async () => saved, set: async d => { saved = structuredClone(d) } }
    dep = await deployPool({ client, wallet: keeperWallet, store, usdc, owner: '0x00000000000000000000000000000000000000aa' })
    keeper = new PredictPoolKeeper({ client, wallet: keeperWallet, pool: dep.pool as Address, fromBlock: dep.block, data, now: () => Date.now() + offset })
    await rpc('anvil_setBalance', [bob.address, '0x3635C9ADC5DEA00000']) // 1,000 for gas
    for (const pk of [ALICE_PK, BOB_PK]) {
      await send(pk, usdc, TEST_USDC_ABI, 'faucet', [])
      await send(pk, usdc, TEST_USDC_ABI, 'approve', [dep.pool, 500_000_000n])
      await pool(pk, 'deposit', [500_000_000n])
    }
  }, 60_000)

  afterAll(() => { proc?.kill() })

  test('the engine deploys this build, with its keeper as the signer', async () => {
    expect(await verifyPool(client, dep, keeperAcc.address)).toBeNull()
    expect(await verifyPool(client, dep, bob.address)).toContain("not this engine's keeper")
    expect((await read<Address>('owner')).toLowerCase()).toBe('0x00000000000000000000000000000000000000aa')
    expect(await read<bigint>('lpCash')).toBe(0n)
    expect(await bal(alice.address)).toBe(500_000_000n)
  })

  test('a buy fills at the mid signed after it, not in its own second', async () => {
    mids.set('7:0', 0.5)
    await pool(ALICE_PK, 'requestBuy', [7, 0, 100_000_000n, 990_000n])
    await keeper.run()
    expect(keeper.requests.size).toBe(1) // made this second: not priced yet
    await later(1)
    await keeper.run()
    expect(keeper.requests.size).toBe(0)
    const p = await read<{ contracts: bigint; cost: bigint }>('positionOf', [alice.address, 7, 0])
    expect(p.contracts).toBe(200_000_000n)
    expect(p.cost).toBe(100_000_000n)
    expect(keeper.list(alice.address, 10)[0]).toMatchObject({ kind: 'buy', outcome: 7, side: 0, px: '500000' })
  }, 60_000)

  test('the pool starts empty, so a win waits in the queue; a later loss pays it', async () => {
    mids.set('7:0', 0.6)
    await trade(ALICE_PK, 'requestSell', [7, 0, 200_000_000n, 0n])
    expect(await bal(alice.address)).toBe(500_000_000n) // her $100 back; the $20 profit waits
    expect(await read<bigint>('queuedOf', [alice.address])).toBe(19_600_000n)
    expect(keeper.list(alice.address, 1)[0]).toMatchObject({ kind: 'sell', pnl: '19600000' })
    mids.set('8:0', 0.5)
    await trade(BOB_PK, 'requestBuy', [8, 0, 50_000_000n, 990_000n])
    mids.set('8:0', 0.25)
    await trade(BOB_PK, 'requestSell', [8, 0, 100_000_000n, 0n])
    expect(await read<bigint>('queuedOf', [alice.address])).toBe(0n)
    expect(await bal(alice.address)).toBe(519_600_000n)
    expect(await bal(bob.address)).toBe(475_000_000n)
    const tok = dep.token as Address
    expect(await client.readContract({ address: tok, abi: PREDICT_TOKEN_ABI, functionName: 'balanceOf', args: [bob.address] })).toBe(25n * 100n * 10n ** 18n)
    expect(await read<bigint>('lpCash')).toBe(5_400_000n)
  }, 60_000)

  test('a market with no price is refunded', async () => {
    await trade(BOB_PK, 'requestBuy', [99, 0, 10_000_000n, 990_000n])
    expect(await bal(bob.address)).toBe(475_000_000n)
    expect(keeper.list(bob.address, 1)[0]).toMatchObject({ kind: 'rejected', reason: 1 })
  }, 60_000)

  test('a settled market is proposed, waits its delay, and every holder is paid', async () => {
    mids.set('9:1', 0.4)
    mids.set('9:0', 0.6)
    await trade(ALICE_PK, 'requestBuy', [9, 1, 40_000_000n, 990_000n]) // 100 No
    await trade(BOB_PK, 'requestBuy', [9, 0, 30_000_000n, 990_000n]) // 50 Yes
    settled.set(9, 0) // No wins
    await keeper.settle()
    const m = await read<readonly unknown[]>('markets', [9])
    expect(m[4]).toBe(1) // settlement pending
    await keeper.settle()
    expect(await bal(alice.address)).toBe(519_600_000n - 40_000_000n) // not paid before the delay
    await later(Number(await read<number>('settleDelay')))
    await keeper.settle()
    // Bob's $30 loss first? The holders go in the order they're held: alice is paid from cash, the rest queued.
    const queued = await read<bigint>('queuedOf', [alice.address])
    expect(await bal(alice.address) + queued).toBe(519_600_000n + 58_800_000n) // $100 for 100 No: $60 profit, 2% off
    expect(await bal(bob.address)).toBe(475_000_000n - 30_000_000n)
    expect(await read<bigint>('liabilities')).toBe(await client.readContract({ address: usdc, abi: TEST_USDC_ABI, functionName: 'balanceOf', args: [dep.pool as Address] }))
    expect(keeper.list(alice.address, 1)[0]).toMatchObject({ kind: 'settled', outcome: 9, side: 1 })
  }, 60_000)
})
