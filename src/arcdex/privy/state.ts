// Sign-in with Privy (the owner's decision D1, the build pack's Phase 1): email or a social account, with an EVM wallet
// and a Solana wallet made for it by Privy. Their keys stay with Privy; exporting one goes through Privy's own window,
// so ARCDEX's code never sees a key (04).
//
// This file is the small part every page carries: the state, and the calls the rest of the app makes. Privy's own code
// (~1 MB) is in PrivyRoot.tsx, loaded only when someone picks "Email or social", or when this browser was signed in
// before. Once loaded:
//   • the EVM wallet is the connected wallet (the wagmi connector `privy` in wagmi.ts reads its provider here), so every
//     trade form, Portfolio and the withdraw flow work with it as they do with MetaMask, Privy confirming each
//     transaction in its own window;
//   • the Solana wallet signs as a Solana wallet app would (lib/solanaWallet.ts `setPrivySolana`).
//
// On only with VITE_PRIVY_APP_ID set (a public id) and the `privy` flag on (lib/flags.ts; /admin can turn it off).

import { useSyncExternalStore } from 'react'
import type { EIP1193Provider } from 'viem'
import { flag, useFlag } from '../lib/flags'
import { N_ } from '../lib/i18n'
import { isOwnAddress, isPrivyAppId, stepUpNeed, type StepUpAction, type StepUpNeed } from './stepUp'

type Env = Record<string, string | undefined>
const env: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}

export const PRIVY_APP_ID = (env.VITE_PRIVY_APP_ID ?? '').trim()
export const privyConfigured = isPrivyAppId(PRIVY_APP_ID)
/** Privy sign-in is offered: the app id is set and the flag is on. */
export const privyOn = () => privyConfigured && flag('privy')
export function usePrivyOn(): boolean { const f = useFlag('privy'); return privyConfigured && f }

/** What the app calls the wallets Privy made, EVM and Solana alike ("Confirm the trade in Privy…"): Privy's window is
 * where they're confirmed. */
export const PRIVY_WALLET_NAME = 'Privy'

export interface PrivyState {
  /** Privy's code has been asked for. */
  started: boolean
  /** Privy answered: it knows whether someone is signed in. */
  ready: boolean
  authenticated: boolean
  /** The account's email or social handle. */
  label: string | null
  evm: `0x${string}` | null
  sol: string | null
  /** Two-step verification is on (Privy asks for it before keys or money leave). */
  mfa: boolean
  /** When this tab last signed in (memory only: a reload starts with none). */
  lastAuthAt: number | null
  error: string | null
}

export interface PrivyActions {
  login: () => void
  logout: () => Promise<void>
  exportEvm: () => Promise<void>
  exportSol: () => Promise<void>
  promptMfa: () => Promise<void>
  enrollMfa: () => void
}

const HINT = 'arcdex:privy:v1'
const readHint = () => { try { return localStorage.getItem(HINT) === '1' } catch { return false } }

let state: PrivyState = { started: false, ready: false, authenticated: false, label: null, evm: null, sol: null, mfa: false, lastAuthAt: null, error: null }
let actions: PrivyActions | null = null
let evmProvider: EIP1193Provider | null = null
/** Connect the EVM wallet to the app once it's there: after a sign-in here, or when it was the wallet in use last time. */
let connectWish = false
const listeners = new Set<() => void>()
const tell = () => { for (const f of listeners) f() }

export function setPrivyState(p: Partial<PrivyState>) {
  const next = { ...state, ...p }
  if (JSON.stringify(next) === JSON.stringify(state)) return
  state = next
  if ('authenticated' in p && state.ready) {
    try { if (state.authenticated) localStorage.setItem(HINT, '1'); else localStorage.removeItem(HINT) } catch { /* storage blocked */ }
  }
  tell()
}
export const privyState = () => state
export const usePrivyState = () => useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f) } }, () => state, () => state)

/** PrivyRoot hands over what it can do once Privy is up (null when it goes away). */
export function registerPrivy(a: PrivyActions | null) { actions = a; tell() }
export function markSignedIn(at = Date.now()) { setPrivyState({ lastAuthAt: at }) }

