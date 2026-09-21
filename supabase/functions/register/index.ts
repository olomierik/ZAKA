// Edge Function: register
// Creates a user record + Circle wallet, returns session token
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { name, phone, pin } = await req.json() as { name: string; phone: string; pin: string }
    if (!name || !phone || !pin) {
      return Response.json({ error: 'name, phone, and pin required' }, { status: 400, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Check phone not already taken
    const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle()
    if (existing) {
      return Response.json({ error: 'Phone already registered' }, { status: 400, headers: corsHeaders })
    }

    // Create wallet via Circle SDK (or demo mode)
    const apiKey = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''
    const entitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET') ?? ''
    let walletId = ''
    let walletAddress = ''

    if (apiKey && entitySecret) {
      // Call Circle API directly (no SDK in Deno edge)
      const pubKeyRes = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      })
      if (!pubKeyRes.ok) throw new Error('Circle auth failed')

      // Get or create wallet set
      const wsRes = await fetch('https://api.circle.com/v1/w3s/walletSets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-User-Token': entitySecret },
        body: JSON.stringify({ name: 'ZAKA', entitySecretCiphertext: entitySecret }),
      })
      const wsData = await wsRes.json() as { data?: { walletSet?: { id?: string } } }
      const walletSetId = wsData?.data?.walletSet?.id ?? ''

      const walletRes = await fetch('https://api.circle.com/v1/w3s/developer/wallets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountType: 'EOA', blockchains: ['ARC-TESTNET'], count: 1, walletSetId, entitySecretCiphertext: entitySecret }),
      })
      const walletData = await walletRes.json() as { data?: { wallets?: Array<{ id: string; address: string }> } }
      const wallet = walletData?.data?.wallets?.[0]
      walletId = wallet?.id ?? ''
      walletAddress = wallet?.address ?? ''
    }

    // Demo fallback
    if (!walletAddress) {
      const id = crypto.randomUUID()
      walletId = 'demo-' + id
      walletAddress = '0x' + id.replace(/-/g, '').slice(0, 40)
    }

    // Create Supabase auth user with phone as email
    const fakeEmail = `${phone.replace(/\D/g, '')}@zaka.app`
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: fakeEmail,
      password: pin,
      email_confirm: true,
    })
    if (authErr) throw new Error(authErr.message)
    const userId = authData.user.id

    // Store user profile
    const { error: dbErr } = await supabase.from('users').insert({
      id: userId, name, phone, pin,
      walletId, walletAddress,
      createdAt: new Date().toISOString(),
    })
    if (dbErr) throw new Error(dbErr.message)

    // Sign in to get session token
    const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({ email: fakeEmail, password: pin })
    if (signInErr) throw new Error(signInErr.message)

    return Response.json({
      user: { id: userId, name, phone, walletId, walletAddress, createdAt: new Date().toISOString() },
      token: session.session?.access_token ?? '',
    }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Registration failed' }, { status: 500, headers: corsHeaders })
  }
})
