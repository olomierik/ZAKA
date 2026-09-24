// ── Launchpad media upload (Supabase Storage) ──────────────────────────
// Token logo + metadata JSON (name/symbol/description/image/socials) for
// launchpad tokens. The contract only ever stores a `metadataURI` string
// (in the TokenLaunched event, not even contract state) — everything
// richer lives off-chain here, the same pattern every other launchpad
// uses for token images/socials.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const BUCKET = 'launchpad-media'

export function isMediaUploadConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY
}

function randomFilename(ext: string): string {
  const rand = crypto.randomUUID().replace(/-/g, '')
  return `${Date.now()}-${rand}.${ext}`
}

async function uploadObject(path: string, body: Blob, contentType: string): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Media upload not configured')
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
}

/** Uploads a token logo image, returns its public URL. */
export async function uploadTokenImage(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new Error('Image must be under 2MB')
  if (!file.type.startsWith('image/')) throw new Error('File must be an image')
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
  return uploadObject(`images/${randomFilename(ext)}`, file, file.type)
}

export interface TokenMetadata {
  name: string
  symbol: string
  description?: string
  image?: string
  website?: string
  twitter?: string
  telegram?: string
}

/** Uploads the token's metadata JSON, returns its public URL — this is
 * what goes on-chain as `metadataURI`. */
export async function uploadTokenMetadata(meta: TokenMetadata): Promise<string> {
  const blob = new Blob([JSON.stringify(meta)], { type: 'application/json' })
  return uploadObject(`metadata/${randomFilename('json')}`, blob, 'application/json')
}

/** Encodes the metadata directly into the URI itself — no storage bucket
 * needed at all. `fetch()` resolves `data:` URIs natively, so
 * `fetchTokenMetadata` reads this back exactly like a hosted file, with
 * no code path difference. Used when Supabase Storage isn't configured
 * (or its bucket hasn't been created yet), so a creator can still attach
 * an image/socials by pasting a direct image URL instead of uploading a
 * file — same on-chain shape (`metadataURI` string), the encoding is
 * just inline rather than hosted. */
export function buildInlineMetadataURI(meta: TokenMetadata): string {
  const json = JSON.stringify(meta)
  const base64 = btoa(unescape(encodeURIComponent(json))) // UTF-8 safe base64
  return `data:application/json;base64,${base64}`
}

const metadataCache = new Map<string, TokenMetadata | null>()

/** Fetches and caches a token's metadata JSON from its metadataURI. Never
 * throws — a broken/missing URI just means no image/socials to show. */
export async function fetchTokenMetadata(metadataURI: string): Promise<TokenMetadata | null> {
  if (!metadataURI) return null
  const cached = metadataCache.get(metadataURI)
  if (cached !== undefined) return cached
  try {
    const res = await fetch(metadataURI, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) { metadataCache.set(metadataURI, null); return null }
    const json = await res.json() as TokenMetadata
    metadataCache.set(metadataURI, json)
    return json
  } catch {
    metadataCache.set(metadataURI, null)
    return null
  }
}
