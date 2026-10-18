// /admin's browser-wallet picker (src/arcdex/lib/browserWallets.ts): the wallets an admin can sign with as themselves,
// whatever Privy connected.
//   bun scripts/test-browser-wallets.ts
import { browserWallets, type ConnectorLike } from '../src/arcdex/lib/browserWallets'

let n = 0
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); n++; console.log('  ✓', m) }

const c = (id: string, name: string, type = 'injected', icon?: string): ConnectorLike => ({ id, name, type, ...(icon ? { icon } : {}) })
const config = [c('metaMask', 'MetaMask'), c('injected', 'Injected'), c('walletConnect', 'WalletConnect', 'walletConnect'), c('coinbaseWalletSDK', 'Coinbase Wallet', 'coinbaseWallet'), c('privy', 'Privy')]
const announced = [c('io.metamask', 'MetaMask', 'injected', 'data:mm'), c('io.rabby', 'Rabby Wallet', 'injected', 'data:rb'), c('io.metamask.flask', 'MetaMask', 'injected', 'data:mm2')]

const both = browserWallets([...config, ...announced], true)
ok(both.map(w => w.id).join() === 'io.metamask,io.rabby', 'the wallets the browser announces (EIP-6963), one per name')
ok(!both.some(w => w.id === 'privy') && !browserWallets([c('privy', 'Privy', 'injected', 'data:p')], true).length, 'never the wallet Privy made, even if it announced itself')
ok(!both.some(w => w.type !== 'injected'), 'not WalletConnect or Coinbase (they open their own windows)')
ok(browserWallets(config, true).map(w => w.id).join() === 'injected', 'nothing announced but window.ethereum there: the generic browser wallet')
ok(browserWallets(config, false).length === 0, 'no browser wallet at all: nothing to offer')

console.log(`\n${n} checks passed`)
