// The wallet used last time is reconnected on load (src/arcdex/lib/reconnect.ts), and stays connected.
//
// With `reconnectOnMount={false}`, wagmi's provider clears every connection while it first renders (core/hydrate.js).
// The app used to start its reconnect before rendering: a wallet that answers at once was reconnected, then wiped, so a
// reload signed it out. Found by the Phase 6 browser check with an in-page wallet. This checks wagmi still behaves that
// way (so the order matters), that reconnecting after the provider mounts keeps the wallet, and the entry files' order.
//   bun scripts/test-reconnect.tsx
import { readFileSync } from 'node:fs'
import { createConfig, createConnector, createStorage, hydrate, reconnect } from '@wagmi/core'
import { http, type EIP1193Provider } from 'viem'
import { arc } from '../src/arcdex/wagmi'
import { reconnectLastWallet } from '../src/arcdex/lib/reconnect'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const

/** A wallet that answers every request at once, as a wallet with its accounts cached in the page does. */
function fastWallet() {
  const provider = {
    on: () => {}, removeListener: () => {},
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [ACCOUNT]
      if (method === 'eth_chainId') return `0x${arc.id.toString(16)}`
      throw new Error(`not in the test wallet: ${method}`)
    },
  } as unknown as EIP1193Provider
  return createConnector(() => ({
    id: 'fast.wallet', name: 'Fast Wallet', type: 'injected',
    async connect() { return { accounts: [ACCOUNT], chainId: arc.id } as never },
    async disconnect() {},
    async getAccounts() { return [ACCOUNT] },
    async getChainId() { return arc.id },
    async getProvider() { return provider },
    async isAuthorized() { return true },
    onAccountsChanged() {}, onChainChanged() {}, onDisconnect() {},
  }))
}

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}
async function freshConfig() {
  const config = createConfig({ chains: [arc], connectors: [fastWallet()], transports: { [arc.id]: http('http://127.0.0.1:1') }, storage: createStorage({ storage: memory() }), multiInjectedProviderDiscovery: false })
  await config.storage!.setItem('recentConnectorId', 'fast.wallet')
  return config
}
const connected = (c: Awaited<ReturnType<typeof freshConfig>>) => c.state.connections.size === 1 && [...c.state.connections.values()][0].accounts[0] === ACCOUNT
const settle = () => new Promise(r => setTimeout(r, 50))

console.log('wagmi’s provider clears connections when it mounts (why the order matters)')
{
  const config = await freshConfig()
  await reconnect(config, { connectors: config.connectors })
  check(connected(config), 'a fast wallet reconnects before the provider mounts…')
  hydrate(config, { reconnectOnMount: false }).onMount()
  check(config.state.connections.size === 0, '…and the provider’s first render wipes it (the old order’s reload sign-out)')
}

console.log('reconnecting after the provider mounts keeps the wallet')
{
  const config = await freshConfig()
  hydrate(config, { reconnectOnMount: false }).onMount()
  reconnectLastWallet(config)
  await settle()
  check(connected(config), 'the last wallet is connected')
  check(config.state.status === 'connected', 'status connected')
  reconnectLastWallet(config)
  await settle()
  check(connected(config) && config.state.connections.size === 1, 'a second call (React’s strict-mode effects run twice) does nothing more')
}

console.log('nothing is reconnected without a last wallet')
{
  const config = await freshConfig()
  await config.storage!.removeItem('recentConnectorId')
  hydrate(config, { reconnectOnMount: false }).onMount()
  reconnectLastWallet(config)
  await settle()
  check(config.state.connections.size === 0, 'no last wallet: nothing connected')
}

console.log('the entry files start it from inside the provider')
for (const f of ['src/appMain.tsx', 'src/arcdex/main.tsx']) {
  const s = readFileSync(f, 'utf8')
  check(/<WagmiProvider[^>]*reconnectOnMount=\{false\}>\s*<ReconnectLastWallet \/>/.test(s), `${f}: <ReconnectLastWallet /> inside <WagmiProvider reconnectOnMount={false}>`)
  check(!/reconnectLastWallet\(/.test(s), `${f}: no reconnect started before rendering`)
}
check(/useEffect\(\(\) => \{ reconnectLastWallet\(config\) \}, \[config\]\)/.test(readFileSync('src/arcdex/lib/reconnect.ts', 'utf8')), 'ReconnectLastWallet starts it in an effect (after the provider’s first render)')

if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
