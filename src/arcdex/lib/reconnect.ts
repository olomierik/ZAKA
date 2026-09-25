import type { Config } from 'wagmi'
import { reconnect } from 'wagmi/actions'

// Reconnect only the wallet used last time. wagmi's default reconnect asks
// every connector for its provider, which downloads and starts the
// WalletConnect SDK (with its relay socket) and the Coinbase SDK — ~700 KB —
// on every visit, for everyone, even people who never used them.
export function reconnectLastWallet(config: Config) {
  const run = async () => {
    const recent = await config.storage?.getItem('recentConnectorId')
    if (!recent) return
    // Wallets announcing themselves (EIP-6963) can land a moment after load.
    for (let i = 0; i < 6; i++) {
      const found = config.connectors.filter(c => c.id === recent)
      if (found.length) { await reconnect(config, { connectors: found }).catch(() => {}); return }
      await new Promise(r => setTimeout(r, 250))
    }
  }
  void run()
}
