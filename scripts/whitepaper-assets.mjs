// Makes the whitepaper's downloadable files from the built site:
//   public/arcdex-whitepaper.pdf    A4, from /whitepaper's print styles (the "Download PDF" link)
//   public/arcdex-whitepaper-x.png  1600×900: the post card for X, also the link-preview image
//   public/arcdex-roadmap-x.png     1080×1350: the roadmap, for X
// Run it again after editing src/arcdex/landing/Whitepaper.tsx or roadmap.ts:
//   bun run build && (npx vite preview --port 4173 &) && node scripts/whitepaper-assets.mjs
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
// Options (env):
//   BASE=http://localhost:4173        where the built site is served
//   PLAYWRIGHT=/path/to/playwright    a Playwright install to use instead of the local one
//   CHROMIUM=/path/to/chrome          a Chromium binary to use
//   FONT_CACHE=/dir                   serve the Google Fonts from a local copy (fonts.css plus
//                                     the woff2 files under their fonts.gstatic.com paths), for
//                                     machines whose browser can't reach Google Fonts

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pw = await import(process.env.PLAYWRIGHT ?? 'playwright')
const { chromium } = pw.default ?? pw
const BASE = process.env.BASE ?? 'http://localhost:4173'
const OUT = fileURLToPath(new URL('../public/', import.meta.url))
const FONTS = process.env.FONT_CACHE

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})

async function open(url, viewport) {
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1 })).newPage()
  if (FONTS) {
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: readFileSync(path.join(FONTS, 'fonts.css'), 'utf8') }))
    await page.route('https://fonts.gstatic.com/**', r => r.fulfill({ contentType: 'font/woff2', path: path.join(FONTS, new URL(r.request().url()).pathname) }))
  }
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(BASE + url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const loaded = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').length)
  if (!loaded) console.warn(`  ! ${url}: no web fonts loaded, the system fallback font is used (see FONT_CACHE)`)
  if (errors.length) throw new Error(`${url}: ${errors.join(' | ')}`)
  return page
}

// The PDF: the page's print styles (a dark cover, then light A4 pages).
{
  const page = await open('/whitepaper', { width: 1200, height: 900 })
  await page.emulateMedia({ media: 'print' })
  // Page numbers come from the page's own @page margin boxes (whitepaper.css),
  // which leave the full-bleed cover alone.
  await page.pdf({ path: path.join(OUT, 'arcdex-whitepaper.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true })
  console.log('  ✓ public/arcdex-whitepaper.pdf')
}

// The X images.
for (const [card, width, height, file] of [['cover', 1600, 900, 'arcdex-whitepaper-x.png'], ['roadmap', 1080, 1350, 'arcdex-roadmap-x.png']]) {
  const page = await open(`/whitepaper?card=${card}`, { width, height })
  await page.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width, height } })
  console.log(`  ✓ public/${file} (${width}×${height})`)
}

await browser.close()
