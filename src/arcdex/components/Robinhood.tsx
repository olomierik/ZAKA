// Small pieces shared by the Robinhood Chain screens: a coin's logo and the stock-token tag.

import { t as T } from '../lib/i18n'
import { useLogo } from '../lib/logo'

export function RhLogo({ src, symbol, size = 28 }: { src: string | null; symbol: string; size?: number }) {
  const { url, onError } = useLogo(src, size)
  if (!url) {
    const bg = `hsl(${(symbol.charCodeAt(0) * 17 + 90) % 360},55%,26%)`
    return (
      <span className="rh-logo" style={{ width: size, height: size, background: bg, fontSize: size * 0.35 }}>
        {symbol.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  return <img className="rh-logo" src={url} alt={symbol} width={size} height={size} style={{ width: size, height: size }} onError={onError} />
}

/** Marks one of Robinhood's stock tokens. */
export function StockTag() {
  return <span className="mk-tag rh-stock-tag" title={T('A Robinhood stock token: it tracks the company’s share price.')}>{T('STOCK')}</span>
}
