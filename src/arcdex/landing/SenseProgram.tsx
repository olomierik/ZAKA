import { useEffect, useState } from 'react'
import { t } from '../lib/i18n'
import type { SenseEntry, SenseProgramView } from '../../../engine/src/sense/shared'

// Where ARCSENSE's fees go (owner, 2026-10-03): 30% buy back $SENSE and burn it, 70% go to
// liquidity pools. Live from the engine's ledger of the fee wallet (engine/src/sense/program.ts);
// the full ledger and every transaction are on /sense.

const EXPLORER = 'https://explorer.arc.io'
const usd = (n: number | null | undefined) => (n == null ? '…' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const big = (n: number | null | undefined) => (n == null ? '…' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0))
const LABEL: Record<SenseEntry['kind'], string> = {
  fee: 'Fee in', buyback: 'Bought back', burn: 'Burned', liquidity: 'Liquidity added', unliquidity: 'Liquidity removed',
}

export default function SenseProgram({ engine }: { engine: string }) {
  const [v, setV] = useState<SenseProgramView | null>(null)
  useEffect(() => {
    if (!engine) return
    let alive = true
    const load = () => fetch(`${engine}/v1/sense/program`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((x: SenseProgramView | null) => { if (alive && x) setV(x) }).catch(() => {})
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [engine])
  const tt = v?.totals
  return (
    <section className="ld-section" id="sense">
      <h2>{t('Where the fees go')}</h2>
      <p className="ld-sub">{t('Of the fees ARCSENSE collects, 30% buy back $SENSE and burn it, and 70% go to liquidity pools. Every number is read from the fee wallet on Arc.')}</p>
      {v && !v.program.started && <p className="ld-muted">{t('The program starts {date}. From then on, every fee counts.', { date: new Date(v.program.since).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) })}</p>}
      <div className="ld-split">
        <div className="ld-card ld-split-card">
          <span className="ld-split-pct">30%</span>
          <h3>🔥 {t('Buyback & burn')}</h3>
          <div className="ld-split-row"><span>{t('Bought back')}</span><b>{usd(tt?.buybackUsd)}</b></div>
          <div className="ld-split-row"><span>{t('$SENSE burned')}</span><b>{big(tt?.senseBurned)}</b></div>
          <div className="ld-split-row"><span>{t('Still to buy')}</span><b>{usd(v?.pending.buybackUsd)}</b></div>
        </div>
        <div className="ld-card ld-split-card">
          <span className="ld-split-pct">70%</span>
          <h3>💧 {t('Liquidity pools')}</h3>
          <div className="ld-split-row"><span>{t('Added to liquidity')}</span><b>{usd(tt?.liquidityUsd)}</b></div>
          <div className="ld-split-row"><span>{t('Still to add')}</span><b>{usd(v?.pending.liquidityUsd)}</b></div>
          <div className="ld-split-row"><span>{t('Fees collected')}</span><b>{usd(tt?.feesUsd)}</b></div>
        </div>
      </div>
      {v && v.actions.length > 0 && (
        <div className="ld-card ld-split-list">
          {v.actions.slice(0, 4).map(a => (
            <a key={`${a.tx}:${a.kind}`} href={`${EXPLORER}/tx/${a.tx}`} target="_blank" rel="noreferrer">
              <span>{t(LABEL[a.kind])}</span>
              <b>{a.kind === 'burn' ? `${big(a.sense)} $SENSE` : usd(a.usd)}</b>
              <span className="ld-muted">{a.at ? new Date(a.at).toLocaleDateString() : ''} ↗</span>
            </a>
          ))}
        </div>
      )}
      <p className="ld-muted ld-split-foot">
        <a href="/sense">{t('See the full ledger')} →</a>
        {' · '}
        <a href={`${EXPLORER}/address/${v?.program.feeWallet ?? '0x274262a0321a0701b0a46a3576e07ae881c286bb'}`} target="_blank" rel="noreferrer">{t('The fee wallet on the explorer')} ↗</a>
      </p>
    </section>
  )
}
