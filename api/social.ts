// POST /api/social  (Authorization: Bearer <session token>)
//   { action: 'profile', username?, display_name?, avatar_url?, bio?, x_handle? }
//   { action: 'follow' | 'unfollow', target }
//   { action: 'thesis', token, body, position_usd? }
//   { action: 'thesis.delete', id }
//   { action: 'like' | 'unlike', thesis_id }
//
// Every write is on behalf of the address the session token was issued to
// — the body can never name someone else as the actor. Reads don't come
// through here; browsers read the public tables directly.

import { isAddress } from 'viem'
import { bearer, verifyToken } from './_session'
import { adminReady, db, DbError, insertIgnore, json, upsert } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

const THESES_PER_DAY = 20

type Body = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined)
const addr = (v: unknown) => {
  const s = str(v)
  return s && isAddress(s) ? s.toLowerCase() : null
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  if (!adminReady) return json(503, { error: 'Social features are not configured on the server yet' })
  const me = await verifyToken(bearer(req))
  if (!me) return json(401, { error: 'Sign in with your wallet first' })

  let b: Body
  try { b = await req.json() } catch { return json(400, { error: 'Bad JSON' }) }

  try {
    switch (b.action) {
      case 'profile': return json(200, await saveProfile(me, b))
      case 'follow': {
        const target = addr(b.target)
        if (!target || target === me) return json(400, { error: 'Bad target' })
        await insertIgnore('arcdex_follows', [{ follower: me, following: target }])
        return json(200, { ok: true })
      }
      case 'unfollow': {
        const target = addr(b.target)
        if (!target) return json(400, { error: 'Bad target' })
        await db(`arcdex_follows?follower=eq.${me}&following=eq.${target}`, { method: 'DELETE' })
        return json(200, { ok: true })
      }
      case 'thesis': {
        const token = addr(b.token)
        const body = str(b.body)
        if (!token || !body || body.length > 280) return json(400, { error: 'A thesis is 1–280 characters on a coin' })
        const since = new Date(Date.now() - 86_400_000).toISOString()
        const recent = await db<{ id: number }[]>(`arcdex_theses?select=id&author=eq.${me}&created_at=gte.${since}`)
        if (recent.length >= THESES_PER_DAY) return json(429, { error: `Limit is ${THESES_PER_DAY} theses a day` })
        const position = typeof b.position_usd === 'number' && Number.isFinite(b.position_usd) && b.position_usd >= 0 ? b.position_usd : null
        const rows = await db<unknown[]>('arcdex_theses', {
          method: 'POST',
          body: [{ author: me, token, body, position_usd: position }],
          prefer: 'return=representation',
        })
        return json(200, { thesis: rows[0] })
      }
      case 'thesis.delete': {
        const id = Number(b.id)
        if (!Number.isInteger(id)) return json(400, { error: 'Bad id' })
        await db(`arcdex_theses?id=eq.${id}&author=eq.${me}`, { method: 'DELETE' })
        return json(200, { ok: true })
      }
      case 'like':
      case 'unlike': {
        const id = Number(b.thesis_id)
        if (!Number.isInteger(id)) return json(400, { error: 'Bad thesis id' })
        if (b.action === 'like') await insertIgnore('arcdex_thesis_likes', [{ thesis_id: id, liker: me }])
        else await db(`arcdex_thesis_likes?thesis_id=eq.${id}&liker=eq.${me}`, { method: 'DELETE' })
        return json(200, { ok: true })
      }
      default:
        return json(400, { error: 'Unknown action' })
    }
  } catch (e) {
    if (e instanceof DbError) {
      if (e.status === 409 || e.body.includes('23505')) return json(409, { error: 'That username is taken' })
      if (e.body.includes('23514')) return json(400, { error: 'Some field has an invalid value' })
      if (e.body.includes('23503')) return json(404, { error: 'Not found' })
    }
    return json(500, { error: 'Something went wrong — try again' })
  }
}

async function saveProfile(me: string, b: Body) {
  const row: Record<string, unknown> = { address: me, updated_at: new Date().toISOString() }
  const set = (k: string, v: string | null | undefined, ok: (s: string) => boolean) => {
    if (v === undefined) return
    if (v === '' || v === null) { row[k] = null; return }
    if (!ok(v)) throw new DbError(400, `23514 invalid ${k}`)
    row[k] = v
  }
  const username = str(b.username)?.toLowerCase().replace(/^@/, '')
  set('username', username, s => /^[a-z0-9_]{3,20}$/.test(s))
  set('display_name', str(b.display_name), s => s.length <= 40)
  set('avatar_url', str(b.avatar_url), s => /^https:\/\/\S+$/.test(s) && s.length <= 500)
  set('bio', str(b.bio), s => s.length <= 160)
  set('x_handle', str(b.x_handle)?.replace(/^@/, ''), s => /^[A-Za-z0-9_]{1,15}$/.test(s))
  const rows = await upsert('arcdex_profiles', [row], 'address')
  return { profile: (rows as unknown[])[0] }
}
