// Edge Function: send-usdc — transfers USDC between ZAKA users via Circle developer wallets
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encryptEntitySecret } from '../_shared/circle.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CIRCLE_BASE = 'https://api.circle.com/v1/w3s'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })

    const { toPhone, amount, note } = await req.json() as { toPhone: string; amount: string; note?: string }
    if (!toPhone || !amount) return Response.json({ error: 'toPhone and amount required' }, { status: 400, headers: corsHeaders })

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
      // Get USDC token address from sender wallet
      const balRes = await fetch(`${CIRCLE_BASE}/wallets/${senderProfile.walletId}/balances`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const balData = await balRes.json() as { data?: { tokenBalances?: Array<{ token?: { symbol?: string; tokenAddress?: string; isNative?: boolean }; amount?: string }> } }
      const balances = balData?.data?.tokenBalances ?? []

      // Arc Testnet exposes USDC as both a native token (no tokenAddress) and an ERC-20.
      // Transfers require a tokenAddress, so always prefer the ERC-20 entry.
      const usdcToken = balances.find(
        (b) => b.token?.symbol?.toUpperCase() === 'USDC' && b.token?.tokenAddress && !b.token?.isNative
      ) ?? balances.find(
        (b) => b.token?.symbol?.toUpperCase() === 'USDC' && b.token?.tokenAddress
      )

      if (!usdcToken) {
        return Response.json({ error: 'No USDC in wallet. Please deposit first.' }, { status: 400, headers: corsHeaders })
      }
      if (parseFloat(usdcToken.amount ?? '0') <= 0) {
        return Response.json({ error: 'Insufficient USDC balance. Please deposit first.' }, { status: 400, headers: corsHeaders })
      }

      // Encrypt entity secret fresh for this request
      const ciphertext = await encryptEntitySecret(entitySecret, apiKey)

      const txRes = await fetch(`${CIRCLE_BASE}/developer/transactions/transfer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          walletId: senderProfile.walletId,
          tokenAddress: usdcToken.token.tokenAddress,
          destinationAddress: recipientProfile.walletAddress,
          amounts: [amount],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          entitySecretCiphertext: ciphertext,
        }),
      })
      const txData = await txRes.json() as { data?: { id?: string }; message?: string }
      if (!txData?.data?.id) {
        console.error('[send-usdc] Circle tx error:', JSON.stringify(txData))
        return Response.json({ error: txData.message ?? 'Transfer initiation failed' }, { status: 500, headers: corsHeaders })
      }
      circleTxId = txData.data.id

      // Poll briefly for a terminal state (up to 20s)
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const statusRes = await fetch(`${CIRCLE_BASE}/transactions/${circleTxId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        const statusData = await statusRes.json() as { data?: { transaction?: { state?: string; txHash?: string } } }
        const state = statusData?.data?.transaction?.state ?? ''
        txHash = statusData?.data?.transaction?.txHash ?? undefined
        if (['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'].includes(state)) break
      }
    }

    const now = new Date().toISOString()
    await supabase.from('transactions').insert([
      { id: crypto.randomUUID(), userId: user.id, type: 'send', amount, status: 'complete', counterparty: recipientProfile.name, counterpartyPhone: toPhone, txHash, circleTxId, description: note, createdAt: now },
      { id: crypto.randomUUID(), userId: recipientProfile.id, type: 'receive', amount, status: 'complete', counterparty: senderProfile?.name, counterpartyPhone: senderProfile?.phone, txHash, circleTxId, description: note, createdAt: now },
    ])

    return Response.json({ txId: circleTxId, status: 'complete' }, { headers: corsHeaders })

  } catch (e) {
    console.error('[send-usdc]', e)
    return Response.json({ error: e instanceof Error ? e.message : 'Transfer failed' }, { status: 500, headers: corsHeaders })
  }
})
