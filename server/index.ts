/**
 * ZAKA backend server
 * Auth, Circle developer-controlled wallets, USDC transfers.
 * Storage: Supabase Postgres (falls back to in-memory for local dev).
 * Runs on port 3001; Vite proxies /api -> this server in dev.
 */
/// <reference types="bun-types" />
import { randomUUID } from 'crypto'
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { createClient } from '@supabase/supabase-js'
import { isTerminalTransactionState } from '../src/onchain-wait'

// ── env ──────────────────────────────────────────────────────────────────────
const API_KEY       = process.env.CIRCLE_DEVELOPER_CONTROLLED_API_KEY ?? process.env.CIRCLE_API_KEY ?? ''
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET ?? process.env.ENTITY_SECRET ?? ''
const JWT_SECRET    = process.env.JWT_SECRET ?? 'zaka-dev-secret-change-in-prod'
const PORT          = parseInt(process.env.PORT ?? '3001', 10)
const SUPABASE_URL  = process.env.SUPABASE_URL ?? ''
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? ''

// Arc Testnet
const ARC_TESTNET_BLOCKCHAIN = 'ARC-TESTNET'

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null

if (!supabase) {
  console.warn('⚠ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using in-memory store')
}

// ── in-memory fallback (local dev only) ──────────────────────────────────────
interface UserRecord {
  id: string; name: string; phone: string; pin: string
  walletId: string; walletAddress: string; walletSetId: string; createdAt: string
}
interface TxRecord {
  id: string; userId: string; type: 'send'|'receive'|'deposit'|'withdraw'
  amount: string; status: 'pending'|'complete'|'failed'
  counterparty?: string; counterpartyPhone?: string
  txHash?: string; description?: string; circleTxId?: string; createdAt: string
}
const memUsers = new Map<string, UserRecord>()
const memTxs   = new Map<string, TxRecord[]>()
let sharedWalletSetId: string | null = null

// ── DB helpers ────────────────────────────────────────────────────────────────
async function dbGetUserByPhone(phone: string): Promise<UserRecord | null> {
  if (!supabase) return memUsers.get(phone) ?? null
  const { data } = await supabase.from('users').select('*').eq('phone', phone).single()
  return data ?? null
}
async function dbGetUserById(id: string): Promise<UserRecord | null> {
  if (!supabase) {
    return [...memUsers.values()].find(u => u.id === id) ?? null
  }
  const { data } = await supabase.from('users').select('*').eq('id', id).single()
  return data ?? null
}
async function dbCreateUser(user: UserRecord): Promise<void> {
  if (!supabase) { memUsers.set(user.phone, user); return }
  await supabase.from('users').insert(user)
}
async function dbGetWalletSetId(): Promise<string | null> {
  if (!supabase) return sharedWalletSetId
  const { data } = await supabase.from('wallet_sets').select('id').limit(1).single()
  return data?.id ?? null
}
async function dbSaveWalletSetId(id: string): Promise<void> {
  if (!supabase) { sharedWalletSetId = id; return }
  await supabase.from('wallet_sets').insert({ id })
}
async function dbAddTx(tx: TxRecord): Promise<void> {
  if (!supabase) {
    const list = memTxs.get(tx.userId) ?? []
    memTxs.set(tx.userId, [tx, ...list])
    return
  }
  await supabase.from('transactions').insert(tx)
}
async function dbGetTxs(userId: string): Promise<TxRecord[]> {
  if (!supabase) return memTxs.get(userId) ?? []
  const { data } = await supabase.from('transactions').select('*').eq('userId', userId).order('createdAt', { ascending: false })
  return data ?? []
}
async function dbSearchUsers(query: string, excludeId: string): Promise<Array<{name:string;phone:string}>> {
  if (!supabase) {
    return [...memUsers.values()]
      .filter(u => u.id !== excludeId && (u.phone.includes(query) || u.name.toLowerCase().includes(query.toLowerCase())))
      .slice(0, 8)
      .map(u => ({ name: u.name, phone: u.phone }))
  }
  const { data } = await supabase.from('users').select('name,phone')
    .neq('id', excludeId)
    .or(`phone.ilike.%${query}%,name.ilike.%${query}%`)
    .limit(8)
  return data ?? []
}

