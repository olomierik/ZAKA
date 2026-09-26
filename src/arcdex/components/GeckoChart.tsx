// GeckoTerminal's own live chart, embedded the way argus.world shows it (the
// chart that reads "Powered by GeckoTerminal"). GeckoTerminal draws and
// updates it itself, so it's live with nothing to poll from here. The coin
// page can switch to ARCDEX's chart (PriceChart: trade labels, theses,
// indicators, whose history also comes from GeckoTerminal's API).

import { useState } from 'react'
import { useIsMobile } from '../lib/useMobile'
import { t as T } from '../lib/i18n'

const NETWORK = 'arc'
const BG = '0b1628'

/** A pool GeckoTerminal can chart: a v2/v3 pool address or a v4 pool id. */
export const canEmbedGecko = (pool: string | null | undefined): pool is string =>
  !!pool && /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(pool)

export function geckoEmbedUrl(pool: string, chartType: 'price' | 'market_cap' = 'market_cap'): string {
  const q = new URLSearchParams({
    embed: '1', info: '0', swaps: '0', grayscale: '0', light_chart: '0',
    chart_type: chartType, resolution: '15m', bg_color: BG,
  })
  return `https://www.geckoterminal.com/${NETWORK}/pools/${pool.toLowerCase()}?${q}`
}

export default function GeckoChart({ pool, symbol }: { pool: string; symbol: string }) {
  const mobile = useIsMobile()
  const [loaded, setLoaded] = useState(false)
  return (
    <div style={{ position: 'relative', height: mobile ? 380 : 440, borderRadius: 8, overflow: 'hidden', background: `#${BG}` }}>
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          {T('Loading the live GeckoTerminal chart…')}
        </div>
      )}
      <iframe
        key={pool}
        title={T('{symbol} live chart by GeckoTerminal', { symbol })}
        src={geckoEmbedUrl(pool)}
        onLoad={() => setLoaded(true)}
        allow="clipboard-write; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        style={{ position: 'relative', width: '100%', height: '100%', border: 0, display: 'block' }}
      />
    </div>
  )
}

const SOURCE_KEY = 'arcdex:chart-source'
export type ChartSource = 'gecko' | 'arcdex'

/** GeckoTerminal's live chart by default; the choice is remembered per browser. */
export function useChartSource(): [ChartSource, (s: ChartSource) => void] {
  const [src, setSrc] = useState<ChartSource>(() => {
    try { return localStorage.getItem(SOURCE_KEY) === 'arcdex' ? 'arcdex' : 'gecko' } catch { return 'gecko' }
  })
  const set = (s: ChartSource) => { setSrc(s); try { localStorage.setItem(SOURCE_KEY, s) } catch { /* storage blocked */ } }
  return [src, set]
}

export function ChartSourceTabs({ value, onChange }: { value: ChartSource; onChange: (s: ChartSource) => void }) {
  const tab = (s: ChartSource, label: string) => (
    <button key={s} onClick={() => onChange(s)} style={{
      padding: '5px 10px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer',
      border: `1px solid ${value === s ? 'var(--adx-accent)' : 'var(--adx-card-border)'}`,
      background: value === s ? 'rgba(59,130,246,0.15)' : 'transparent', color: value === s ? 'var(--adx-accent)' : 'var(--text-muted)',
    }}>{label}</button>
  )
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
      {tab('gecko', T('Live · GeckoTerminal'))}
      {tab('arcdex', T('ARCDEX chart'))}
    </div>
  )
}
