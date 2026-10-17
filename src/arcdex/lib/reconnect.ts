import { useEffect } from 'react'
import { useConfig, type Config } from 'wagmi'
import { reconnect } from 'wagmi/actions'
import { initPrivy } from '../privy/state'

// Reconnect only the wallet used last time. wagmi's default reconnect asks
// every connector for its provider, which downloads and starts the
// WalletConnect SDK (with its relay socket) and the Coinbase SDK — ~700 KB —
// on every visit, for everyone, even people who never used them.
const started = new WeakSet<Config>()
export function reconnectLastWallet(config: Config) {
  if (started.has(config)) return
  started.add(config)
  const run = async () => {
    const recent = await config.storage?.getItem('recentConnectorId')
    // An email or social sign-in (Privy) comes back when Privy has loaded: privy/PrivyRoot.tsx connects it then.
    initPrivy(recent ?? null)
    if (!recent || recent === 'privy') return
    // Wallets announcing themselves (EIP-6963) can land a moment after load.
    for (let i = 0; i < 6; i++) {
      const found = config.connectors.filter(c => c.id === recent)
      if (found.length) { await reconnect(config, { connectors: found }).catch(() => {}); return }
      await new Promise(r => setTimeout(r, 250))
    }
  }
  void run()
}

/** Put inside `<WagmiProvider reconnectOnMount={false}>`. With that setting, wagmi clears every connection while the
 * provider first renders. A reconnect started before then could finish first and be wiped: a wallet that answers at
 * once (no round trip to an extension) was signed out on every reload. So it starts after the provider has mounted. */
export function ReconnectLastWallet(): null {
  const config = useConfig()
  useEffect(() => { reconnectLastWallet(config) }, [config])
  return null
}
