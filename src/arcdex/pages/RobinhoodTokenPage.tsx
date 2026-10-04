// A Robinhood Chain coin or stock token, on the spot screen's layout
// (ArgusTokenPage.tsx): the pair bar, market trades, the chart, a buy form
// and a sell form side by side (components/RobinhoodTrade.tsx), the pair's
// pools, and every trade underneath. Phones: chart, stats, trades and a
// Buy / Sell bar opening the trade sheet.
//
// Prices, candles and trades are GeckoTerminal's (api/robinhoodMarket.ts);
// whether it's one of Robinhood's stock tokens is read from the chain.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Page } from '../App'
import PriceChart, { type ChartTrade } from '../components/PriceChart'
import { MarketTrades } from '../components/SpotPanels'
import type { TradeRow } from '../components/TokenSocialTabs'
import Sheet, { TradeBar } from '../components/Sheet'
import { AgoText } from '../components/Ago'
import { ChainIcon } from '../components/Chains'
import { RhLogo, StockTag } from '../components/Robinhood'
import RobinhoodTrade, { RH_NOTE } from '../components/RobinhoodTrade'
import { getRhCoin, getRhTrades, rhChartSource, type RhCoinDetail } from '../api/robinhoodMarket'
import { isStockName, isStockToken, rhAddress, rhTokenInfo, rhTx, stockCompany } from '../lib/robinhood'
import type { Tick } from '../lib/candles'
import { useIsMobile } from '../lib/useMobile'
import { useTrader } from '../lib/identity'
import { t as T } from '../lib/i18n'

