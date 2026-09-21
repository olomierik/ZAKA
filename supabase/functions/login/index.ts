// Edge Function: login
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { phone, pin } = await req.json() as { phone: string; pin: string }
    if (!phone || !pin) {
      return Response.json({ error: 'phone and pin required' }, { status: 400, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Look up user profile
    const { data: profile, error: profileErr } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .maybeSingle()

    if (profileErr || !profile) {
      return Response.json({ error: 'Invalid phone or PIN' }, { status: 401, headers: corsHeaders })
    }

    const fakeEmail = `${phone.replace(/\D/g, '')}@zaka.app`
    const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({
      email: fakeEmail,
      password: pin,
    })

    if (signInErr || !session.session) {
      return Response.json({ error: 'Invalid phone or PIN' }, { status: 401, headers: corsHeaders })
    }

    return Response.json({
      user: {
        id: profile.id as string,
        name: profile.name as string,
        phone: profile.phone as string,
        walletId: profile.walletId as string,
        walletAddress: profile.walletAddress as string,
        createdAt: profile.createdAt as string,
      },
      token: session.session.access_token,
    }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Login failed' }, { status: 500, headers: corsHeaders })
  }
})
