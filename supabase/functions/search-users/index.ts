// Edge Function: search-users — find ZAKA users by phone or name, or resolve a wallet address
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS })

    const { query, walletAddress } = await req.json() as { query?: string; walletAddress?: string }

    // Resolve a wallet address to a ZAKA user
    if (walletAddress) {
      const { data } = await supabase
        .from('users')
        .select('id, name, phone, walletAddress')
        .eq('walletAddress', walletAddress)
        .maybeSingle()
      return Response.json({ user: data ?? null }, { headers: CORS })
    }

    if (!query || query.length < 2) return Response.json({ users: [] }, { headers: CORS })

    const { data, error: dbErr } = await supabase
      .from('users')
      .select('name, phone, walletAddress')
      .neq('id', user.id)
      .or(`phone.ilike.%${query}%,name.ilike.%${query}%`)
      .limit(8)

    if (dbErr) return Response.json({ error: dbErr.message }, { status: 500, headers: CORS })
    return Response.json({ users: data ?? [] }, { headers: CORS })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500, headers: CORS })
  }
})