// ── Circle SDK ────────────────────────────────────────────────────────────────
function getCircleClient() {
  if (!API_KEY || !ENTITY_SECRET) return null
  return initiateDeveloperControlledWalletsClient({ apiKey: API_KEY, entitySecret: ENTITY_SECRET })
}
async function ensureWalletSet(sdk: ReturnType<typeof initiateDeveloperControlledWalletsClient>) {
  const existing = await dbGetWalletSetId()
  if (existing) return existing
  const res = await sdk.createWalletSet({ name: 'ZAKA WalletSet' })
  const id = res.data?.walletSet?.id
  if (!id) throw new Error('Failed to create wallet set')
  await dbSaveWalletSetId(id)
  return id
}
async function createWalletForUser(userId: string): Promise<{ walletId: string; walletAddress: string }> {
  const sdk = getCircleClient()
  if (!sdk) {
    const addr = '0x' + userId.replace(/-/g, '').slice(0, 40).padStart(40, '0')
    return { walletId: 'demo-' + userId, walletAddress: addr }
  }
  const walletSetId = await ensureWalletSet(sdk)
  const res = await sdk.createWallets({ accountType: 'EOA', blockchains: [ARC_TESTNET_BLOCKCHAIN], count: 1, walletSetId })
  const wallet = res.data?.wallets?.[0]
  if (!wallet?.id || !wallet?.address) throw new Error('Wallet creation failed')
  return { walletId: wallet.id, walletAddress: wallet.address }
}

// ── JWT ───────────────────────────────────────────────────────────────────────
async function signToken(userId: string): Promise<string> {
  const payload = btoa(JSON.stringify({ userId, iat: Date.now() }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}
async function verifyToken(token: string): Promise<string | null> {
  try {
    const [payload, sig] = token.split('.')
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(sig), c => c.charCodeAt(0)), new TextEncoder().encode(payload))
    if (!ok) return null
    const { userId } = JSON.parse(atob(payload)) as { userId: string }
    return userId
  } catch { return null }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
}
function err(msg: string, status = 400) { return json({ error: msg }, status) }

async function authUser(req: Request): Promise<UserRecord | null> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const userId = await verifyToken(token)
  if (!userId) return null
  return dbGetUserById(userId)
}

function makeTx(userId: string, tx: Omit<TxRecord,'id'|'userId'|'createdAt'>): TxRecord {
  return { ...tx, id: randomUUID(), userId, createdAt: new Date().toISOString() }
}

