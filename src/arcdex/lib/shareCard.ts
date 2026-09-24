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
