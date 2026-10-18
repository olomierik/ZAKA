// Portfolio's wallets card (the build pack's Phase 1: "portfolio card across chains"): the EVM address, the same on Arc,
// Robinhood Chain, BNB Chain, Base, Arbitrum and Ethereum, the Solana address, and what's held on each chain. Since
// 2026-10-18 (owner: "I sent one USDG and it doesn't show; read balances from all the chains we support, all networks by
// default") every chain's own coin and dollar tokens are read here: ETH and USDG on Robinhood Chain, BNB, USDT and USDC
// on BNB Chain, SOL and USDC on Solana, ETH and USDC on Base, Arbitrum and Ethereum (lib/chainBalances.ts). Coins
// bought there are valued by Portfolio's own sections and passed in. Below it, the security notices from withdrawals.

import { useEffect, useState } from 'react'
import { ChainIcon } from './Chains'
import { balanceUsd, EXTRA_CHAINS, EXTRA_CHAIN_LIST, readChainBalance, type ChainBalance, type ExtraChain } from '../lib/chainBalances'
import { rhEthUsd } from '../api/rhSwaps'
import { bnbUsd } from '../api/bscMarket'
import { solUsd } from '../api/solanaMarket'
import { solBalance, solTokenBalance, SOL_USDC } from '../lib/solana'
import { onBalances } from '../lib/balances'
import { useSolanaWallets } from '../lib/solanaWallet'
import { withdrawNotices, type WithdrawNotice } from '../lib/withdrawPolicy'
import { t as T } from '../lib/i18n'
import { formatUnits } from 'viem'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 6 })
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const EVM_CHAINS = ['Arc', 'Robinhood', 'BNB', 'Base', 'Arbitrum', 'Ethereum'] as const

