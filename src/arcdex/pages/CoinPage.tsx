import { lazy, useEffect, useState } from 'react'
import { isLaunchpadCoin, isLaunchpadCoinNow } from '../lib/launchpadCoins'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const ArgusTokenPage = lazy(() => import('./ArgusTokenPage'))
const CurveTokenPage = lazy(() => import('./CurveTokenPage'))

/** A coin's page from a /token/0x… link: the launchpad coin page (buy and
 * sell on its bonding curve) for ArcLaunchpad coins, the Argus/Uniswap coin
 * page for everything else. */
export default function CoinPage({ address, pool, navigate }: { address: string; pool: string; navigate: (p: Page) => void }) {
  const [curve, setCurve] = useState<boolean | null>(() => isLaunchpadCoinNow(address))
  useEffect(() => {
    if (curve !== null) return
    let alive = true
    isLaunchpadCoin(address).then(c => { if (alive) setCurve(c) }).catch(() => { if (alive) setCurve(false) })
    return () => { alive = false }
  }, [address, curve])
  if (curve === null) return <div className="loading-state">{T('Loading…')}</div>
  return curve
    ? <CurveTokenPage address={address} navigate={navigate} />
    : <ArgusTokenPage address={address} pool={pool} navigate={navigate} />
}
