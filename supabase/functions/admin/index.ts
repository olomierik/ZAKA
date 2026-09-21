// Edge Function: admin — management API (users, transactions, retry, stats)
// Protected by ZAKA_ADMIN_SECRET header
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encryptEntitySecret } from '../_shared/circle.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
}

const CIRCLE_BASE = 'https://api.circle.com/v1/w3s'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // ── Admin auth: shared secret header ────────────────────────────────────────
  const adminSecret = Deno.env.get('ZAKA_ADMIN_SECRET') ?? ''
  const provided    = req.headers.get('x-admin-secret') ?? ''
  if (!adminSecret || provided !== adminSecret) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const url = new URL(req.url)
  const action = url.searchParams.get('action') ?? ''

  try {
    // ── GET /admin?action=stats ────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'stats') {
      const [usersRes, txRes, feeRes] = await Promise.all([
        supabase.from('users').select('id', { count: 'exact', head: true }),
        supabase.from('transactions').select('id', { count: 'exact', head: true }),
        supabase.from('transactions').select('platformFee').not('platformFee', 'is', null),
      ])
      const totalFees = (feeRes.data ?? []).reduce(
        (sum: number, r: { platformFee?: string }) => sum + parseFloat(r.platformFee ?? '0'), 0
      )
      return Response.json({
        totalUsers: usersRes.count ?? 0,
        totalTransactions: txRes.count ?? 0,
        totalFeesCollected: totalFees.toFixed(4),
      }, { headers: corsHeaders })
    }

    // ── GET /admin?action=users&page=0&q=search ───────────────────────────────
    if (req.method === 'GET' && action === 'users') {
      const page = parseInt(url.searchParams.get('page') ?? '0')
      const q    = url.searchParams.get('q') ?? ''
      const PAGE = 25
      let query = supabase.from('users').select('*').order('createdAt', { ascending: false })
        .range(page * PAGE, (page + 1) * PAGE - 1)
      if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`)
      const { data, error } = await query
      if (error) return Response.json({ error: error.message }, { status: 500, headers: corsHeaders })
      return Response.json({ users: data }, { headers: corsHeaders })
    }

    // ── GET /admin?action=transactions&page=0&userId=&status= ─────────────────
    if (req.method === 'GET' && action === 'transactions') {
      const page   = parseInt(url.searchParams.get('page') ?? '0')
      const userId = url.searchParams.get('userId') ?? ''
      const status = url.searchParams.get('status') ?? ''
      const PAGE   = 50
      let query = supabase.from('transactions').select('*').order('createdAt', { ascending: false })
        .range(page * PAGE, (page + 1) * PAGE - 1)
      if (userId) query = query.eq('userId', userId)
      if (status) query = query.eq('status', status)
      const { data, error } = await query
      if (error) return Response.json({ error: error.message }, { status: 500, headers: corsHeaders })
      return Response.json({ transactions: data }, { headers: corsHeaders })
    }

    // ── GET /admin?action=tx&id=circleTxId ────────────────────────────────────
    if (req.method === 'GET' && action === 'tx') {
      const txId  = url.searchParams.get('id') ?? ''
      const apiKey = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''
      if (!txId) return Response.json({ error: 'id required' }, { status: 400, headers: corsHeaders })
      const res  = await fetch(`${CIRCLE_BASE}/transactions/${txId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const data = await res.json()
      return Response.json(data, { headers: corsHeaders })
    }

    // ── POST /admin?action=suspend ────────────────────────────────────────────
    if (req.method === 'POST' && action === 'suspend') {
      const { userId, reason } = await req.json() as { userId: string; reason?: string }
      await supabase.from('users').update({ suspended: true, suspendReason: reason ?? '' }).eq('id', userId)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    // ── POST /admin?action=unsuspend ──────────────────────────────────────────
    if (req.method === 'POST' && action === 'unsuspend') {
      const { userId } = await req.json() as { userId: string }
      await supabase.from('users').update({ suspended: false, suspendReason: '' }).eq('id', userId)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    // ── POST /admin?action=set-tier ───────────────────────────────────────────
    // Tier 1: $50,000/mo (phone only)
    // Tier 2: $100,000/mo (phone + ID verified)
    // Tier 3: Unlimited (KYB / business)
    if (req.method === 'POST' && action === 'set-tier') {
      const { userId, tier } = await req.json() as { userId: string; tier: number }
      if (![1, 2, 3].includes(tier)) return Response.json({ error: 'tier must be 1, 2, or 3' }, { status: 400, headers: corsHeaders })
      await supabase.from('users').update({ kycTier: tier }).eq('id', userId)
      return Response.json({ ok: true, tier }, { headers: corsHeaders })
    }

    // ── POST /admin?action=retry ──────────────────────────────────────────────
    // Retry a failed transaction by re-submitting to Circle
    if (req.method === 'POST' && action === 'retry') {
      const { txRecordId } = await req.json() as { txRecordId: string }
      const { data: txRecord } = await supabase.from('transactions').select('*').eq('id', txRecordId).single()
      if (!txRecord) return Response.json({ error: 'Transaction not found' }, { status: 404, headers: corsHeaders })

      const { data: sender } = await supabase.from('users').select('*').eq('id', txRecord.userId).single()
      if (!sender) return Response.json({ error: 'Sender not found' }, { status: 404, headers: corsHeaders })

      const apiKey      = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''
      const entitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET') ?? ''

      // Get the token ID from wallet balances
      const balRes = await fetch(`${CIRCLE_BASE}/wallets/${sender.walletId}/balances`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const balData = await balRes.json() as {
        data?: { tokenBalances?: Array<{ token?: { id?: string; symbol?: string; isNative?: boolean }; amount?: string }> }
      }
      const usdcToken = (balData?.data?.tokenBalances ?? []).find(
        (b) => b.token?.symbol?.toUpperCase() === 'USDC' && !b.token?.isNative && b.token?.id
      )
      if (!usdcToken?.token?.id) return Response.json({ error: 'No USDC to retry with' }, { status: 400, headers: corsHeaders })

      const ciphertext = await encryptEntitySecret(entitySecret, apiKey)
      const retryRes = await fetch(`${CIRCLE_BASE}/developer/transactions/transfer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          walletId: sender.walletId,
          tokenId: usdcToken.token.id,
          destinationAddress: txRecord.counterpartyPhone?.startsWith('0x') ? txRecord.counterpartyPhone : undefined,
          amounts: [txRecord.amount],
          feeLevel: 'MEDIUM',
          entitySecretCiphertext: ciphertext,
        }),
      })
      const retryData = await retryRes.json() as { data?: { id?: string }; message?: string }
      if (!retryData?.data?.id) {
        return Response.json({ error: retryData.message ?? 'Retry failed' }, { status: 500, headers: corsHeaders })
      }
      // Update record with new circleTxId and reset status
      await supabase.from('transactions').update({
        circleTxId: retryData.data.id,
        status: 'pending',
        retryAt: new Date().toISOString(),
      }).eq('id', txRecordId)

      return Response.json({ ok: true, newTxId: retryData.data.id }, { headers: corsHeaders })
    }

    // ── POST /admin?action=resolve ────────────────────────────────────────────
    // Manually mark a transaction as resolved (dispute cleared)
    if (req.method === 'POST' && action === 'resolve') {
      const { txRecordId, note } = await req.json() as { txRecordId: string; note?: string }
      await supabase.from('transactions').update({
        status: 'complete',
        adminNote: note ?? 'Manually resolved by admin',
        resolvedAt: new Date().toISOString(),
      }).eq('id', txRecordId)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    return Response.json({ error: 'Unknown action' }, { status: 400, headers: corsHeaders })

  } catch (e) {
    console.error('[admin]', e)
    return Response.json({ error: e instanceof Error ? e.message : 'Admin error' }, { status: 500, headers: corsHeaders })
  }
})
