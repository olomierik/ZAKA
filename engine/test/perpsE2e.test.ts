// ARCSENSE futures end to end on a local chain (anvil, as chain 5042002): the engine deploys the
// three contracts and seeds the pool, a trader opens, closes and gets liquidated, and the keeper
// executes each step with prices signed in RedStone's gateway format and read through the same
// code as the real gateway's. Skipped where Foundry's anvil isn't installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'
import { PERPS_ABI, TEST_USDC_ABI } from '../src/perps/abi'
import { deployStep, verifyDeployment, type DeployStore } from '../src/perps/deploy'
import { PerpsEvents } from '../src/perps/events'
import { PerpsKeeper } from '../src/perps/keeper'
import { packageHash, RedstoneFeed } from '../src/perps/redstone'
import { ARC_TESTNET, FEEDS, TESTNET_SEED_USDC, feedIdOf, type PerpsDeployment } from '../src/perps/shared'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil'
const ANVIL = [join(homedir(), '.foundry', 'bin', exe)].find(p => existsSync(p)) ?? (Bun.which('anvil') ?? null)
const PORT = 8599
const RPC = `http://127.0.0.1:${PORT}`
// anvil's well-known development keys.
const KEEPER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TRADER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const SIGNER_PKS = Array.from({ length: 5 }, () => generatePrivateKey())
const SIGNERS = SIGNER_PKS.map(k => privateKeyToAccount(k).address)

