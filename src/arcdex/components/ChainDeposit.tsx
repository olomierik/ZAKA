// Deposit → Crypto: what to send, on which network, to which address (owner, 2026-10-18: "users can't deposit USDG or
// ETH on Robinhood, BNB, SOL or USDC on Solana: the deposit window says send only USDC on Arc"). Every network ARCDEX
// trades on, each with the assets its coin pages can pay with:
//   • Arc: USDC (Arc's gas too);
//   • Robinhood Chain: ETH or USDG (ETH is its gas);
//   • BNB Chain: BNB or USDT (BNB is its gas);
//   • Solana: SOL or USDC, to the Solana address;
//   • Ethereum, Base, Arbitrum: USDC or ETH, spent with "Pay from Ethereum, Base or Arbitrum" on any coin page.
// One EVM address on every EVM network (the trading wallet's key, Privy's wallet or the connected wallet signs on all
// of them); Solana has its own address. The trade forms pick what's held there (lib/payAssets.ts).

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { Trader } from '../lib/identity'
import { useSolanaWallets } from '../lib/solanaWallet'
import { BSC_USDT } from '../../../api/_bscCore'
import { USDG } from '../../../api/_rhCore'
import { SOL_USDC } from '../../../api/_solCore'
import { PAY_CHAINS } from '../lib/payChains'
import { USDC } from '../lib/usdc'
import { ChainIcon } from './Chains'
import { t as T, N_ } from '../lib/i18n'

export type DepositNet = 'arc' | 'hood' | 'bnb' | 'sol' | 'base' | 'arb' | 'eth'

interface NetInfo { id: DepositNet; name: string; icon: string; assets: { symbol: string; contract?: string }[]; use: string; solana?: boolean }

const pay = (name: string) => PAY_CHAINS.find(c => c.name === name)!.usdc

export const DEPOSIT_NETS: NetInfo[] = [
  { id: 'arc', name: 'Arc', icon: 'Arc', assets: [{ symbol: 'USDC', contract: USDC }], use: N_('Trades every Arc coin. USDC also pays Arc’s gas.') },
  { id: 'hood', name: 'Robinhood Chain', icon: 'Robinhood', assets: [{ symbol: 'ETH' }, { symbol: 'USDG', contract: USDG }], use: N_('Buys Robinhood Chain coins straight from your wallet there. ETH also pays its gas.') },
  { id: 'bnb', name: 'BNB Chain', icon: 'BNB', assets: [{ symbol: 'BNB' }, { symbol: 'USDT', contract: BSC_USDT }], use: N_('Buys BNB Chain coins straight from your wallet there. BNB also pays its gas.') },
  { id: 'sol', name: 'Solana', icon: 'Solana', assets: [{ symbol: 'SOL' }, { symbol: 'USDC', contract: SOL_USDC }], use: N_('Buys Solana coins straight from your Solana wallet. SOL also pays its fees.'), solana: true },
  { id: 'base', name: 'Base', icon: 'Base', assets: [{ symbol: 'USDC', contract: pay('Base') }, { symbol: 'ETH' }], use: N_('Pays for coins on any chain: pick “Pay from Ethereum, Base or Arbitrum” on a coin page.') },
  { id: 'arb', name: 'Arbitrum', icon: 'Arbitrum', assets: [{ symbol: 'USDC', contract: pay('Arbitrum') }, { symbol: 'ETH' }], use: N_('Pays for coins on any chain: pick “Pay from Ethereum, Base or Arbitrum” on a coin page.') },
  { id: 'eth', name: 'Ethereum', icon: 'Ethereum', assets: [{ symbol: 'USDC', contract: pay('Ethereum') }, { symbol: 'ETH' }], use: N_('Pays for coins on any chain: pick “Pay from Ethereum, Base or Arbitrum” on a coin page. Ethereum’s fees are high: small amounts are better sent on Base or Arbitrum.') },
]

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function ChainDeposit({ trader, initial = 'arc' }: { trader: Trader; initial?: DepositNet }) {
  const [net, setNet] = useState<DepositNet>(initial)
  const sol = useSolanaWallets()
  const solAddr = sol.trading ?? sol.external?.address ?? null
  const info = DEPOSIT_NETS.find(n => n.id === net)!
  const addr = info.solana ? solAddr : trader.address
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setQr(null); setCopied(false)
    if (addr) void QRCode.toDataURL(addr, { margin: 1, width: 220, color: { dark: '#0b1628', light: '#ffffff' } }).then(setQr).catch(() => {})
  }, [addr])
  const assets = info.assets.map(a => a.symbol).join(T(' or '))

  return (
    <div className="cdep" data-testid="chain-deposit">
      <div className="cdep-nets" role="tablist" aria-label={T('Network')}>
        {DEPOSIT_NETS.map(n => (
          <button key={n.id} role="tab" aria-selected={n.id === net} className={n.id === net ? 'on' : ''} onClick={() => setNet(n.id)}>
            <ChainIcon chain={n.icon} size={16} /><span>{n.name}</span>
          </button>
        ))}
      </div>
      <div className="cdep-assets">
        {T('Send')} {info.assets.map((a, i) => <b key={a.symbol}>{i > 0 && <span className="cdep-or">{T(' or ')}</span>}{a.symbol}</b>)} {T('on')} <b>{info.name}</b>
      </div>
      <div className="cdep-use">{T(info.use)}</div>
      {!addr ? (
        <div className="cdep-warn">{T('Unlock your trading wallet, log in, or connect Phantom to get your Solana address.')}</div>
      ) : (
        <>
          {qr && <img src={qr} alt={T('Deposit address QR code')} className="cdep-qr" />}
          <div className="cdep-addr">{addr}</div>
          <button className="btn-ghost" onClick={() => { void navigator.clipboard?.writeText(addr); setCopied(true) }}>{copied ? T('Copied ✓') : T('Copy address')}</button>
          {!info.solana && <div className="cdep-same">{T('The same address on Arc, Robinhood Chain, BNB Chain, Ethereum, Base and Arbitrum.')}</div>}
          <div className="cdep-warn">
            {T('Send only {assets} on the {network} network to this address. Other tokens or networks can be lost.', { assets, network: info.name })}
          </div>
          {info.assets.some(a => a.contract) && (
            <div className="cdep-contracts">
              {info.assets.filter(a => a.contract).map(a => (
                <span key={a.symbol}>{T('{symbol} contract', { symbol: a.symbol })} <code title={a.contract}>{short(a.contract!)}</code></span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
