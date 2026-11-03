// Runs live BTC Up/Down trading (lib/updownLive.ts) while ARCDEX is open: the engine's buy and sell signals from the
// `updown` channel, traded one at a time from the unlocked trading wallet on Polymarket (lib/polyLive.ts). One tab
// trades at a time (a lease renewed every 2s). Every 20s it settles ended windows from the engine's result and collects
// winning shares; every 15s it re-reads the balance and applies the drawdown stop and the losing-streak pause.

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { UpdownSignal } from '../../../api/_updownProtocol'
import { engineApiUrl, marketStream } from '../api/marketStream'
import { useTrader } from '../lib/identity'
import { t as T } from '../lib/i18n'
import { assertTradingOn } from '../lib/tradeSwitch'
import { getLiveBook, getLiveSettings, liveBuy, liveCheck, logLive, saveLiveBook, setLiveSettings, useLiveSettings, type LivePosition } from '../lib/updownLive'

const LEASE = 'arcdex:updown-live:lease'
const held = (p: LivePosition) => Math.max(0, p.shares - p.sold)

function holdLease(me: string, now = Date.now()): boolean {
  try {
    const l = JSON.parse(localStorage.getItem(LEASE) ?? 'null') as { id?: string; until?: number } | null
    if (l && l.id !== me && (l.until ?? 0) > now) return false
    localStorage.setItem(LEASE, JSON.stringify({ id: me, until: now + 6_000 }))
  } catch { /* storage blocked: this tab alone */ }
  return true
}

