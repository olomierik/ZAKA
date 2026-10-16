// Alerts by push on the page (lib/push.ts): the switch that turns them on for this device, and the bell on Arc coin
// pages that sets a price alert or a whale alert (a single trade of at least an amount) on that coin.

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { t as T, N_ } from '../lib/i18n'
import { addCoinAlert, disablePush, enablePush, pushSupport, removeCoinAlert, testPush, usePush, type CoinAlert } from '../lib/push'

const fmtUsd = (n: number) => (n >= 1 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : `$${n.toPrecision(4)}`)
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const WHY: Record<string, string> = {
  'no-engine': N_('Alerts on this device need ARCDEX’s market engine, which this build doesn’t reach.'),
  off: N_('Alerts on this device are switched off for now.'),
  unsupported: N_('This browser can’t receive alerts with ARCDEX closed. On an iPhone, add ARCDEX to your home screen first.'),
  blocked: N_('Notifications are blocked for this site in your browser’s settings.'),
}

/** On / off for alerts that reach this device with ARCDEX closed. */
export function PushToggle({ compact }: { compact?: boolean }) {
  const s = usePush()
  const support = pushSupport()
  const [tested, setTested] = useState<string | null>(null)
  if (support !== 'ok' && !s.sub) return <div className="fx-fine push-why" data-push="unavailable">{T(WHY[support] ?? WHY.unsupported)}</div>
  return (
    <div className={`push-toggle${s.sub ? ' on' : ''}`} data-push={s.sub ? 'on' : 'off'}>
      <div>
        <strong>{s.sub ? T('🔔 Alerts reach this device') : T('Get alerts with ARCDEX closed')}</strong>
        {!compact && <small>{s.sub ? T('Checked by ARCDEX’s engine around the clock, sent within seconds.') : T('A notification on this device, even with every ARCDEX tab closed.')}</small>}
      </div>
      {s.sub ? (
        <span className="push-actions">
          <button className="link-btn" disabled={s.busy} onClick={() => void testPush(T('ARCDEX alerts are on'), T('This is how an alert will look.')).then(() => setTested(T('Sent.')), e => setTested(String((e as Error).message)))}>{T('Send a test')}</button>
          <button className="link-btn" disabled={s.busy} onClick={() => void disablePush()}>{T('Turn off')}</button>
        </span>
      ) : (
        <button className="btn-primary" disabled={s.busy} onClick={() => void enablePush()}>{s.busy ? T('Turning on…') : T('Turn on')}</button>
      )}
      {tested && <small className="push-tested">{tested}</small>}
      {s.error && <small className="fx-hint-bad">⚠ {T(WHY[s.error] ?? s.error)}</small>}
    </div>
  )
}

