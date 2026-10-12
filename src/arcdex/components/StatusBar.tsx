// The bottom status line, as motion.gift's: shortcuts on the left, live prices in the middle (BTC, ETH, SOL, BNB from
// Hyperliquid, and $ARCDEX), and on the right how fast this browser reaches the chain in view, frames per second,
// and the way to the About page.

import { useEffect, useState } from 'react'
import type { Page } from '../App'
import { trenchesPage } from './NavBar'
import { useHlMarkets, useHlMids } from '../hl/live'
import { COIN_LC, COIN_POOL, fmtPct, fmtSmallUsd, useCoin } from '../lib/coin'
import { CHAINS, useChain } from '../lib/chains'
import { OPEN_RPC_SETTINGS, useHead, useReadSpeed } from '../lib/rpcSettings'
import { setTrench, useTrench } from '../lib/trenches'
import { t as T } from '../lib/i18n'
import { IcBell, IcStar, IcSearch, IcGrid } from './TrIcons'

const TICKERS = ['BTC', 'ETH', 'SOL', 'BNB'] as const

/** Frames drawn in the last second (only while the page is visible). */
function useFps(): number | null {
  const [fps, setFps] = useState<number | null>(null)
  useEffect(() => {
    let frames = 0, raf = 0, last = performance.now()
    const loop = (t: number) => {
      frames++
      if (t - last >= 1000) { setFps(Math.round((frames * 1000) / (t - last))); frames = 0; last = t }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return fps
}

export default function StatusBar({ navigate, onAlerts }: { navigate: (p: Page) => void; onAlerts: () => void }) {
  const chain = useChain()
  const { markets } = useHlMarkets()
  const mids = useHlMids()
  const coinQ = useCoin()
  const head = useHead(chain)
  // What reads actually take through the node in use (lib/rpcSettings.ts puts the fastest first), else the block poll's.
  const read = useReadSpeed(chain)
  const ms = read.ms ?? head?.ms ?? null
  const node = read.ms !== null ? read.node : head?.node ?? read.node
  const fps = useFps()
  const s = useTrench()
  const speed = ms !== null ? (ms < 250 ? 'fast' : ms < 600 ? 'ok' : 'slow') : 'wait'
  const speedLabel = { fast: T('Fast'), ok: T('OK'), slow: T('Slow'), wait: '…' }[speed]

  return (
    <footer className="tm-status">
      <button className="tm-st-logo" onClick={() => navigate(trenchesPage(chain))}><img src="/arcdex-mark.png" alt="" width={14} height={14} />arcdex</button>
      <button className="tm-st-link" onClick={() => navigate({ name: 'portfolio' })}><IcGrid />{T('Positions')}</button>
      <button className="tm-st-link" onClick={onAlerts}><IcBell />{T('Alerts')}</button>
      <button className={`tm-st-link${s.watchOnly ? ' on' : ''}`} onClick={() => { setTrench({ watchOnly: !s.watchOnly }); navigate(trenchesPage(chain)) }}><IcStar on={s.watchOnly} />{T('Watchlist')}</button>
      <a className="tm-st-link" href={CHAINS[chain].explorer} target="_blank" rel="noopener noreferrer"><IcSearch />{T('Explorer')}</a>

      <div className="tm-st-tickers">
        {TICKERS.map(c => {
          const m = markets?.find(x => x.coin === c)
          const px = mids[c] ?? m?.markPx ?? null
          const chg = m && px && m.prevDayPx > 0 ? (px / m.prevDayPx - 1) * 100 : null
          return (
            <button key={c} className="tm-st-tick" onClick={() => navigate({ name: 'perps', coin: c })} title={T('{c} perpetual', { c })}>
              <b>{c}</b><span>{px ? `$${px.toLocaleString(undefined, { maximumFractionDigits: px >= 100 ? 0 : 2 })}` : '—'}</span>
              {chg !== null && <span className={chg >= 0 ? 'up' : 'down'}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>}
            </button>
          )
        })}
        <button className="tm-st-tick" onClick={() => navigate({ name: 'argus', address: COIN_LC, pool: COIN_POOL })} title="$ARCDEX">
          <b>ARCDEX</b><span>{fmtSmallUsd(coinQ?.priceUsd)}</span>
          {coinQ?.change24h != null && <span className={coinQ.change24h >= 0 ? 'up' : 'down'}>{fmtPct(coinQ.change24h)}</span>}
        </button>
      </div>

      <button className={`tm-st-speed ${speed}`} onClick={() => window.dispatchEvent(new Event(OPEN_RPC_SETTINGS))} title={ms !== null ? T('{chain} via {node}: answered in {ms} ms. Click for RPC settings.', { chain: CHAINS[chain].name, node, ms: Math.round(ms) }) : T('RPC settings')}>
        <i />{speedLabel}{ms !== null ? ` ${Math.round(ms)} ms` : ''}
      </button>
      {fps !== null && <span className="tm-st-fps">{fps} FPS</span>}
      <button className="tm-st-link" onClick={() => navigate({ name: 'routes' })}>{T('Routes')}</button>
      <a className="tm-st-link" href="/about">{T('About')}</a>
    </footer>
  )
}
