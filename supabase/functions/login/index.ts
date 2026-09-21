// Edge Function: login — no external imports
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

async function signIn(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { phone, pin } = await req.json()
    if (!phone || !pin) {
      return Response.json({ error: 'phone and pin required' }, { status: 400, headers: CORS })
    }

    // Get user profile
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/users?phone=eq.${encodeURIComponent(phone)}&select=*`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    })
    const profiles = await profileRes.json()
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return Response.json({ error: 'Phone not registered' }, { status: 400, headers: CORS })
    }
    const userRow = profiles[0]

    const fakeEmail = `${phone.replace(/\D/g, '')}@zaka.app`
    const session = await signIn(fakeEmail, pin)
    if (session.error) {
      return Response.json({ error: 'Invalid PIN' }, { status: 401, headers: CORS })
    }

    return Response.json({
      user: { id: userRow.id, name: userRow.name, phone: userRow.phone, walletId: userRow.walletId, walletAddress: userRow.walletAddress, createdAt: userRow.createdAt },
      token: session.access_token ?? '',
    }, { headers: CORS })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Login failed' }, { status: 500, headers: CORS })
  }
})
