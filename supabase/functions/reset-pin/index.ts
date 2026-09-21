// Edge Function: reset-pin
// Step 1: user submits email → we send a magic link OTP
// Step 2: user clicks link, app gets access_token → user sets new PIN
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') ?? SERVICE_KEY

    const body = await req.json() as { email?: string; newPin?: string; accessToken?: string }
    const { email, newPin, accessToken } = body

    // ── Step 1: send magic-link / OTP email ──────────────────────────────────
    if (email && !newPin) {
      if (!email.includes('@')) {
        return Response.json({ error: 'Invalid email address' }, { status: 400, headers: CORS })
      }

      // Use Supabase admin to check if user exists first
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
      const { data: users } = await supabase.auth.admin.listUsers()
      const exists = users?.users?.some((u) => u.email === email)
      if (!exists) {
        return Response.json({ error: 'No ZAKA account found with that email address' }, { status: 404, headers: CORS })
      }

      // Send OTP magic link
      const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
        method: 'POST',
        headers: {
          'apikey': ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, create_user: false }),
      })
      if (!res.ok) {
        const err = await res.json() as { msg?: string; message?: string }
        return Response.json({ error: err.msg ?? err.message ?? 'Failed to send reset email' }, { status: 500, headers: CORS })
      }
      return Response.json({ message: 'Reset link sent. Check your email.' }, { headers: CORS })
    }

    // ── Step 2: set new PIN using the access token from the magic link ────────
    if (email && newPin && accessToken) {
      if (newPin.length < 4) {
        return Response.json({ error: 'PIN must be at least 4 digits' }, { status: 400, headers: CORS })
      }

      // Verify the access token
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
      const { data: { user }, error: authErr } = await supabase.auth.getUser(accessToken)
      if (authErr || !user) {
        return Response.json({ error: 'Invalid or expired reset link. Please request a new one.' }, { status: 401, headers: CORS })
      }

      // Look up the user's phone to build the derived auth password
      const { data: profile } = await supabase
        .from('users')
        .select('phone')
        .eq('id', user.id)
        .single()
      const phone = (profile as { phone: string } | null)?.phone ?? ''
      const last4 = phone.replace(/\D/g, '').slice(-4)
      const authPassword = `zaka_${newPin}_${last4}`

      // Update Supabase Auth password
      await supabase.auth.admin.updateUserById(user.id, { password: authPassword })

      // Update PIN in users table
      await supabase.from('users').update({ pin: newPin }).eq('id', user.id)

      return Response.json({ message: 'PIN reset successfully. Please sign in with your new PIN.' }, { headers: CORS })
    }

    return Response.json({ error: 'email required, or email + newPin + accessToken for step 2' }, { status: 400, headers: CORS })

  } catch (e) {
    console.error('[reset-pin]', e)
    return Response.json({ error: e instanceof Error ? e.message : 'Reset failed' }, { status: 500, headers: CORS })
  }
})