/** The EVM wallet's EIP-1193 provider, for the `privy` wagmi connector (wagmi.ts). */
export const privyEvmProvider = (): EIP1193Provider | undefined => evmProvider ?? undefined
export function setPrivyEvmProvider(p: unknown) { evmProvider = (p as EIP1193Provider | null) ?? null }
export function wantPrivyConnect(v = true) { connectWish = v }
/** Whether to connect the EVM wallet to the app now (asked once per wish). */
export function takePrivyConnectWish(): boolean { const w = connectWish; connectWish = false; return w }

/** Loads Privy's code (PrivyHost mounts it). */
export function startPrivy() { if (privyOn() && !state.started) setPrivyState({ started: true }) }

/** At app start: a browser that was signed in loads Privy at once, and reconnects the wallet if it was the one in use. */
export function initPrivy(recentConnectorId: string | null) {
  if (!privyOn()) return
  if (recentConnectorId === 'privy') wantPrivyConnect()
  if (readHint() || recentConnectorId === 'privy') startPrivy()
}

const waitFor = (ok: () => boolean, ms: number) => new Promise<boolean>(resolve => {
  if (ok()) { resolve(true); return }
  const t0 = Date.now()
  const id = setInterval(() => {
    if (ok()) { clearInterval(id); resolve(true) } else if (Date.now() - t0 > ms) { clearInterval(id); resolve(false) }
  }, 100)
})

let pendingLogin: { resolve: () => void; reject: (e: Error) => void } | null = null
/** PrivyRoot: the sign-in finished (null) or didn't (why). */
export function loginSettled(err: string | null) {
  const p = pendingLogin
  pendingLogin = null
  // No sign-in: nothing to connect later.
  if (err) wantPrivyConnect(false)
  if (!p) return
  if (err) p.reject(Object.assign(new Error(err), { cancelled: /exited|cancel|closed/i.test(err) }))
  else p.resolve()
}

/** Opens Privy's sign-in. Resolves once signed in; the EVM wallet then connects to the app by itself. */
export async function privySignIn(): Promise<void> {
  if (!privyOn()) throw new Error(N_('Email sign-in isn’t switched on'))
  startPrivy()
  wantPrivyConnect()
  if (!(await waitFor(() => !!actions && state.ready, 20_000))) {
    wantPrivyConnect(false)
    throw new Error(state.error ?? N_('Email sign-in couldn’t be reached. Try again, or use another wallet.'))
  }
  if (state.authenticated) return
  return new Promise<void>((resolve, reject) => {
    pendingLogin?.reject(new Error('replaced'))
    pendingLogin = { resolve, reject }
    actions!.login()
  })
}

export async function privySignOut() {
  wantPrivyConnect(false)
  await actions?.logout()
  setPrivyState({ lastAuthAt: null })
}

/** Signs out and in again: what a step-up asks for without two-step verification. */
export async function privyReauth() {
  await actions?.logout()
  setPrivyState({ lastAuthAt: null })
  await privySignIn()
}

/** What `action` needs from this account right now. */
export function privyNeed(action: StepUpAction, now = Date.now()): StepUpNeed {
  return stepUpNeed(action, { lastAuthAt: state.lastAuthAt, mfa: state.mfa, now })
}

/** Whether `address` is this tab's Privy EVM wallet. */
export const isPrivyWallet = (address: string | null | undefined) => !!address && !!state.evm && state.authenticated && address.toLowerCase() === state.evm.toLowerCase()
/** Whether sending to `to` stays within the account (its own EVM or Solana address). */
export const privyOwns = (to: string) => isOwnAddress(to, { evm: state.evm, sol: state.sol })

export class StepUpRequired extends Error {
  constructor(message: string) { super(message); this.name = 'StepUpRequired' }
}

/** Runs the step-up for `action`: Privy's two-step verification, or a refusal that asks for a fresh sign-in. */
export async function privyStepUp(action: StepUpAction, refusal: string): Promise<void> {
  const need = privyNeed(action)
  if (need === 'relogin') throw new StepUpRequired(refusal)
  if (need === 'mfa') {
    if (!actions) throw new Error(N_('Email sign-in isn’t loaded yet. Try again in a moment.'))
    await actions.promptMfa()
  }
}

/** Exports a key through Privy's own window, after the step-up. */
export async function privyExport(which: 'evm' | 'sol', refusal: string): Promise<void> {
  await privyStepUp('export', refusal)
  if (!actions) throw new Error(N_('Email sign-in isn’t loaded yet. Try again in a moment.'))
  await (which === 'evm' ? actions.exportEvm() : actions.exportSol())
}

export function privyEnrollMfa() { actions?.enrollMfa() }
