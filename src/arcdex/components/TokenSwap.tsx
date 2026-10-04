// The right swap for any Arc token:
//   • an ARCDEX launchpad coin trades on its bonding curve (CurveSwapWidget)
//   • anything with a USDC (or ARGUS) Uniswap pool — from Argus or any other
//     Arc launchpad — trades through ARCDEX's swap router (ArgusSwapWidget:
//     exact approvals, simulated before sending)
//   • a coin on Mercuri's or SolonPad's own curve trades on that curve
//     (api/curves.ts) until it graduates
//   • a coin only on another launchpad's own curve links to that launchpad
// Replaces the old SwapWidget, which targeted a router that was never
// deployed on mainnet and asked for unlimited approvals.

import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import ArgusSwapWidget from './ArgusSwapWidget'
import CurveSwapWidget from './CurveSwapWidget'
import { bestSwapRoute, buildSwapRoute, cachedArgusMarket, getArgusMarket, getArgusOnchain, getArgusTokenPools, type ArgusPool, type SwapRoute } from '../api/argusMarket'
import { launchpadNamed } from '../../../api/_launchpads'
import { getLaunchpadToken, type LaunchpadToken } from '../api/launchpad'
import { getCurve, type CurveInfo } from '../api/curves'
import { t as T } from '../lib/i18n'

interface Props {
  address: string
  /** The pool to trade through, when the caller knows it (else the coin's deepest). */
  pool?: string
  /** Shown while (or if) the market list doesn't have the coin. */
  fallback?: { symbol: string; image?: string | null; priceUsd?: number }
  onTraded?: () => void
  initialMode?: 'buy' | 'sell'
}

export default function TokenSwap({ address, pool, fallback, onTraded, initialMode }: Props) {
  const token = address.toLowerCase()
  const [curve, setCurve] = useState<LaunchpadToken | null | undefined>(undefined)
  const [row, setRow] = useState<ArgusPool | null | undefined>(undefined)
  const [route, setRoute] = useState<SwapRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(true)
  const [tax, setTax] = useState<{ buy: number | null; sell: number | null }>({ buy: null, sell: null })

  // Launchpad coin?
  useEffect(() => {
    let cancelled = false
    setCurve(undefined)
    getLaunchpadToken(address as Address).then(t => { if (!cancelled) setCurve(t) }).catch(() => { if (!cancelled) setCurve(null) })
    return () => { cancelled = true }
  }, [address])

  // On Mercuri's or SolonPad's own curve? Traded there until it graduates.
  const [other, setOther] = useState<CurveInfo | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setOther(undefined)
    getCurve(address).then(c => { if (!cancelled) setOther(c) }).catch(() => { if (!cancelled) setOther(null) })
    return () => { cancelled = true }
  }, [address])
  const onCurve = other && !other.graduated ? other : null
  const curveRoute = useMemo<SwapRoute | null>(() => onCurve ? { kind: 'curve', curve: onCurve } : null, [onCurve])

  // Otherwise: its market row (price, symbol, deepest pool), route and taxes.
  useEffect(() => {
    if (curve !== null) return
    let cancelled = false
    const pick = (list: ArgusPool[] | null) => list?.filter(p => p.token.address.toLowerCase() === token)
      .sort((a, b) => (pool ? Number(b.pool.toLowerCase() === pool.toLowerCase()) - Number(a.pool.toLowerCase() === pool.toLowerCase()) : 0) || b.liquidityUsd - a.liquidityUsd)[0] ?? null
    const cached = pick(cachedArgusMarket())
    if (cached) setRow(cached)
    getArgusMarket().then(list => { if (!cancelled) setRow(pick(list) ?? cached) }).catch(() => { if (!cancelled) setRow(cached) })
    getArgusOnchain(address as Address).then(c => { if (!cancelled) setTax({ buy: c.buyTaxBps, sell: c.sellTaxBps }) }).catch(() => {})
    return () => { cancelled = true }
  }, [curve, token, pool, address])

  const poolId = pool || row?.pool
  useEffect(() => {
    if (curve !== null) return
    if (!poolId) { if (row === null) setRouteLoading(false); return }
    let cancelled = false
    setRouteLoading(true)
    // This pool first; if ARCDEX can't route it (a launchpad's own curve),
    // the coin's other pools, deepest first (a graduated coin's Uniswap pool).
    buildSwapRoute(token, poolId, row?.createdAt)
      .catch(() => null)
      .then(async r => r ?? bestSwapRoute(token, (await getArgusTokenPools(token).catch(() => [] as ArgusPool[])).filter(p => p.pool !== poolId.toLowerCase())))
      .then(r => { if (!cancelled) setRoute(r) })
      .catch(() => { if (!cancelled) setRoute(null) })
      .finally(() => { if (!cancelled) setRouteLoading(false) })
    return () => { cancelled = true }
  }, [curve, token, poolId, row])

  if (curve === undefined || other === undefined) return <div className="loading-state" style={{ padding: 24 }}>{T("Loading…")}</div>
  if (curve) return <CurveSwapWidget token={curve} onTraded={onTraded} initialMode={initialMode} />
  if (onCurve && curveRoute) {
    return (
      <ArgusSwapWidget token={address as Address} symbol={row?.token.symbol ?? onCurve.symbol ?? fallback?.symbol ?? '…'} tokenImage={row?.token.image ?? fallback?.image ?? null}
        priceUsd={onCurve.priceUsd} marketCapUsd={onCurve.supply ? onCurve.supply * onCurve.priceUsd : null}
        route={curveRoute} routeLoading={false} onTraded={onTraded} initialMode={initialMode} venue={{ name: onCurve.venue, site: launchpadNamed(onCurve.venue)?.site }} />
    )
  }

  const symbol = row?.token.symbol ?? fallback?.symbol ?? '…'
  const lpName = row?.launchpad
  const venue = lpName && lpName !== 'Argus' && !/uniswap/i.test(lpName) ? { name: lpName, site: launchpadNamed(lpName)?.site } : null
  if (row === null && !poolId) {
    return (
      <div style={{ padding: 20, fontSize: '0.84rem', color: 'var(--text-muted)', lineHeight: 1.5, textAlign: 'center' }}>
        {T("{symbol} has no USDC or ARGUS pool that ARCDEX can route yet, so it can't be swapped here.", { symbol })}
      </div>
    )
  }
  return (
    <ArgusSwapWidget token={address as Address} symbol={symbol} tokenImage={row?.token.image ?? fallback?.image ?? null}
      priceUsd={row?.priceUsd ?? fallback?.priceUsd ?? 0} marketCapUsd={row?.marketCapUsd ?? null}
      route={route} routeLoading={routeLoading} buyTaxBps={tax.buy} sellTaxBps={tax.sell} onTraded={onTraded} initialMode={initialMode} venue={venue} />
  )
}
