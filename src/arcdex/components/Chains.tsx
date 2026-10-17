// Networks for the multichain screens (Swap, Bridge): each chain's mark in its own colour, a strip of
// every chain ARCDEX bridges USDC with, and a picker that opens a grid of them.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BRIDGE_NETWORKS as BRIDGE_CHAINS } from '../lib/bridgeChains'
import { t as T } from '../lib/i18n'

/** Each chain's colour and short mark (no third-party logos are bundled). */
const LOOK: Record<string, { bg: string; fg?: string; mark: string }> = {
  Arc: { bg: 'linear-gradient(135deg, #2a6df4, #6d5cf6)', mark: 'A' },
  Base: { bg: '#0052ff', mark: 'B' },
  Ethereum: { bg: '#627eea', mark: 'Ξ' },
  Arbitrum: { bg: '#213147', fg: '#28a0f0', mark: 'A' },
  Optimism: { bg: '#ff0420', mark: 'OP' },
  Polygon: { bg: '#8247e5', mark: 'P' },
  Avalanche: { bg: '#e84142', mark: 'A' },
  Linea: { bg: '#121212', fg: '#61dfff', mark: 'L' },
  Unichain: { bg: '#f50db4', mark: 'U' },
  WorldChain: { bg: '#1c1c1c', fg: '#ffffff', mark: 'W' },
  Sonic: { bg: '#0a1a33', fg: '#fe9a4d', mark: 'S' },
  Solana: { bg: 'linear-gradient(135deg, #9945ff, #14f195)', mark: 'S' },
  Robinhood: { bg: '#ccff00', fg: '#0b0e11', mark: 'R' },
  BNB: { bg: '#f0b90b', fg: '#0b0e11', mark: 'B' },
  HL: { bg: '#072723', fg: '#97fce4', mark: 'H' },
}

export function chainLabel(chain: string): string {
  if (chain === 'Arc') return 'Arc'
  if (chain === 'Robinhood') return 'Robinhood Chain'
  if (chain === 'BNB') return 'BNB Chain'
  if (chain === 'HL') return 'Hyperliquid'
  return BRIDGE_CHAINS.find(c => c.chain === chain)?.label ?? chain
}

/** Each chain's logo on DefiLlama's icon CDN (2026-10-17, owner: "chain icons and symbols to be shown", as Across shows
 * them); the coloured mark above stays until it loads, and if it can't. */
const LLAMA: Record<string, string> = {
  Arc: 'arc', Base: 'base', Ethereum: 'ethereum', Arbitrum: 'arbitrum', Optimism: 'optimism', Polygon: 'polygon', Avalanche: 'avalanche',
  Linea: 'linea', Unichain: 'unichain', WorldChain: 'world%20chain', Sonic: 'sonic', Solana: 'solana', Robinhood: 'robinhood', BNB: 'bsc',
  HL: 'hyperliquid',
}
export const chainLogoUrl = (chain: string): string | null => (LLAMA[chain] ? `https://icons.llamao.fi/icons/chains/rsz_${LLAMA[chain]}.jpg` : null)

export function ChainIcon({ chain, size = 22 }: { chain: string; size?: number }) {
  const l = LOOK[chain] ?? { bg: '#2b3139', mark: chain.slice(0, 1) }
  const url = chainLogoUrl(chain)
  const [ok, setOk] = useState(false)
  return (
    <span className={`chain-icon${ok ? ' has-img' : ''}`} title={chainLabel(chain)} style={{ width: size, height: size, background: ok ? 'transparent' : l.bg, color: l.fg ?? '#fff', fontSize: size * (l.mark.length > 1 ? 0.36 : 0.48) }}>
      {!ok && l.mark}
      {/* Loaded invisibly: a lazy image that's display:none is never fetched. */}
      {url && <img src={url} alt="" width={size} height={size} decoding="async" onLoad={() => setOk(true)} onError={() => setOk(false)} style={ok ? undefined : { position: 'absolute', opacity: 0, width: 1, height: 1 }} />}
    </span>
  )
}

/** Across's token pill: the token's icon with its chain's logo on it, the token and "on {chain}" (a button when it
 * opens a picker). */
export function TokenChainLabel({ token, chain, icon }: { token: string; chain: string; icon?: ReactNode }) {
  return (
    <>
      <span className="xs-tok-ic">{icon ?? <UsdcIcon size={30} />}<span className="xs-tok-chain"><ChainIcon chain={chain} size={15} /></span></span>
      <span className="xs-tok-tx"><b>{token}</b><small>{T('on {chain}', { chain: chainLabel(chain) })}</small></span>
    </>
  )
}

/** Every network USDC moves between and Arc: a row of their marks. */
export function ChainStrip({ size = 22, onPick }: { size?: number; onPick?: (chain: string) => void }) {
  return (
    <div className="chain-strip">
      {BRIDGE_CHAINS.map(c => (
        onPick
          ? <button key={c.chain} className="chain-strip-item" onClick={() => onPick(c.chain)} title={c.label}><ChainIcon chain={c.chain} size={size} /></button>
          : <ChainIcon key={c.chain} chain={c.chain} size={size} />
      ))}
    </div>
  )
}

/** A network button that opens a grid of the chains to choose from (or shows Arc, fixed). */
export function ChainPicker({ value, options, onChange, fixed, token, tokenIcon }: {
  value: string
  options: string[]
  onChange?: (chain: string) => void
  /** Arc's side of a transfer: shown, not chosen. */
  fixed?: boolean
  /** Shown as Across's token pill (the token on its chain) instead of the network alone. */
  token?: string
  tokenIcon?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const list = options.filter(c => chainLabel(c).toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="chain-picker" ref={ref}>
      <button className={`chain-picker-btn${fixed ? ' is-fixed' : ''}${token ? ' xs-pill' : ''}`} onClick={() => !fixed && setOpen(o => !o)} aria-expanded={open} disabled={fixed}>
        {token ? <TokenChainLabel token={token} chain={value} icon={tokenIcon} /> : <><ChainIcon chain={value} size={24} /><span>{chainLabel(value)}</span></>}
        {!fixed && <em>▾</em>}
      </button>
      {open && (
        <div className="chain-pop">
          <input className="chain-pop-search" autoFocus placeholder={T('Search networks')} value={q} onChange={e => setQ(e.target.value)} />
          <div className="chain-pop-grid">
            {list.map(c => (
              <button key={c} className={`chain-pop-item${c === value ? ' active' : ''}`} onClick={() => { onChange?.(c); setOpen(false); setQ('') }}>
                <ChainIcon chain={c} size={26} />
                <span>{chainLabel(c)}</span>
              </button>
            ))}
            {list.length === 0 && <div className="chain-pop-empty">{T('No network matches.')}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

/** USDC's mark: a blue coin with a dollar sign. */
export function UsdcIcon({ size = 22 }: { size?: number }) {
  return <span className="chain-icon usdc-icon" style={{ width: size, height: size, fontSize: size * 0.55 }}>$</span>
}
