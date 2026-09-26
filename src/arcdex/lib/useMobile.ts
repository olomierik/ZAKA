// Phone layout switch: one breakpoint for every "native app" layout choice
// (bottom tab bar, sticky Buy/Sell, bottom sheets), kept in step with the
// `@media (max-width: 767px)` rules in arcdex.css.

import { useEffect, useState } from 'react'

export const MOBILE_QUERY = '(max-width: 767px)'

export const isMobileNow = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(isMobileNow)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const on = () => setMobile(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}
