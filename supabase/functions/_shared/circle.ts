/**
 * Shared Circle helpers for Supabase Edge Functions (Deno runtime).
 * Generates a fresh RSA-encrypted entity secret ciphertext per request,
 * matching the behaviour of the Circle Node SDK.
 */

const CIRCLE_BASE = 'https://api.circle.com/v1/w3s'

// Cache the RSA public key for the duration of the isolate lifetime
let cachedPublicKey: CryptoKey | null = null

async function getCirclePublicKey(apiKey: string): Promise<CryptoKey> {
  if (cachedPublicKey) return cachedPublicKey

  const res = await fetch(`${CIRCLE_BASE}/config/entity/publicKey`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const data = await res.json() as { data?: { publicKey?: string } }
  const pem = data?.data?.publicKey
  if (!pem) throw new Error('Could not fetch Circle RSA public key')

  // Strip PEM headers and decode base64
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '')
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

  cachedPublicKey = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
  return cachedPublicKey
}

/**
 * Encrypt the raw entity secret with Circle's RSA public key.
 * Returns a base64-encoded ciphertext suitable for `entitySecretCiphertext`.
 */
export async function encryptEntitySecret(entitySecret: string, apiKey: string): Promise<string> {
  const publicKey = await getCirclePublicKey(apiKey)
  // Entity secret is a 64-char hex string representing 32 raw bytes.
  // Must be passed as raw bytes (not UTF-8) to match the Circle SDK behaviour.
  const secretBytes = Uint8Array.from(
    entitySecret.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  )
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, secretBytes)
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)))
}

/**
 * Circle API wrapper: ensures a wallet set exists for ZAKA and returns its ID.
 */
export async function getOrCreateWalletSetId(
  apiKey: string,
  entitySecretCiphertext: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<string> {
  // Check DB first
  const dbRes = await fetch(`${supabaseUrl}/rest/v1/wallet_sets?select=id&limit=1`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  })
  const rows = await dbRes.json() as Array<{ id: string }>
  if (Array.isArray(rows) && rows.length > 0) return rows[0].id

  // Create via Circle
  const res = await fetch(`${CIRCLE_BASE}/developer/walletSets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      name: 'ZAKA WalletSet',
      entitySecretCiphertext,
    }),
  })
  const data = await res.json() as { data?: { walletSet?: { id?: string } } }
  const id = data?.data?.walletSet?.id
  if (!id) throw new Error('Failed to create Circle wallet set: ' + JSON.stringify(data))

  await fetch(`${supabaseUrl}/rest/v1/wallet_sets`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ id }),
  })
  return id
}

/**
 * Create one EOA wallet on ARC-TESTNET for a given wallet set.
 */
export async function createCircleWallet(
  apiKey: string,
  entitySecretCiphertext: string,
  walletSetId: string,
): Promise<{ walletId: string; walletAddress: string }> {
  const res = await fetch(`${CIRCLE_BASE}/developer/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      walletSetId,
      blockchains: ['ARC-TESTNET'],
      count: 1,
      accountType: 'EOA',
      entitySecretCiphertext,
    }),
  })
  const data = await res.json() as { data?: { wallets?: Array<{ id?: string; address?: string }> } }
  const wallet = data?.data?.wallets?.[0]
  if (!wallet?.id || !wallet?.address) {
    throw new Error('Circle wallet creation failed: ' + JSON.stringify(data))
  }
  return { walletId: wallet.id, walletAddress: wallet.address }
}
