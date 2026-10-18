// The browser wallets (MetaMask, Rabby, Phantom…) an admin can sign with on /admin, whatever Privy connected
// (owner, 2026-10-18: "it gets hard for our admin wallets to be recognized: once you sign in with Privy it creates a
// wallet for you, whether you signed in with email, MetaMask or another wallet"). After a Privy sign-in the app's
// connected wallet is the one Privy made; an admin wallet in MetaMask, or a router's owner setting its fee, has to sign
// as itself, so /admin connects it directly through wagmi's injected connectors.

export interface ConnectorLike { id: string; name: string; type: string; icon?: string }

/** The wallets announced by the browser (EIP-6963), one per name, Privy's own left out; with none announced, the
 * generic injected wallet (window.ethereum) when there is one. */
export function browserWallets<C extends ConnectorLike>(connectors: readonly C[], hasInjected: boolean): C[] {
  const injected = connectors.filter(c => c.type === 'injected' && c.id !== 'privy')
  const announced: C[] = []
  for (const c of injected) if (c.icon && !announced.some(a => a.name === c.name)) announced.push(c)
  if (announced.length) return announced
  return hasInjected ? injected.filter(c => c.id === 'injected').slice(0, 1) : []
}
