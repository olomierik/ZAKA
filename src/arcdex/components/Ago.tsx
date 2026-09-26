import { agoShort, useNow } from '../lib/ago'
import { t as T } from '../lib/i18n'

/** A trade's age that counts up live (12s → 5m → 3h → 2d → 4mo → 1y). */
export default function Ago({ ts }: { ts: number }) {
  const now = useNow()
  return <>{agoShort(ts, now)}</>
}

/** The same, as "12s ago" in the reader's language (word order varies). */
export function AgoText({ ts }: { ts: number }) {
  const now = useNow()
  return <>{T('{time} ago', { time: agoShort(ts, now) })}</>
}
