// The tiny PostgREST client must answer exactly like supabase-js did.
//   bun scripts/test-postgrest.ts   (reads VITE_SUPABASE_URL / _ANON_KEY from .env)
import { createClient } from '@supabase/supabase-js'
import { createPostgrest } from '../src/arcdex/lib/postgrest'

const URL = process.env.VITE_SUPABASE_URL!, KEY = process.env.VITE_SUPABASE_ANON_KEY!
if (!URL || !KEY) { console.log('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
const pg = createPostgrest(URL, KEY)

let fails = 0
const same = (a: unknown, b: unknown, msg: string) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? '  ✓' : '  ✗', msg, ok ? '' : `\n     supabase-js: ${JSON.stringify(b).slice(0, 200)}\n     postgrest:   ${JSON.stringify(a).slice(0, 200)}`)
}

const profs = await sb.from('arcdex_profiles').select('*').order('created_at', { ascending: false }).limit(5)
same((await pg.from('arcdex_profiles').select('*').order('created_at', { ascending: false }).limit(5)).data, profs.data, 'select + order + limit')
const addrs = (profs.data ?? []).map(p => p.address as string).concat(['0x' + '0'.repeat(40)])
same((await pg.from('arcdex_profiles').select('*').in('address', addrs)).data, (await sb.from('arcdex_profiles').select('*').in('address', addrs)).data, 'in(…)')
const a = addrs[0] ?? '0x' + '1'.repeat(40)
same((await pg.from('arcdex_follows').select('*', { count: 'exact', head: true }).eq('following', a)).count,
  (await sb.from('arcdex_follows').select('*', { count: 'exact', head: true }).eq('following', a)).count, 'head count')
const u = (profs.data ?? []).find(p => p.username)?.username ?? 'nobody_here'
same((await pg.from('arcdex_profiles').select('*').eq('username', u).maybeSingle()).data,
  (await sb.from('arcdex_profiles').select('*').eq('username', u).maybeSingle()).data, 'maybeSingle (hit)')
same((await pg.from('arcdex_profiles').select('*').eq('username', 'zz_no_such_user_zz').maybeSingle()).data, null, 'maybeSingle (miss) → null')
same((await pg.from('arcdex_profiles').select('*').ilike('username', `${u.slice(0, 2)}%`).limit(8)).data,
  (await sb.from('arcdex_profiles').select('*').ilike('username', `${u.slice(0, 2)}%`).limit(8)).data, 'ilike prefix')
same((await pg.from('arcdex_transfer_notes').select('*').or(`sender.eq.${a},recipient.eq.${a}`).order('created_at', { ascending: false }).limit(5)).data,
  (await sb.from('arcdex_transfer_notes').select('*').or(`sender.eq.${a},recipient.eq.${a}`).order('created_at', { ascending: false }).limit(5)).data, 'or(…)')
same((await pg.from('arcdex_clan_members').select('role, arcdex_clans(*)').eq('member', a).maybeSingle()).data,
  (await sb.from('arcdex_clan_members').select('role, arcdex_clans(*)').eq('member', a).maybeSingle()).data, 'embedded resource')
same((await pg.rpc('arcdex_fee_stats', {})).data, (await sb.rpc('arcdex_fee_stats', {})).data, 'rpc')
same((await pg.rpc('arcdex_leaderboard', { p_since: new Date(Date.now() - 30 * 864e5).toISOString(), p_limit: 5 })).data,
  (await sb.rpc('arcdex_leaderboard', { p_since: new Date(Date.now() - 30 * 864e5).toISOString(), p_limit: 5 })).data, 'rpc with args')
const missing = await pg.from('arcdex_no_such_table').select('*').limit(1)
same([missing.data, !!missing.error], [null, true], 'missing table → error, null data')

if (fails) { console.log(`${fails} failed`); process.exit(1) }
console.log('postgrest client matches supabase-js')
