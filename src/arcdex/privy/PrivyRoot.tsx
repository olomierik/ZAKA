// Privy itself (privy/state.ts says what this is for), in its own chunk: loaded only when someone picks "Email or
// social", or when this browser was signed in before. It renders nothing of its own; Privy draws its windows (sign-in,
// confirmations, key export) on top of the page.
//
// It keeps privy/state.ts up to date (signed in, the account's label, its EVM and Solana addresses, two-step
// verification), hands the EVM wallet's provider to the `privy` wagmi connector and connects it, and gives
// lib/solanaWallet.ts the Solana wallet's signer.

import { useEffect, useMemo } from 'react'
import { getIdentityToken, PrivyProvider, useExportWallet, useLogin, useLogout, useMfa, useMfaEnrollment, usePrivy, useWallets, type PrivyClientConfig } from '@privy-io/react-auth'
import {
  defaultSolanaRpcsPlugin,
  useExportWallet as useExportSolana,
  useSignMessage as useSignSolanaMessage,
  useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets,
} from '@privy-io/react-auth/solana'
import { connect, disconnect, getAccount, getConnections } from 'wagmi/actions'
import { arc, wagmiConfig } from '../wagmi'
import { useTheme } from '../lib/theme'
import { t as T } from '../lib/i18n'
import { setPrivySolana } from '../lib/solanaWallet'
import { accountLabel } from './stepUp'
import { loginSettled, markSignedIn, registerPrivy, setPrivyEvmProvider, setPrivyState, takePrivyConnectWish, wantPrivyConnect } from './state'

export default function PrivyRoot({ appId }: { appId: string }) {
  const theme = useTheme()
  const config = useMemo((): PrivyClientConfig => ({
    appearance: {
      theme,
      accentColor: theme === 'dark' ? '#00ec97' : '#0a8f4f',
      logo: `${window.location.origin}/arcdex-mark.png`,
      landingHeader: T('Sign in to ARCDEX'),
      loginMessage: T('With your email or a social account. Your EVM and Solana wallets are made for you.'),
    },
    // Every account gets both wallets, even one that also linked a wallet app.
    embeddedWallets: { ethereum: { createOnLogin: 'all-users' }, solana: { createOnLogin: 'all-users' }, showWalletUIs: true },
    // Arc first: the wallet starts there. The rest are the chains ARCDEX trades and bridges on.
    defaultChain: arc,
    supportedChains: [...wagmiConfig.chains],
    // Privy's own Solana RPC for its windows (balances and simulations it shows before signing).
    plugins: [defaultSolanaRpcsPlugin()],
  }), [theme])
  return (
    <PrivyProvider appId={appId} config={config}>
      <Bridge />
    </PrivyProvider>
  )
}

/** The EVM wallet connected to the app (wagmi), if it isn't already. */
async function connectWagmi() {
  const connector = wagmiConfig.connectors.find(c => c.id === 'privy')
  if (!connector) return
  const a = getAccount(wagmiConfig)
  if (a.isConnected && a.connector?.id === 'privy') return
  await connect(wagmiConfig, { connector, chainId: arc.id }).catch(() => { /* already connected, or the wallet isn't ready: the next change tries again */ })
}

async function disconnectWagmi() {
  for (const c of getConnections(wagmiConfig)) {
    if (c.connector.id !== 'privy') continue
    await disconnect(wagmiConfig, { connector: c.connector }).catch(() => {
      // wagmi says goodbye through the wallet's provider; without one it can't, so the connection is dropped here.
      wagmiConfig.setState(st => {
        const connections = new Map(st.connections)
        connections.delete(c.connector.uid)
        const current = st.current === c.connector.uid ? (connections.keys().next().value ?? null) : st.current
        return { ...st, connections, current, status: connections.size ? st.status : 'disconnected' }
      })
    })
  }
}

