import { useEffect, useRef, useState } from 'react'
import { t } from '../lib/i18n'
import { COIN, COIN_IMAGE, COIN_LC, COIN_PATH, COIN_SUPPLY, fmtCompactUsd, fmtPct, fmtSmallUsd, useCoin, useCoinBurned } from '../lib/coin'
import type { CoinBurn, CoinProgramView } from '../../../engine/src/coin/shared'

// $ARCDEX, live, for the home page (owner, 2026-10-04: "the coin info including the burn rate and its
// market cap, and how each buy and burn shows in real time"). The engine reads its Argus pool's swaps
// (GET /v1/tokens/<coin>/trades, every few seconds) and every transfer to the dead address since the
// coin was created (GET /v1/coin/program). No wallet libraries: the home page stays a small bundle.

const EXPLORER = 'https://explorer.arc.io'
interface WireTrade { id: string; s: 'B' | 'S' | 'U'; ba: number; u: number | null; w: string | null; tx: string; ts: number }

export const big = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '…' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0))
const usd = (n: number | null | undefined) => (n == null ? '—' : n >= 1000 ? fmtCompactUsd(n) : `$${n.toFixed(2)}`)
const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—')

/** "12s", "5m", "3h", "2d": how long ago. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** The burn ledger (every burn, the totals, the program), refreshed every 20 seconds. */
export function useCoinProgram(engine: string): CoinProgramView | null {
  const [v, setV] = useState<CoinProgramView | null>(null)
  useEffect(() => {
    if (!engine) return
    let alive = true
    const load = () => fetch(`${engine}/v1/coin/program`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((x: CoinProgramView | null) => { if (alive && x?.program) setV(x) }).catch(() => {})
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 20_000)
    return () => { alive = false; clearInterval(id) }
  }, [engine])
  return v
}

/** $ARCDEX's latest swaps in its Argus pool, refreshed every 5 seconds. */
function useCoinTrades(engine: string): WireTrade[] | null {
  const [rows, setRows] = useState<WireTrade[] | null>(null)
  useEffect(() => {
    if (!engine) return
    let alive = true
    const load = () => fetch(`${engine}/v1/tokens/${COIN_LC}/trades?limit=20`, { signal: AbortSignal.timeout(8_000) })
      .then(r => (r.ok ? r.json() : null)).then((j: { trades?: WireTrade[] } | null) => { if (alive && j?.trades) setRows(j.trades) }).catch(() => {})
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 5_000)
    return () => { alive = false; clearInterval(id) }
  }, [engine])
  return rows
}

type FeedItem = { key: string; kind: 'buy' | 'sell' | 'burn'; at: number; tokens: number; usd: number | null; who: string | null; tx: string }

function feedOf(trades: WireTrade[] | null, burns: CoinBurn[] | undefined): FeedItem[] {
  const out: FeedItem[] = []
  for (const tr of trades ?? []) if (tr.s !== 'U') out.push({ key: tr.id, kind: tr.s === 'B' ? 'buy' : 'sell', at: tr.ts, tokens: tr.ba, usd: tr.u, who: tr.w, tx: tr.tx })
  for (const b of burns ?? []) if (b.at) out.push({ key: `burn:${b.tx}:${b.amount}`, kind: 'burn', at: b.at, tokens: b.amount, usd: null, who: b.from, tx: b.tx })
  return out.sort((a, b) => b.at - a.at)
}

/** Buys, sells and burns of $ARCDEX as they happen; a new one slides in. */
export function CoinFeed({ engine, program, limit = 8 }: { engine: string; program: CoinProgramView | null; limit?: number }) {
  const trades = useCoinTrades(engine)
  const items = feedOf(trades, program?.burns).slice(0, limit)
  const seen = useRef<Set<string> | null>(null)
  const fresh = new Set<string>()
  if (seen.current) for (const i of items) if (!seen.current.has(i.key)) fresh.add(i.key)
  useEffect(() => { seen.current = new Set(items.map(i => i.key)) })
  const [, tick] = useState(0)
  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 5_000); return () => clearInterval(id) }, [])
  const label = { buy: t('Buy'), sell: t('Sell'), burn: t('Burn') }
  return (
    <div className="ld-feed">
      <div className="ld-feed-h"><span className="ld-live-dot" />{t('Live: buys, sells and burns')}</div>
      {!items.length && <div className="ld-feed-empty">{trades === null && !program ? t('Connecting…') : t('No trades yet today.')}</div>}
      {items.map(i => (
        <a key={i.key} className={`ld-feed-row ${i.kind}${fresh.has(i.key) ? ' fresh' : ''}`} href={`${EXPLORER}/tx/${i.tx}`} target="_blank" rel="noreferrer">
          <span className="ld-feed-kind">{i.kind === 'burn' ? '🔥' : i.kind === 'buy' ? '▲' : '▼'} {label[i.kind]}</span>
          <span className="ld-feed-amt"><b>{big(i.tokens)}</b> ARCDEX</span>
          <span className="ld-feed-usd">{i.kind === 'burn' ? short(i.who) : usd(i.usd)}</span>
          <span className="ld-feed-ago">{ago(i.at)}</span>
        </a>
      ))}
    </div>
  )
}

