// Edge Function: send-usdc
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

    const { toPhone, amount, note } = await req.json() as { toPhone: string; amount: string; note?: string }
    if (!toPhone || !amount) return Response.json({ error: 'toPhone and amount required' }, { status: 400, headers: corsHeaders })

    // Get sender + recipient profiles
    const { data: sender } = await supabase.from('users').select('*').eq('id', user.id).single()
    const { data: recipient } = await supabase.from('users').select('*').eq('phone', toPhone).maybeSingle()
    if (!recipient) return Response.json({ error: 'Recipient not found on ZAKA' }, { status: 404, headers: corsHeaders })

    const senderProfile = sender as { walletId: string; name: string; phone: string; walletAddress: string } | null
    const recipientProfile = recipient as { id: string; walletId: string; name: string; phone: string; walletAddress: string }

    const apiKey = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''
    const entitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET') ?? ''
    let circleTxId = 'demo-' + crypto.randomUUID()
    let txHash: string | undefined

    if (apiKey && entitySecret && senderProfile && !senderProfile.walletId.startsWith('demo-')) {
      // Get USDC token address
      const balRes = await fetch(`https://api.circle.com/v1/w3s/wallets/${senderProfile.walletId}/balances`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const balData = await balRes.json() as { data?: { tokenBalances?: Array<{ token?: { symbol?: string; tokenAddress?: string }; amount?: string }> } }
      const usdcToken = balData?.data?.tokenBalances?.find((b) => b.token?.symbol?.toUpperCase() === 'USDC')
      if (!usdcToken?.token?.tokenAddress) {
        return Response.json({ error: 'No USDC in wallet. Please deposit first.' }, { status: 400, headers: corsHeaders })
      }

      const txRes = await fetch('https://api.circle.com/v1/w3s/developer/transactions/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletId: senderProfile.walletId,
          tokenAddress: usdcToken.token.tokenAddress,
          destinationAddress: recipientProfile.walletAddress,
          amounts: [amount],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          entitySecretCiphertext: entitySecret,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      const txData = await txRes.json() as { data?: { id?: string } }
      circleTxId = txData?.data?.id ?? circleTxId
    }

    const now = new Date().toISOString()
    await supabase.from('transactions').insert([
      { id: crypto.randomUUID(), userId: user.id, type: 'send', amount, status: 'complete', counterparty: recipientProfile.name, counterpartyPhone: toPhone, txHash, circleTxId, description: note, createdAt: now },
      { id: crypto.randomUUID(), userId: recipientProfile.id, type: 'receive', amount, status: 'complete', counterparty: senderProfile?.name, counterpartyPhone: senderProfile?.phone, txHash, circleTxId, description: note, createdAt: now },
    ])

    return Response.json({ txId: circleTxId, status: 'complete' }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Transfer failed' }, { status: 500, headers: corsHeaders })
  }
})
