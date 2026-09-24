// POST /api/session  { address, issuedAt, nonce, signature }
// Verifies that `signature` is `address` signing the ARCDEX sign-in
// message (EOAs and smart-contract wallets via ERC-1271/6492), then returns
// a session token for social writes. See _session.ts.

import { createPublicClient, http, isAddress, type Hex } from 'viem'
import { issueToken, sessionReady, signInMessage, SIGN_IN_MAX_AGE_MS } from './_session'
import { json } from './_supabaseAdmin'

export const config = { runtime: 'edge' }

const client = createPublicClient({ transport: http('https://rpc.mainnet.arc.io', { retryCount: 2 }) })

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  if (!sessionReady) return json(503, { error: 'Sign-in is not configured on the server yet' })

  let body: { address?: string; issuedAt?: string; nonce?: string; signature?: string }
  try { body = await req.json() } catch { return json(400, { error: 'Bad JSON' }) }
  const { address, issuedAt, nonce, signature } = body

  if (!address || !isAddress(address)) return json(400, { error: 'Bad address' })
  if (!issuedAt || !nonce || !/^[A-Za-z0-9]{8,64}$/.test(nonce)) return json(400, { error: 'Bad sign-in message' })
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) return json(400, { error: 'Bad signature' })

  const issued = Date.parse(issuedAt)
  // A signed message is only good for a few minutes, so an old signature
  // someone found can't be replayed later.
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > SIGN_IN_MAX_AGE_MS) {
    return json(400, { error: 'Sign-in message expired — try again' })
  }

  let valid = false
  try {
    valid = await client.verifyMessage({
      address: address as Hex,
      message: signInMessage(address, issuedAt, nonce),
      signature: signature as Hex,
    })
  } catch {
    valid = false
  }
  if (!valid) return json(401, { error: 'Signature does not match this wallet' })

  const { token, expiresAt } = await issueToken(address)
  return json(200, { address: address.toLowerCase(), token, expiresAt })
}
