// Edge Function: get-balance
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

    const { data: profile } = await supabase.from('users').select('walletId').eq('id', user.id).single()
    const walletId = (profile as { walletId: string } | null)?.walletId ?? ''

    const apiKey = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''

    if (apiKey && walletId && !walletId.startsWith('demo-')) {
      const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}/balances`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const data = await res.json() as { data?: { tokenBalances?: Array<{ token?: { symbol?: string }; amount?: string }> } }
      const usdc = data?.data?.tokenBalances?.find((b) => b.token?.symbol?.toUpperCase() === 'USDC')?.amount ?? '0'
      return Response.json({ usdc }, { headers: corsHeaders })
    }

    // Demo: sum from transactions
    const { data: txs } = await supabase.from('transactions').select('type,amount,status').eq('userId', user.id)
    let bal = 0
    for (const tx of (txs ?? []) as Array<{ type: string; amount: string; status: string }>) {
      if (tx.status !== 'complete') continue
      const a = parseFloat(tx.amount)
      if (tx.type === 'receive' || tx.type === 'deposit') bal += a
      if (tx.type === 'send' || tx.type === 'withdraw') bal -= a
    }
    return Response.json({ usdc: Math.max(0, bal).toFixed(6) }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500, headers: corsHeaders })
  }
})
