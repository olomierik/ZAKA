// Launchpad media: a coin's logo and its metadata JSON, in Supabase Storage
// (bucket `launchpad-media`, public read, created on first use).
//
//   POST /api/upload?kind=image      body: the image (PNG, JPEG, GIF or WebP, ≤ 2 MB)
//   POST /api/upload?kind=metadata   body: { name, symbol, description?, image?, website?, twitter?, telegram? }
//   → { url }   (Authorization: Bearer <session from /api/session>)
//
// Signed-in wallets only (the same session as /api/social), 30 uploads a
// day per wallet. An image's type is read from its bytes, not its name or
// Content-Type; SVG isn't accepted (it can carry scripts). Metadata is
// reduced to the fields ARCDEX shows, with https-only links.

import { bearer, verifySession } from './_session'
import { DbError, adminReady, ensureBucket, json, kvGet, kvSet, sessionRevoked, storageUpload } from './_supabaseAdmin'
import { cleanText, sanitizeMeta } from './_launchpadCore'

export const config = { runtime: 'edge' }

const BUCKET = 'launchpad-media'
const MAX_IMAGE = 2 * 1024 * 1024
const PER_DAY = 30
const IMAGE_TYPES: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { type: 'image/png', ext: 'png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { type: 'image/webp', ext: 'webp', test: b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
]

const name = (ext: string) => `${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}.${ext}`

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const kind = new URL(req.url).searchParams.get('kind')
  if (kind !== 'image' && kind !== 'metadata') return json(400, { error: 'kind must be image or metadata' })
  if (!adminReady) return json(503, { error: 'Uploads are not set up' })

  const session = await verifySession(bearer(req))
  if (!session) return json(401, { error: 'Sign in first' })
  const me = session.address
  if (await sessionRevoked(me, session.iat)) return json(401, { error: 'You signed out of all devices — sign in again' })

  // Per-wallet daily cap (best effort: a counter in arcdex_kv).
  const day = new Date().toISOString().slice(0, 10)
  const counterKey = `upload:${me}:${day}`
  const used = (await kvGet<number>(counterKey))?.value ?? 0
  if (used >= PER_DAY) return json(429, { error: `Upload limit reached (${PER_DAY} a day)` })

  try {
    await ensureBucket(BUCKET, { fileSizeLimit: MAX_IMAGE, mimeTypes: [...IMAGE_TYPES.map(t => t.type), 'application/json'] })
    let url: string
    if (kind === 'image') {
      const len = Number(req.headers.get('content-length') ?? 0)
      if (len > MAX_IMAGE) return json(413, { error: 'Image must be under 2 MB' })
      const buf = await req.arrayBuffer()
      if (buf.byteLength === 0) return json(400, { error: 'Empty file' })
      if (buf.byteLength > MAX_IMAGE) return json(413, { error: 'Image must be under 2 MB' })
      const t = IMAGE_TYPES.find(x => x.test(new Uint8Array(buf, 0, Math.min(12, buf.byteLength))))
      if (!t) return json(415, { error: 'Use a PNG, JPEG, GIF or WebP image' })
      url = await storageUpload(BUCKET, `images/${me}/${name(t.ext)}`, buf, t.type)
    } else {
      const raw = await req.text()
      if (raw.length > 20_000) return json(413, { error: 'Metadata too large' })
      let body: Record<string, unknown>
      try { body = JSON.parse(raw) as Record<string, unknown> } catch { return json(400, { error: 'Invalid JSON' }) }
      const coinName = typeof body.name === 'string' ? cleanText(body.name) : ''
      const symbol = typeof body.symbol === 'string' ? cleanText(body.symbol, 24) : ''
      if (!coinName || !symbol) return json(400, { error: 'Name and symbol are required' })
      const meta = { name: coinName, symbol, ...(sanitizeMeta(body) ?? {}) }
      url = await storageUpload(BUCKET, `metadata/${me}/${name('json')}`, JSON.stringify(meta), 'application/json')
    }
    await kvSet(counterKey, used + 1)
    return json(200, { url })
  } catch (e) {
    const detail = e instanceof DbError ? e.body : e instanceof Error ? e.message : 'error'
    return json(502, { error: `Upload failed: ${detail.slice(0, 160)}` })
  }
}
