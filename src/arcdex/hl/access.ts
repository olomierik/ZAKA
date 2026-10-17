// Who signs a Hyperliquid action, what the account still needs before it can trade, and the one-time setup.
//
// - The trading wallet (or a Solana wallet's ARCDEX account) holds its key in this tab: it signs every action itself,
//   with no pop-ups, as it does on Arc.
// - An external wallet (MetaMask, WalletConnect…) approves an agent once: a key made here, kept in this browser, that
//   Hyperliquid lets place and cancel orders for the account but never withdraw. Orders then need no pop-up.
//   Withdrawals and other money movements are always signed by the wallet itself.
//
// "Enable trading", once per account (each step only if needed):
//   1. a new account ("default" mode) becomes a unified account, Hyperliquid's recommended mode: one USDC balance
//      for every market (perps on every dex, and the outcome markets);
//   2. ARCDEX's builder fee is approved, up to 0.1% (BUILDER), when the builder can receive it (see builderReady);
//   3. an external wallet approves its agent.
// Hyperliquid refuses every action from an account that has never deposited, so a deposit comes first.

import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getAccount, signTypedData } from 'wagmi/actions'
import { wagmiConfig } from '../wagmi'
import { getEmbeddedWalletClient } from '../lib/embeddedWallet'
import { promptWallet } from '../lib/tx'
import { hideWalletPrompt } from '../lib/walletPrompt'
import { FEE_WALLET } from '../lib/platform'
import { visitorWhere } from '../lib/geo'
import { HL_CHAIN_NAME, HL_NETWORK, hlExchange, hlInfo } from './client'
import { signUserAction, type TypedData, type TypedDataSigner, USER_SIGNED } from './signing'

type Env = Record<string, string | undefined>
const env: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}
const tenthsBps = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Math.min(Number(v), 100) : d)

/** ARCDEX's builder fee on Hyperliquid, in tenths of a basis point (Hyperliquid's unit: 50 = 0.05%). Perps at most
 * 0.1% by Hyperliquid's rules; outcome markets charge it on sells only. Users approve up to MAX_F. */
export const BUILDER = {
  address: FEE_WALLET.toLowerCase(),
  perpF: tenthsBps(env.VITE_HL_BUILDER_PERP, 50),
  outcomeF: tenthsBps(env.VITE_HL_BUILDER_OUTCOME, 100),
  maxF: 100,
  maxFeeRate: '0.1%',
  /** What the builder must hold in its perps account for Hyperliquid to pay it. */
  minAccountValue: 100,
}

export type HlMode = 'default' | 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'dexAbstraction'

/** A monotonic nonce for this tab: Hyperliquid refuses a nonce a signer already used. */
let lastNonce = 0
export function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1)
  return lastNonce
}

// ── signers ──────────────────────────────────────────────────────────────

/** The trading wallet's key (or a Solana wallet's ARCDEX account), signing here. */
export function localSigner(): TypedDataSigner | null {
  try {
    const c = getEmbeddedWalletClient()
    return { address: c.account.address, signTypedData: td => c.signTypedData({ account: c.account, ...(td as Omit<Parameters<typeof c.signTypedData>[0], 'account'>) }) }
  } catch { return null }
}

/** The connected external wallet, signing in its own window. */
export function externalSigner(): TypedDataSigner | null {
  const a = getAccount(wagmiConfig)
  if (!a.address) return null
  return {
    address: a.address,
    signTypedData: async td => {
      const prompted = await promptWallet()
      try { return await signTypedData(wagmiConfig, td as Parameters<typeof signTypedData>[1]) }
      finally { if (prompted) hideWalletPrompt() }
    },
  }
}

/** The chain an external wallet signs on: its current one (a browser wallet refuses typed data for another chain). */
function signatureChainId(kind: 'local' | 'external'): string {
  if (kind === 'local') return '0x66eee'
  const id = getAccount(wagmiConfig).chainId ?? 5042
  return `0x${id.toString(16)}`
}

const agentKey = (user: string) => `arcdex:hl-agent:v1:${HL_NETWORK}:${user.toLowerCase()}`

interface StoredAgent { pk: Hex; address: `0x${string}` }

function storedAgent(user: string): StoredAgent | null {
  try {
    const raw = localStorage.getItem(agentKey(user))
    if (!raw) return null
    const a = JSON.parse(raw) as StoredAgent
    return /^0x[0-9a-f]{64}$/i.test(a.pk) ? a : null
  } catch { return null }
}

export function forgetAgent(user: string) {
  try { localStorage.removeItem(agentKey(user)) } catch { /* storage blocked */ }
}

function agentSigner(a: StoredAgent): TypedDataSigner {
  const acct = privateKeyToAccount(a.pk)
  return { address: acct.address, signTypedData: td => acct.signTypedData(td as Parameters<typeof acct.signTypedData>[0]) }
}

export interface HlAccess {
  /** The account: the address that holds the money and the positions. */
  user: `0x${string}`
  kind: 'local' | 'external'
  /** Signs orders, cancels and leverage: the account itself (local) or its approved agent (external). */
  l1: TypedDataSigner | null
  /** Signs money movements and approvals: always the account's own wallet. */
  main: TypedDataSigner
}

/** The signers for the trader in use (the trading wallet first, as everywhere on ARCDEX). */
export function currentAccess(): HlAccess | null {
  const local = localSigner()
  if (local) return { user: local.address, kind: 'local', l1: local, main: local }
  const ext = externalSigner()
  if (!ext) return null
  const agent = storedAgent(ext.address)
  return { user: ext.address, kind: 'external', l1: agent ? agentSigner(agent) : null, main: ext }
}

