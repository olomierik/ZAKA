// Edge Function: register — no external imports, uses fetch directly
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

async function dbQuery(path: string, method: string, body?: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function authAdmin(action: string, payload: unknown) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${action}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  return res.json()
}

async function signIn(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { name, phone, pin } = await req.json()
    if (!name || !phone || !pin) {
      return Response.json({ error: 'name, phone, and pin required' }, { status: 400, headers: CORS })
    }

    // Check if phone exists
    const existing = await dbQuery(`users?phone=eq.${encodeURIComponent(phone)}&select=id`, 'GET')
    if (Array.isArray(existing) && existing.length > 0) {
      return Response.json({ error: 'Phone already registered' }, { status: 400, headers: CORS })
    }

    // Demo wallet
    const uid = crypto.randomUUID()
    const walletId = 'demo-' + uid
    const walletAddress = '0x' + uid.replace(/-/g, '').slice(0, 40)

    const fakeEmail = `${phone.replace(/\D/g, '')}@zaka.app`

    // Create auth user
    const authResult = await authAdmin('users', { email: fakeEmail, password: pin, email_confirm: true })
    if (authResult.error) throw new Error(authResult.error.message ?? 'Auth creation failed')
    const userId = authResult.id

    // Store profile
    await dbQuery('users', 'POST', {
      id: userId, name, phone, pin, walletId, walletAddress,
      createdAt: new Date().toISOString(),
    })

    // Sign in for token — retry once after short delay (auth propagation)
    let session = await signIn(fakeEmail, pin)
    if (session.error) {
      await new Promise(r => setTimeout(r, 800))
      session = await signIn(fakeEmail, pin)
    }

    return Response.json({
      user: { id: userId, name, phone, walletId, walletAddress, createdAt: new Date().toISOString() },
      token: session.access_token ?? '',
    }, { headers: CORS })

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Registration failed'
    return Response.json({ error: msg }, { status: 500, headers: CORS })
  }
})
