// A futures position's P&L card (2026-10-12): the Share button in each position row draws it from the numbers on
// screen (market, side, leverage, ROE, entry and mark, the P&L unless hidden) and opens the share sheet. Paper
// positions say so on the card.

import { useCallback, useState } from 'react'
import { futuresShareText, renderFuturesCard, type FuturesCardData } from '../lib/shareCard'
import { t as T } from '../lib/i18n'
import ShareCardModal from './ShareCardModal'

const linkOf = (coin: string) => `https://arcsense.site/futures/${encodeURIComponent(coin)}`

export interface FuturesShareInput { coin: string; market: string; long: boolean; leverage: number; roePct: number; pnlUsd: number; entryPx: string; markPx: string; paper: boolean }

function FuturesShareModal({ data, onClose }: { data: FuturesCardData; onClose: () => void }) {
  const render = useCallback(() => renderFuturesCard(data), [data])
  return (
    <ShareCardModal title={T('Share your {market} position', { market: data.market })} render={render}
      fileName={`arcdex-${data.market.replace(/[^A-Za-z0-9-]/g, '')}-${data.side}.png`} link={data.link} text={futuresShareText(data)} onClose={onClose} />
  )
}

/** "Share": a snapshot of the position as it stands when pressed. */
export function ShareFuturesButton({ p }: { p: FuturesShareInput }) {
  const [data, setData] = useState<FuturesCardData | null>(null)
  return (
    <>
      <button className="link-btn fx-share" title={T('Share a P&L card of this position')} onClick={() => setData({
        market: p.market, side: p.long ? 'long' : 'short', leverage: p.leverage, roePct: p.roePct, pnlUsd: p.pnlUsd,
        entryPx: p.entryPx, markPx: p.markPx, paper: p.paper, link: linkOf(p.coin), at: Date.now(),
      })}>{T('Share')}</button>
      {data && <FuturesShareModal data={data} onClose={() => setData(null)} />}
    </>
  )
}
