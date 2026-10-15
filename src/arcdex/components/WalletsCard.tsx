// Portfolio's wallets card (the build pack's Phase 1: "portfolio card across chains"): the EVM address, the same on Arc,
// Ethereum, Arbitrum, BNB Chain and Robinhood Chain, the Solana address, and what's held on each chain. Arc, BNB Chain,
// Robinhood Chain, Solana and Hyperliquid are valued by Portfolio's own sections and passed in; Ethereum and Arbitrum
// (decision D3) are read here. Below it, the security notices from withdrawals (lib/withdrawPolicy.ts).

import { useEffect, useState } from 'react'
import { ChainIcon } from './Chains'
import { balanceUsd, readChainBalance, type ChainBalance, type ExtraChain } from '../lib/chainBalances'
import { rhEthUsd } from '../api/rhSwaps'
import { useSolanaWallets } from '../lib/solanaWallet'
import { withdrawNotices, type WithdrawNotice } from '../lib/withdrawPolicy'
import { t as T } from '../lib/i18n'
import { formatUnits } from 'viem'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const EVM_CHAINS = ['Arc', 'Ethereum', 'Arbitrum', 'BNB', 'Robinhood'] as const

export interface ChainValues {
  /** USDC cash on Arc and coins there. */
  arcCash: number | null
  arcCoins: number | null
  bnb: number
  robinhood: number
  solana: number
  hyperliquid: number
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="wl-copy" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? T('Copied ✓') : T('Copy')}
    </button>
  )
}

/** ETH and USDC on Ethereum and Arbitrum for `address`, valued; reports their sum. */
function useExtraChains(address: string, onValue: (usd: number) => void) {
  const [bal, setBal] = useState<Partial<Record<ExtraChain, ChainBalance | 'error'>>>({})
  const [eth, setEth] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    setBal({})
    const load = () => {
      void rhEthUsd().then(p => { if (alive) setEth(p) })
      for (const c of ['Ethereum', 'Arbitrum'] as const) {
        readChainBalance(c, address).then(b => { if (alive) setBal(s => ({ ...s, [c]: b })) }, () => { if (alive) setBal(s => ({ ...s, [c]: s[c] && s[c] !== 'error' ? s[c] : 'error' })) })
      }
    }
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [address])
  const usdOf = (c: ExtraChain) => { const b = bal[c]; return b && b !== 'error' ? balanceUsd(b, eth) : 0 }
  const total = usdOf('Ethereum') + usdOf('Arbitrum')
  useEffect(() => { onValue(total) }, [total, onValue])
  return { bal, eth, usdOf }
}