function fmt(n: number | null | undefined, prefix = ''): string {
  if (!n || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`
  if (n >= 1) return `${prefix}${n.toFixed(2)}`
  return `${prefix}${n.toPrecision(3)}`
}
function fmtPrice(p: number): string {
  if (!p || !Number.isFinite(p)) return '—'
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (p >= 1) return `$${p.toFixed(4)}`
  return `$${p.toPrecision(4)}`
}
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
const color = (n: number) => (n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text-muted)')

interface Props { address: string; pool?: string; navigate: (p: Page) => void }

export default function RobinhoodTokenPage({ address, pool: poolParam, navigate }: Props) {
  const mobile = useIsMobile()
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const [coin, setCoin] = useState<RhCoinDetail | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Undefined until read; null when there's no token at the address.
  const [onchain, setOnchain] = useState<{ name: string; symbol: string; decimals: number } | null | undefined>(undefined)
  const [stockOnChain, setStockOnChain] = useState<boolean | null>(null)
  const [rows, setRows] = useState<TradeRow[]>([])
  const [tradesLoaded, setTradesLoaded] = useState(false)
  const [sheet, setSheet] = useState<'buy' | 'sell' | null>(null)
  const [copied, setCopied] = useState(false)

  // The coin: GeckoTerminal's page for it (price, supply, pools), every 60s.
  useEffect(() => {
    let live = true
    const load = () => getRhCoin(address, poolParam).then(c => { if (live && c) setCoin(c) }).catch(() => {}).finally(() => { if (live) setLoaded(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [address, poolParam])

  // From the chain: what it is, and whether it's one of Robinhood's stock tokens.
  useEffect(() => {
    void rhTokenInfo(address).then(setOnchain)
    void isStockToken(address).then(setStockOnChain).catch(() => setStockOnChain(null))
  }, [address])

  // The pool shown: the link's, unless it's off the market (getRhCoin then picks the coin's best).
  const offLink = !!poolParam && !!coin?.pools.some(p => p.pool === poolParam.toLowerCase() && p.offMarket)
  const pool = (offLink ? coin?.pool : poolParam || coin?.pool) || ''
  const shown = pool.toLowerCase()
  const notToken = loaded && !coin && onchain === null
  const symbol = coin?.symbol ?? onchain?.symbol ?? (notToken ? '?' : '…')
  const fullName = coin?.name ?? onchain?.name ?? ''
  const stockName = isStockName(fullName)
  // The chain decides. Until it answers, a stock name counts as a stock (the buy side stays gated).
  const stock = stockOnChain ?? stockName
  const impostor = stockName && stockOnChain === false
  const name = stock ? stockCompany(fullName) : fullName
  const priceUsd = coin?.priceUsd ?? 0
  const decimals = coin?.decimals ?? onchain?.decimals ?? null

  // Trades, every 12s while the page is visible. Ones that weren't there before are live.
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!pool) return
    let live = true
    seen.current = null
    setRows([]); setTradesLoaded(false)
    const load = () => getRhTrades(pool, address).then(list => {
      if (!live) return
      const before = seen.current
      const next = list.map(r => ({ ...r, live: before !== null && !before.has(r.txHash + r.kind) }))
      seen.current = new Set(list.map(r => r.txHash + r.kind))
      setRows(prev => {
        // Keep the live flag on trades that already popped.
        const wasLive = new Set(prev.filter(r => r.live).map(r => r.txHash + r.kind))
        return next.map(r => (wasLive.has(r.txHash + r.kind) ? { ...r, live: true } : r))
      })
    }).catch(() => {}).finally(() => { if (live) setTradesLoaded(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 12_000)
    return () => { live = false; clearInterval(id) }
  }, [pool, address])

  const source = useMemo(() => (pool ? rhChartSource(pool, address) : undefined), [pool, address])
  const ticks: Tick[] = useMemo(() => rows.filter(r => r.live && r.tokenAmount > 0).map(r => ({ time: r.timestamp, priceUsd: r.usd / r.tokenAmount, usd: r.usd })), [rows])
  const chartTrades: ChartTrade[] = useMemo(() => rows.flatMap(r => {
    const price = r.tokenAmount > 0 ? r.usd / r.tokenAmount : 0
    if (!price) return []
    const who = r.maker ? `${r.maker.slice(0, 6)}…${r.maker.slice(-4)}` : T('Someone')
    return [{
      id: r.txHash + r.kind, time: r.timestamp, priceUsd: price, usd: r.usd, kind: r.kind, maker: r.maker, live: r.live,
      mine: !!me && r.maker?.toLowerCase() === me,
      label: `${who} ${r.kind === 'buy' ? 'bought' : 'sold'} $${r.usd >= 1000 ? (r.usd / 1000).toFixed(1) + 'K' : r.usd.toFixed(2)}`,
    }]
  }), [rows, me])

  useEffect(() => { document.title = `${priceUsd ? fmtPrice(priceUsd) + ' | ' : ''}${symbol} | ARCSENSE` }, [priceUsd, symbol])

  const chart = source ? (
    <PriceChart poolAddress={null} source={source} ticks={ticks} live={rows.some(r => r.live)} trades={chartTrades} supply={coin?.supply ?? null}
      symbol={symbol} height={mobile ? 300 : 420} liveTitle={T('Trades on Robinhood Chain, from GeckoTerminal')} />
  ) : <div className="spot-empty" style={{ height: mobile ? 300 : 420, display: 'grid', placeItems: 'center' }}>{loaded ? T('No market for this coin on GeckoTerminal yet.') : T('Loading…')}</div>

  const stats: [string, string, string?][] = [
    [T('24h change'), coin ? pct(coin.change24h) : '—', coin ? color(coin.change24h) : undefined],
    [T('1h'), coin ? pct(coin.change1h) : '—', coin ? color(coin.change1h) : undefined],
    [T('Market cap'), fmt(coin?.marketCap, '$')],
    [T('Liquidity'), fmt(coin?.liquidity, '$')],
    [T('24h volume'), fmt(coin?.volume24h, '$')],
    [T('24h trades'), coin ? (coin.buys24h + coin.sells24h).toLocaleString() : '—'],
  ]

  const network = <span className="rh-net"><ChainIcon chain="Robinhood" size={14} /> {T('Robinhood Chain')}</span>
  const headActions = (
    <div className="token-head-actions">
      <button title={T('Copy contract address')} className="head-icon" onClick={() => { void navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>{copied ? '✓' : '⧉'}</button>
      <a title={T('Explorer')} className="head-icon" href={rhAddress(address)} target="_blank" rel="noopener noreferrer">↗</a>
      <a title={T('Search on X')} className="head-icon" href={`https://x.com/search?q=${encodeURIComponent(`${address} OR $${symbol}`)}&f=live`} target="_blank" rel="noopener noreferrer">🔍</a>
    </div>
  )
  const notices = (
    <>
      {notToken && <div className="spot-notice warn">{T('No token at this address on Robinhood Chain.')}</div>}
      {impostor && <div className="spot-notice warn">{T('⚠ This token uses a Robinhood stock name, but it isn’t one of Robinhood’s stock tokens. Check the contract address before trading.')}</div>}
      {stock && !impostor && <div className="spot-notice">{T('A Robinhood stock token: it tracks {name}’s share price. Not offered to US persons or in some countries; buying asks where you are first.', { name: name || symbol })}</div>}
    </>
  )
  const trade = (side?: 'buy' | 'sell', compact?: boolean, initialMode?: 'buy' | 'sell') => notToken ? null : (
    <RobinhoodTrade key={`${side ?? initialMode ?? 'x'}`} token={address} symbol={symbol} decimals={decimals} priceUsd={priceUsd} stock={stock}
      side={side} compact={compact} initialMode={initialMode} />
  )
  const tradesTable = (
    <div className="spot-panel rh-trades">
      <div className="spot-panel-h"><span>{T('Trades')}</span><a className="rh-gt" href={`https://www.geckoterminal.com/robinhood/pools/${pool}`} target="_blank" rel="noopener noreferrer">GeckoTerminal ↗</a></div>
      <div className="swaps-wrap" style={{ overflow: 'auto', maxHeight: 480 }}>
        <table className="swaps-table rh-swaps">
          <thead><tr><th>{T('Date')}</th><th className="sw-type">{T('Type')}</th><th>USD</th><th className="sw-tok">{symbol}</th><th className="sw-price">{T('Price')}</th><th>{T('Maker')}</th><th className="sw-tx" /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="spot-empty">{tradesLoaded ? T('No trades yet') : T('Loading trades…')}</td></tr>}
            {rows.slice(0, 100).map(r => {
              const buy = r.kind === 'buy'
              const c = buy ? 'var(--green)' : 'var(--red)'
              const price = r.tokenAmount > 0 ? r.usd / r.tokenAmount : 0
              const mine = !!me && r.maker?.toLowerCase() === me
              return (
                <tr key={r.txHash + r.kind} className={`${r.live ? 'swap-row-new' : ''}${mine ? ' rh-mine' : ''}`}>
                  <td className="rh-muted"><AgoText ts={r.timestamp} /></td>
                  <td className="sw-type" style={{ color: c, fontWeight: 700 }}>{buy ? T('Buy') : T('Sell')}</td>
                  <td className="rh-mono" style={{ color: c }}>{r.usd < 0.01 ? '<$0.01' : fmt(r.usd, '$')}</td>
                  <td className="sw-tok rh-mono" style={{ color: c }}>{fmt(r.tokenAmount)}</td>
                  <td className="sw-price rh-mono" style={{ color: c }}>{price ? fmtPrice(price) : '—'}</td>
                  <td>{r.maker ? <a className="rh-maker" href={rhAddress(r.maker)} target="_blank" rel="noopener noreferrer">{r.maker.slice(0, 6)}…{r.maker.slice(-4)}</a> : '—'}</td>
                  <td className="sw-tx"><a href={rhTx(r.txHash)} target="_blank" rel="noopener noreferrer" title={T('Explorer')} className="rh-muted">↗</a></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
  const pools = coin && coin.pools.length > 0 && (
    <div className="spot-panel rh-pools">
      <div className="spot-panel-h"><span>{T('Pools')}</span></div>
      {coin.pools.slice(0, 6).map(p => (
        // Off-market pools (a trap's fee, or priced far from the coin's market) are listed, never opened.
        <button key={p.pool} className={`rh-pool${p.pool === shown ? ' on' : ''}${p.offMarket ? ' off' : ''}`} disabled={p.offMarket}
          title={p.offMarket ? T('Priced far off {symbol}’s market: a trap pool, not a market.', { symbol }) : undefined}
          onClick={() => navigate({ name: 'rh-token', address, pool: p.pool })}>
          <span>{symbol}/{p.quoteSymbol || '?'}{p.feePct !== null && <em> {p.feePct}%</em>}</span>
          <small>{p.offMarket ? T('⚠ Off-market pool') : p.dex.replace(/-robinhood$/, '').replace(/-/g, ' ')}</small>
          <b>{fmt(p.liquidity, '$')}</b>
        </button>
      ))}
    </div>
  )

  if (mobile) return (
    <div className="token-page coin-mobile rh-token">
      <div className="token-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <RhLogo src={coin?.image ?? null} symbol={symbol} size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1.15rem', display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              {symbol}<span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>/{coin?.quoteSymbol || 'USD'}</span>
              {stock && !impostor && <StockTag />}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{priceUsd ? fmtPrice(priceUsd) : '…'}</span>
              {coin && <span style={{ fontWeight: 600, fontSize: '0.82rem', color: color(coin.change24h) }}>{pct(coin.change24h)}</span>}
              {network}
            </div>
          </div>
        </div>
        {headActions}
      </div>
      {chart}
      <div className="rh-stats">
        {stats.map(([label, val, c]) => <div key={label}><span>{label}</span><b style={{ color: c }}>{val}</b></div>)}
      </div>
      {notices}
      <div className="coin-mobile-body">
        {tradesTable}
        {pools}
        <p className="swap-note" style={{ padding: '0 16px' }}>{RH_NOTE()}</p>
        {!notToken && <TradeBar symbol={symbol} onTrade={setSheet} />}
        <Sheet open={sheet !== null} onClose={() => setSheet(null)}>
          {sheet && trade(undefined, false, sheet)}
        </Sheet>
      </div>
    </div>
  )

  return (
    <div className="token-page spot-page rh-token">
      <div className="spot-bar">
        <div className="spot-bar-pair">
          <RhLogo src={coin?.image ?? null} symbol={symbol} size={32} />
          <div style={{ minWidth: 0 }}>
            <div className="spot-bar-sym">{symbol}<span>/{coin?.quoteSymbol || 'USD'}</span>{stock && !impostor && <StockTag />}</div>
            <div className="spot-bar-name">{name}{name && ' · '}{network}</div>
          </div>
        </div>
        <div className="spot-bar-price">
          <b className={(coin?.change24h ?? 0) >= 0 ? 'up-txt' : 'down-txt'}>{priceUsd ? fmtPrice(priceUsd) : '…'}</b>
          <span>{coin?.marketCap ? T('MCap {v}', { v: fmt(coin.marketCap, '$') }) : ''}</span>
        </div>
        <div className="spot-bar-stats">
          {stats.map(([label, val, c]) => <div key={label}><span>{label}</span><b style={{ color: c }}>{val}</b></div>)}
        </div>
        {headActions}
      </div>
      {notices}

      <div className="spot-grid">
        <div className="spot-book">
          <MarketTrades rows={rows} priceUsd={priceUsd} change24h={coin?.change24h ?? null} symbol={symbol} loaded={tradesLoaded}
            buys24h={coin?.buys24h ?? null} sells24h={coin?.sells24h ?? null} />
        </div>
        <div className="spot-main">
          <div className="spot-panel spot-chart">{chart}</div>
          <div className="spot-panel spot-form">
            <div className="spot-form-tabs">
              <span className="active">{T('Spot')}</span>
              <span className="spot-form-kind">{T('Market')}</span>
              <span className="spot-form-hint">{T('Pay with USDC on Arc; sales come back to Arc.')}</span>
            </div>
            <div className="spot-form-sides">
              {trade('buy', true)}
              {trade('sell', true)}
            </div>
            <p className="spot-form-note">{RH_NOTE()}</p>
          </div>
        </div>
        <div className="spot-side">
          <div className="spot-panel rh-back">
            <button className="mk-trade" onClick={() => navigate({ name: 'robinhood' })}>‹ {T('Robinhood Chain markets')}</button>
          </div>
          {pools}
        </div>
        <div className="spot-bottom">{tradesTable}</div>
      </div>
    </div>
  )
}
