// Small pieces shared by the Robinhood Chain screens and the Markets page:
// the Arc ⇄ Robinhood Chain switch, a coin's logo and the stock-token tag.

import { useState } from 'react'
import type { Page } from '../App'
import { ChainIcon } from './Chains'
import { t as T } from '../lib/i18n'

/** Markets on Arc or on Robinhood Chain. */
export function ChainSwitch({ chain, navigate }: { chain: 'arc' | 'robinhood'; navigate: (p: Page) => void }) {
  return (
    <div className="chain-switch" role="tablist" aria-label={T('Network')}>
      <button role="tab" aria-selected={chain === 'arc'} className={chain === 'arc' ? 'on' : ''} onClick={() => chain !== 'arc' && navigate({ name: 'terminal' })}>
        <ChainIcon chain="Arc" size={16} /> Arc
      </button>
      <button role="tab" aria-selected={chain === 'robinhood'} className={chain === 'robinhood' ? 'on' : ''} onClick={() => chain !== 'robinhood' && navigate({ name: 'robinhood' })}>
        <ChainIcon chain="Robinhood" size={16} /> <span className="cs-full">{T('Robinhood Chain')}</span><span className="cs-short">Robinhood</span>
      </button>
    </div>
  )
}

export function RhLogo({ src, symbol, size = 28 }: { src: string | null; symbol: string; size?: number }) {
  const [err, setErr] = useState(false)
  if (!src || err) {
    const bg = `hsl(${(symbol.charCodeAt(0) * 17 + 90) % 360},55%,26%)`
    return (
      <span className="rh-logo" style={{ width: size, height: size, background: bg, fontSize: size * 0.35 }}>
        {symbol.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  return <img className="rh-logo" src={src} alt={symbol} width={size} height={size} style={{ width: size, height: size }} onError={() => setErr(true)} />
}

/** Marks one of Robinhood's stock tokens. */
export function StockTag() {
  return <span className="mk-tag rh-stock-tag" title={T('A Robinhood stock token: it tracks the company’s share price.')}>{T('STOCK')}</span>
}