describe.skipIf(!ANVIL)('futures on a local chain', () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let client: PublicClient
  const keeperAcc = privateKeyToAccount(KEEPER_PK)
  const trader = privateKeyToAccount(TRADER_PK)
  const chain = { ...ARC_TESTNET, rpcUrls: { default: { http: [RPC] } } }
  const keeperWallet = createWalletClient({ account: keeperAcc, chain, transport: http(RPC) })
  const traderWallet = createWalletClient({ account: trader, chain, transport: http(RPC) })
  const feed = new RedstoneFeed({ feeds: FEEDS, signers: SIGNERS, threshold: 3, gateways: [], dataService: 'x' })
  let dep: PerpsDeployment
  let keeper: PerpsKeeper
  let lastTs = 0

  /** Prices signed by the test signers, in the gateway's own format, fed through RedstoneFeed. */
  async function publish(prices: Record<string, number>) {
    const block = await client.getBlock()
    lastTs = Math.max(lastTs + 1, Number(block.timestamp) * 1000)
    const raw: Record<string, unknown[]> = {}
    for (const [f, p] of Object.entries(prices)) {
      raw[f] = await Promise.all(SIGNER_PKS.map(async (pk, i) => {
        const value = parseUnits(String(p), 8)
        const sig = await sign({ hash: packageHash(feedIdOf(f), value, BigInt(lastTs)), privateKey: pk, to: 'hex' })
        return { timestampMilliseconds: lastTs, signature: Buffer.from(sig.slice(2), 'hex').toString('base64'), signerAddress: SIGNERS[i], dataPoints: [{ dataFeedId: f, value: p }] }
      }))
    }
    const snap = await feed.ingest(raw as never, Date.now())
    expect(snap?.ts).toBe(lastTs)
  }

  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: dep.perps as Address, abi: PERPS_ABI, functionName: functionName as never, args: args as never }) as Promise<T>
  const usdcOf = (a: Address) => client.readContract({ address: dep.usdc as Address, abi: TEST_USDC_ABI, functionName: 'balanceOf', args: [a] })
  const send = async (w: typeof traderWallet, address: Address, abi: typeof PERPS_ABI | typeof TEST_USDC_ABI, functionName: string, args: unknown[]) => {
    const hash = await w.writeContract({ address, abi, functionName, args } as never)
    const r = await client.waitForTransactionReceipt({ hash })
    expect(r.status).toBe('success')
  }

  beforeAll(async () => {
    proc = Bun.spawn([ANVIL!, '--port', String(PORT), '--chain-id', String(ARC_TESTNET.id), '--silent'], { stdout: 'ignore', stderr: 'ignore' })
    client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient
    for (let i = 0; i < 100; i++) {
      try { await client.getChainId(); break } catch { await Bun.sleep(100) }
    }
    let saved: PerpsDeployment | null = null
    const store: DeployStore = { get: async () => saved, set: async d => { saved = structuredClone(d) } }
    dep = await deployStep({ client, wallet: keeperWallet, store, signers: SIGNERS, threshold: 3, owner: '0x00000000000000000000000000000000000000aa' })
    keeper = new PerpsKeeper({ client, wallet: keeperWallet, perps: dep.perps as Address, feed })
  }, 60_000)

  afterAll(() => { proc?.kill() })

  test('the engine deploys the build, then seeds the pool', async () => {
    expect(dep.seeded).toBe(true)
    expect(await verifyDeployment(client, dep)).toBeNull()
    expect((await read<bigint[]>('pendingRequestIds')).length).toBe(1)
    await keeper.tick() // no open interest: the deposit needs no prices
    expect(await read<bigint>('poolAmount')).toBe(TESTNET_SEED_USDC)
    expect(await read<bigint>('balanceOf', [keeperAcc.address])).toBe(TESTNET_SEED_USDC - 1_000n)
    expect(keeper.state?.markets.length).toBe(3)
  }, 60_000)

  test('a trader opens a 10x long; the keeper fills it at the first price signed after the request', async () => {
    await send(traderWallet, dep.usdc as Address, TEST_USDC_ABI, 'faucet', [])
    await send(traderWallet, dep.usdc as Address, TEST_USDC_ABI, 'approve', [dep.perps, 10n ** 12n])
    await send(traderWallet, dep.perps as Address, PERPS_ABI, 'requestOpen', [0, true, 100_000_000n, 1_000_000_000n, parseUnits('200000', 8), 0n, 0n, 0n])
    await keeper.tick()
    expect((await read<bigint[]>('positionIdsOf', [trader.address])).length).toBe(0) // no price after it yet
    await publish({ BTC: 100_000, ETH: 4_000, SOL: 150 })
    await keeper.tick()
    const ids = await read<bigint[]>('positionIdsOf', [trader.address])
    expect(ids.length).toBe(1)
    const [p] = await read<{ entryPrice: bigint; size: bigint; collateral: bigint }[]>('getPositions', [ids])
    expect(p.entryPrice).toBe(parseUnits('100000', 8))
    expect(p.size).toBe(1_000_000_000n)
    expect(p.collateral).toBe(99_200_000n)
  }, 60_000)

  test('closing at +5% pays the trader', async () => {
    const before = await usdcOf(trader.address)
    const [id] = await read<bigint[]>('positionIdsOf', [trader.address])
    await send(traderWallet, dep.perps as Address, PERPS_ABI, 'requestClose', [id, 0n])
    await publish({ BTC: 105_000, ETH: 4_000, SOL: 150 })
    await keeper.tick()
    expect((await read<bigint[]>('positionIdsOf', [trader.address])).length).toBe(0)
    const got = Number(await usdcOf(trader.address) - before) / 1e6
    expect(got).toBeGreaterThan(99.2 + 50 - 0.8 - 0.05 - 0.01) // collateral + $50 - close fee - exec fee - borrow
    expect(got).toBeLessThan(99.2 + 50)
  }, 60_000)

  test('a short goes under its maintenance margin and the keeper liquidates it', async () => {
    await send(traderWallet, dep.perps as Address, PERPS_ABI, 'requestOpen', [1, false, 100_000_000n, 1_000_000_000n, 1n, 0n, 0n, 0n])
    await publish({ BTC: 105_000, ETH: 4_000, SOL: 150 })
    await keeper.tick()
    expect((await read<bigint[]>('positionIdsOf', [trader.address])).length).toBe(1)
    const before = await usdcOf(trader.address)
    await publish({ BTC: 105_000, ETH: 4_400, SOL: 150 }) // +10% against a 10x short
    await keeper.tick()
    expect((await read<bigint[]>('openPositionIds')).length).toBe(0)
    expect(await usdcOf(trader.address)).toBe(before) // nothing back
    expect(await read<bigint>('poolAmount')).toBeGreaterThan(TESTNET_SEED_USDC)
  }, 60_000)

  test('take-profit closes on the keeper\'s next price', async () => {
    await send(traderWallet, dep.perps as Address, PERPS_ABI, 'requestOpen', [2, true, 100_000_000n, 500_000_000n, parseUnits('1000', 8), 0n, parseUnits('160', 8), 0n])
    await publish({ BTC: 105_000, ETH: 4_400, SOL: 150 })
    await keeper.tick()
    expect((await read<bigint[]>('positionIdsOf', [trader.address])).length).toBe(1)
    await publish({ BTC: 105_000, ETH: 4_400, SOL: 161 })
    await keeper.tick()
    expect((await read<bigint[]>('positionIdsOf', [trader.address])).length).toBe(0)
  }, 60_000)

  test('the events tell the trader\'s story', async () => {
    const ev = new PerpsEvents(client, dep.perps as Address, dep.block)
    ev.setMarkets(['BTC', 'ETH', 'SOL'])
    await ev.poll()
    await ev.poll() // a read that failed under load picks up where it stopped
    const mine = ev.list(trader.address, 20).map(t => [t.kind, t.market, t.isLong])
    expect(mine).toEqual([
      ['takeProfit', 'SOL', true], ['opened', 'SOL', true],
      ['liquidated', 'ETH', false], ['opened', 'ETH', false],
      ['closed', 'BTC', true], ['opened', 'BTC', true],
    ])
    expect(ev.list(null, 3).length).toBe(3)
    expect(keeper.executed).toBeGreaterThanOrEqual(7)
  }, 60_000)
})
