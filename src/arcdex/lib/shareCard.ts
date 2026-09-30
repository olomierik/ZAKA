// Shareable trade card (1200×630 PNG, the X/Telegram preview size).
// Drawn entirely client-side on a canvas; the token image is only used if
// its host allows cross-origin reads (otherwise the canvas would be
// tainted and couldn't be exported), falling back to a lettered badge.

import { identiconSvg } from '../components/Avatar'

export interface CardData {
  symbol: string
  tokenImage: string | null
  headline: string        // e.g. "+182.4%" or "Bought"
  headlineColor: string   // green / red / accent
  lines: string[]         // 1–3 short detail lines
  trader: string          // username or short address
  traderAddress: string
  link: string            // referral link printed on the card
}

function loadImage(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    if (cors) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
    setTimeout(() => resolve(null), 4000)
  })
}

export async function renderCard(d: CardData): Promise<Blob> {
  const W = 1200, H = 630
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const g = canvas.getContext('2d')!

  // background
  const bg = g.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#060d18'); bg.addColorStop(1, '#0f1f3a')
  g.fillStyle = bg; g.fillRect(0, 0, W, H)
  g.fillStyle = d.headlineColor; g.globalAlpha = 0.12
  g.beginPath(); g.arc(W - 120, 120, 320, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1

  // brand
  g.fillStyle = '#eef3fa'; g.font = '700 34px "Space Grotesk", system-ui, sans-serif'
  g.fillText('ARCDEX', 64, 84)
  g.fillStyle = '#86a2c2'; g.font = '500 22px "Space Grotesk", system-ui, sans-serif'
  g.fillText('Social trading on Arc', 64, 118)

  // token
  const tokenImg = d.tokenImage ? await loadImage(d.tokenImage, true) : null
  const tx = 64, ty = 180, ts = 96
  g.save(); g.beginPath(); g.arc(tx + ts / 2, ty + ts / 2, ts / 2, 0, Math.PI * 2); g.clip()
  if (tokenImg) g.drawImage(tokenImg, tx, ty, ts, ts)
  else { g.fillStyle = '#1e3a5f'; g.fillRect(tx, ty, ts, ts); g.fillStyle = '#3b82f6'; g.font = '700 34px system-ui'; g.textAlign = 'center'; g.fillText(d.symbol.slice(0, 3), tx + ts / 2, ty + ts / 2 + 12); g.textAlign = 'left' }
  g.restore()
  g.fillStyle = '#eef3fa'; g.font = '700 54px "Space Grotesk", system-ui, sans-serif'
  g.fillText(`$${d.symbol}`, tx + ts + 28, ty + 66)

  // headline
  g.fillStyle = d.headlineColor; g.font = '800 132px "Space Grotesk", system-ui, sans-serif'
  g.fillText(d.headline, 64, 420)

  // details
  g.fillStyle = '#b8cbe2'; g.font = '500 30px "JetBrains Mono", ui-monospace, monospace'
  d.lines.slice(0, 3).forEach((l, i) => g.fillText(l, 64, 478 + i * 42))

  // trader
  const av = await loadImage(`data:image/svg+xml;utf8,${encodeURIComponent(identiconSvg(d.traderAddress, 64))}`, false)
  const ax = W - 64 - 64, ay = H - 64 - 64
  if (av) { g.save(); g.beginPath(); g.arc(ax + 32, ay + 32, 32, 0, Math.PI * 2); g.clip(); g.drawImage(av, ax, ay, 64, 64); g.restore() }
  g.textAlign = 'right'
  g.fillStyle = '#eef3fa'; g.font = '700 28px "Space Grotesk", system-ui, sans-serif'
  g.fillText(d.trader, ax - 18, ay + 28)
  g.fillStyle = '#3b82f6'; g.font = '500 22px "JetBrains Mono", ui-monospace, monospace'
  g.fillText(d.link.replace(/^https:\/\//, ''), ax - 18, ay + 60)
  g.textAlign = 'left'

  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not render card'))), 'image/png'))
}

export function tweetUrl(text: string, link: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`
}

// ── A bot's P&L card (owner's request, 2026-10-01: "let each bot produce a P&L
// card shareable to social media"): the bot's name, P&L, win rate and trades,
// and the curve of its closed trades, 1200×630 like the trade card.

export interface BotCardData {
  name: string
  mode: 'paper' | 'live'
  strategies: string[]
  pnlUsd: number
  pnlPct: number | null
  winRate: number | null
  trades: number
  /** Cumulative P&L after each closed trade, oldest first, ending at the P&L shown. */
  curve: number[]
  since: number | null
  link: string
}

const STRAT_LABEL: Record<string, string> = { scalp: 'Fast scalp', snipe: 'Snipe', 'second-leg': 'Dip rebound' }
const usdText = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The curve: closed trades' P&L, oldest first, added up so it ends at `endUsd`. */
export function botCurve(closed: { pnlUsd: number | null; closedAt: number | null }[], endUsd: number): number[] {
  const list = [...closed].filter(p => p.closedAt).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const sum = list.reduce((s, p) => s + (p.pnlUsd ?? 0), 0)
  let run = endUsd - sum
  const out = [run]
  for (const p of list) { run += p.pnlUsd ?? 0; out.push(run) }
  if (Math.abs(out[out.length - 1] - endUsd) > 1e-9) out.push(endUsd)
  return out
}

export async function renderBotCard(d: BotCardData): Promise<Blob> {
  const W = 1200, H = 630
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const g = canvas.getContext('2d')!
  const up = d.pnlUsd >= 0
  const accent = up ? '#22c55e' : '#ef4444'
  const sans = '"Space Grotesk", system-ui, sans-serif', mono = '"JetBrains Mono", ui-monospace, monospace'

  const bg = g.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#060d18'); bg.addColorStop(1, '#101c33')
  g.fillStyle = bg; g.fillRect(0, 0, W, H)
  g.fillStyle = accent; g.globalAlpha = 0.1
  g.beginPath(); g.arc(W - 160, 140, 340, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1

  // brand and mode
  g.fillStyle = '#eef3fa'; g.font = `700 32px ${sans}`
  g.fillText('ARCDEX', 64, 82)
  g.fillStyle = '#f59e0b'; g.font = `700 20px ${sans}`
  g.fillText('⚡ AUTOTRADE', 196, 81)
  const mode = d.mode === 'live' ? 'LIVE' : 'PAPER'
  g.font = `800 20px ${sans}`
  const mw = g.measureText(mode).width + 32
  g.fillStyle = d.mode === 'live' ? '#ef4444' : 'rgba(255,255,255,0.08)'
  roundRect(g, W - 64 - mw, 54, mw, 38, 10); g.fill()
  g.fillStyle = d.mode === 'live' ? '#fff' : '#a9bbd4'; g.textAlign = 'center'
  g.fillText(mode, W - 64 - mw / 2, 80); g.textAlign = 'left'

  // the bot
  g.fillStyle = '#eef3fa'; g.font = `700 56px ${sans}`
  g.fillText(`🤖 ${fit(g, d.name, 620)}`, 64, 178)
  g.fillStyle = '#8ca3c0'; g.font = `500 24px ${sans}`
  g.fillText(d.strategies.map(s => STRAT_LABEL[s] ?? s).join(' · '), 64, 218)

  // P&L
  g.fillStyle = accent; g.font = `800 112px ${sans}`
  g.fillText(usdText(d.pnlUsd), 64, 350)
  if (d.pnlPct !== null) {
    g.font = `700 40px ${mono}`
    g.fillText(`${d.pnlPct >= 0 ? '+' : '−'}${Math.abs(d.pnlPct).toFixed(1)}%`, 68, 408)
  }

  // record
  const stats: [string, string][] = [
    ['Win rate', d.winRate === null ? '—' : `${Math.round(d.winRate * 100)}%`],
    ['Trades', d.trades.toLocaleString('en-US')],
    ['Since', d.since ? new Date(d.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'],
  ]
  stats.forEach(([k, v], i) => {
    const x = 64 + i * 190
    g.fillStyle = '#8ca3c0'; g.font = `500 20px ${sans}`; g.fillText(k, x, 470)
    g.fillStyle = '#eef3fa'; g.font = `700 36px ${mono}`; g.fillText(v, x, 512)
  })

  // the curve of its closed trades
  const cx = 700, cy = 250, cw = 436, ch = 250
  g.fillStyle = 'rgba(255,255,255,0.03)'; roundRect(g, cx, cy, cw, ch, 16); g.fill()
  const pts = d.curve.length >= 2 ? d.curve : [0, d.pnlUsd]
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1
  const px = (i: number) => cx + 20 + (i / (pts.length - 1)) * (cw - 40)
  const py = (v: number) => cy + 20 + (1 - (v - lo) / span) * (ch - 40)
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.setLineDash([6, 6]); g.lineWidth = 1.5
  g.beginPath(); g.moveTo(cx + 20, py(0)); g.lineTo(cx + cw - 20, py(0)); g.stroke(); g.setLineDash([])
  const fill = g.createLinearGradient(0, cy, 0, cy + ch)
  fill.addColorStop(0, up ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'); fill.addColorStop(1, 'rgba(0,0,0,0)')
  g.beginPath(); pts.forEach((v, i) => (i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v))))
  g.lineTo(px(pts.length - 1), cy + ch - 20); g.lineTo(px(0), cy + ch - 20); g.closePath(); g.fillStyle = fill; g.fill()
  g.beginPath(); pts.forEach((v, i) => (i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v))))
  g.strokeStyle = accent; g.lineWidth = 4; g.lineJoin = 'round'; g.stroke()
  g.fillStyle = accent; g.beginPath(); g.arc(px(pts.length - 1), py(pts[pts.length - 1]), 7, 0, Math.PI * 2); g.fill()
  g.fillStyle = '#8ca3c0'; g.font = `500 18px ${sans}`
  g.fillText('P&L over its closed trades', cx + 20, cy + ch + 30)

  // footer
  g.fillStyle = '#3b82f6'; g.font = `500 22px ${mono}`
  g.fillText(d.link.replace(/^https:\/\//, ''), 64, H - 50)
  g.textAlign = 'right'; g.fillStyle = '#8ca3c0'; g.font = `500 20px ${sans}`
  g.fillText(d.mode === 'paper' ? 'Paper trading · virtual USDC' : 'Live · real USDC', W - 64, H - 50)
  g.textAlign = 'left'

  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not render card'))), 'image/png'))
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath()
}

/** Text shortened with … to fit `max` pixels in the current font. */
function fit(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s
  let t = s
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1)
  return t + '…'
}

/** What a bot's card says when it's shared (the post's text). */
export function botShareText(d: Pick<BotCardData, 'name' | 'mode' | 'pnlUsd' | 'pnlPct' | 'winRate' | 'trades'>, mine = true): string {
  const pct = d.pnlPct === null ? '' : ` (${d.pnlPct >= 0 ? '+' : '−'}${Math.abs(d.pnlPct).toFixed(1)}%)`
  const won = d.winRate === null ? '' : `, ${Math.round(d.winRate * 100)}% of ${d.trades} trades won`
  return `🤖 ${mine ? 'My bot' : 'The bot'} ${d.name} is ${usdText(d.pnlUsd)}${pct}${won}${d.mode === 'paper' ? ' (paper trading)' : ''} on ARCDEX Autotrade. Self-improving trading bots for Arc.`
}
