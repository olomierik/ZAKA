import { isEstablishedCoin, isLaunchpadCoin } from '../../../api/_launchpads'
import { isListable, isRugged, LISTING } from '../lib/safety'
import { useEffect, useMemo, useState } from 'react'
import { cachedArgusMarket, copycatOf, getArgusMarket, type ArgusPool } from '../api/argusMarket'
import { getAllLaunchpadTokens } from '../api/launchpad'
import TokenSwap from '../components/TokenSwap'
import { SolanaPayCard } from '../components/SolanaCross'
import { ARC_ID } from '../lib/relayQuote'
import { ChainIcon, ChainStrip, UsdcIcon } from '../components/Chains'
import { BRIDGE_NETWORKS } from '../lib/bridgeChains'
import { COIN_IMAGE, COIN_LC, COIN_POOL, fmtPct, fmtSmallUsd, useCoin } from '../lib/coin'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'
import { useLogo } from '../lib/logo'

// /swap: Binance's Convert, for Arc. USDC on Arc in, any coin out (or back), in one card; beside it,
// the way in for anyone whose USDC is on another chain (11 networks, Circle's CCTP), and $ARCDEX.

interface Props { navigate: (p: Page) => void }

interface Coin { address: string; symbol: string; name: string; image: string | null; priceUsd: number; volume24h: number; pool?: string; launchpad: boolean
  /** Listed (lib/safety.ts isListable): $15K or more of market cap and not rugged. Searching still finds the rest. */
  listed: boolean }

const fromMarket = (list: ArgusPool[]): Coin[] => {
  const best = new Map<string, ArgusPool>()
  // Launchpad coins (owner, 2026-10-04) and established coins from any DEX (2026-10-05).
  const now = Date.now()
  const established = (x: ArgusPool) => isEstablishedCoin({ symbol: x.token.symbol, liquidityUsd: x.liquidityUsd, ageMs: x.createdAt ? now - Date.parse(x.createdAt) : 0,
    marketCapUsd: x.marketCapUsd ?? x.fdvUsd ?? 0, txns24h: x.txns24h.buys + x.txns24h.sells })
  for (const p of list.filter(x => isLaunchpadCoin(x.launchpad ?? 'Argus') || established(x))) {
    const k = p.token.address.toLowerCase()
    const cur = best.get(k)
    if (!cur || p.liquidityUsd > cur.liquidityUsd) best.set(k, p)
  }
  return [...best.values()].map(p => {
    const onCurve = p.bonded === false
    const mc = p.marketCapUsd ?? p.fdvUsd ?? 0
    return {
      address: p.token.address.toLowerCase(), symbol: p.token.symbol, name: p.token.name, image: p.token.image,
      priceUsd: p.priceUsd, volume24h: p.volume24h, pool: p.pool, launchpad: false,
      listed: isListable({ official: false, marketCapUsd: mc, rugged: isRugged({ change24h: p.change.h24, liquidityUsd: p.liquidityUsd, onCurve }) }),
    }
  })
}
const price = (n: number) => !n ? '—' : n < 0.0001 ? `$${n.toPrecision(3)}` : n < 1 ? `$${n.toPrecision(3)}` : `$${n.toFixed(2)}`

function CoinLogo({ coin, size = 30 }: { coin: Pick<Coin, 'image' | 'symbol'>; size?: number }) {
  const { url, onError } = useLogo(coin.image, size)
  if (!url) return <span className="xs-logo blank" style={{ width: size, height: size }}>{coin.symbol.slice(0, 2).toUpperCase()}</span>
  return <img className="xs-logo" src={url} alt="" width={size} height={size} onError={onError} />
}

