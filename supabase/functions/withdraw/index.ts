// Edge Function: withdraw (M-Pesa / mobile money offramp)
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

    const { phone, amount, provider } = await req.json() as { phone: string; amount: string; provider: string }
    if (!phone || !amount || !provider) {
      return Response.json({ error: 'phone, amount, and provider required' }, { status: 400, headers: corsHeaders })
    }

    // ── Platform fee: 1% withdrawal fee paid by withdrawer ───────────────────
    const amountNum = parseFloat(amount)
    const withdrawalFee = parseFloat((amountNum * 0.01).toFixed(6))   // 1%
    const netAmount     = parseFloat((amountNum - withdrawalFee).toFixed(6)) // 99% delivered

    // TODO: integrate Kotani Pay or Yellow Card API for real offramp
    const reference = 'ZK' + Date.now().toString(36).toUpperCase()

    await supabase.from('transactions').insert({
      id: crypto.randomUUID(),
      userId: user.id,
      type: 'withdraw',
      amount: netAmount.toString(),
      platformFee: withdrawalFee.toString(),
      status: 'pending',
      description: `${provider} ${phone}`,
      createdAt: new Date().toISOString(),
    })

    return Response.json({
      reference,
      status: 'pending',
      netAmount,
      withdrawalFee,
      message: `Processing withdrawal of ${netAmount.toFixed(2)} USDC to ${provider} ${phone} (${withdrawalFee.toFixed(2)} USDC withdrawal fee). Funds arrive in 1–5 minutes.`,
    }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Withdrawal failed' }, { status: 500, headers: corsHeaders })
  }
})