export function CoinAlertBell({ address, symbol, priceUsd }: { address: string; symbol: string; priceUsd: number | null }) {
  const s = usePush()
  const [open, setOpen] = useState(false)
  const n = s.coin.filter(a => a.market === address.toLowerCase() && !(a.kind === 'price' && a.firedAt)).length
  return (
    <>
      <button className={`tk-link pa-bell-coin${n ? ' on' : ''}`} title={T('Alerts on {sym}', { sym: symbol })} aria-label={T('Alerts on {sym}', { sym: symbol })} onClick={() => setOpen(true)}>🔔{n ? <b>{n}</b> : null}</button>
      {/* In <body>, not inside the header's row of links, whose styles (one line, no wrapping) it would inherit. */}
      {open && createPortal(<CoinAlertModal address={address.toLowerCase()} symbol={symbol} priceUsd={priceUsd} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function CoinAlertModal({ address, symbol, priceUsd, onClose }: { address: string; symbol: string; priceUsd: number | null; onClose: () => void }) {
  const s = usePush()
  const px = priceUsd ?? 0
  const [level, setLevel] = useState(() => (px > 0 ? (px * 1.2).toPrecision(4) : ''))
  const [minUsd, setMinUsd] = useState('5000')
  const [side, setSide] = useState<'any' | 'buy' | 'sell'>('any')
  const [done, setDone] = useState<string | null>(null)
  const mine = useMemo(() => s.coin.filter(a => a.market === address), [s.coin, address])
  const n = Number(level), m = Number(minUsd)
  const url = `/token/${address}`

  async function ensureOn() { return s.sub ? true : enablePush() }
  async function addPrice() {
    if (!(n > 0 && px > 0) || !(await ensureOn())) return
    const dir = n >= px ? 'above' : 'below'
    const title = dir === 'above' ? T('{sym} rises to {px}', { sym: symbol, px: fmtUsd(n) }) : T('{sym} falls to {px}', { sym: symbol, px: fmtUsd(n) })
    addCoinAlert({ kind: 'price', market: address, symbol, dir, px: n, title, body: T('Price alert on ARCDEX'), url })
    setDone(title)
  }
  async function addWhale() {
    if (!(m >= 10) || !(await ensureOn())) return
    const title = side === 'any' ? T('{side} of {usd} on {sym}', { sym: symbol }) : side === 'buy' ? T('Buy of {usd} on {sym}', { sym: symbol }) : T('Sell of {usd} on {sym}', { sym: symbol })
    addCoinAlert({ kind: 'activity', market: address, symbol, minUsd: m, side, title, body: T('A single trade on ARCDEX’s Arc feed'), url, buyWord: T('Buy'), sellWord: T('Sell') })
    setDone(T('a single trade of {usd} or more', { usd: `$${m.toLocaleString()}` }))
  }
  const describe = (a: CoinAlert) => a.kind === 'price'
    ? (a.dir === 'above' ? T('{sym} rises to {px}', { sym: a.symbol, px: fmtUsd(a.px ?? 0) }) : T('{sym} falls to {px}', { sym: a.symbol, px: fmtUsd(a.px ?? 0) }))
    : T('A single {side} of {usd} or more', { side: a.side === 'buy' ? T('buy') : a.side === 'sell' ? T('sell') : T('trade'), usd: `$${(a.minUsd ?? 0).toLocaleString()}` })

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card hl-modal pa-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={T('Alerts on {sym}', { sym: symbol })}>
        <div className="hl-modal-h"><b>🔔 {T('Alerts on {sym}', { sym: symbol })}</b><button className="fxb-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <PushToggle compact />
        <div className="fx-summary"><div><span>{T('Price now')}</span><b>{px > 0 ? fmtUsd(px) : '—'}</b></div></div>
        <div className="fxb-input"><span>{T('Alert me at')}</span><input inputMode="decimal" value={level} onChange={e => { setLevel(e.target.value.replace(/[^0-9.]/g, '')); setDone(null) }} /><em>USD</em></div>
        <div className="pa-chips">
          {[-50, -25, -10, 10, 25, 50, 100, 200].map(p => (
            <button key={p} className={p < 0 ? 'down' : 'up'} disabled={!(px > 0)} onClick={() => { setLevel((px * (1 + p / 100)).toPrecision(4)); setDone(null) }}>{p > 0 ? '+' : '−'}{Math.abs(p)}%</button>
          ))}
        </div>
        <button className="btn-primary" disabled={s.busy || !(n > 0) || !(px > 0)} onClick={() => void addPrice()}>{T('Set price alert')}</button>
        <div className="fxb-input"><span>{T('A single trade of at least')}</span><input inputMode="decimal" value={minUsd} onChange={e => { setMinUsd(e.target.value.replace(/[^0-9]/g, '')); setDone(null) }} /><em>USD</em></div>
        <div className="pa-seg">
          {(['any', 'buy', 'sell'] as const).map(v => <button key={v} className={side === v ? 'on' : ''} onClick={() => setSide(v)}>{v === 'any' ? T('Buys and sells') : v === 'buy' ? T('Buys') : T('Sells')}</button>)}
        </div>
        <button className="btn-primary" disabled={s.busy || !(m >= 10)} onClick={() => void addWhale()}>{T('Set whale alert')}</button>
        {done && <div className="fx-note ok">✓ {T('Alert set: {cond}.', { cond: done })}</div>}
        {mine.length > 0 && (
          <div className="pa-mine">
            {mine.map(a => (
              <div key={a.id} className={`pa-row ${a.kind === 'price' && a.firedAt ? 'fired' : 'active'}`}>
                <span>{describe(a)}</span>
                <small>{a.kind === 'price' ? (a.firedAt ? T('reached {time}', { time: when(a.firedAt) }) : T('waiting')) : a.lastAt ? T('last {time}', { time: when(a.lastAt) }) : T('waiting')}</small>
                <button className="link-btn" onClick={() => removeCoinAlert(a.id)}>{T('Delete')}</button>
              </div>
            ))}
          </div>
        )}
        <p className="fx-fine">{T('ARCDEX’s engine checks every trade on this coin and sends the alert to this device within seconds. A price alert fires once; a whale alert at most once a minute.')}</p>
      </div>
    </div>
  )
}
