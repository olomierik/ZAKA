// Deploys the prediction pool on Arc testnet from the pool keeper's wallet: one transaction (the pool deploys its
// tPOOL token itself), on the futures' test USDC (tUSDC, with a faucet for everyone), owned by the owner's deploy
// wallet, paying the platform's fee wallet, with the keeper as the signer. The pool starts at $0, as papertrade's
// does: nothing is seeded. Saved once deployed; testnet only (any other chain is refused).

import { getAddress, isAddress, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem'
import { PREDICT_POOL_ABI } from './abi'
import { PREDICT_POOL_BYTECODE, PREDICT_POOL_IMMUTABLES, PREDICT_POOL_RUNTIME, PREDICT_TOKEN_IMMUTABLES, PREDICT_TOKEN_RUNTIME } from './build'
import type { PredictPoolDeployment } from './shared'
import { ARC_TESTNET, PERPS_OWNER } from '../perps/shared'
import { codeMatches } from '../perps/deploy'
import { FEE_RECIPIENT } from '../feeWallet'
import { log } from '../log'

/** Native testnet USDC the keeper needs before it deploys (the pool is ~22 KB). */
export const POOL_DEPLOY_GAS_USDC = 0.1

export interface PoolDeployStore {
  get(): Promise<PredictPoolDeployment | null>
  set(d: PredictPoolDeployment): Promise<void>
}

export interface PoolDeployDeps {
  client: PublicClient
  wallet: WalletClient<Transport, Chain, Account>
  store: PoolDeployStore
  /** The futures' test USDC. */
  usdc: Address
  owner?: Address
  feeWallet?: Address
  /** The chain to deploy on (default: Arc testnet only). */
  chainId?: number
}

export async function deployPool(d: PoolDeployDeps): Promise<PredictPoolDeployment> {
  const chainId = await d.client.getChainId()
  if (chainId !== (d.chainId ?? ARC_TESTNET.id)) throw new Error(`refusing to deploy the prediction pool on chain ${chainId}: Arc testnet only`)
  const saved = await d.store.get()
  if (saved?.pool) return saved
  const signer = d.wallet.account.address
  const hash = await d.wallet.deployContract({
    abi: PREDICT_POOL_ABI, bytecode: PREDICT_POOL_BYTECODE,
    args: [d.usdc, d.owner ?? (PERPS_OWNER as Address), d.feeWallet ?? FEE_RECIPIENT, signer],
  })
  const r = await d.client.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 })
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deployment ${hash} failed`)
  const pool = getAddress(r.contractAddress)
  const token = await d.client.readContract({ address: pool, abi: PREDICT_POOL_ABI, functionName: 'token' })
  const dep: PredictPoolDeployment = { chainId, pool, token, usdc: getAddress(d.usdc), signer, block: Number(r.blockNumber), at: Date.now() }
  await d.store.set(dep)
  log.info('predict pool: deployed', { pool, token, tx: hash })
  return dep
}

/** Checks a deployment's code against this build (apart from immutables), and that its signer is the keeper. */
export async function verifyPool(c: PublicClient, dep: PredictPoolDeployment, keeper: Address | null): Promise<string | null> {
  for (const [addr, runtime, imm, name] of [
    [dep.pool, PREDICT_POOL_RUNTIME, PREDICT_POOL_IMMUTABLES, 'pool'],
    [dep.token, PREDICT_TOKEN_RUNTIME, PREDICT_TOKEN_IMMUTABLES, 'tPOOL token'],
  ] as const) {
    if (!addr || !isAddress(addr)) continue
    if (!codeMatches(await c.getCode({ address: addr as Address }), runtime, imm)) return `the ${name} at ${addr} isn't this build`
  }
  if (dep.pool && keeper) {
    const s = await c.readContract({ address: dep.pool as Address, abi: PREDICT_POOL_ABI, functionName: 'signer' })
    if (getAddress(s) !== getAddress(keeper)) return `the pool's signer is ${s}, not this engine's keeper ${keeper}`
  }
  return null
}
