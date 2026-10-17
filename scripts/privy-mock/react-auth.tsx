// A stand-in for @privy-io/react-auth, for checking ARCDEX's Privy sign-in in a browser without Privy's servers
// (scripts/vite.privy-mock.config.ts swaps it in; it is never in a real build). It has the hooks src/arcdex/privy/
// PrivyRoot.tsx uses, with Privy's shapes, and plain windows in place of Privy's: "Continue" signs in as a test account,
// "Close" cancels. Its EVM wallet answers a few wallet methods itself and records every transaction it's asked to send
// (it sends nothing); everything else goes to Arc's RPC. What it did is in window.__privyMock.log.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const MOCK_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const MOCK_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const KEY = 'privy-mock'

type Modal = { kind: 'login' } | { kind: 'export'; address: string; done: () => void } | { kind: 'mfa'; done: (ok: boolean) => void } | null
interface Store { authenticated: boolean; mfa: boolean; walletsReady: boolean; modal: Modal }
const saved = (): { authenticated: boolean; mfa: boolean } => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? '') } catch { return { authenticated: false, mfa: false } } }
let store: Store = { ...saved(), walletsReady: saved().authenticated, modal: null }
const subs = new Set<() => void>()
const set = (p: Partial<Store>) => {
  store = { ...store, ...p }
  try { sessionStorage.setItem(KEY, JSON.stringify({ authenticated: store.authenticated, mfa: store.mfa })) } catch { /* blocked */ }
  for (const f of subs) f()
}
const log = (s: string) => { const w = window as unknown as { __privyMock?: { log: string[] } }; (w.__privyMock ??= { log: [] }).log.push(s) }
let loginCallbacks: { onComplete?: (p: { user: unknown; isNewUser: boolean; wasAlreadyAuthenticated: boolean; loginMethod: string | null; loginAccount: null }) => void; onError?: (e: string) => void } = {}

function useStore(): Store {
  const [s, setS] = useState(store)
  useEffect(() => { const f = () => setS(store); subs.add(f); return () => { subs.delete(f) } }, [])
  return s
}

const userOf = (s: Store) => s.authenticated ? {
  id: 'did:privy:mock', createdAt: new Date(0), email: { address: 'mock@arcdex.test' }, hasAcceptedTerms: true, isGuest: false,
  mfaMethods: s.mfa ? ['totp'] : [],
  linkedAccounts: [
    { type: 'email', address: 'mock@arcdex.test' },
    { type: 'wallet', chainType: 'ethereum', walletClientType: 'privy', address: MOCK_EVM },
    { type: 'wallet', chainType: 'solana', walletClientType: 'privy', address: MOCK_SOL },
  ],
} : null

// ── the EVM wallet ───────────────────────────────────────────────────────────
type Listener = (...a: unknown[]) => void
const listeners = new Map<string, Set<Listener>>()
let chainId = 5042
const provider = {
  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case 'eth_chainId': return `0x${chainId.toString(16)}`
      case 'eth_accounts': case 'eth_requestAccounts': return store.authenticated ? [MOCK_EVM] : []
      case 'wallet_requestPermissions': return [{ caveats: [{ value: [MOCK_EVM] }] }]
      case 'wallet_switchEthereumChain': {
        chainId = parseInt((params?.[0] as { chainId: string }).chainId, 16)
        listeners.get('chainChanged')?.forEach(f => f(`0x${chainId.toString(16)}`))
        return null
      }
      case 'personal_sign': log('personal_sign'); return `0x${'11'.repeat(65)}`
      case 'eth_sendTransaction': log(`send:${JSON.stringify(params?.[0])}`); return `0x${'ab'.repeat(32)}`
      default: {
        const r = await fetch('https://rpc.mainnet.arc.io', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }) })
        const j = await r.json() as { result?: unknown; error?: { message: string } }
        if (j.error) throw new Error(j.error.message)
        return j.result
      }
    }
  },
  on(e: string, f: Listener) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e)!.add(f) },
  removeListener(e: string, f: Listener) { listeners.get(e)?.delete(f) },
}