export interface ChainValues {
  /** USDC cash on Arc and coins there. */
  arcCash: number | null
  arcCoins: number | null
  /** Coins held on each chain (Portfolio's sections), without the chain's own coin or dollar tokens. */
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

type Read<T> = T | 'error' | undefined
interface SolBal { sol: number; usdc: number }

/** Every chain's own coin and dollar tokens for `address` (and the Solana address), valued; reports their sum. Read on
 * open, every 60 seconds, and when a trade or transfer lands (lib/balances.ts). */
function useChainBalances(address: string, solAddr: string | null, onValue: (usd: number) => void) {
  const [bal, setBal] = useState<Partial<Record<ExtraChain, Read<ChainBalance>>>>({})
  const [sol, setSol] = useState<Read<SolBal>>(undefined)
  const [px, setPx] = useState<{ ETH: number | null; BNB: number | null; SOL: number | null }>({ ETH: null, BNB: null, SOL: null })
  useEffect(() => {
    let alive = true
    setBal({}); setSol(undefined)
    const load = () => {
      void rhEthUsd().then(p => { if (alive && p) setPx(x => ({ ...x, ETH: p })) })
      void bnbUsd().then(p => { if (alive && p > 0) setPx(x => ({ ...x, BNB: p })) }).catch(() => {})
      void solUsd().then(p => { if (alive && p > 0) setPx(x => ({ ...x, SOL: p })) }).catch(() => {})
      for (const c of EXTRA_CHAIN_LIST) {
        readChainBalance(c, address).then(
          b => { if (alive) setBal(s => ({ ...s, [c]: b })) },
          () => { if (alive) setBal(s => ({ ...s, [c]: s[c] && s[c] !== 'error' ? s[c] : 'error' })) })
      }
      if (solAddr) {
        Promise.all([solBalance(solAddr), solTokenBalance(solAddr, SOL_USDC)]).then(
          ([s, u]) => { if (alive) setSol({ sol: s, usdc: u.amount }) },
          () => { if (alive) setSol(x => (x && x !== 'error' ? x : 'error')) })
      }
    }
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    const off = onBalances(load)
    return () => { alive = false; clearInterval(id); off() }
  }, [address, solAddr])
  const usdOf = (c: ExtraChain) => { const b = bal[c]; return b && b !== 'error' ? balanceUsd(b, px[EXTRA_CHAINS[c].native]) : 0 }
  const solUsdNow = sol && sol !== 'error' ? sol.usdc + (px.SOL ? sol.sol * px.SOL : 0) : 0
  const total = EXTRA_CHAIN_LIST.reduce((s, c) => s + usdOf(c), 0) + solUsdNow
  useEffect(() => { onValue(total) }, [total, onValue])
  return { bal, sol, px, usdOf, solUsdNow }
}

export default function WalletsCard({ evm, values, onExtraValue }: { evm: string; values: ChainValues; onExtraValue: (usd: number) => void }) {
  const solW = useSolanaWallets()
  const solAddr = solW.trading ?? solW.external?.address ?? null
  const { bal, sol, px, usdOf, solUsdNow } = useChainBalances(evm, solAddr, onExtraValue)
  const [notices, setNotices] = useState<WithdrawNotice[]>(() => withdrawNotices(evm))
  useEffect(() => {
    const on = () => setNotices(withdrawNotices(evm))
    on()
    window.addEventListener('arcdex:withdraw-book', on)
    return () => window.removeEventListener('arcdex:withdraw-book', on)
  }, [evm])

  /** What a chain holds, in words: its dollar tokens and its own coin. */
  const assets = (c: ExtraChain) => {
    const b = bal[c]
    if (b === undefined) return T('Reading…')
    if (b === 'error') return T('Couldn’t reach {chain}', { chain: T(EXTRA_CHAINS[c].name) })
    const native = EXTRA_CHAINS[c].native
    const n = Number(formatUnits(b.native, 18))
    const parts = b.tokens.map(t => ({ t, v: Number(formatUnits(t.raw, t.decimals)) })).filter(x => x.v > 0)
      .map(x => `${amt(x.v)} ${x.t.symbol}${x.t.note ? ` (${x.t.note})` : ''}`)
    if (n > 0) parts.push(`${amt(n)} ${native}${px[native] ? '' : ' ' + T('(price unknown)')}`)
    return parts.join(' · ')
  }
  const withCoins = (words: string, coins: number) => [words, coins > 0 ? T('{v} in coins', { v: money(coins) }) : ''].filter(Boolean).join(' · ') || T('Nothing here yet')
  const evmTile = (c: ExtraChain, coins: number) => {
    const b = bal[c]
    const read = !!b && b !== 'error'
    return { chain: c, name: T(EXTRA_CHAINS[c].name), usd: read ? usdOf(c) + coins : b === 'error' && coins ? coins : null, sub: read ? withCoins(assets(c), coins) : assets(c) }
  }
  const solRead = !!sol && sol !== 'error'
  const solWords = solRead ? [sol.usdc > 0 ? `${amt(sol.usdc)} USDC` : '', sol.sol > 0 ? `${amt(sol.sol)} SOL` : ''].filter(Boolean).join(' · ') : ''
  const tiles: { chain: string; name: string; usd: number | null; sub: string }[] = [
    // The cash shows as soon as it's read; the coins join the total once they're priced.
    { chain: 'Arc', name: 'Arc', usd: values.arcCash === null ? null : values.arcCash + (values.arcCoins ?? 0), sub: values.arcCash === null ? T('Reading…') : T('{cash} USDC cash · {coins} in coins', { cash: money(values.arcCash), coins: values.arcCoins === null ? '…' : money(values.arcCoins) }) },
    evmTile('Robinhood', values.robinhood),
    evmTile('BNB', values.bnb),
    {
      chain: 'Solana', name: 'Solana', usd: !solAddr ? null : solRead ? solUsdNow + values.solana : null,
      sub: !solAddr ? T('Unlock your trading wallet or connect Phantom') : sol === undefined ? T('Reading…') : sol === 'error' ? T('Couldn’t reach {chain}', { chain: 'Solana' }) : withCoins(solWords, values.solana),
    },
    evmTile('Base', 0),
    evmTile('Arbitrum', 0),
    evmTile('Ethereum', 0),
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
          <span>{T('The same address on Arc, Robinhood Chain, BNB Chain, Base, Arbitrum and Ethereum')}</span>
        </div>
      </div>
      <div className="wl-addr">
        <div className="wl-addr-top">
          <span className="wl-kind sol">SOL</span>
          {solAddr ? <><code className="mono" title={solAddr}>{short(solAddr)}</code><Copy text={solAddr} /></> : <span className="wl-muted">{T('Unlock your trading wallet or connect Phantom to see it')}</span>}
        </div>
        {solAddr && <div className="wl-same"><span className="wl-marks"><ChainIcon chain="Solana" size={16} /></span><span>{solW.trading ? T('Your trading wallet’s Solana address') : T('Your {wallet} wallet', { wallet: solW.external?.name ?? 'Solana' })}</span></div>}
      </div>
      <div className="wl-grid">
        {tiles.map(t => (
          <div key={t.chain} className={`wl-tile${t.usd ? '' : ' empty'}`}>
            <ChainIcon chain={t.chain === 'Hyperliquid' ? 'HL' : t.chain} size={22} />
            <div>
              <div className="wl-tile-h"><span>{t.name}</span><b className="mono sensitive">{t.usd === null ? '…' : money(t.usd)}</b></div>
              <small className="sensitive">{t.sub}</small>
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

/** The trading wallet's panel (components/TradingWalletPanel.tsx): what it holds on every other chain, one line each,
 * read the same way as the card above. Chains holding nothing aren't listed. */
export function OtherChains({ evm, sol }: { evm: string; sol: string | null }) {
  const noop = useState(() => () => {})[0]
  const { bal, sol: s, usdOf, solUsdNow } = useChainBalances(evm, sol, noop)
  const rows: { chain: string; name: string; usd: number; words: string }[] = []
  for (const c of EXTRA_CHAIN_LIST) {
    const b = bal[c]
    if (!b || b === 'error') continue
    const native = EXTRA_CHAINS[c].native
    const n = Number(formatUnits(b.native, 18))
    const parts = b.tokens.map(t => ({ t, v: Number(formatUnits(t.raw, t.decimals)) })).filter(x => x.v > 0).map(x => `${amt(x.v)} ${x.t.symbol}`)
    if (n > 0) parts.push(`${amt(n)} ${native}`)
    if (parts.length) rows.push({ chain: c, name: T(EXTRA_CHAINS[c].name), usd: usdOf(c), words: parts.join(' · ') })
  }
  if (s && s !== 'error' && (s.sol > 0 || s.usdc > 0)) rows.splice(2, 0, { chain: 'Solana', name: 'Solana', usd: solUsdNow, words: [s.usdc > 0 ? `${amt(s.usdc)} USDC` : '', s.sol > 0 ? `${amt(s.sol)} SOL` : ''].filter(Boolean).join(' · ') })
  const reading = EXTRA_CHAIN_LIST.some(c => bal[c] === undefined)
  if (!rows.length) return reading ? <div className="wl-other-empty">{T('Reading other chains…')}</div> : null
  return (
    <div className="wl-other" aria-label={T('On other chains')}>
      <div className="wl-other-h">{T('On other chains')}</div>
      {rows.map(r => (
        <div key={r.chain} className="wl-other-row">
          <ChainIcon chain={r.chain} size={16} />
          <span>{r.name}</span>
          <small className="sensitive">{r.words}</small>
          <b className="mono sensitive">{money(r.usd)}</b>
        </div>
      ))}
    </div>
  )
}