export default function UpdownLiveRunner() {
  const s = useLiveSettings()
  const trader = useTrader()
  const me = trader.kind === 'trading-wallet' ? trader.address : null
  const tab = useRef(Math.random().toString(36).slice(2))

  useEffect(() => {
    if (!s.on || !me) return
    let alive = true
    let cash = 0
    let chain: Promise<unknown> = Promise.resolve()
    const run = (job: () => Promise<unknown>) => { chain = chain.then(job, job).catch(() => {}) }
    const live = () => alive && getLiveSettings().on && holdLease(tab.current)
    const lib = import('../lib/polyLive')

    const openCost = () => getLiveBook(me).positions.filter(p => p.status === 'open').reduce((a, p) => a + p.cost - p.proceeds, 0)
    const check = () => {
      const patch = liveCheck(getLiveSettings(), getLiveBook(me), cash + openCost(), Date.now())
      if (!patch) return
      setLiveSettings(patch)
      if (patch.halted) { logLive(me, { kind: 'stop', k: 'Stopped: {r}', v: { r: patch.halted } }); toast.error(T('Live autotrade stopped: {r}', { r: patch.halted })) }
      else if (patch.pauseUntil) logLive(me, { kind: 'stop', k: 'Paused for an hour after four losses in a row' })
    }
    const refresh = async () => {
      try { cash = (await (await lib).polyAccount()).pusd; check() } catch { /* the next refresh tries again */ }
    }

    const onBuy = async (sig: UpdownSignal) => {
      const d = liveBuy(getLiveSettings(), getLiveBook(me), sig, cash, cash + openCost(), Date.now())
      if ('why' in d) { logLive(me, { kind: 'skip', k: d.why, v: d.v }); return }
      // ARCDEX's trade switch (/admin): sales and collecting winnings go on, new buys stop.
      try { await assertTradingOn('polymarket') } catch (e) { logLive(me, { kind: 'skip', k: 'Not bought: {r}', v: { r: (e as Error).message } }); return }
      try {
        const r = await (await lib).polyBuy(sig.asset, d.usd, sig.price)
        if (!r.ok) { logLive(me, { kind: 'skip', k: 'Not filled: {r}', v: { r: r.why } }); return }
        const b = getLiveBook(me)
        const pos: LivePosition = { id: sig.id, slug: sig.slug, side: sig.side, asset: sig.asset, conditionId: sig.conditionId, end: sig.end, at: Date.now(), shares: r.shares, cost: r.usd, sold: 0, proceeds: 0, status: 'open', pnl: null }
        saveLiveBook(me, { ...b, positions: [...b.positions, pos] })
        cash -= r.usd
        logLive(me, { kind: 'buy', k: 'Bought {n} {side} at {p}¢ for ${u}', v: { n: r.shares.toFixed(2), side: sig.side === 'up' ? 'Up' : 'Down', p: String(Math.round((r.usd / r.shares) * 100)), u: r.usd.toFixed(2) } })
        toast.success(T('Live: bought {side} for ${u}', { side: T(sig.side === 'up' ? 'Up' : 'Down'), u: r.usd.toFixed(2) }))
      } catch (e) { logLive(me, { kind: 'error', k: 'Buy failed: {r}', v: { r: (e as Error).message.slice(0, 160) } }) }
    }

    const onSell = async (sig: UpdownSignal) => {
      const mine = getLiveBook(me).positions.filter(p => p.asset === sig.asset && p.status === 'open' && held(p) > 0.01)
      for (const p of mine) {
        try {
          const r = await (await lib).polySell(p.asset, held(p), sig.price)
          if (!r.ok) { logLive(me, { kind: 'skip', k: 'Sale not filled: {r}', v: { r: r.why } }); continue }
          const b = getLiveBook(me)
          const positions = b.positions.map(x => {
            if (x.id !== p.id) return x
            const y = { ...x, sold: x.sold + r.shares, proceeds: x.proceeds + r.usd }
            return held(y) < 0.01 ? { ...y, status: 'closed' as const, pnl: y.proceeds - y.cost } : y
          })
          saveLiveBook(me, { ...b, positions })
          cash += r.usd
          logLive(me, { kind: 'sell', k: sig.why === 'stop' ? 'Cut {side} early at {p}¢: ${u} back' : 'Took profit on {side} at {p}¢: ${u} back', v: { side: p.side === 'up' ? 'Up' : 'Down', p: String(Math.round((r.usd / r.shares) * 100)), u: r.usd.toFixed(2) } })
          check()
        } catch (e) { logLive(me, { kind: 'error', k: 'Sale failed: {r}', v: { r: (e as Error).message.slice(0, 160) } }) }
      }
    }

    /** Ended windows: the result from the engine, P&L, and winning shares collected (retried until it goes through). */
    const settle = async () => {
      const b = getLiveBook(me)
      const due = b.positions.filter(p => (p.status === 'open' || (p.won && !p.redeemed && held(p) > 0.01)) && Date.now() / 1000 > p.end + 30)
      for (const p of due) {
        if (p.won === undefined) {
          const r = await fetch(`${engineApiUrl}/v1/updown/result?slug=${encodeURIComponent(p.slug)}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null)
          if (!r?.ok) continue
          const res = await r.json() as { up: boolean }
          const won = (p.side === 'up') === res.up
          const pnl = (won ? held(p) : 0) + p.proceeds - p.cost
          const cur = getLiveBook(me)
          saveLiveBook(me, { ...cur, positions: cur.positions.map(x => (x.id === p.id ? { ...x, won, status: 'closed' as const, pnl } : x)) })
          logLive(me, { kind: 'settle', k: won ? 'Won {side}: +${u}' : 'Lost {side}: −${u}', v: { side: p.side === 'up' ? 'Up' : 'Down', u: Math.abs(pnl).toFixed(2) } })
          if (!won) { check(); continue }
        }
        if ((p.won ?? true) && held(p) > 0.01) {
          try {
            await (await lib).polyRedeem(p.conditionId)
            const cur = getLiveBook(me)
            saveLiveBook(me, { ...cur, positions: cur.positions.map(x => (x.conditionId === p.conditionId ? { ...x, redeemed: true } : x)) })
            logLive(me, { kind: 'settle', k: 'Collected the winning shares as pUSD' })
            await refresh()
          } catch (e) { logLive(me, { kind: 'error', k: 'Collecting the winnings failed (it tries again): {r}', v: { r: (e as Error).message.slice(0, 120) } }) }
        }
      }
      check()
    }

    void refresh()
    const off = marketStream.subscribe({ channel: 'updown' }, m => {
      if (m.t !== 'UDSIG' || !live()) return
      const sig = m.d
      run(() => (sig.kind === 'buy' ? onBuy(sig) : onSell(sig)))
    })
    const lease = setInterval(() => { if (alive && getLiveSettings().on) holdLease(tab.current) }, 2_000)
    const bal = setInterval(() => run(refresh), 15_000)
    const st = setInterval(() => { if (live()) run(settle) }, 20_000)
    return () => { alive = false; off(); clearInterval(lease); clearInterval(bal); clearInterval(st) }
  }, [s.on, me])

  return null
}