// ── Privy's API, as used ─────────────────────────────────────────────────────
export type PrivyClientConfig = Record<string, unknown>
const Ctx = createContext<{ config: PrivyClientConfig; appId: string } | null>(null)

export function PrivyProvider({ appId, config, children }: { appId: string; config: PrivyClientConfig; children: ReactNode }) {
  const s = useStore()
  useEffect(() => { log(`provider:${appId}`) }, [appId])
  const close = () => {
    const m = store.modal
    set({ modal: null })
    if (m?.kind === 'login') loginCallbacks.onError?.('exited_auth_flow')
    if (m?.kind === 'export') m.done()
    if (m?.kind === 'mfa') m.done(false)
  }
  const go = () => {
    const m = store.modal
    if (m?.kind === 'login') {
      set({ modal: null, authenticated: true, walletsReady: false })
      log('login')
      loginCallbacks.onComplete?.({ user: userOf(store), isNewUser: false, wasAlreadyAuthenticated: false, loginMethod: 'email', loginAccount: null })
      // Privy makes the wallets a moment after the sign-in.
      setTimeout(() => set({ walletsReady: true }), 300)
    } else if (m?.kind === 'mfa') { set({ modal: null }); m.done(true) } else close()
  }
  return (
    <Ctx.Provider value={{ config, appId }}>
      {children}
      {s.modal && createPortal(
        <div data-testid="privy-mock-modal" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.5)', display: 'grid', placeItems: 'center' }}>
          <div style={{ background: '#fff', color: '#000', padding: 20, borderRadius: 12, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <b>Privy (stand-in) · {s.modal.kind}{s.modal.kind === 'export' ? ` · ${s.modal.address}` : ''}</b>
            <button data-testid="privy-mock-continue" onClick={go}>{s.modal.kind === 'export' ? 'Done' : 'Continue as mock@arcdex.test'}</button>
            <button data-testid="privy-mock-close" onClick={close}>Close</button>
          </div>
        </div>, document.body)}
    </Ctx.Provider>
  )
}

export function usePrivy() {
  const s = useStore()
  return { ready: true, authenticated: s.authenticated, user: userOf(s), error: null as Error | null }
}
export function useLogin(cb?: typeof loginCallbacks) {
  loginCallbacks = cb ?? {}
  return { login: useCallback(() => { log('open-login'); set({ modal: { kind: 'login' } }) }, []) }
}
export function useLogout() {
  return { logout: useCallback(async () => { log('logout'); set({ authenticated: false, walletsReady: false }) }, []) }
}
export function useWallets() {
  const s = useStore()
  return {
    ready: true,
    wallets: s.authenticated && s.walletsReady ? [{ address: MOCK_EVM, walletClientType: 'privy', type: 'ethereum', chainId: `eip155:${chainId}`, getEthereumProvider: async () => provider }] : [],
  }
}
const useExporter = (tag: string) => useCallback(async (o?: { address: string }) => {
  log(`${tag}:${o?.address}`)
  await new Promise<void>(done => set({ modal: { kind: 'export', address: o?.address ?? '', done } }))
}, [])
export function useExportWallet() { return { exportWallet: useExporter('export-evm') } }
export function useMfa() {
  return { promptMfa: useCallback(async () => { log('mfa'); const ok = await new Promise<boolean>(done => set({ modal: { kind: 'mfa', done } })); if (!ok) throw new Error('MFA cancelled') }, []) }
}
export function useMfaEnrollment() { return { showMfaEnrollmentModal: useCallback(() => { log('enroll'); set({ mfa: true }) }, []) } }

// The Solana side (react-auth/solana) shares the store.
export function useSolanaMock() {
  const s = useStore()
  return s.authenticated && s.walletsReady
}
export { useExporter as _useExporter, log as _log }
