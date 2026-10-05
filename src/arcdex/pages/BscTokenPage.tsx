// A BNB Chain coin (2026-10-05), on Solana's coin page layout (SolanaTokenPage.tsx): the pair bar, market trades, the
// chart, a buy form and a sell form side by side (components/BscTrade.tsx), the coin's pools, and every trade
// underneath. Phones: chart, stats, trades and a Buy / Sell bar opening the trade sheet.
//
// Trades come straight from the chain (api/bscSwaps.ts, lib/useChainTrades.ts, 2026-10-05): four.meme's own events
// while the coin is on its curve, else its PancakeSwap pool's, each about a second after its block, so they move the
// price and pop on the chart. GeckoTerminal (api/bscMarket.ts) gives the candles, the coin's stats, its pools and the
// older trades. four.meme's contract says whether it launched the coin, whether it's still on its curve and how far
// along, read when the page opens and every 30s.

import { useEffect, useMemo, useState } from 'react'
import type { Page } from '../App'
import PriceChart, { type ChartTrade } from '../components/PriceChart'
import { MarketTrades } from '../components/SpotPanels'
import Sheet, { TradeBar } from '../components/Sheet'
import { AgoText } from '../components/Ago'
import { ChainIcon } from '../components/Chains'
import { RhLogo } from '../components/Robinhood'
import SafetyBadge from '../components/SafetyBadge'
import BscTrade, { BSC_NOTE } from '../components/BscTrade'
import { getBscCoin, getBscTrades, bscChartSource, bscCoinFour, bscSeed, bnbUsd, withFour, BNB_NATIVE, FOUR, WBNB, type BscCoin, type BscCoinDetail, type FourInfo } from '../api/bscMarket'
import { bscFeed, bscMaker, bscPoolKind, resolveBscMakers, type BscPoolMeta } from '../api/bscSwaps'
import { useChainTrades } from '../lib/useChainTrades'
import { BSC_QUOTE_SYMBOLS } from '../../../api/_bscCore'
import { bscAddress, bscToken, bscTx } from '../lib/bsc'
import { bscSafety } from '../lib/safety'
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
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

interface Props { address: string; pool?: string; navigate: (p: Page) => void }

function seedCoin(token: string, pool?: string): BscCoinDetail | null {
  const r = bscSeed(token, pool)
  return r ? { ...r, supply: null, pools: [r] } : null
}

