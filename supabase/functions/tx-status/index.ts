// Edge Function: tx-status
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })

    const { txId } = await req.json() as { txId: string }
    const apiKey = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''

    if (apiKey && txId && !txId.startsWith('demo-')) {
      const res = await fetch(`https://api.circle.com/v1/w3s/transactions/${txId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const data = await res.json() as { data?: { transaction?: { state?: string; txHash?: string } } }
      return Response.json({
        status: data?.data?.transaction?.state ?? 'UNKNOWN',
        txHash: data?.data?.transaction?.txHash,
      }, { headers: corsHeaders })
    }

    return Response.json({ status: 'COMPLETE' }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500, headers: corsHeaders })
  }
})