function Bridge() {
  const { ready, authenticated, user, error } = usePrivy()
  const { login } = useLogin({
    onComplete: ({ wasAlreadyAuthenticated }) => {
      // A sign-in that just happened counts for the step-up; a session restored on load doesn't.
      if (!wasAlreadyAuthenticated) markSignedIn()
      loginSettled(null)
    },
    onError: e => loginSettled(String(e)),
  })
  const { logout } = useLogout()
  const { wallets } = useWallets()
  const { wallets: solWallets } = useSolanaWallets()
  const { exportWallet } = useExportWallet()
  const { exportWallet: exportSolana } = useExportSolana()
  const { signTransaction } = useSignSolanaTransaction()
  const { signMessage } = useSignSolanaMessage()
  const { promptMfa } = useMfa()
  const { showMfaEnrollmentModal } = useMfaEnrollment()

  // The wallets Privy made (not a wallet app the account also linked).
  const evm = wallets.find(w => w.walletClientType === 'privy') ?? null
  const solAddress = user?.linkedAccounts.find((a): a is Extract<typeof a, { type: 'wallet' }> =>
    a.type === 'wallet' && a.chainType === 'solana' && a.walletClientType === 'privy')?.address ?? null
  const sol = solWallets.find(w => w.address === solAddress) ?? null
  const evmAddress = (evm?.address ?? null) as `0x${string}` | null

  useEffect(() => {
    setPrivyState({
      ready, authenticated,
      label: authenticated ? accountLabel(user) : null,
      evm: authenticated ? evmAddress : null,
      sol: authenticated ? sol?.address ?? null : null,
      mfa: authenticated && (user?.mfaMethods.length ?? 0) > 0,
      error: error ? error.message : null,
    })
  }, [ready, authenticated, user, evmAddress, sol?.address, error])

  useEffect(() => {
    registerPrivy({
      login: () => login(),
      logout: () => logout(),
      exportEvm: () => (evmAddress ? exportWallet({ address: evmAddress }) : Promise.reject(new Error(T('Your EVM wallet isn’t ready yet')))),
      exportSol: () => (sol ? exportSolana({ address: sol.address }) : Promise.reject(new Error(T('Your Solana wallet isn’t ready yet')))),
      promptMfa: () => promptMfa(),
      enrollMfa: () => showMfaEnrollmentModal(),
      identityToken: () => getIdentityToken(),
    })
    return () => registerPrivy(null)
  }, [login, logout, exportWallet, exportSolana, promptMfa, showMfaEnrollmentModal, evmAddress, sol])

  // The EVM wallet → the app. Another account signing in on this tab reconnects, so the app never trades from the one
  // before. Signed out (here, or the session ended): the app lets go of the wallet first, while its provider is still
  // there for wagmi to disconnect through, then the provider goes.
  useEffect(() => {
    let alive = true
    if (!ready) return
    if (!authenticated) {
      void disconnectWagmi().finally(() => { if (alive) setPrivyEvmProvider(null) })
      return () => { alive = false }
    }
    if (!evm) return
    void evm.getEthereumProvider().then(async provider => {
      if (!alive) return
      setPrivyEvmProvider(provider)
      const a = getAccount(wagmiConfig)
      if (a.isConnected && a.connector?.id === 'privy' && a.address?.toLowerCase() !== evm.address.toLowerCase()) {
        await disconnectWagmi()
        wantPrivyConnect()
      }
      if (takePrivyConnectWish()) await connectWagmi()
    }).catch(() => {})
    return () => { alive = false }
  }, [ready, authenticated, evm])

  // The Solana wallet → lib/solanaWallet.ts. Privy shows its own confirmation before it signs.
  useEffect(() => {
    if (!authenticated || !sol) { setPrivySolana(null); return }
    setPrivySolana({
      address: sol.address,
      signTransaction: async bytes => (await signTransaction({ transaction: bytes, wallet: sol, chain: 'solana:mainnet' })).signedTransaction,
      signMessage: async message => (await signMessage({ message, wallet: sol })).signature,
    })
    return () => setPrivySolana(null)
  }, [authenticated, sol, signTransaction, signMessage])

  return null
}
