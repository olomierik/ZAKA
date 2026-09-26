import { useEffect, useMemo, useState } from 'react'
import { cachedArgusMarket, copycatOf, getArgusMarket, type ArgusPool } from '../api/argusMarket'
import { getAllLaunchpadTokens } from '../api/launchpad'
import TokenSwap from '../components/TokenSwap'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

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
const price = (n: number) => !n ? '—' : n < 0.0001 ? `$${n.toExponential(2)}` : n < 1 ? `$${n.toPrecision(3)}` : `$${n.toFixed(2)}`

export default function Swap({ navigate }: Props) {
  const [coins, setCoins] = useState<Coin[]>(() => fromMarket(cachedArgusMarket() ?? []))
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Coin | null>(null)

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

  // Most traded first; typing narrows by symbol, name or address.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? coins.filter(c => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.address === q) : coins
    return [...list].sort((a, b) => b.volume24h - a.volume24h).slice(0, q ? 20 : 12)
  }, [coins, query])

  return (
    <div className="form-page">
      <h1 className="page-title">{T("Swap")}</h1>
      <p className="page-sub">{T("Trade any Arc token against USDC through ARCDEX's swap router — launchpad coins trade on their bonding curve. Approvals are for the exact amount only.")}</p>

      {!picked ? (
        <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 10 }}>
          <input
            placeholder={T("Search by symbol, name, or address…")}
            value={query}
            onChange={e => setQuery(e.target.value)}
            inputMode="search"
            className="swap-input" style={{ marginBottom: 6, fontFamily: 'inherit' }}
          />
          {!query && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.04em', padding: '4px 6px' }}>{T("MOST TRADED")}</div>}
          {matches.map(c => {
            const copy = copycatOf(c.symbol, c.address)
            return (
              <button key={c.address} onClick={() => setPicked(c)} className="swap-coin-row">
                {c.image
                  ? <img src={c.image} alt="" width={30} height={30} style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: 'var(--bg-3)' }} onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                  : <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 700, flexShrink: 0 }}>{c.symbol.slice(0, 2).toUpperCase()}</span>}
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.symbol}{c.launchpad && <span className="swap-tag">{T("Launchpad")}</span>}
                  </span>
                  <span style={{ display: 'block', fontSize: '0.7rem', color: copy ? '#fca5a5' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {copy ? T("⚠ Not real {symbol}", { symbol: copy }) : c.name}
                  </span>
                </span>
                <span style={{ fontSize: '0.8rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)', flexShrink: 0 }}>{price(c.priceUsd)}</span>
              </button>
            )
          })}
          {query && matches.length === 0 && (
            <div style={{ padding: '16px 8px', color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center' }}>{T("No tokens match \"")}{query}"</div>
          )}
          {!query && coins.length === 0 && <div className="loading-state" style={{ padding: 20 }}>{T("Loading…")}</div>}
        </div>
      ) : (
        <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 14px 0' }}>
            <button onClick={() => { setPicked(null); setQuery('') }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem', padding: '6px 0' }}>{T("← Choose a different token")}</button>
            <button onClick={() => navigate(picked.launchpad ? { name: 'token', address: picked.address, symbol: picked.symbol } : { name: 'argus', address: picked.address, pool: picked.pool ?? '' })}
              style={{ background: 'none', border: 'none', color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.78rem', padding: '6px 0' }}>{T("View chart →")}</button>
          </div>
          <TokenSwap address={picked.address} pool={picked.pool} fallback={{ symbol: picked.symbol, image: picked.image, priceUsd: picked.priceUsd }} />
        </div>
      )}
    </div>
  )
}
