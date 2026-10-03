import { useCallback, useState } from 'react'
import type { MarketBot, MarketBotDetail, PaperAccountView } from '../../../api/_marketProtocol'
import { botCurve, botShareText, renderBotCard, type BotCardData } from '../lib/shareCard'
import { t as T } from '../lib/i18n'
import ShareCardModal from './ShareCardModal'

// A bot's P&L card (owner's request, 2026-10-01): a button that draws it from
// the numbers on screen and opens the share sheet (Share…, Post on X,
// Download, Copy link). The owner's dashboard and every bot's public page
// have one; a profit notification opens it too.

const linkOf = (slug: string) => `https://arcsense.site/bots/${encodeURIComponent(slug)}`

/** The card for a bot as the marketplace shows it (its public page). */
export function cardFromMarket(b: MarketBot | MarketBotDetail): BotCardData {
  const trades = 'trades' in b ? b.trades.filter(p => (b.mode === 'live' ? p.mode === 'live' : p.mode !== 'live')) : []
  const open = b.positions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
  const curve = botCurve(trades, b.pnlUsd - open)
  if (Math.abs(open) > 1e-9) curve.push(b.pnlUsd)
  return { name: b.name, mode: b.mode, strategies: b.strategies, pnlUsd: b.pnlUsd, pnlPct: b.pnlPct, winRate: b.winRate, trades: b.closed, curve, since: b.createdAt, link: linkOf(b.slug) }
}

/** The card for the owner's own bot (its dashboard). */
/** Winning trades in a row, most recent first (for the post: "7 wins in a row"). */
function winStreak(closed: { closedAt: number | null; pnlUsd: number | null }[]): number {
  let n = 0
  for (const p of [...closed].sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0))) { if ((p.pnlUsd ?? 0) > 0) n++; else break }
  return n
}

export function cardFromAccount(a: PaperAccountView): BotCardData {
  const live = a.mode === 'live' && a.live
  const pnl = live ? a.live!.pnlUsd : a.equity - a.deposited
  const closed = a.positions.filter(p => p.status === 'closed' && (live ? p.mode === 'live' : p.mode !== 'live'))
  return {
    name: a.name ?? 'My bot', mode: live ? 'live' : 'paper', strategies: a.strategies,
    pnlUsd: pnl, pnlPct: live ? (a.live!.startBalanceUsd ? (pnl / a.live!.startBalanceUsd) * 100 : null) : a.deposited > 0 ? (pnl / a.deposited) * 100 : null,
    streak: winStreak(closed),
    winRate: live ? a.live!.winRate : a.stats.winRate, trades: live ? a.live!.closed : a.stats.closed,
    curve: botCurve(closed, live ? a.live!.pnlUsd : a.stats.totalPnlUsd).concat(live ? [] : [pnl]),
    since: a.startedAt ?? a.createdAt, link: linkOf(a.slug ?? ''),
  }
}

export function BotShareModal({ data, mine, onClose }: { data: BotCardData; mine: boolean; onClose: () => void }) {
  const render = useCallback(() => renderBotCard(data), [data])
  const slug = data.link.split('/').pop() ?? 'bot'
  return <ShareCardModal title={T('Share {name}\'s P&L card', { name: data.name })} render={render} fileName={`arcdex-bot-${slug}.png`} link={data.link} text={botShareText(data, mine)} onClose={onClose} />
}

/** "Share P&L card": draws the card from `get()` when pressed (a snapshot of the numbers then). */
export function ShareBotButton({ get, mine, className = 'btn-ghost', label }: { get: () => BotCardData | Promise<BotCardData>; mine: boolean; className?: string; label?: string }) {
  const [data, setData] = useState<BotCardData | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try { setData(await get()) } finally { setBusy(false) }
  }
  return (
    <>
      <button className={className} disabled={busy} onClick={() => void open()}>📤 {label ?? T('Share P&L card')}</button>
      {data && <BotShareModal data={data} mine={mine} onClose={() => setData(null)} />}
    </>
  )
}
