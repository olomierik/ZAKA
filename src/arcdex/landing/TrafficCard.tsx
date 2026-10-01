import { useEffect, useRef, useState } from 'react'
import { t } from '../lib/i18n'
import { onTraffic, startTraffic, type TrafficCounts } from '../lib/traffic'

// The landing page's traffic counter (owner's request, 2026-10-01: "a small card that shows the live count of online
// users, people who have visited and those who are online, like a traffic counter"). Online now, visitors today and
// in all, from the engine (../lib/traffic.ts); each number counts to its new value. Hidden until the first counts arrive.

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A whole number that counts to its new value instead of jumping. */
function Count({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const cur = useRef(value)
  useEffect(() => {
    const from = cur.current, to = value
    if (from === to) return
    if (reduced()) { cur.current = to; setShown(to); return }
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 700)
      cur.current = from + (to - from) * (1 - Math.pow(1 - k, 3))
      setShown(cur.current)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{Math.round(shown).toLocaleString('en-US')}</>
}

export default function TrafficCard({ engine }: { engine: string }) {
  const [c, setC] = useState<TrafficCounts | null>(null)
  useEffect(() => {
    startTraffic(engine)
    return onTraffic(setC)
  }, [engine])
  if (!c) return null
  return (
    <div className="ld-traffic" role="group" aria-label={t('Site traffic')}>
      <span className="ld-traffic-item"><span className="ld-traffic-dot" aria-hidden /><b><Count value={c.online} /></b> {t('online now')}</span>
      <span className="ld-traffic-sep" aria-hidden />
      <span className="ld-traffic-item"><b><Count value={c.today} /></b> {t('visitors today')}</span>
      <span className="ld-traffic-sep" aria-hidden />
      <span className="ld-traffic-item"><b><Count value={c.total} /></b> {t('visitors in all')}</span>
    </div>
  )
}
