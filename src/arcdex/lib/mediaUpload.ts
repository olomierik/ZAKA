// ── Launchpad media: logo + metadata JSON ─────────────────────────────
// A launchpad token's logo and metadata (name/symbol/description/image/
// socials). The contract only ever stores a `metadataURI` string (in the
// TokenLaunched event, not even contract state) — everything richer lives
// off-chain, the same pattern every other launchpad uses.
//
// Uploads go through /api/upload (signed-in wallets only; the server checks
// the file and stores it in Supabase Storage). If that's unavailable, the
// metadata is encoded straight into the URI instead (see below) and the
// creator can paste an image link.

import type { Trader } from './identity'

export interface TokenMetadata {
  name: string
  symbol: string
  description?: string
  image?: string
  website?: string
  twitter?: string
  telegram?: string
}

async function upload(trader: Trader, kind: 'image' | 'metadata', body: BodyInit, contentType: string): Promise<string> {
  const { authedRequest } = await import('../api/social')
  const r = await authedRequest<{ url?: string }>(trader, `/api/upload?kind=${kind}`, body, contentType)
  if (!r.url) throw new Error('Upload failed')
  return r.url
}

/** Uploads a token logo image (PNG/JPEG/GIF/WebP, under 2 MB), returns its public URL. */
export async function uploadTokenImage(trader: Trader, file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new Error('Image must be under 2MB')
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Use a PNG, JPEG, GIF or WebP image')
  return upload(trader, 'image', file, file.type)
}

/** Uploads the token's metadata JSON, returns its public URL — this is
 * what goes on-chain as `metadataURI`. */
export function uploadTokenMetadata(trader: Trader, meta: TokenMetadata): Promise<string> {
  return upload(trader, 'metadata', JSON.stringify(meta), 'application/json')
}

/** Encodes the metadata directly into the URI itself — no storage needed.
 * The launchpad index (and `fetch()`) read `data:` URIs like a hosted file,
 * so this is the fallback when an upload isn't possible: same on-chain
 * shape (`metadataURI` string), just inline rather than hosted. */
export function buildInlineMetadataURI(meta: TokenMetadata): string {
  const json = JSON.stringify(meta)
  const base64 = btoa(unescape(encodeURIComponent(json))) // UTF-8 safe base64
  return `data:application/json;base64,${base64}`
}