export default function Swap({ navigate }: Props) {
  const [coins, setCoins] = useState<Coin[]>(() => fromMarket(cachedArgusMarket() ?? []))
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Coin | null>(null)
  const coinQ = useCoin()
  const coinPick: Coin = { address: COIN_LC, symbol: 'ARCDEX', name: 'ARCDEX', image: COIN_IMAGE, priceUsd: coinQ?.priceUsd ?? 0, volume24h: coinQ?.volume24h ?? 0, pool: COIN_POOL, launchpad: false, listed: true }

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getArgusMarket().then(fromMarket).catch(() => [] as Coin[]),
      // ARCDEX's own launchpad: every coin has a 1B supply.
      getAllLaunchpadTokens().then(ts => ts.map((t): Coin => ({
        address: t.address.toLowerCase(), symbol: t.symbol, name: t.name, image: t.metadata?.image ?? null,
        priceUsd: t.priceUsd, volume24h: 0, launchpad: true, listed: t.priceUsd * 1e9 >= LISTING.minMarketCapUsd,
      }))).catch(() => [] as Coin[]),
    ]).then(([market, curve]) => {
      if (cancelled) return
      const seen = new Set(market.map(c => c.address))
      setCoins(prev => {
        const next = [...market, ...curve.filter(c => !seen.has(c.address))]
        return next.length ? next : prev
      })
    })
    return () => { cancelled = true }
  }, [])

  // Most traded first ($ARCDEX always on top); typing narrows by symbol, name or address.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rest = coins.filter(c => c.address !== COIN_LC)
    const list = q ? rest.filter(c => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.address === q) : rest.filter(c => c.listed)
    const top = [...list].sort((a, b) => b.volume24h - a.volume24h).slice(0, q ? 20 : 10)
    const coinFits = !q || 'arcdex arcd'.includes(q) || q === COIN_LC
    return coinFits ? [{ ...coinPick, priceUsd: coinQ?.priceUsd ?? coins.find(c => c.address === COIN_LC)?.priceUsd ?? 0 }, ...top] : top
  }, [coins, query, coinQ]) // eslint-disable-line react-hooks/exhaustive-deps
  const popular = useMemo(() => [...coins].filter(c => c.address !== COIN_LC && c.listed && !copycatOf(c.symbol, c.address)).sort((a, b) => b.volume24h - a.volume24h).slice(0, 5), [coins])

  return (
    <div className="xs-page">
      <div className="xs-head">
        <h1>{T("Swap")}</h1>
        <p>{T('Swap USDC for any coin on Arc in one tap, and back. USDC on another chain? Bring it over in about a minute.')}</p>
      </div>

      <div className="xs-grid">
        <div className="xs-main">
          <div className="xs-card">
            {!picked ? (
              <>
                <div className="xs-box">
                  <div className="xs-box-h"><span>{T('From')}</span><span className="xs-net"><ChainIcon chain="Arc" size={16} /> Arc</span></div>
                  <div className="xs-asset"><UsdcIcon size={30} /><b>USDC</b><small>{T('Pay with USDC, or sell a coin back to USDC')}</small></div>
                </div>
                <div className="xs-arrow" aria-hidden>↓</div>
                <div className="xs-box xs-box-to">
                  <div className="xs-box-h"><span>{T('To')}</span><span className="xs-net"><ChainIcon chain="Arc" size={16} /> Arc</span></div>
                  <input placeholder={T("Search by symbol, name, or address…")} value={query} onChange={e => setQuery(e.target.value)} inputMode="search" className="xs-search" />
                  {!query && (
                    <div className="xs-chips">
                      <button className="xs-chip arcdex" onClick={() => setPicked(coinPick)}><CoinLogo coin={coinPick} size={18} />ARCDEX</button>
                      {popular.map(c => <button key={c.address} className="xs-chip" onClick={() => setPicked(c)}><CoinLogo coin={c} size={18} />{c.symbol}</button>)}
                    </div>
                  )}
                  <div className="xs-list-h"><span>{query ? T('Results') : T("MOST TRADED")}</span><span>{T('Price')}</span></div>
                  <div className="xs-list">
                    {matches.map(c => {
                      const copy = copycatOf(c.symbol, c.address)
                      return (
                        <button key={c.address} onClick={() => setPicked(c)} className={`xs-coin${c.address === COIN_LC ? ' arcdex' : ''}`}>
                          <CoinLogo coin={c} />
                          <span className="xs-coin-name">
                            <b>{c.symbol}{c.address === COIN_LC && <span className="mk-official">{T('Official')}</span>}{c.launchpad && <span className="swap-tag">{T("Launchpad")}</span>}</b>
                            <small style={copy ? { color: '#fca5a5' } : undefined}>{copy ? T("⚠ Not real {symbol}", { symbol: copy }) : c.name}</small>
                          </span>
                          <span className="xs-coin-price">{price(c.priceUsd)}</span>
                        </button>
                      )
                    })}
                    {query && matches.length === 0 && <div className="xs-empty">{T("No tokens match \"")}{query}"</div>}
                    {!query && coins.length === 0 && <div className="xs-empty">{T("Loading…")}</div>}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="xs-picked">
                  <CoinLogo coin={picked} size={36} />
                  <span className="xs-coin-name"><b>{picked.symbol}<small>/USDC</small></b><small>{picked.name}</small></span>
                  <button className="xs-link" onClick={() => navigate(picked.launchpad ? { name: 'token', address: picked.address, symbol: picked.symbol } : { name: 'argus', address: picked.address, pool: picked.pool ?? '' })}>{T("View chart →")}</button>
                  <button className="xs-change" onClick={() => { setPicked(null); setQuery('') }}>{T('Change')}</button>
                </div>
                <div className="xs-widget">
                  <TokenSwap address={picked.address} pool={picked.pool} fallback={{ symbol: picked.symbol, image: picked.image, priceUsd: picked.priceUsd }} />
                  {/* Or straight from a Solana wallet, with SOL or USDC on Solana. */}
                  <SolanaPayCard chainId={ARC_ID} token={picked.address} symbol={picked.symbol} priceUsd={picked.priceUsd} />
                </div>
              </>
            )}
          </div>
        </div>

        <aside className="xs-side">
          <div className="xs-panel xs-multi">
            <b>{T('USDC on another chain?')}</b>
            <p>{T('Bring it to Arc from {n} networks with Circle’s CCTP: native USDC, no wrapped tokens, usually under a minute.', { n: BRIDGE_NETWORKS.length })}</p>
            <ChainStrip size={26} onPick={() => navigate({ name: 'bridge', dir: 'in' })} />
            <button className="btn-primary xs-btn" onClick={() => navigate({ name: 'bridge', dir: 'in' })}>{T('Deposit USDC to Arc')}</button>
            <button className="xs-link" onClick={() => navigate({ name: 'bridge', dir: 'out' })}>{T('Send USDC to another chain →')}</button>
          </div>
          <div className="xs-panel">
            <b>{T('How it works')}</b>
            <ol className="xs-steps">
              <li><span>1</span>{T('Bring USDC to Arc: bridge it in, or buy it with a card.')}</li>
              <li><span>2</span>{T('Pick a coin and an amount: the price and fees show before you confirm.')}</li>
              <li><span>3</span>{T('Confirm. With the trading wallet it’s one tap, no pop-ups.')}</li>
            </ol>
          </div>
          <button className="xs-panel xs-arcdex" onClick={() => setPicked(coinPick)}>
            <img src={COIN_IMAGE} alt="" width={32} height={32} />
            <span><b>$ARCDEX</b><small>{T('30% of ARCDEX’s fees buy back $ARCDEX and burn it.')}</small></span>
            <span className="xs-arcdex-price">{fmtSmallUsd(coinQ?.priceUsd)}<small className={(coinQ?.change24h ?? 0) >= 0 ? 'up-txt' : 'down-txt'}>{fmtPct(coinQ?.change24h)}</small></span>
          </button>
        </aside>
      </div>
    </div>
  )
}
