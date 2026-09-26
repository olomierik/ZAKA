// A coin's trend: its price line with a soft fill under it and a pulsing dot
// on the latest price. Green when it's up over the window, red when down.
// It draws itself in from the left when it first shows (arcdex.css, .spark).

import { useId } from 'react'
import { SPARK_H, SPARK_W, sparkGeometry } from '../lib/spark'

export default function Sparkline({ points, label }: { points: readonly number[] | undefined; label: string }) {
  const id = useId()
  const g = sparkGeometry(points)
  if (!g) return null
  return (
    <span className={`spark ${g.dir}`} role="img" aria-label={label} title={label}>
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity=".38" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={g.area} fill={`url(#${id})`} />
        <path className="spark-line" d={g.line} vectorEffect="non-scaling-stroke" />
      </svg>
      <i className="spark-dot" style={{ top: `${(g.lastY / SPARK_H) * 100}%` }} />
    </span>
  )
}
