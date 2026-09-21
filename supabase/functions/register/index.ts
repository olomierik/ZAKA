// Edge Function: register — creates a real Circle developer-controlled wallet on ARC-TESTNET
import { encryptEntitySecret, getOrCreateWalletSetId, createCircleWallet } from '../_shared/circle.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CIRCLE_KEY    = Deno.env.get('CIRCLE_DEVELOPER_CONTROLLED_API_KEY') ?? ''
const ENTITY_SECRET = Deno.env.get('CIRCLE_ENTITY_SECRET') ?? ''

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
    headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
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

    // Check if phone already registered
    const existing = await dbQuery(`users?phone=eq.${encodeURIComponent(phone)}&select=id`, 'GET')
    if (Array.isArray(existing) && existing.length > 0) {
      return Response.json({ error: 'Phone already registered' }, { status: 400, headers: CORS })
    }

    // Create wallet — real Circle wallet if keys present, demo fallback otherwise
    let walletId: string
    let walletAddress: string

    if (CIRCLE_KEY && ENTITY_SECRET) {
      // Encrypt entity secret fresh for this request (required — no replay)
      const ciphertext = await encryptEntitySecret(ENTITY_SECRET, CIRCLE_KEY)
      const walletSetId = await getOrCreateWalletSetId(CIRCLE_KEY, ciphertext, SUPABASE_URL, SERVICE_KEY)
      // Each wallet needs its own fresh ciphertext
      const ciphertext2 = await encryptEntitySecret(ENTITY_SECRET, CIRCLE_KEY)
      const wallet = await createCircleWallet(CIRCLE_KEY, ciphertext2, walletSetId)
      walletId = wallet.walletId
      walletAddress = wallet.walletAddress
    } else {
      const uid = crypto.randomUUID()
      walletId = 'demo-' + uid
      walletAddress = '0x' + uid.replace(/-/g, '').slice(0, 40)
    }

    const fakeEmail = `${phone.replace(/\D/g, '')}@zaka.app`
    // Supabase Auth requires ≥6 chars; derive a stable internal password from the PIN
    const authPassword = `zaka_${pin}_${phone.replace(/\D/g, '').slice(-4)}`

    // Create Supabase auth user
    const authResult = await authAdmin('users', { email: fakeEmail, password: authPassword, email_confirm: true })
    if (authResult.error) throw new Error(authResult.error.message ?? 'Auth creation failed')
    const userId = authResult.id
    if (!userId) throw new Error('Auth user created but no id returned: ' + JSON.stringify(authResult))

    // Store user profile
    const dbResult = await dbQuery('users', 'POST', {
      id: userId, name, phone, pin, walletId, walletAddress,
      createdAt: new Date().toISOString(),
    })
    if (!Array.isArray(dbResult) || dbResult.length === 0) {
      console.error('[register] dbQuery result:', JSON.stringify(dbResult))
      // Non-fatal — auth user + wallet already created; log and continue
    }

    // Sign in to get access token (retry up to 3x for auth propagation)
    let session = await signIn(fakeEmail, authPassword)
    for (let i = 0; i < 3 && session.error; i++) {
      await new Promise(r => setTimeout(r, 1000))
      session = await signIn(fakeEmail, authPassword)
    }
    if (session.error) {
      console.error('[register] signIn error:', JSON.stringify(session.error))
    }

    return Response.json({
      user: { id: userId, name, phone, walletId, walletAddress, createdAt: new Date().toISOString() },
      token: session.access_token ?? '',
    }, { headers: CORS })

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Registration failed'
    console.error('[register]', msg)
    return Response.json({ error: msg }, { status: 500, headers: CORS })
  }
})
