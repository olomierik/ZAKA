// Edge Function: get-transactions
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

    const { data, error: dbErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('userId', user.id)
      .order('createdAt', { ascending: false })
      .limit(100)

    if (dbErr) return Response.json({ error: dbErr.message }, { status: 500, headers: CORS })
    return Response.json({ transactions: data ?? [] }, { headers: CORS })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500, headers: CORS })
  }
})
