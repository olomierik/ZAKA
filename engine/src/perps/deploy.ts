// Deploys ARCSENSE futures on Arc testnet from the engine's keeper wallet, once that wallet has
// testnet USDC for gas (Circle's faucet): the test USDC (tUSDC, with a faucet for everyone), the
// oracle (RedStone's signers) and the futures contract, owned by the owner's deploy wallet, with
// the platform's fee wallet. Then 1,000,000 tUSDC is minted and deposited as the pool's first
// liquidity. Each step is saved, so a restart picks up where it stopped. Testnet only: it refuses
// any other chain.

import { getAddress, isAddress, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem'
import { ORACLE_ABI, PERPS_ABI, TEST_USDC_ABI } from './abi'
import {
  ORACLE_BYTECODE, ORACLE_IMMUTABLES, ORACLE_RUNTIME, PERPS_BYTECODE, PERPS_IMMUTABLES, PERPS_RUNTIME,
  TEST_USDC_BYTECODE, TEST_USDC_IMMUTABLES, TEST_USDC_RUNTIME,
} from './build'
import { ARC_TESTNET, FEE_WALLET, MARKET_DEFAULTS, MARKET_FEEDS, PERPS_OWNER, REDSTONE, TESTNET_SEED_USDC, feedIdOf, type PerpsDeployment } from './shared'
import { log } from '../log'

/** Enough native USDC for the three deployments and the seeding (~0.15 at testnet gas prices). */
export const DEPLOY_GAS_USDC = 0.3

export interface DeployStore {
  get(): Promise<PerpsDeployment | null>
  set(d: PerpsDeployment): Promise<void>
}

export function emptyDeployment(): PerpsDeployment {
  return { chainId: ARC_TESTNET.id, usdc: null, oracle: null, perps: null, block: null, seeded: false, at: null }
}

/** The markets the contract is deployed with (MARKET_FEEDS: BTC, ETH, SOL). */
export function initialMarkets() {
  return MARKET_FEEDS.map(f => ({
    feedId: feedIdOf(f),
    enabled: true,
    maxLeverage: MARKET_DEFAULTS.maxLeverage,
    openFeeBps: MARKET_DEFAULTS.openFeeBps,
    closeFeeBps: MARKET_DEFAULTS.closeFeeBps,
    liquidationBps: MARKET_DEFAULTS.liquidationBps,
    borrowRatePerHour: MARKET_DEFAULTS.borrowRatePerHour,
    maxOiLong: MARKET_DEFAULTS.maxOiLong,
    maxOiShort: MARKET_DEFAULTS.maxOiShort,
  }))
}

/** Is `code` the build's runtime code, apart from its immutables? */
export function codeMatches(code: Hex | undefined, runtime: string, immutables: readonly (readonly [number, number])[]): boolean {
  if (!code || code.length !== runtime.length) return false
  const a = code.toLowerCase().slice(2)
  const b = runtime.toLowerCase().slice(2)
  let i = 0
  for (const [start, len] of immutables) {
    if (a.slice(i * 2, start * 2) !== b.slice(i * 2, start * 2)) return false
    i = start + len
  }
  return a.slice(i * 2) === b.slice(i * 2)
}

export interface DeployDeps {
  client: PublicClient
  wallet: WalletClient<Transport, Chain, Account>
  store: DeployStore
  owner?: Address
  feeWallet?: Address
  /** The oracle's signers (default: RedStone's); tests sign with their own. */
  signers?: readonly string[]
  threshold?: number
  /** The chain to deploy on (default: Arc testnet only). */
  chainId?: number
}

async function deployed(c: PublicClient, hash: Hex) {
  const r = await c.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 })
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deployment ${hash} failed`)
  return { address: getAddress(r.contractAddress), block: Number(r.blockNumber) }
}

async function mined(c: PublicClient, hash: Hex) {
  const r = await c.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 })
  if (r.status !== 'success') throw new Error(`transaction ${hash} failed`)
}

/** Runs whatever deployment steps are left. Returns the deployment as it stands. */
export async function deployStep(d: DeployDeps): Promise<PerpsDeployment> {
  const chainId = await d.client.getChainId()
  if (chainId !== (d.chainId ?? ARC_TESTNET.id)) throw new Error(`refusing to deploy futures on chain ${chainId}: Arc testnet only`)
  const keeper = d.wallet.account.address
  const owner = d.owner ?? (PERPS_OWNER as Address)
  const feeWallet = d.feeWallet ?? (FEE_WALLET as Address)
  const dep = (await d.store.get()) ?? emptyDeployment()
  const save = async () => { await d.store.set(dep) }

  if (!dep.usdc) {
    const hash = await d.wallet.deployContract({ abi: TEST_USDC_ABI, bytecode: TEST_USDC_BYTECODE, args: [keeper, 0n] })
    dep.usdc = (await deployed(d.client, hash)).address
    log.info('perps: test USDC deployed', { address: dep.usdc, tx: hash })
    await save()
  }
  if (!dep.oracle) {
    const hash = await d.wallet.deployContract({ abi: ORACLE_ABI, bytecode: ORACLE_BYTECODE, args: [owner, (d.signers ?? REDSTONE.signers).map(s => getAddress(s)), d.threshold ?? REDSTONE.threshold] })
    dep.oracle = (await deployed(d.client, hash)).address
    log.info('perps: oracle deployed', { address: dep.oracle, tx: hash })
    await save()
  }
  if (!dep.perps) {
    const hash = await d.wallet.deployContract({
      abi: PERPS_ABI, bytecode: PERPS_BYTECODE,
      args: [dep.usdc as Address, dep.oracle as Address, owner, feeWallet, keeper, initialMarkets()],
    })
    const r = await deployed(d.client, hash)
    dep.perps = r.address
    dep.block = r.block
    dep.at = Date.now()
    log.info('perps: futures contract deployed', { address: dep.perps, block: r.block, tx: hash })
    await save()
  }
  if (!dep.seeded) {
    const usdc = dep.usdc as Address
    const perps = dep.perps as Address
    const have = await d.client.readContract({ address: usdc, abi: TEST_USDC_ABI, functionName: 'balanceOf', args: [keeper] })
    const fee = await d.client.readContract({ address: perps, abi: PERPS_ABI, functionName: 'execFee' })
    if (have < TESTNET_SEED_USDC + fee) {
      await mined(d.client, await d.wallet.writeContract({ address: usdc, abi: TEST_USDC_ABI, functionName: 'mint', args: [keeper, TESTNET_SEED_USDC + fee - have] }))
    }
    await mined(d.client, await d.wallet.writeContract({ address: usdc, abi: TEST_USDC_ABI, functionName: 'approve', args: [perps, TESTNET_SEED_USDC + fee] }))
    await mined(d.client, await d.wallet.writeContract({ address: perps, abi: PERPS_ABI, functionName: 'requestDeposit', args: [TESTNET_SEED_USDC, 0n] }))
    dep.seeded = true
    log.info('perps: pool seeded', { usdc: String(TESTNET_SEED_USDC / 1_000_000n) })
    await save()
  }
  return dep
}

/** Checks a deployment's code against this build (apart from immutables). */
export async function verifyDeployment(c: PublicClient, dep: PerpsDeployment): Promise<string | null> {
  const checks: [string | null, string, readonly (readonly [number, number])[], string][] = [
    [dep.usdc, TEST_USDC_RUNTIME, TEST_USDC_IMMUTABLES, 'test USDC'],
    [dep.oracle, ORACLE_RUNTIME, ORACLE_IMMUTABLES, 'oracle'],
    [dep.perps, PERPS_RUNTIME, PERPS_IMMUTABLES, 'futures contract'],
  ]
  for (const [addr, runtime, imm, name] of checks) {
    if (!addr || !isAddress(addr)) continue
    const code = await c.getCode({ address: addr as Address })
    if (!codeMatches(code, runtime, imm)) return `the ${name} at ${addr} isn't this build`
  }
  return null
}