// ── router ────────────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const url    = new URL(req.url)
  const path   = url.pathname.replace(/^\/api/, '')   // strip /api prefix if present
  const method = req.method

  if (method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } })
  }

  // POST /auth/register
  if (path === '/auth/register' && method === 'POST') {
    const { name, phone, pin } = await req.json() as { name: string; phone: string; pin: string }
    if (!name || !phone || !pin) return err('name, phone, and pin required')
    if (await dbGetUserByPhone(phone)) return err('Phone already registered')
    const id = randomUUID()
    const { walletId, walletAddress } = await createWalletForUser(id)
    const user: UserRecord = { id, name, phone, pin, walletId, walletAddress, walletSetId: '', createdAt: new Date().toISOString() }
    await dbCreateUser(user)
    const token = await signToken(id)
    return json({ user: { id, name, phone, walletId, walletAddress, createdAt: user.createdAt }, token })
  }

  // POST /auth/login
  if (path === '/auth/login' && method === 'POST') {
    const { phone, pin } = await req.json() as { phone: string; pin: string }
    const user = await dbGetUserByPhone(phone)
    if (!user || user.pin !== pin) return err('Invalid phone or PIN', 401)
    const token = await signToken(user.id)
    return json({ user: { id: user.id, name: user.name, phone: user.phone, walletId: user.walletId, walletAddress: user.walletAddress, createdAt: user.createdAt }, token })
  }

  const currentUser = await authUser(req)
  if (!currentUser) return err('Unauthorized', 401)

  // GET /wallet/balance
  if (path === '/wallet/balance' && method === 'GET') {
    const sdk = getCircleClient()
    if (!sdk || currentUser.walletId.startsWith('demo-')) {
      const txs = await dbGetTxs(currentUser.id)
      let bal = 0
      for (const tx of txs) {
        if (tx.status !== 'complete') continue
        const a = parseFloat(tx.amount)
        if (tx.type === 'receive' || tx.type === 'deposit') bal += a
        if (tx.type === 'send'    || tx.type === 'withdraw') bal -= a
      }
      return json({ usdc: Math.max(0, bal).toFixed(6) })
    }
    try {
      const res = await sdk.getWalletTokenBalance({ id: currentUser.walletId })
      const usdcBalance = res.data?.tokenBalances?.find(b => b.token?.symbol?.toUpperCase() === 'USDC')
      return json({ usdc: usdcBalance?.amount ?? '0' })
    } catch { return json({ usdc: '0' }) }
  }

  // GET /wallet/deposit-address
  if (path === '/wallet/deposit-address' && method === 'GET') {
    return json({ address: currentUser.walletAddress, network: 'Arc Testnet' })
  }

  // GET /wallet/transactions
  if (path === '/wallet/transactions' && method === 'GET') {
    return json({ transactions: await dbGetTxs(currentUser.id) })
  }

  // GET /wallet/tx/:id
  if (path.startsWith('/wallet/tx/') && method === 'GET') {
    const txId = path.split('/')[3]
    const sdk = getCircleClient()
    if (!sdk) return json({ status: 'COMPLETE' })
    try {
      const res = await sdk.getTransaction({ id: txId })
      return json({ status: res.data?.transaction?.state, txHash: res.data?.transaction?.txHash })
    } catch { return json({ status: 'UNKNOWN' }) }
  }

  // POST /wallet/send
  if (path === '/wallet/send' && method === 'POST') {
    const { toPhone, amount, note } = await req.json() as { toPhone: string; amount: string; note?: string }
    if (!toPhone || !amount) return err('toPhone and amount required')
    const recipient = await dbGetUserByPhone(toPhone)
    if (!recipient) return err('Recipient not found on ZAKA. Ask them to register first.')
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) return err('Invalid amount')

    const sdk = getCircleClient()
    let circleTxId = 'demo-' + randomUUID()
    let txHash: string | undefined

    if (sdk && !currentUser.walletId.startsWith('demo-')) {
      try {
        const balRes = await sdk.getWalletTokenBalance({ id: currentUser.walletId })
        const usdcToken = balRes.data?.tokenBalances?.find(b => b.token?.symbol?.toUpperCase() === 'USDC')
        if (!usdcToken?.token?.tokenAddress) return err('USDC not found in wallet. Please deposit first.')
        const txRes = await sdk.createTransaction({
          walletId: currentUser.walletId,
          tokenAddress: usdcToken.token.tokenAddress,
          destinationAddress: recipient.walletAddress,
          amount: [amount],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        })
        circleTxId = txRes.data?.id ?? circleTxId
        const startTime = Date.now()
        while (Date.now() - startTime < 30_000) {
          await new Promise(r => setTimeout(r, 2000))
          const statusRes = await sdk.getTransaction({ id: circleTxId })
          const state = statusRes.data?.transaction?.state ?? ''
          txHash = statusRes.data?.transaction?.txHash ?? undefined
          if (isTerminalTransactionState(state)) break
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : 'Transfer failed')
      }
    }

    await dbAddTx(makeTx(currentUser.id, { type: 'send', amount, status: 'complete', counterparty: recipient.name, counterpartyPhone: toPhone, txHash, circleTxId, description: note }))
    await dbAddTx(makeTx(recipient.id,   { type: 'receive', amount, status: 'complete', counterparty: currentUser.name, counterpartyPhone: currentUser.phone, txHash, circleTxId, description: note }))
    return json({ txId: circleTxId, status: 'complete' })
  }

  // POST /wallet/withdraw
  if (path === '/wallet/withdraw' && method === 'POST') {
    const { phone, amount, provider } = await req.json() as { phone: string; amount: string; provider: string }
    if (!phone || !amount || !provider) return err('phone, amount, and provider required')
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) return err('Invalid amount')
    const reference = 'ZK' + Date.now().toString(36).toUpperCase()
    await dbAddTx(makeTx(currentUser.id, { type: 'withdraw', amount, status: 'complete', description: `${provider} ${phone}` }))
    return json({ reference, status: 'pending', message: `Processing withdrawal to ${provider} ${phone}. Funds arrive in 1–5 minutes.` })
  }

  // GET /users/search
  if (path.startsWith('/users/search') && method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    if (q.length < 3) return json({ users: [] })
    return json({ users: await dbSearchUsers(q, currentUser.id) })
  }

  return err('Not found', 404)
}

Bun.serve({
  port: PORT,
  fetch: async (req: Request) => {
    const res = await handle(req)
    res.headers.set('Access-Control-Allow-Origin', '*')
    return res
  },
})

console.log(`ZAKA server running on port ${PORT}`)
if (!API_KEY)      console.warn('⚠ CIRCLE_DEVELOPER_CONTROLLED_API_KEY not set — running in demo mode')
if (!supabase)     console.warn('⚠ Supabase not connected — using in-memory store (data lost on restart)')