/** The share of the supply burned, as a meter, with the last 24 hours and 7 days. The total is
 * the dead wallet's balance read from Arc (shown at once), else the engine's ledger. */
export function BurnMeter({ program }: { program: CoinProgramView | null }) {
  const b = program?.burned
  const dead = useCoinBurned()
  const total = dead?.total ?? b?.total ?? null
  const pct = dead?.pct ?? b?.pct ?? null
  return (
    <div className="ld-burn">
      <div className="ld-burn-top">
        <span>🔥 {t('Burned forever')}</span>
        <b>{total != null ? big(total) : '…'} <small>/ {big(COIN_SUPPLY)}</small></b>
      </div>
      <div className="ld-burn-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0} aria-label={t('Share of the supply burned')}>
        <span style={{ width: `${Math.min(100, Math.max(pct ?? 0, pct ? 1.5 : 0))}%` }} />
      </div>
      <div className="ld-burn-foot">
        <span><b>{pct == null ? '…' : `${pct.toFixed(2)}%`}</b> {t('of the supply')}</span>
        <span>{t('24h')} <b>{b ? big(b.h24) : '…'}</b></span>
        <span>{t('7d')} <b>{b ? big(b.d7) : '…'}</b></span>
      </div>
    </div>
  )
}

/** $ARCDEX's card for the hero: price, market cap, liquidity, volume, the burn meter and the live feed. */
export function CoinLiveCard({ engine, program }: { engine: string; program: CoinProgramView | null }) {
  const q = useCoin()
  const chg = q?.change24h ?? null
  return (
    <div className="ld-card ld-coin">
      <div className="ld-coin-head">
        <img src={COIN_IMAGE} alt="" width={44} height={44} />
        <div>
          <b>$ARCDEX</b>
          <small>{t('The ARCDEX coin · launched on Argus')}</small>
        </div>
        <span className="ld-coin-price">
          {fmtSmallUsd(q?.priceUsd)}
          <span className={chg == null ? '' : chg >= 0 ? 'ld-up' : 'ld-down'}>{fmtPct(chg)}</span>
        </span>
      </div>
      <div className="ld-coin-stats">
        <div><span>{t('Market cap')}</span><b>{fmtCompactUsd(q?.marketCapUsd)}</b></div>
        <div><span>{t('Liquidity')}</span><b>{fmtCompactUsd(q?.liquidityUsd)}</b></div>
        <div><span>{t('24h volume')}</span><b>{fmtCompactUsd(q?.volume24h)}</b></div>
        <div><span>{t('24h trades')}</span><b>{q ? <><em className="ld-up">{q.buys24h}</em> / <em className="ld-down">{q.sells24h}</em></> : '—'}</b></div>
      </div>
      <BurnMeter program={program} />
      <CoinFeed engine={engine} program={program} limit={6} />
      <a className="ld-btn ld-btn-primary ld-btn-block" href={COIN_PATH}>{t('Buy $ARCDEX')} →</a>
      <p className="ld-coin-fine">
        <a href={`${EXPLORER}/address/${COIN}`} target="_blank" rel="noreferrer">{t('Explorer')} ↗</a>
      </p>
    </div>
  )
}

/** Burned per day (the last 60 days the engine has), as bars. */
export function BurnChart({ program }: { program: CoinProgramView | null }) {
  const days = program?.burnDays ?? []
  const max = Math.max(1, ...days.map(d => d.amount))
  if (!program) return <div className="ld-chart-empty">{t('Loading the burn history…')}</div>
  if (!days.length) return <div className="ld-chart-empty">{program.burned.complete ? t('No burns yet.') : t('Reading every burn since the coin launched…')}</div>
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return (
    <>
      {/* A square-root scale: the launch week's big burns don't flatten every later day. */}
      <div className="ld-chart" role="img" aria-label={t('$ARCDEX burned per day')}>
        {days.map(d => (
          <span key={d.day} className="ld-chart-bar" style={{ height: `${Math.max(3, Math.sqrt(d.amount / max) * 100)}%` }}
            title={`${label(d.day)}: ${Math.round(d.amount).toLocaleString()} ARCDEX`} />
        ))}
      </div>
      <div className="ld-chart-axis"><span>{label(days[0].day)}</span><span>{label(days[days.length - 1].day)}</span></div>
    </>
  )
}

/** The latest burns, each with its transaction. */
export function BurnList({ program, limit = 8 }: { program: CoinProgramView | null; limit?: number }) {
  const burns = program?.burns.slice(0, limit) ?? []
  if (!burns.length) return null
  return (
    <div className="ld-burnlist">
      {burns.map(b => (
        <a key={`${b.tx}:${b.amount}`} href={`${EXPLORER}/tx/${b.tx}`} target="_blank" rel="noreferrer">
          <span>🔥 <b>{big(b.amount)}</b> ARCDEX</span>
          <span className="ld-muted">{short(b.from)}</span>
          <span className="ld-muted">{b.at ? new Date(b.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''} ↗</span>
        </a>
      ))}
    </div>
  )
}