// ── what the account needs ───────────────────────────────────────────────

export interface HlAccessStatus {
  deposited: boolean
  mode: HlMode | null
  builderReady: boolean
  /** The builder fee the user approved, in tenths of a basis point. */
  approvedF: number
  agentOk: boolean
  needs: ('deposit' | 'mode' | 'builder' | 'agent')[]
}

let builderCache: { at: number; ready: boolean } | null = null

/** Hyperliquid pays builder fees only to a builder with 100+ USDC in its perps account. Until the fee wallet has
 * that, orders go out without ARCDEX's fee (and nobody is asked to approve one). Read every 5 minutes. */
export async function builderReady(): Promise<boolean> {
  if (builderCache && Date.now() - builderCache.at < 5 * 60_000) return builderCache.ready
  const s = await hlInfo<{ marginSummary?: { accountValue?: string } }>({ type: 'clearinghouseState', user: BUILDER.address }).catch(() => null)
  const ready = Number(s?.marginSummary?.accountValue ?? 0) >= BUILDER.minAccountValue
  builderCache = { at: Date.now(), ready }
  return ready
}

export async function accessStatus(a: HlAccess): Promise<HlAccessStatus> {
  const [role, mode, ready, approved] = await Promise.all([
    hlInfo<{ role?: string }>({ type: 'userRole', user: a.user }).catch(() => null),
    hlInfo<HlMode>({ type: 'userAbstraction', user: a.user }).catch(() => null),
    builderReady(),
    hlInfo<number>({ type: 'maxBuilderFee', user: a.user, builder: BUILDER.address }).catch(() => 0),
  ])
  const deposited = !!role && role.role !== 'missing'
  let agentOk = a.kind === 'local'
  if (a.kind === 'external' && a.l1) {
    const agents = await hlInfo<{ address: string }[]>({ type: 'extraAgents', user: a.user }).catch(() => null)
    agentOk = !agents || agents.some(x => x.address.toLowerCase() === a.l1!.address.toLowerCase())
    if (!agentOk) forgetAgent(a.user)
  }
  const approvedF = Number(approved) || 0
  const needs: HlAccessStatus['needs'] = []
  if (!deposited) needs.push('deposit')
  else {
    if (mode === 'default') needs.push('mode')
    if (ready && approvedF < BUILDER.maxF) needs.push('builder')
    if (!agentOk) needs.push('agent')
  }
  return { deposited, mode, builderReady: ready, approvedF, agentOk, needs }
}

async function userAction(a: HlAccess, primaryType: keyof typeof USER_SIGNED, fields: Record<string, unknown>) {
  const nonce = nextNonce()
  const nonceField = 'time' in fields ? 'time' : 'nonce'
  const action: Record<string, unknown> = { ...fields, [nonceField]: nonce, hyperliquidChain: HL_CHAIN_NAME, signatureChainId: signatureChainId(a.kind) }
  const signature = await signUserAction(a.main, primaryType, action)
  return hlExchange({ action, nonce, signature })
}

export type EnableStep = 'mode' | 'builder' | 'agent'

/** Does what `needs` lists, in order, telling the page each step as it starts. */
export async function enableTrading(a: HlAccess, needs: HlAccessStatus['needs'], onStep: (s: EnableStep) => void): Promise<HlAccess> {
  if (needs.includes('mode')) {
    onStep('mode')
    await userAction(a, 'HyperliquidTransaction:UserSetAbstraction', { type: 'userSetAbstraction', user: a.user.toLowerCase(), abstraction: 'unifiedAccount', nonce: 0 })
  }
  if (needs.includes('builder')) {
    onStep('builder')
    await userAction(a, 'HyperliquidTransaction:ApproveBuilderFee', { type: 'approveBuilderFee', maxFeeRate: BUILDER.maxFeeRate, builder: BUILDER.address, nonce: 0 })
  }
  if (needs.includes('agent') && a.kind === 'external') {
    onStep('agent')
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    await userAction(a, 'HyperliquidTransaction:ApproveAgent', { type: 'approveAgent', agentAddress: acct.address.toLowerCase(), agentName: 'ARCDEX', nonce: 0 })
    try { localStorage.setItem(agentKey(a.user), JSON.stringify({ pk, address: acct.address })) } catch { /* storage blocked: the agent lives for this tab */ }
    return { ...a, l1: agentSigner({ pk, address: acct.address }) }
  }
  return a
}

/** Signs and sends a user-signed action as the account's own wallet (withdrawals, transfers between its balances). */
export function sendUserAction(a: HlAccess, primaryType: keyof typeof USER_SIGNED, fields: Record<string, unknown>) {
  return userAction(a, primaryType, fields)
}

export type { TypedData }

// ── the eligibility gate ─────────────────────────────────────────────────

/** Hyperliquid's terms exclude US persons, Ontario and sanctioned territories. Opening positions and depositing are
 * blocked there; closing, cancelling and withdrawing never are (nobody is trapped). Unknown counts as blocked. */
export const HL_RESTRICTED = new Set(['US', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY'])
export const HL_RESTRICTED_REGIONS = new Set(['CA-ON', 'UA-43', 'UA-14', 'UA-09'])

export async function hlEligibility(): Promise<{ ok: boolean; country: string | null; why: 'restricted' | 'unknown' | null }> {
  const w = await visitorWhere()
  if (!w.country) return { ok: false, country: null, why: 'unknown' }
  if (HL_RESTRICTED.has(w.country) || (w.subdivision && HL_RESTRICTED_REGIONS.has(`${w.country}-${w.subdivision}`))) return { ok: false, country: w.country, why: 'restricted' }
  return { ok: true, country: w.country, why: null }
}
