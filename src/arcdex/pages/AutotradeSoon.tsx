// /autotrade, /bots — Autotrade is coming soon (ARCSENSE, 2026-10-03, owner:
// "hide the autotrade marketplace and let the users see only COMING SOON").
// Bots open no new trades (AUTOTRADE_PAUSED on the engine). An owner whose
// bots hold USDC still gets one button to them, to manage and withdraw
// (/autotrade/manage): their money is never out of reach.

import { useEffect, useState } from 'react'
import { botMe, botSession, engineEnabled } from '../api/marketStream'
import { t as T } from '../lib/i18n'
import type { Page } from '../App'

export default function AutotradeSoon({ navigate }: { navigate: (p: Page) => void }) {
  const [bots, setBots] = useState<number | null>(null)
  useEffect(() => {
    if (!engineEnabled || !botSession()) return
    let alive = true
    void botMe().then(m => { if (alive) setBots(m.bots.length) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return (
    <div className="content-page soon-page">
      <div className="soon-hero">
        <span className="soon-badge">{T('Coming soon')}</span>
        <h2 className="page-h">⚡ {T('Autotrade')}</h2>
        <p className="soon-lead">{T('Bots that trade spot and futures for you, with the safety checks ARCSENSE runs on every coin.')}</p>
      </div>
      {bots !== null && bots > 0 && (
        <div className="soon-owner">
          <span>{T('You have {n} Autotrade bot(s). They open no new trades; you can manage them and withdraw your USDC at any time.', { n: bots })}</span>
          <button className="btn-primary" onClick={() => navigate({ name: 'signals', view: 'manage' })}>{T('Manage and withdraw')} →</button>
        </div>
      )}
      <div className="soon-cta">
        <button className="btn-ghost" onClick={() => navigate({ name: 'terminal' })}>{T('Trade spot now')} →</button>
      </div>
    </div>
  )
}
