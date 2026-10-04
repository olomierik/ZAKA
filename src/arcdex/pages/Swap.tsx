import { useEffect, useMemo, useState } from 'react'
import { cachedArgusMarket, copycatOf, getArgusMarket, type ArgusPool } from '../api/argusMarket'
import { getAllLaunchpadTokens } from '../api/launchpad'
import TokenSwap from '../components/TokenSwap'
import { ChainIcon, ChainStrip, UsdcIcon } from '../components/Chains'
import { BRIDGE_NETWORKS } from '../lib/bridgeChains'
import { SENSE_IMAGE, SENSE_LC, SENSE_POOL, fmtPct, fmtSmallUsd, useSense } from '../lib/sense'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// /swap: Binance's Convert, for Arc. USDC on Arc in, any coin out (or back), in one card; beside it,
// the way in for anyone whose USDC is on another chain (11 networks, Circle's CCTP), and $SENSE.

interface Props { navigate: (p: Page) => void }

interface Coin { address: string; symbol: string; name: string; image: string | null; priceUsd: number; volume24h: number; pool?: string; launchpad: boolean }

const fromMarket = (list: ArgusPool[]): Coin[] => {
  const best = new Map<string, ArgusPool>()
  for (const p of list) {
    const k = p.token.address.toLowerCase()
    const cur = best.get(k)
    if (!cur || p.liquidityUsd > cur.liquidityUsd) best.set(k, p)
  }
  return [...best.values()].map(p => ({
    address: p.token.address.toLowerCase(), symbol: p.token.symbol, name: p.token.name, image: p.token.image,
    priceUsd: p.priceUsd, volume24h: p.volume24h, pool: p.pool, launchpad: false,
  }))
}
const price = (n: number) => !n ? '—' : n < 0.0001 ? `$${n.toPrecision(3)}` : n < 1 ? `$${n.toPrecision(3)}` : `$${n.toFixed(2)}`

function CoinLogo({ coin, size = 30 }: { coin: Pick<Coin, 'image' | 'symbol'>; size?: number }) {
  const [err, setErr] = useState(false)
  if (!coin.image || err) return <span className="xs-logo blank" style={{ width: size, height: size }}>{coin.symbol.slice(0, 2).toUpperCase()}</span>
  return <img className="xs-logo" src={coin.image} alt="" width={size} height={size} onError={() => setErr(true)} />
}

export default function Swap({ navigate }: Props) {
  const [coins, setCoins] = useState<Coin[]>(() => fromMarket(cachedArgusMarket() ?? []))
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Coin | null>(null)
  const sense = useSense()
  const senseCoin: Coin = { address: SENSE_LC, symbol: 'SENSE', name: 'ARCSENSE', image: SENSE_IMAGE, priceUsd: sense?.priceUsd ?? 0, volume24h: sense?.volume24h ?? 0, pool: SENSE_POOL, launchpad: false }

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getArgusMarket().then(fromMarket).catch(() => [] as Coin[]),
      getAllLaunchpadTokens().then(ts => ts.map((t): Coin => ({
        address: t.address.toLowerCase(), symbol: t.symbol, name: t.name, image: t.metadata?.image ?? null,
        priceUsd: t.priceUsd, volume24h: 0, launchpad: true,
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

  // Most traded first ($SENSE always on top); typing narrows by symbol, name or address.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rest = coins.filter(c => c.address !== SENSE_LC)
    const list = q ? rest.filter(c => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.address === q) : rest
    const top = [...list].sort((a, b) => b.volume24h - a.volume24h).slice(0, q ? 20 : 10)
    const senseFits = !q || 'sense arcsense'.includes(q) || q === SENSE_LC
    return senseFits ? [{ ...senseCoin, priceUsd: sense?.priceUsd ?? coins.find(c => c.address === SENSE_LC)?.priceUsd ?? 0 }, ...top] : top
  }, [coins, query, sense]) // eslint-disable-line react-hooks/exhaustive-deps
  const popular = useMemo(() => [...coins].filter(c => c.address !== SENSE_LC && !copycatOf(c.symbol, c.address)).sort((a, b) => b.volume24h - a.volume24h).slice(0, 5), [coins])

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
                      <button className="xs-chip sense" onClick={() => setPicked(senseCoin)}><CoinLogo coin={senseCoin} size={18} />SENSE</button>
                      {popular.map(c => <button key={c.address} className="xs-chip" onClick={() => setPicked(c)}><CoinLogo coin={c} size={18} />{c.symbol}</button>)}
                    </div>
                  )}
                  <div className="xs-list-h"><span>{query ? T('Results') : T("MOST TRADED")}</span><span>{T('Price')}</span></div>
                  <div className="xs-list">
                    {matches.map(c => {
                      const copy = copycatOf(c.symbol, c.address)
                      return (
                        <button key={c.address} onClick={() => setPicked(c)} className={`xs-coin${c.address === SENSE_LC ? ' sense' : ''}`}>
                          <CoinLogo coin={c} />
                          <span className="xs-coin-name">
                            <b>{c.symbol}{c.address === SENSE_LC && <span className="mk-official">{T('Official')}</span>}{c.launchpad && <span className="swap-tag">{T("Launchpad")}</span>}</b>
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
                </div>
              </>
            )}
          </div>
          <p className="xs-fine">{T("Trades go through ARCSENSE's swap router (launchpad coins on their bonding curve). Every trade is simulated first, and approvals are for the exact amount only.")}</p>
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
          <button className="xs-panel xs-sense" onClick={() => setPicked(senseCoin)}>
            <img src={SENSE_IMAGE} alt="" width={32} height={32} />
            <span><b>$SENSE</b><small>{T('30% of ARCSENSE’s fees buy back $SENSE and burn it.')}</small></span>
            <span className="xs-sense-price">{fmtSmallUsd(sense?.priceUsd)}<small className={(sense?.change24h ?? 0) >= 0 ? 'up-txt' : 'down-txt'}>{fmtPct(sense?.change24h)}</small></span>
          </button>
        </aside>
      </div>
    </div>
  )
}