export default function WalletsCard({ evm, values, onExtraValue }: { evm: string; values: ChainValues; onExtraValue: (usd: number) => void }) {
  const sol = useSolanaWallets()
  const solAddr = sol.trading ?? sol.external?.address ?? null
  const { bal, eth, usdOf } = useExtraChains(evm, onExtraValue)
  const [notices, setNotices] = useState<WithdrawNotice[]>(() => withdrawNotices(evm))
  useEffect(() => {
    const on = () => setNotices(withdrawNotices(evm))
    on()
    window.addEventListener('arcdex:withdraw-book', on)
    return () => window.removeEventListener('arcdex:withdraw-book', on)
  }, [evm])

  const extraSub = (c: ExtraChain) => {
    const b = bal[c]
    if (b === undefined) return T('Reading…')
    if (b === 'error') return T('Couldn’t reach {chain}', { chain: c })
    const ethAmt = Number(formatUnits(b.native, 18))
    const usdc = Number(formatUnits(b.usdc, 6))
    if (!ethAmt && !usdc) return T('Nothing here yet')
    return [usdc ? `${money(usdc)} USDC` : '', ethAmt ? `${ethAmt.toLocaleString(undefined, { maximumFractionDigits: 5 })} ETH${eth ? '' : ' ' + T('(price unknown)')}` : ''].filter(Boolean).join(' · ')
  }
  const tiles: { chain: string; name: string; usd: number | null; sub: string }[] = [
    // The cash shows as soon as it's read; the coins join the total once they're priced.
    { chain: 'Arc', name: 'Arc', usd: values.arcCash === null ? null : values.arcCash + (values.arcCoins ?? 0), sub: values.arcCash === null ? T('Reading…') : T('{cash} USDC cash · {coins} in coins', { cash: money(values.arcCash), coins: values.arcCoins === null ? '…' : money(values.arcCoins) }) },
    { chain: 'Ethereum', name: 'Ethereum', usd: bal.Ethereum && bal.Ethereum !== 'error' ? usdOf('Ethereum') : null, sub: extraSub('Ethereum') },
    { chain: 'Arbitrum', name: 'Arbitrum', usd: bal.Arbitrum && bal.Arbitrum !== 'error' ? usdOf('Arbitrum') : null, sub: extraSub('Arbitrum') },
    { chain: 'BNB', name: T('BNB Chain'), usd: values.bnb, sub: values.bnb ? T('Coins and BNB') : T('Nothing here yet') },
    { chain: 'Robinhood', name: T('Robinhood Chain'), usd: values.robinhood, sub: values.robinhood ? T('Coins and ETH') : T('Nothing here yet') },
    { chain: 'Solana', name: 'Solana', usd: solAddr ? values.solana : null, sub: solAddr ? (values.solana ? T('Coins and SOL') : T('Nothing here yet')) : T('Unlock your trading wallet or connect Phantom') },
    { chain: 'Hyperliquid', name: 'Hyperliquid', usd: values.hyperliquid, sub: values.hyperliquid ? T('Futures and predictions') : T('Nothing here yet') },
  ]

  return (
    <section className="arc-card wl-card" aria-label={T('Your wallets')}>
      <div className="wl-head"><b>{T('Your wallets')}</b><span>{T('One account, every chain')}</span></div>
      <div className="wl-addr">
        <div className="wl-addr-top">
          <span className="wl-kind">EVM</span>
          <code className="mono" title={evm}>{short(evm)}</code>
          <Copy text={evm} />
        </div>
        <div className="wl-same">
          <span className="wl-marks">{EVM_CHAINS.map(c => <ChainIcon key={c} chain={c} size={16} />)}</span>
          <span>{T('The same address on Arc, Ethereum, Arbitrum, BNB Chain and Robinhood Chain')}</span>
        </div>
      </div>
      <div className="wl-addr">
        <div className="wl-addr-top">
          <span className="wl-kind sol">SOL</span>
          {solAddr ? <><code className="mono" title={solAddr}>{short(solAddr)}</code><Copy text={solAddr} /></> : <span className="wl-muted">{T('Unlock your trading wallet or connect Phantom to see it')}</span>}
        </div>
        {solAddr && <div className="wl-same"><span className="wl-marks"><ChainIcon chain="Solana" size={16} /></span><span>{sol.trading ? T('Your trading wallet’s Solana address') : T('Your {wallet} wallet', { wallet: sol.external?.name ?? 'Solana' })}</span></div>}
      </div>
      <div className="wl-grid">
        {tiles.map(t => (
          <div key={t.chain} className={`wl-tile${t.usd ? '' : ' empty'}`}>
            <ChainIcon chain={t.chain === 'Hyperliquid' ? 'HL' : t.chain} size={22} />
            <div>
              <div className="wl-tile-h"><span>{t.name}</span><b className="mono sensitive">{t.usd === null ? '…' : money(t.usd)}</b></div>
              <small>{t.sub}</small>
            </div>
          </div>
        ))}
      </div>
      {notices.length > 0 && (
        <div className="wl-notices">
          <b>{T('Security notices')}</b>
          {notices.slice(0, 3).map(n => (
            <div key={n.at + n.title}><span className="mono">{new Date(n.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> {n.title}</div>
          ))}
        </div>
      )}
    </section>
  )
}
