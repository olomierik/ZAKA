// The trade switch, read from the engine (engine/src/site/tradeSwitch.ts; docs/REPO_MAP.md finding 4): trading turned
// off everywhere or on one venue by an admin. Every trade path calls assertTradingOn before anything is signed, and the
// banner (components/TradePausedBar.tsx) shows what's off.
//
// The status is read again when it's over 30 seconds old (a trade waits up to 4 seconds for it), so a switch reaches a
// trade within a minute. When the engine can't be reached, the last state read decides: a venue known to be off stays
// off. With nothing read yet (or a stored state over a day old), the trade goes ahead: trading doesn't stop because the
// engine is down. Withdrawals, transfers and the bridge aren't trades and never ask.

import { useEffect, useState } from 'react'
import { TRADE_VENUE_LABEL, tradeSwitchMessage, type TradeSwitchControl, type TradeSwitchState, type TradeVenue } from '../../../api/_marketProtocol'
import { engineApiUrl } from '../api/marketStream'
import { t as T } from './i18n'

const STORE_KEY = 'arcdex:trade-switch'
export const SWITCH_FRESH_MS = 30_000
const STORED_MAX_MS = 24 * 3_600_000

let state: TradeSwitchState | null = loadStored()
let readAt = 0
let inflight: Promise<TradeSwitchState | null> | null = null
const subs = new Set<() => void>()

function loadStored(): TradeSwitchState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const s = raw ? JSON.parse(raw) as TradeSwitchState : null
    return s && typeof s.at === 'number' && Date.now() - s.at < STORED_MAX_MS ? s : null
  } catch { return null }
}

/** The status from the engine (null without an engine); the last state read when it can't be reached. */
export function readTradeSwitch(): Promise<TradeSwitchState | null> {
  if (!engineApiUrl) return Promise.resolve(null)
  inflight ??= fetch(`${engineApiUrl}/v1/trading/status`, { cache: 'no-store', signal: AbortSignal.timeout(4_000) })
    .then(r => (r.ok ? r.json() as Promise<TradeSwitchState> : Promise.reject(new Error(`status ${r.status}`))))
    .then(s => {
      state = s
      readAt = Date.now()
      try { localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch { /* private mode: memory only */ }
      for (const f of subs) f()
      return s
    }, () => state)
    .finally(() => { inflight = null })
  return inflight
}

/** Why trading on `venue` is off in `s`, or null. */
export function offReason(venue: TradeVenue, s: TradeSwitchState | null = state): string | null {
  return s?.all?.reason ?? s?.venues?.[venue]?.reason ?? null
}

export class TradingPausedError extends Error {}

/** Throws when trading on `venue` is off (the message says where and why). Call it before anything is signed. */
export async function assertTradingOn(venue: TradeVenue): Promise<void> {
  if (Date.now() - readAt > SWITCH_FRESH_MS) await readTradeSwitch()
  const why = offReason(venue)
  if (why) throw new TradingPausedError(T('Trading on {venue} is paused: {reason}', { venue: TRADE_VENUE_LABEL[venue], reason: why }))
}

/** The switch's state for a banner, read every 30 seconds while the page is visible. */
export function useTradeSwitch(): TradeSwitchState | null {
  const [s, setS] = useState(state)
  useEffect(() => {
    const update = () => setS(state)
    subs.add(update)
    const tick = () => { if (document.visibilityState === 'visible') void readTradeSwitch() }
    tick()
    const id = setInterval(tick, SWITCH_FRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { subs.delete(update); clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [])
  return s
}

/** For tests: set the state as if read from the engine. */
export function setTradeSwitchForTest(s: TradeSwitchState | null) { state = s; readAt = s ? Date.now() : 0 }

/** An admin's change, signed by `sign` (the engine checks the wallet against ADMIN_EVM_ADDRESSES); the new state. */
export async function sendTradeSwitch(control: TradeSwitchControl, sign: (message: string) => Promise<`0x${string}`>): Promise<TradeSwitchState> {
  const at = Date.now()
  const signature = await sign(tradeSwitchMessage(control, at))
  const res = await fetch(`${engineApiUrl}/v1/trading/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...control, at, signature }), signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({})) as { state?: TradeSwitchState; error?: string; note?: string }
  if (!res.ok || !body.state) throw new Error(body.error ?? `the engine answered ${res.status}`)
  state = body.state
  readAt = Date.now()
  for (const f of subs) f()
  return body.state
}
