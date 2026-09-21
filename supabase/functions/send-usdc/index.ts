// Edge Function: send-usdc — transfers USDC between ZAKA users or to any wallet address
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

    // Accept toPhone (ZAKA user) OR toAddress (any 0x wallet) OR both
    const { toPhone, toAddress, amount, note } = await req.json() as {
      toPhone?: string
      toAddress?: string
      amount: string
      note?: string
    }
    if (!amount) return Response.json({ error: 'amount required' }, { status: 400, headers: corsHeaders })
    if (!toPhone && !toAddress) return Response.json({ error: 'toPhone or toAddress required' }, { status: 400, headers: corsHeaders })

    // ── resolve sender ────────────────────────────────────────────────────────
    const { data: sender } = await supabase.from('users').select('*').eq('id', user.id).single()
    const senderProfile = sender as { walletId: string; name: string; phone: string; walletAddress: string } | null

    // ── resolve recipient ─────────────────────────────────────────────────────
    let destinationAddress: string
    let recipientProfile: { id: string; walletId: string; name: string; phone: string; walletAddress: string } | null = null
    let recipientCounterparty = 'External Wallet'
    let recipientPhone: string | undefined

    if (toAddress && /^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
      // Direct wallet address — check if it belongs to a ZAKA user first
      const { data: zakaUser } = await supabase
        .from('users')
        .select('*')
        .eq('walletAddress', toAddress)
        .maybeSingle()
      if (zakaUser) {
        recipientProfile = zakaUser as typeof recipientProfile
        recipientCounterparty = recipientProfile!.name
        recipientPhone = recipientProfile!.phone
      }
      destinationAddress = toAddress
    } else if (toPhone) {
      // Phone number — must be a ZAKA user
      const { data: zakaUser } = await supabase.from('users').select('*').eq('phone', toPhone).maybeSingle()
      if (!zakaUser) return Response.json({ error: 'Recipient not found on ZAKA. Ask them to register first.' }, { status: 404, headers: corsHeaders })
      recipientProfile = zakaUser as typeof recipientProfile
      recipientCounterparty = recipientProfile!.name
      recipientPhone = toPhone
      destinationAddress = recipientProfile!.walletAddress
    } else {
      return Response.json({ error: 'Invalid recipient. Provide a phone number or a valid 0x wallet address.' }, { status: 400, headers: corsHeaders })
    }

    // ── KYC tier limits (monthly volume) ─────────────────────────────────────
    // Tier 1 (phone only)      : $50,000 / month
    // Tier 2 (phone + ID)      : $100,000 / month
    // Tier 3 (KYB / business)  : unlimited
    const KYC_MONTHLY_LIMITS: Record<number, number> = { 1: 50_000, 2: 100_000, 3: Infinity }
    const senderTier: number = ((sender as Record<string,unknown>)?.kycTier as number) ?? 1
    const monthlyLimit = KYC_MONTHLY_LIMITS[senderTier] ?? 50_000

    // Sum all sends in the current calendar month
    const monthStart = new Date()
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const { data: monthlySends } = await supabase
      .from('transactions')
      .select('amount')
      .eq('userId', user.id)
      .eq('type', 'send')
      .gte('createdAt', monthStart.toISOString())
    const monthlyVolume = (monthlySends ?? []).reduce((s, t) => s + parseFloat((t as {amount:string}).amount), 0)
    const amountNum = parseFloat(amount)

    if (monthlyLimit !== Infinity && monthlyVolume + amountNum > monthlyLimit) {
      const remaining = Math.max(0, monthlyLimit - monthlyVolume)
      return Response.json({
        error: `Monthly send limit reached. Tier ${senderTier} allows $${monthlyLimit.toLocaleString()}/month. You have $${remaining.toFixed(2)} remaining this month. Upgrade your KYC tier for higher limits.`,
      }, { status: 403, headers: corsHeaders })
    }

    // ── Platform fee: 1% collected to ZAKA platform wallet ───────────────────
    const PLATFORM_WALLET = Deno.env.get('ZAKA_PLATFORM_WALLET_ADDRESS') ?? ''
    const platformFee = parseFloat((amountNum * 0.01).toFixed(6))   // 1%
    const sendAmount  = parseFloat((amountNum - platformFee).toFixed(6)) // 99% to recipient

    // ── Circle transfer ───────────────────────────────────────────────────────
    const apiKey = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''
    const entitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET') ?? ''
    let circleTxId = 'demo-' + crypto.randomUUID()
    let feeTxId: string | undefined
    let txHash: string | undefined

    if (apiKey && entitySecret && senderProfile && !senderProfile.walletId.startsWith('demo-')) {
      const balRes = await fetch(`${CIRCLE_BASE}/wallets/${senderProfile.walletId}/balances`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const balData = await balRes.json() as {
        data?: { tokenBalances?: Array<{ token?: { id?: string; symbol?: string; isNative?: boolean }; amount?: string }> }
      }
      const balances = balData?.data?.tokenBalances ?? []

      // Arc Testnet returns USDC twice (native + ERC-20). Prefer ERC-20 (non-native) for transfers.
      const usdcToken = balances.find(
        (b) => b.token?.symbol?.toUpperCase() === 'USDC' && !b.token?.isNative && b.token?.id
      ) ?? balances.find(
        (b) => b.token?.symbol?.toUpperCase() === 'USDC' && b.token?.id
      )

      if (!usdcToken?.token?.id) {
        return Response.json({ error: 'No USDC in wallet. Please deposit first.' }, { status: 400, headers: corsHeaders })
      }
      // Check balance covers full amount (send + fee) — gas paid by sender via feeLevel
      if (parseFloat(usdcToken.amount ?? '0') < amountNum) {
        return Response.json({
          error: `Insufficient balance. You have ${parseFloat(usdcToken.amount ?? '0').toFixed(2)} USDC (need ${amountNum.toFixed(2)} including 1% platform fee).`
        }, { status: 400, headers: corsHeaders })
      }

      const ciphertext = await encryptEntitySecret(entitySecret, apiKey)

      // ── 1: Send 99% to recipient ─────────────────────────────────────────
      const txRes = await fetch(`${CIRCLE_BASE}/developer/transactions/transfer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          walletId: senderProfile.walletId,
          tokenId: usdcToken.token.id,
          destinationAddress,
          amounts: [sendAmount.toString()],
          feeLevel: 'MEDIUM',   // gas paid by sender
          entitySecretCiphertext: ciphertext,
        }),
      })
      const txData = await txRes.json() as { data?: { id?: string }; message?: string; errors?: unknown[] }
      if (!txData?.data?.id) {
        console.error('[send-usdc] Circle tx error:', JSON.stringify(txData))
        return Response.json({ error: txData.message ?? 'Transfer initiation failed' }, { status: 500, headers: corsHeaders })
      }
      circleTxId = txData.data.id

      // ── 2: Send 1% platform fee to ZAKA platform wallet ─────────────────
      if (PLATFORM_WALLET && platformFee > 0) {
        const feeRes = await fetch(`${CIRCLE_BASE}/developer/transactions/transfer`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            walletId: senderProfile.walletId,
            tokenId: usdcToken.token.id,
            destinationAddress: PLATFORM_WALLET,
            amounts: [platformFee.toString()],
            feeLevel: 'MEDIUM',
            entitySecretCiphertext: await encryptEntitySecret(entitySecret, apiKey),
          }),
        })
        const feeData = await feeRes.json() as { data?: { id?: string } }
        feeTxId = feeData?.data?.id
      }

      // Poll up to 20s for main tx terminal state
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

    // ── record transactions ───────────────────────────────────────────────────
    const now = new Date().toISOString()
    const inserts: object[] = [
      {
        id: crypto.randomUUID(), userId: user.id, type: 'send',
        amount: sendAmount.toString(),
        platformFee: platformFee.toString(),
        feeTxId,
        status: 'complete',
        counterparty: recipientCounterparty,
        counterpartyPhone: recipientPhone ?? destinationAddress,
        txHash, circleTxId, description: note, createdAt: now,
      },
    ]
    // Only record a receive entry for ZAKA users (external wallets are unknown)
    if (recipientProfile?.id) {
      inserts.push({
        id: crypto.randomUUID(), userId: recipientProfile.id, type: 'receive',
        amount: sendAmount.toString(),
        platformFee: platformFee.toString(),
        status: 'complete',
        counterparty: senderProfile?.name ?? 'ZAKA User',
        counterpartyPhone: senderProfile?.phone,
        txHash, circleTxId, description: note, createdAt: now,
      })
    }
    await supabase.from('transactions').insert(inserts)

    return Response.json({
      txId: circleTxId,
      status: 'complete',
      recipient: recipientCounterparty,
      amountSent: sendAmount,
      platformFee,
      isZakaUser: !!recipientProfile,
    }, { headers: corsHeaders })

  } catch (e) {
    console.error('[send-usdc]', e)
    return Response.json({ error: e instanceof Error ? e.message : 'Transfer failed' }, { status: 500, headers: corsHeaders })
  }
})