export default function BscTokenPage({ address, pool: poolParam, navigate }: Props) {
  const mobile = useIsMobile()
  const me = useTrader().address?.toLowerCase() ?? null
  const mine = new Set(me ? [me] : [])
  const [coin, setCoin] = useState<BscCoinDetail | null>(() => seedCoin(address, poolParam))
  const [loaded, setLoaded] = useState(false)
  // four.meme's word: undefined until it answers, null for a coin it didn't launch.
  const [four, setFour] = useState<FourInfo | null | undefined>(() => seedCoin(address, poolParam)?.four)
  const [sheet, setSheet] = useState<'buy' | 'sell' | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setCoin(prev => (prev && prev.address === address ? prev : seedCoin(address, poolParam))); setLoaded(false)
    const load = () => getBscCoin(address, poolParam).then(c => { if (live && c) setCoin(c) }).catch(() => {}).finally(() => { if (live) setLoaded(true) })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [address, poolParam])

  const offLink = !!poolParam && !!coin?.pools.some(p => p.pool === poolParam && p.offMarket)
  const pool = (offLink ? coin?.pool : poolParam || coin?.pool) || ''

  // four.meme's contract: whether it launched the coin, and its curve (re-read every 30s while it's on it).
  useEffect(() => {
    let live = true
    const read = () => bscCoinFour(address).then(f => { if (live && f !== undefined) setFour(f) }).catch(() => {})
    void read()
    const id = setInterval(() => { if (!document.hidden) void read() }, 30_000)
    return () => { live = false; clearInterval(id) }
  }, [address])

  const symbol = coin?.symbol ?? (loaded ? '?' : '…')
  const decimals = coin?.decimals ?? null
  const gtPrice = coin?.priceUsd ?? 0
  const poolRow = coin ? coin.pools.find(p => p.pool === pool) : undefined
  const onCurve = !!four && !four.graduated

  // The pool's swaps from the chain: four.meme's events while on its curve, else the PancakeSwap pool's.
  const kind = onCurve ? 'four' : poolRow ? bscPoolKind(poolRow.dex) : null
  const quote = (onCurve ? four!.quote : poolRow?.quote ?? '').toLowerCase()
  const isBnb = quote === WBNB || quote === BNB_NATIVE
  const knownQuote = !!quote && (isBnb || quote in BSC_QUOTE_SYMBOLS)
  const coinDecimals = decimals ?? (onCurve ? 18 : null)
  const meta = useMemo<BscPoolMeta | null>(() => (kind && knownQuote && coinDecimals !== null && (kind === 'four' || pool)
    ? { pool: kind === 'four' ? FOUR.manager : pool.toLowerCase(), kind, coin: address.toLowerCase(), quote, coinDecimals, quoteDecimals: 18 }
    : null), [kind, knownQuote, coinDecimals, pool, address, quote])
  const feed = useMemo(() => (meta ? bscFeed(meta) : null), [meta])
  // The quote in dollars: BNB from PancakeSwap's WBNB/USDT pair (every 30s), the stablecoins at $1.
  const [bnbPrice, setBnbPrice] = useState(0)
  useEffect(() => {
    if (!isBnb) return
    let live = true
    const read = () => bnbUsd().then(v => { if (live && v > 0) setBnbPrice(v) })
    void read()
    const id = setInterval(() => { if (!document.hidden) void read() }, 30_000)
    return () => { live = false; clearInterval(id) }
  }, [isBnb])
  const quoteUsd = isBnb ? (bnbPrice || null) : knownQuote ? 1 : null
  const { rows, ticks, chainOn, tradesLoaded, chainPrice } = useChainTrades({
    feed, gtKey: pool, gtLoad: pool ? () => getBscTrades(pool, address) : null, quoteUsd, gtPrice,
    makerOf: bscMaker, resolveMakers: (txs, found) => void resolveBscMakers(txs, found),
  })
  const livePrice = chainPrice || (!chainOn && rows[0]?.live ? rows[0].priceUsd : 0)
  const priceUsd = livePrice || gtPrice
  // The trade form's price guard: a live trade's price only from a pool GeckoTerminal lists for the coin, not off-market.
  const guardPrice = (!!poolRow && !poolRow.offMarket && livePrice) || gtPrice

  const withChain: BscCoin | null = coin ? withFour(coin, four ?? undefined) : null
  const safety = withChain ? bscSafety(withChain) : null
  const progress = onCurve ? four!.progress : null

  // Launchpad coins only (owner, 2026-10-04): four.meme's, and four.meme's contract must vouch for it.
  const unlisted = (!!coin && loaded && !coin.launchpad) || four === null
  const buyBlocked = unlisted ? T('Not a launchpad coin: ARCDEX only lists and sells coins launched on a launchpad, because coins from unknown contracts can be malicious. You can still sell any you hold.')
    : undefined

  useEffect(() => { document.title = `${priceUsd ? fmtPrice(priceUsd) + ' | ' : ''}${symbol} | ARCDEX` }, [priceUsd, symbol])

  const source = useMemo(() => (pool ? bscChartSource(pool, address, chainOn) : undefined), [pool, address, chainOn])
  const chartTrades: ChartTrade[] = useMemo(() => rows.flatMap(r => {
    if (!r.priceUsd) return []
    const who = r.maker ? short(r.maker) : T('Someone')
    return [{
      id: r.id, time: r.timestamp, priceUsd: r.priceUsd, usd: r.usd, kind: r.kind, maker: r.maker, live: r.live,
      mine: !!r.maker && mine.has(r.maker.toLowerCase()),
      label: `${who} ${r.kind === 'buy' ? 'bought' : 'sold'} $${r.usd >= 1000 ? (r.usd / 1000).toFixed(1) + 'K' : r.usd.toFixed(2)}`,
    }]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, me])

  const chart = source ? (
    <PriceChart poolAddress={null} source={source} ticks={ticks} live={chainOn || rows.some(r => r.live)} trades={chartTrades} supply={coin?.supply ?? null}
      symbol={symbol} height={mobile ? 300 : 420} liveTitle={chainOn ? T('Every swap appears the moment its block lands') : T('Trades on BNB Chain, from GeckoTerminal')} />
  ) : <div className="spot-empty" style={{ height: mobile ? 300 : 420, display: 'grid', placeItems: 'center' }}>{loaded ? T('No market for this coin on GeckoTerminal yet.') : T('Loading…')}</div>

  const stats: [string, string, string?][] = [
    [T('24h change'), coin ? pct(coin.change24h) : '—', coin ? color(coin.change24h) : undefined],
    [T('1h'), coin ? pct(coin.change1h) : '—', coin ? color(coin.change1h) : undefined],
    [T('Market cap'), fmt(coin?.marketCap, '$')],
    [T('Liquidity'), fmt(coin?.liquidity, '$')],
    [T('24h volume'), fmt(coin?.volume24h, '$')],
    [T('24h trades'), coin ? (coin.buys24h + coin.sells24h).toLocaleString() : '—'],
  ]

  const network = <span className="rh-net"><ChainIcon chain="BNB" size={14} /> {T('BNB Chain')}</span>
  const headActions = (
    <div className="token-head-actions">
      {safety && <SafetyBadge view={safety} />}
      <button title={T('Copy contract address')} className="head-icon" onClick={() => { void navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>{copied ? '✓' : '⧉'}</button>
      <a title={T('Explorer')} className="head-icon" href={bscToken(address)} target="_blank" rel="noopener noreferrer">↗</a>
      <a title={T('Search on X')} className="head-icon" href={`https://x.com/search?q=${encodeURIComponent(`${address} OR $${symbol}`)}&f=live`} target="_blank" rel="noopener noreferrer">🔍</a>
    </div>
  )
  const notices = (
    <>
      {loaded && !coin && <div className="spot-notice warn">{T('No market for this coin on GeckoTerminal yet.')}</div>}
      {unlisted && <div className="spot-notice warn">{T('⚠ This coin wasn’t launched on a launchpad, so ARCDEX doesn’t list it or offer it to buy. Coins from unknown contracts can be malicious.')}</div>}
      {onCurve && (
        <div className="spot-notice sol-curve">
          <span>🚀 {T('On {pad}’s bonding curve', { pad: 'four.meme' })}{progress !== null ? `: ${progress.toFixed(1)}%` : ''} · {T('traded on four.meme’s contract until it graduates to PancakeSwap')}</span>
          {progress !== null && <span className="sol-curve-bar"><i style={{ width: `${Math.min(100, progress)}%` }} /></span>}
        </div>
      )}
    </>
  )
  const trade = (side?: 'buy' | 'sell', compact?: boolean, initialMode?: 'buy' | 'sell') => (
    <BscTrade key={`${side ?? initialMode ?? 'x'}:${onCurve ? 'curve' : 'pool'}`} token={address} symbol={symbol} decimals={decimals} priceUsd={guardPrice} buyBlocked={buyBlocked}
      four={four} side={side} compact={compact} initialMode={initialMode} />
  )
  const tradesTable = (
    <div className="spot-panel rh-trades">
      <div className="spot-panel-h"><span>{T('Trades')}</span>{pool && <a className="rh-gt" href={`https://www.geckoterminal.com/bsc/pools/${pool}`} target="_blank" rel="noopener noreferrer">GeckoTerminal ↗</a>}</div>
      <div className="swaps-wrap" style={{ overflow: 'auto', maxHeight: 480 }}>
        <table className="swaps-table rh-swaps">
          <thead><tr><th>{T('Date')}</th><th className="sw-type">{T('Type')}</th><th>USD</th><th className="sw-tok">{symbol}</th><th className="sw-price">{T('Price')}</th><th>{T('Maker')}</th><th className="sw-tx" /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="spot-empty">{tradesLoaded ? T('No trades yet') : T('Loading trades…')}</td></tr>}
            {rows.slice(0, 100).map(r => {
              const buy = r.kind === 'buy'
              const c = buy ? 'var(--green)' : 'var(--red)'
              return (
                <tr key={r.id} className={`${r.live ? 'swap-row-new' : ''}${r.maker && mine.has(r.maker.toLowerCase()) ? ' rh-mine' : ''}`}>
                  <td className="rh-muted"><AgoText ts={r.timestamp} /></td>
                  <td className="sw-type" style={{ color: c, fontWeight: 700 }}>{buy ? T('Buy') : T('Sell')}</td>
                  <td className="rh-mono" style={{ color: c }}>{r.usd < 0.01 ? '<$0.01' : fmt(r.usd, '$')}</td>
                  <td className="sw-tok rh-mono" style={{ color: c }}>{fmt(r.tokenAmount)}</td>
                  <td className="sw-price rh-mono" style={{ color: c }}>{r.priceUsd ? fmtPrice(r.priceUsd) : '—'}</td>
                  <td>{r.maker ? <a className="rh-maker" href={bscAddress(r.maker)} target="_blank" rel="noopener noreferrer">{short(r.maker)}</a> : '—'}</td>
                  <td className="sw-tx"><a href={bscTx(r.txHash)} target="_blank" rel="noopener noreferrer" title={T('Explorer')} className="rh-muted">↗</a></td>
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
        <button key={p.pool} className={`rh-pool${p.pool === pool ? ' on' : ''}${p.offMarket ? ' off' : ''}`} disabled={p.offMarket}
          title={p.offMarket ? T('Priced far off {symbol}’s market: a trap pool, not a market.', { symbol }) : undefined}
          onClick={() => navigate({ name: 'bsc-token', address, pool: p.pool })}>
          <span>{symbol}/{p.quoteSymbol || '?'}</span>
          <small>{p.offMarket ? T('⚠ Off-market pool') : (p.launchpad ?? p.dex.replace(/-/g, ' '))}</small>
          <b>{fmt(p.liquidity, '$')}</b>
        </button>
      ))}
    </div>
  )

  if (mobile) return (
    <div className="token-page coin-mobile rh-token sol-token bsc-token">
      <div className="token-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <RhLogo src={coin?.image ?? null} symbol={symbol} size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1.15rem', display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              {symbol}<span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>/{coin?.quoteSymbol || 'USD'}</span>
              {coin?.launchpad && <span className="mk-tag rh-lp-tag">{coin.launchpad}</span>}
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
        <p className="swap-note" style={{ padding: '0 16px' }}>{BSC_NOTE()}</p>
        <TradeBar symbol={symbol} onTrade={setSheet} />
        <Sheet open={sheet !== null} onClose={() => setSheet(null)}>
          {sheet && trade(undefined, false, sheet)}
        </Sheet>
      </div>
    </div>
  )

  return (
    <div className="token-page spot-page rh-token sol-token bsc-token">
      <div className="spot-bar">
        <div className="spot-bar-pair">
          <RhLogo src={coin?.image ?? null} symbol={symbol} size={32} />
          <div style={{ minWidth: 0 }}>
            <div className="spot-bar-sym">{symbol}<span>/{coin?.quoteSymbol || 'USD'}</span>{coin?.launchpad && <span className="mk-tag rh-lp-tag">{coin.launchpad}</span>}</div>
            <div className="spot-bar-name">{coin?.name}{coin?.name && ' · '}{network}</div>
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
              <span className="spot-form-hint">{onCurve ? T('On four.meme’s curve: traded with BNB.') : T('Pay with USDC on Arc, BNB or USDT.')}</span>
            </div>
            <div className="spot-form-sides">
              {trade('buy', true)}
              {trade('sell', true)}
            </div>
            <p className="spot-form-note">{BSC_NOTE()}</p>
          </div>
        </div>
        <div className="spot-side">
          <div className="spot-panel rh-back">
            <button className="mk-trade" onClick={() => navigate({ name: 'bsc' })}>‹ {T('BNB Chain markets')}</button>
          </div>
          {pools}
        </div>
        <div className="spot-bottom">{tradesTable}</div>
      </div>
    </div>
  )
}
