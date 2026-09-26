// Server-only Supabase access for ARCDEX's writes (the leading underscore
// keeps Vercel from deploying this file as its own function).
//
// Browsers only ever READ the arcdex_* tables (public-read RLS, anon key).
// Every write goes through a Vercel function that uses the project's
// secret key, set by the owner in Vercel → project `app` → env:
//   SUPABASE_SECRET_KEY   (new-style "sb_secret_…" key)
//   or SUPABASE_SERVICE_ROLE_KEY (legacy JWT-style key)
// Until one is set, write endpoints answer 503 and the UI says so.

declare const process: { env: Record<string, string | undefined> }

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

export const adminReady = Boolean(URL && KEY)

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY!, 'Content-Type': 'application/json', ...extra }
  // New-style secret keys aren't JWTs and go in `apikey` only; legacy
  // service-role keys are JWTs and are also sent as the bearer token.
  if (!KEY!.startsWith('sb_')) h.Authorization = `Bearer ${KEY}`
  return h
}

export class DbError extends Error {
  constructor(public status: number, public body: string) { super(`supabase ${status}: ${body.slice(0, 300)}`) }
}

/** PostgREST request against /rest/v1/<path>. */
export async function db<T = unknown>(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<T> {
  if (!adminReady) throw new DbError(503, 'Supabase secret key not configured')
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: headers(init.prefer ? { Prefer: init.prefer } : {}),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  if (!res.ok) throw new DbError(res.status, text)
  return (text ? JSON.parse(text) : null) as T
}

/** Insert rows, skipping any whose primary key already exists. */
export function insertIgnore(table: string, rows: unknown[]) {
  if (rows.length === 0) return Promise.resolve(null)
  return db(table, { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates,return=minimal' })
}

/** Insert-or-update rows on their primary key (or `onConflict` columns). */
export function upsert(table: string, rows: unknown[], onConflict?: string) {
  const q = onConflict ? `${table}?on_conflict=${onConflict}` : table
  return db(q, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=representation' })
}

export function json(status: number, body: unknown, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  })
}

/** Last good copy of an upstream response (v4 `arcdex_kv`). Null when
 * missing — or when the table doesn't exist yet, so callers just skip it. */
export async function kvGet<T>(key: string): Promise<{ value: T; age: number } | null> {
  if (!adminReady) return null
  try {
    const r = await db<{ value: T; updated_at: string }[]>(`arcdex_kv?key=eq.${encodeURIComponent(key)}&select=value,updated_at`)
    return r.length ? { value: r[0].value, age: Date.now() - Date.parse(r[0].updated_at) } : null
  } catch {
    return null
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (!adminReady) return
  try {
    await db('arcdex_kv?on_conflict=key', { method: 'POST', body: [{ key, value, updated_at: new Date().toISOString() }], prefer: 'resolution=merge-duplicates,return=minimal' })
  } catch { /* cache only */ }
}

// ── Storage (public buckets, written server-side only) ────────────────

const readyBuckets = new Set<string>()

/** Creates the bucket if it doesn't exist yet (public read, size and type limits). */
export async function ensureBucket(id: string, opts: { fileSizeLimit: number; mimeTypes: string[] }): Promise<void> {
  if (readyBuckets.has(id)) return
  if (!adminReady) throw new DbError(503, 'Supabase secret key not configured')
  const res = await fetch(`${URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ id, name: id, public: true, file_size_limit: opts.fileSizeLimit, allowed_mime_types: opts.mimeTypes }),
  })
  const text = await res.text()
  if (!res.ok && !/already exists|Duplicate/i.test(text)) throw new DbError(res.status, text)
  readyBuckets.add(id)
}

/** Stores one object and returns its public URL. */
export async function storageUpload(bucket: string, path: string, body: ArrayBuffer | string, contentType: string): Promise<string> {
  if (!adminReady) throw new DbError(503, 'Supabase secret key not configured')
  const res = await fetch(`${URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' },
    body,
  })
  if (!res.ok) throw new DbError(res.status, await res.text())
  return `${URL}/storage/v1/object/public/${bucket}/${path}`
}

/** True if the owner signed out of all devices after this token was
 * issued. Missing table (v3 migration not run yet) = never revoked. */
export async function sessionRevoked(me: string, iat: number): Promise<boolean> {
  try {
    const r = await db<{ revoked_before: string }[]>(`arcdex_session_revocations?address=eq.${me}&select=revoked_before`)
    // Whole seconds on both sides, so signing in again right after
    // revoking (same second) isn't rejected.
    return r.length > 0 && Math.floor(Date.parse(r[0].revoked_before) / 1000) > iat
  } catch {
    return false
  }
}
