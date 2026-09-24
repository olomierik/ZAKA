// POST /api/social  (Authorization: Bearer <session token>)
//   { action: 'profile', username?, display_name?, avatar_url?, bio?, x_handle? }
//   { action: 'follow' | 'unfollow', target }
//   { action: 'thesis', token, body, position_usd? }
//   { action: 'thesis.delete', id }
//   { action: 'like' | 'unlike', thesis_id }
//   { action: 'clan.create', slug, name, motto?, avatar_url?, banner_url? }
//   { action: 'clan.join', clan_id } | { action: 'clan.leave' }
//   { action: 'clan.update', name?, motto?, avatar_url?, banner_url? }   (owner)
//   { action: 'transfer.note', tx_hash, note }  (only for your own USDC transfer)
//
// Every write is on behalf of the address the session token was issued to
// — the body can never name someone else as the actor. Reads don't come
// through here; browsers read the public tables directly.

import { createPublicClient, http, isAddress, parseAbiItem, decodeEventLog, type Hex } from 'viem'
import { bearer, verifyToken } from './_session'
import { adminReady, db, DbError, insertIgnore, json, upsert } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

const THESES_PER_DAY = 20
const USDC = '0x3600000000000000000000000000000000000000'
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const chain = createPublicClient({ transport: http('https://rpc.mainnet.arc.io', { retryCount: 2 }) })
const httpsUrl = (v: string) => /^https:\/\/\S+$/.test(v) && v.length <= 500

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
      case 'clan.create': {
        const mine = await db<{ clan_id: string }[]>(`arcdex_clan_members?member=eq.${me}&select=clan_id`)
        if (mine.length) return json(409, { error: 'Leave your current clan first' })
        const slug = str(b.slug)?.toLowerCase()
        const name = str(b.name)
        if (!slug || !/^[a-z0-9-]{3,32}$/.test(slug)) return json(400, { error: 'Clan link: 3–32 of a–z, 0–9, -' })
        if (!name || name.length < 2 || name.length > 40) return json(400, { error: 'Clan name: 2–40 characters' })
        const motto = str(b.motto) || null, avatar = str(b.avatar_url) || null, banner = str(b.banner_url) || null
        if (motto && motto.length > 120) return json(400, { error: 'Motto is at most 120 characters' })
        if ((avatar && !httpsUrl(avatar)) || (banner && !httpsUrl(banner))) return json(400, { error: 'Images must be https:// links' })
        const rows = await db<{ id: string }[]>('arcdex_clans', { method: 'POST', body: [{ slug, name, motto, avatar_url: avatar, banner_url: banner, owner: me }], prefer: 'return=representation' })
        await db('arcdex_clan_members', { method: 'POST', body: [{ member: me, clan_id: rows[0].id, role: 'owner' }], prefer: 'return=minimal' })
        return json(200, { clan: rows[0] })
      }
      case 'clan.join': {
        const id = str(b.clan_id)
        if (!id || !/^[0-9a-f-]{36}$/.test(id)) return json(400, { error: 'Bad clan' })
        const mine = await db<{ clan_id: string }[]>(`arcdex_clan_members?member=eq.${me}&select=clan_id`)
        if (mine.length) return json(409, { error: mine[0].clan_id === id ? 'You are already in this clan' : 'Leave your current clan first' })
        await db('arcdex_clan_members', { method: 'POST', body: [{ member: me, clan_id: id, role: 'member' }], prefer: 'return=minimal' })
        return json(200, { ok: true })
      }
      case 'clan.leave': {
        const mine = await db<{ clan_id: string; role: string }[]>(`arcdex_clan_members?member=eq.${me}&select=clan_id,role`)
        if (!mine.length) return json(200, { ok: true })
        const { clan_id, role } = mine[0]
        await db(`arcdex_clan_members?member=eq.${me}`, { method: 'DELETE' })
        if (role === 'owner') {
          // Hand the clan to its longest-standing member, or close it if empty.
          const next = await db<{ member: string }[]>(`arcdex_clan_members?clan_id=eq.${clan_id}&select=member&order=joined_at.asc&limit=1`)
          if (next.length) {
            await db(`arcdex_clan_members?member=eq.${next[0].member}`, { method: 'PATCH', body: { role: 'owner' } })
            await db(`arcdex_clans?id=eq.${clan_id}`, { method: 'PATCH', body: { owner: next[0].member } })
          } else {
            await db(`arcdex_clans?id=eq.${clan_id}`, { method: 'DELETE' })
          }
        }
        return json(200, { ok: true })
      }
      case 'clan.update': {
        const mine = await db<{ clan_id: string; role: string }[]>(`arcdex_clan_members?member=eq.${me}&select=clan_id,role`)
        if (!mine.length || mine[0].role !== 'owner') return json(403, { error: 'Only the clan owner can edit it' })
        const patch: Record<string, unknown> = {}
        const name = str(b.name), motto = str(b.motto), avatar = str(b.avatar_url), banner = str(b.banner_url)
        if (name !== undefined) { if (name.length < 2 || name.length > 40) return json(400, { error: 'Clan name: 2–40 characters' }); patch.name = name }
        if (motto !== undefined) { if (motto.length > 120) return json(400, { error: 'Motto is at most 120 characters' }); patch.motto = motto || null }
        if (avatar !== undefined) { if (avatar && !httpsUrl(avatar)) return json(400, { error: 'Images must be https:// links' }); patch.avatar_url = avatar || null }
        if (banner !== undefined) { if (banner && !httpsUrl(banner)) return json(400, { error: 'Images must be https:// links' }); patch.banner_url = banner || null }
        await db(`arcdex_clans?id=eq.${mine[0].clan_id}`, { method: 'PATCH', body: patch })
        return json(200, { ok: true })
      }
      case 'transfer.note': {
        const hash = str(b.tx_hash)
        const note = str(b.note) ?? ''
        if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return json(400, { error: 'Bad transaction' })
        if (note.length > 200) return json(400, { error: 'Note is at most 200 characters' })
        // Only the sender of a real on-chain USDC transfer can attach a note to it.
        const rc = await chain.getTransactionReceipt({ hash: hash as Hex }).catch(() => null)
        if (!rc || rc.status !== 'success') return json(400, { error: 'Transaction not found or failed' })
        const t = rc.logs
          .filter(l => l.address.toLowerCase() === USDC)
          .map(l => { try { return decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics }) } catch { return null } })
          .find(e => e && (e.args as { from: string }).from.toLowerCase() === me)
        if (!t) return json(403, { error: 'That transaction is not a USDC transfer from your wallet' })
        const { to, value } = t.args as { to: string; value: bigint }
        await insertIgnore('arcdex_transfer_notes', [{ tx_hash: hash.toLowerCase(), sender: me, recipient: to.toLowerCase(), amount: (Number(value) / 1e6).toFixed(6), note: note || null }])
        return json(200, { ok: true })
      }
      default:
        return json(400, { error: 'Unknown action' })
    }
  } catch (e) {
    if (e instanceof DbError) {
      if (e.status === 409 || e.body.includes('23505')) return json(409, { error: b.action === 'clan.create' ? 'That clan link is taken' : 'That username is taken' })
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
  set('banner_url', str(b.banner_url), s => /^https:\/\/\S+$/.test(s) && s.length <= 500)
  const rows = await upsert('arcdex_profiles', [row], 'address')
  return { profile: (rows as unknown[])[0] }
}
