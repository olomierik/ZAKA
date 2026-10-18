// $ARCDEX on top of the terminal (2026-10-12, owner: "put the ARCD CA on top of the terminal showing the burned
// amount"): its contract address with Copy, its live price and market cap (the market engine), and how much has been
// burned, read from Arc's dead wallet every 15 seconds (lib/coin.ts). Buy opens its coin page.

import { useState } from 'react'
import type { Page } from '../App'
import { COIN, COIN_IMAGE, COIN_LC, COIN_POOL, COIN_SUPPLY, fmtCompactUsd, fmtPct, fmtSmallUsd, useCoin, useCoinBurned } from '../lib/coin'
import { IcCopy, IcFire } from './TrIcons'
import { t as T } from '../lib/i18n'

const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0))

export default function TrenchCoinBar({ navigate }: { navigate: (p: Page) => void }) {
  const q = useCoin()
  const burned = useCoinBurned()
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard?.writeText(COIN).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) }).catch(() => {})
  const open = () => navigate({ name: 'argus', address: COIN_LC, pool: COIN_POOL })
  return (
    <div className="tr-coinbar">
      <button className="tr-cb-coin" onClick={open} title={T('Open $ARCDEX')}><img src={COIN_IMAGE} alt="" width={20} height={20} /><b>$ARCDEX</b></button>
      <button className="tr-cb-ca" onClick={copy} title={T('Copy the contract address')}>
        <i>CA</i><code>{COIN}</code><code className="sh">{COIN.slice(0, 6)}…{COIN.slice(-4)}</code><span>{copied ? T('Copied') : <IcCopy />}</span>
      </button>
      <span className="tr-cb-kv"><span className="tr-cb-lbl">{T('Price')}</span> <b>{fmtSmallUsd(q?.priceUsd)}</b>{q?.change24h != null && <em className={q.change24h >= 0 ? 'up' : 'down'}>{fmtPct(q.change24h)}</em>}</span>
      <span className="tr-cb-kv hide-sm">MC <b>{fmtCompactUsd(q?.marketCapUsd)}</b></span>
      <span className="tr-cb-kv tr-cb-burn" title={T('$ARCDEX held by the dead address 0x…dEaD, read from Arc: gone for good.')}>
        <IcFire /> {T('Burned')} <b>{burned ? tokens(burned.total) : '…'}</b>{burned && <em>{T('{p}% of supply', { p: burned.pct.toFixed(2) })}</em>}
        {burned && <span className="tr-cb-meter" aria-hidden><i style={{ width: `${Math.min(100, (burned.total / COIN_SUPPLY) * 100)}%` }} /></span>}
      </span>
      <button className="tr-cb-buy" onClick={open}><span className="lg">{T('Buy $ARCDEX')}</span><span className="sm">{T('Buy')}</span></button>
    </div>
  )
}
