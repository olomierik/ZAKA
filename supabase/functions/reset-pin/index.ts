// Edge Function: reset-pin
// Sends a PIN reset email via Supabase Auth magic link.
// The user clicks the link → lands on the app with a reset token → sets new PIN.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { email, newPin } = await req.json() as { email?: string; newPin?: string }

    // ── Step 1: request magic-link / OTP (no newPin yet — just send email) ──
    if (email && !newPin) {
      if (!email.includes('@')) {
        return Response.json({ error: 'Invalid email' }, { status: 400, headers: CORS })
      }

      const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
        method: 'POST',
        headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: false }),
      })
      const data = await res.json()
      if (data.error) return Response.json({ error: 'No account found with that email' }, { status: 404, headers: CORS })
      return Response.json({ message: 'Reset link sent. Check your email.' }, { headers: CORS })
    }

    // ── Step 2: update password after user verifies OTP token ──
    // Client sends: { email, newPin, accessToken } after verifying the OTP
    const { accessToken } = await req.json() as { accessToken?: string }
    if (!email || !newPin || !accessToken) {
      return Response.json({ error: 'email, newPin, and accessToken required' }, { status: 400, headers: CORS })
    }
    if (newPin.length < 4) return Response.json({ error: 'PIN must be at least 4 digits' }, { status: 400, headers: CORS })

    // Get the user from the access token
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${accessToken}` },
    })
    const userData = await userRes.json() as { id?: string; email?: string }
    if (!userData.id) return Response.json({ error: 'Invalid token' }, { status: 401, headers: CORS })

    // Get user profile to derive auth password
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userData.id}&select=phone,pin`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    })
    const profiles = await profileRes.json() as Array<{ phone: string; pin: string }>
    if (!profiles?.length) return Response.json({ error: 'User not found' }, { status: 404, headers: CORS })
    const { phone } = profiles[0]
    const authPassword = `zaka_${newPin}_${phone.replace(/\D/g, '').slice(-4)}`

    // Update Supabase Auth password
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userData.id}`, {
      method: 'PUT',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: authPassword }),
    })

    // Update PIN in users table
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userData.id}`, {
      method: 'PATCH',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: newPin }),
    })

    return Response.json({ message: 'PIN reset successfully. Please sign in.' }, { headers: CORS })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Reset failed' }, { status: 500, headers: CORS })
  }
})
