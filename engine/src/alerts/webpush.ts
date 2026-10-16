// Web Push from the engine (the build pack's Phase 5: "alerts delivered within 10 seconds of trigger"), with no library:
//
//   • VAPID (RFC 8292): each request carries a JWT (ES256) for the push service's origin, signed with the engine's key;
//     the browser subscribed with the matching public key, so only this engine can push to it.
//   • Message encryption (RFC 8291, aes128gcm from RFC 8188): a fresh key pair and salt per message; the browser's
//     subscription keys (p256dh, auth) derive the content key, so the push service only ever sees ciphertext.
//
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, the format `web-push generate-vapid-keys` prints). Without them
// the engine makes a pair once and keeps it in its settings (as it does AUTH_SECRET), so subscriptions survive restarts.
//
// Only the known push services are ever called (PUSH_HOSTS): a subscription names a URL the engine will POST to, so an
// arbitrary one would let anyone point the engine at any host.

const enc = new TextEncoder()
/** Bytes WebCrypto takes (a plain ArrayBuffer behind them). */
type Bytes = Uint8Array<ArrayBuffer>

export const b64u = {
  encode(b: Uint8Array): string { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
  decode(s: string): Bytes { return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')) },
}

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export interface VapidKeys { publicKey: string; privateKey: string }

/** A new VAPID key pair (P-256): the public key uncompressed (65 bytes), the private key's scalar (32 bytes). */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return { publicKey: b64u.encode(pub), privateKey: jwk.d! }
}

/** Whether a VAPID pair is well formed and the private key matches the public one. */
export async function vapidValid(k: VapidKeys): Promise<boolean> {
  try {
    const pub = b64u.decode(k.publicKey)
    if (pub.length !== 65 || pub[0] !== 4 || b64u.decode(k.privateKey).length !== 32) return false
    const key = await signingKey(k)
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode('check'))
    const verify = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verify, sig, enc.encode('check'))
  } catch { return false }
}

const jwkOf = (pub: Uint8Array, d?: string): JsonWebKey => ({ kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), ...(d ? { d } : {}), ext: true })

function signingKey(k: VapidKeys): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwkOf(b64u.decode(k.publicKey), k.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

/** The Authorization header for a push to `endpoint` (RFC 8292): a JWT for the endpoint's origin, 12 hours at most. */
export async function vapidAuthorization(endpoint: string, k: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(k), enc.encode(`${head}.${body}`)))
  return `vapid t=${head}.${body}.${b64u.encode(sig)}, k=${k.publicKey}`
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

export interface Subscription { endpoint: string; keys: { p256dh: string; auth: string } }

/** RFC 8291: `plaintext` encrypted for a subscription, as one aes128gcm record (header + ciphertext). `fixed` sets the
 * sender's key pair and the salt, for the RFC's own test vector; never in use. */
export async function encryptPush(sub: Subscription['keys'], plaintext: Uint8Array, fixed?: { asPublic: Bytes; asPrivate: string; salt: Bytes }): Promise<Bytes> {
  const uaPublic = b64u.decode(sub.p256dh), authSecret = b64u.decode(sub.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys')
  let asPublic: Bytes, asPrivate: CryptoKey
  if (fixed) {
    asPublic = fixed.asPublic
    asPrivate = await crypto.subtle.importKey('jwk', jwkOf(fixed.asPublic, fixed.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
    asPrivate = kp.privateKey
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256))
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt: Bytes = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  // One record: the plaintext, then the last-record delimiter (0x02).
  const padded = concat(plaintext, new Uint8Array([2]))
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded))
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct)
}

/** The push services the engine will call: browsers' own (Chrome/Edge/Brave/Opera: FCM; Firefox: Mozilla; Safari:
 * Apple; Edge on Windows: WNS). */
export const PUSH_HOSTS: (string | RegExp)[] = [
  'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', /^[a-z0-9-]+\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/,
]

/** Why a subscription can't be used, or null. */
export function subscriptionProblem(s: unknown): string | null {
  const v = s as Partial<Subscription> | null
  if (!v || typeof v.endpoint !== 'string' || v.endpoint.length > 1024) return 'no endpoint'
  let u: URL
  try { u = new URL(v.endpoint) } catch { return 'the endpoint isn’t a URL' }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return 'the endpoint must be a plain https URL'
  if (!PUSH_HOSTS.some(h => (typeof h === 'string' ? u.hostname === h : h.test(u.hostname)))) return 'not a known push service'
  const k = v.keys
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return 'no keys'
  try {
    const p = b64u.decode(k.p256dh), a = b64u.decode(k.auth)
    if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return 'bad keys'
  } catch { return 'bad keys' }
  return null
}

export type PushResult = { ok: true; status: number } | { ok: false; status: number; gone: boolean; retryAfterMs: number | null }

/** Sends one encrypted message. `ttl`: how long the push service may hold it for an offline browser (seconds). */
export async function sendPush(sub: Subscription, payload: unknown, k: VapidKeys, subject: string, o: { ttl?: number; urgency?: 'high' | 'normal'; topic?: string; fetcher?: typeof fetch } = {}): Promise<PushResult> {
  const body = await encryptPush(sub.keys, enc.encode(JSON.stringify(payload)))
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, k, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    TTL: String(o.ttl ?? 300), Urgency: o.urgency ?? 'high',
  }
  // A topic replaces an undelivered message with the same one (32 base64url characters at most).
  if (o.topic) headers.Topic = o.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  const r = await (o.fetcher ?? fetch)(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(8_000) })
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status }
  const ra = Number(r.headers.get('retry-after'))
  return { ok: false, status: r.status, gone: r.status === 404 || r.status === 410, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null }
}
