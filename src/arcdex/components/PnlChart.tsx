import { useMemo, useState } from 'react'
import type { PnlPoint } from '../api/social'

// Profile PnL chart (fomo's portfolio chart): cumulative realized PnL from
// trades through ARCDEX, for the chosen window, as a line with hover value.

const money = (n: number) => `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)}`

export default function PnlChart({ points, sinceMs }: { points: PnlPoint[]; sinceMs: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 600, H = 150, PAD = 6

  const series = useMemo(() => {
    const before = points.filter(p => Date.parse(p.t) < sinceMs)
    const base = before.length ? before[before.length - 1].cumulative : 0
    const inside = points.filter(p => Date.parse(p.t) >= sinceMs).map(p => ({ t: Date.parse(p.t), v: p.cumulative - base }))
    const start = Math.max(sinceMs, inside[0]?.t ?? Date.now()) // "all" starts at the first trade
    return [{ t: Math.min(start, inside[0]?.t ?? start), v: 0 }, ...inside, { t: Date.now(), v: inside.length ? inside[inside.length - 1].v : 0 }]
  }, [points, sinceMs])

  const t0 = series[0].t, t1 = Math.max(series[series.length - 1].t, t0 + 1)
  const vs = series.map(s => s.v)
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs)
  const span = hi - lo || 1
  const x = (t: number) => PAD + ((t - t0) / (t1 - t0)) * (W - PAD * 2)
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2)
  const path = series.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join(' ')
  const last = series[series.length - 1].v
  const color = last >= 0 ? 'var(--green)' : 'var(--red)'
  const shown = hover !== null ? series[hover] : series[series.length - 1]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'var(--mono)', color: shown.v >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(shown.v)}</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{hover !== null ? new Date(shown.t).toLocaleString() : 'realized PnL'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block', cursor: 'crosshair' }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0)
          let best = 0
          series.forEach((s, i) => { if (Math.abs(s.t - t) < Math.abs(series[best].t - t)) best = i })
          setHover(best)
        }}>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--adx-card-border)" strokeDasharray="4 4" />
        <path d={`${path} L${x(series[series.length - 1].t)},${y(lo)} L${x(series[0].t)},${y(lo)} Z`} fill={color} opacity={0.08} />
        <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hover !== null && <circle cx={x(series[hover].t)} cy={y(series[hover].v)} r={4} fill={color} />}
      </svg>
      {points.length === 0 && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: -H / 2 - 8, position: 'relative' }}>No closed trades yet</div>}
    </div>
  )
}
