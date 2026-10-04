// Solana's market list, shared by the browser (src/arcdex/api/solanaMarket.ts) and the engine
// (api/solmarket.ts, served at /api/solmarket): GeckoTerminal's pools as one row per coin, Solana's
// launchpads, and what the chain says about each coin: how far along its launch curve it is, and what its
// mint lets its creator do. No browser or chain libraries here, so the engine's image can import it.
//
// Owner, 2026-10-04: "bring Solana to the platform", every launchpad, launchpad coins only.

import { isWashPool, markPools, num, isImage, unescape, poolFeePct, type GtPool, type GtPools, type GtToken, type RhCoin } from './_rhCore'

export const SOL_NET = 'solana'
/** Browsers: Solana's own RPC refuses browser origins (403); publicnode answers them. */
export const SOL_RPC_BROWSER = 'https://solana-rpc.publicnode.com'
/** Servers: Solana's own RPC first, publicnode after. */
export const SOL_RPC_SERVER = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']

export const WSOL = 'So11111111111111111111111111111111111111112'
export const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const SOL_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
export const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
/** Quotes, never listed as coins of their own. */
export const SOL_QUOTES = new Set([WSOL, SOL_USDC, SOL_USDT, USD1])
export const SOL_QUOTE_SYMBOLS: Record<string, string> = { [WSOL]: 'SOL', [SOL_USDC]: 'USDC', [SOL_USDT]: 'USDT', [USD1]: 'USD1' }

/** Programs whose accounts are read here. */
export const PROGRAMS = {
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  launchLab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
} as const

/** Solana's launchpads, by GeckoTerminal dex id (its Solana venues, checked 2026-10-04). Only their coins are listed
 * and can be bought (owner, 2026-10-04: no coins from unknown contracts). pump.fun's coins graduate to its own AMM
 * (PumpSwap), so that venue counts too. Plain DEXes (Raydium, Orca, Meteora, …) don't: a coin whose only pools are
 * there came from no launchpad. */
export const SOL_LAUNCHPADS: Record<string, string> = {
  'pump-fun': 'pump.fun',
  'pumpswap': 'pump.fun',
  'raydium-launchlab': 'LaunchLab',
  'letsbonk-fun': 'LetsBonk',
  'meteora-dbc': 'Meteora DBC',
  'moonshot': 'Moonshot',
  'moonit': 'Moonit',
  'boop-fun': 'Boop',
  'daos-fun': 'daos.fun',
  'bags-fm': 'Bags',
  'heaven': 'Heaven',
  'wavebreak': 'Wavebreak',
  'token-mill': 'Token Mill',
  'virtuals-solana': 'Virtuals',
  'clanker-solana': 'Clanker',
  'printr-v2': 'Printr',
  'stonkfun': 'Stonk.fun',
  'easya-kickstart': 'EasyA Kickstart',
}

/** Venues where a coin is still on its launch curve, until the chain says otherwise. PumpSwap is where pump.fun's
 * graduate. */
export const SOL_CURVE_DEXES = new Set(['pump-fun', 'raydium-launchlab', 'letsbonk-fun', 'meteora-dbc', 'moonshot', 'boop-fun', 'bags-fm', 'moonit', 'heaven', 'wavebreak', 'token-mill', 'printr-v2', 'daos-fun', 'stonkfun'])

/** A Solana coin: the Robinhood row's shape (one coin, its main pool, its numbers), with the mint's own powers. Its
 * `address` is the mint, base58, case kept. */
export interface SolCoin extends RhCoin {
  /** What the mint lets someone do (`decodeMint`); absent until the chain has answered. */
  mint?: MintFlags
}

/** What a coin's mint allows. On pump.fun and the other launchpads, every power is renounced at launch. */
export interface MintFlags {
  /** Someone can still mint more. */
  mintAuthority: boolean
  /** Someone can freeze any holder's coins (they then can't sell). */
  freezeAuthority: boolean
  /** A Token-2022 mint (extensions possible). */
  token2022: boolean
  /** Token-2022 extensions that can block or take holders' coins: a permanent delegate, pausing, non-transferable,
   * accounts frozen by default. */
  danger: string[]
  /** Token-2022 extensions that can cost holders: a transfer hook, a transfer fee, a close authority. */
  risky: string[]
}

// ── GeckoTerminal's pools as rows ───────────────────────────────────────

/** A GeckoTerminal id ("solana_<mint>") as the address, case kept (base58 is case-sensitive). */
export const solId = (id: string | undefined) => (id ?? '').replace(/^solana_/, '')
export const isSolAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)

/** One pool as a row for its base token, or null when the base is a quote (SOL/USDC/USDT). */
export function poolToSolCoin(p: GtPool, tokens: Map<string, GtToken['attributes']>): SolCoin | null {
  const a = p.attributes
  const base = solId(p.relationships?.base_token?.data?.id)
  const quote = solId(p.relationships?.quote_token?.data?.id)
  if (!isSolAddress(base) || SOL_QUOTES.has(base)) return null
  const t = tokens.get(base)
  const q = tokens.get(quote)
  const [poolBase = '', poolQuote = ''] = a.name.split(' / ')
  const symbol = unescape(t?.symbol || poolBase.trim() || '?')
  const name = unescape(t?.name || symbol)
  const tx = a.transactions?.h24 ?? {}
  const dex = p.relationships?.dex?.data?.id ?? ''
  return {
    address: base,
    symbol,
    name,
    image: isImage(t?.image_url),
    decimals: typeof t?.decimals === 'number' ? t.decimals : null,
    stock: false,
    pool: a.address,
    dex,
    quote,
    quoteSymbol: SOL_QUOTE_SYMBOLS[quote] ?? q?.symbol ?? poolQuote.split(' ')[0] ?? '',
    priceUsd: num(a.base_token_price_usd),
    change5m: num(a.price_change_percentage?.m5),
    change1h: num(a.price_change_percentage?.h1),
    change24h: num(a.price_change_percentage?.h24),
    volume24h: num(a.volume_usd?.h24),
    liquidity: num(a.reserve_in_usd),
    marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
    buys24h: tx.buys ?? 0,
    sells24h: tx.sells ?? 0,
    traders24h: (tx.buyers ?? 0) + (tx.sellers ?? 0),
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || 0 : 0,
    feePct: poolFeePct(a.name),
    launchpad: SOL_LAUNCHPADS[dex] ?? null,
  }
}

export function parseSolPools(d: GtPools): SolCoin[] {
  const tokens = new Map((d.included ?? []).filter(i => i.type === 'token').map(i => [solId(i.id) || i.attributes.address, i.attributes]))
  return (d.data ?? []).map(p => poolToSolCoin(p, tokens)).filter((c): c is SolCoin => c !== null)
}

/** One row per coin: its best pool leads (`markPools`), volume and trades summed over its pools. */
export function mergeSolCoins(rows: SolCoin[]): SolCoin[] {
  const by = new Map<string, SolCoin[]>()
  for (const r of rows) {
    const list = by.get(r.address)
    if (!list) by.set(r.address, [r])
    else if (!list.some(x => x.pool === r.pool)) list.push(r)
  }
  const out: SolCoin[] = []
  for (const list of by.values()) {
    const marked = markPools(list) as SolCoin[]
    const pick = marked[0]
    const real = marked.filter(r => !r.offMarket)
    const first = Math.min(...list.map(r => r.createdAt || Infinity))
    out.push({
      ...pick,
      launchpad: (real.find(r => r.launchpad) ?? list.find(r => r.launchpad))?.launchpad ?? null,
      image: pick.image ?? list.find(r => r.image)?.image ?? null,
      volume24h: real.reduce((s, r) => s + r.volume24h, 0),
      buys24h: real.reduce((s, r) => s + r.buys24h, 0),
      sells24h: real.reduce((s, r) => s + r.sells24h, 0),
      createdAt: Number.isFinite(first) ? first : 0,
    })
  }
  return out
}

/** Wash trading: a few wallets trading with themselves (as on Robinhood Chain), or millions of "volume" through a pool
 * with no liquidity (seen on Solana 2026-10-04: PEXRA, $52M a day through a $0 pool). */
export function isWashSol(c: SolCoin, now = Date.now()): boolean {
  return isWashPool(c, now) || (c.liquidity < 100 && c.volume24h > 50_000)
}

/** Launchpad coins only. */
export const listedSol = (rows: SolCoin[]): SolCoin[] => rows.filter(c => c.launchpad)

export const SOL_INCLUDE = { include: 'base_token,quote_token,dex' }

/** Every call a full list reads: each launchpad's busiest pools, pump.fun's and PumpSwap's next pages (most of
 * Solana's meme trading), and the newest pools. */
export function solListPaths(): string[] {
  const q = (params: Record<string, string>) => new URLSearchParams({ ...SOL_INCLUDE, ...params }).toString()
  const dex = (d: string, page = '1') => `/networks/${SOL_NET}/dexes/${d}/pools?${q({ sort: 'h24_volume_usd_desc', page })}`
  return [
    dex('pump-fun'), dex('pumpswap'),
    ...Object.keys(SOL_LAUNCHPADS).filter(d => d !== 'pump-fun' && d !== 'pumpswap').map(d => dex(d)),
    dex('pump-fun', '2'), dex('pumpswap', '2'), `/networks/${SOL_NET}/new_pools?${q({})}`,
  ]
}

// ── bytes ────────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s }
  return s
}

export function fromBase64(s: string): Uint8Array {
  if (typeof atob === 'function') return Uint8Array.from(atob(s), c => c.charCodeAt(0))
  return new Uint8Array(Buffer.from(s, 'base64'))
}

const u64 = (b: Uint8Array, o: number) => (o + 8 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true) : 0n)
const u32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true) : 0)
const u16 = (b: Uint8Array, o: number) => (o + 2 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true) : 0)
const nonZero = (b: Uint8Array, o: number, len = 32) => b.slice(o, o + len).some(x => x !== 0)
const share = (part: bigint, whole: bigint) => (whole > 0n ? Math.max(0, Math.min(100, Number((part * 10_000n) / whole) / 100)) : 0)

// ── launch curves ───────────────────────────────────────────────────────
//
// Each launchpad's own measure of how far a coin is to graduating, read from its pool account (GeckoTerminal's pool
// address is that account, checked 2026-10-04), decoded by the program that owns it:
//   pump.fun    the bonding curve: tokens sold of the 793.1M for sale, and `complete` once it has graduated
//   LaunchLab   (LetsBonk, Raydium LaunchLab) SOL raised over the pool's target (85 SOL), `status` 0 while trading
//   Meteora DBC (Moonshot, Bags, Believe…) quote raised over the pool config's migration threshold, `is_migrated`
// Other launchpads' curves (Boop, …) aren't read: their coins show as Bonding without a percentage.

export interface CurveRead { progress: number; graduated: boolean }

/** pump.fun's initial real token reserves: 793.1M tokens (6 decimals) for sale on the curve. */
export const PUMP_FOR_SALE = 793_100_000_000_000n

export function decodePumpCurve(b: Uint8Array): CurveRead | null {
  if (b.length < 49) return null
  const realToken = u64(b, 24)
  const complete = b[48] === 1
  return { progress: complete ? 100 : share(PUMP_FOR_SALE - (realToken > PUMP_FOR_SALE ? PUMP_FOR_SALE : realToken), PUMP_FOR_SALE), graduated: complete }
}

/** LaunchLab's PoolState: discriminator, epoch (u64), bump, status, two decimals, migrate type (u8s), then supply,
 * total for sale, virtual A/B, real A/B and the fundraising target (u64s, from byte 21). */
export function decodeLaunchLab(b: Uint8Array): CurveRead | null {
  if (b.length < 77) return null
  const status = b[17]
  const realB = u64(b, 61)
  const target = u64(b, 69)
  const progress = share(realB, target)
  return { progress: status !== 0 ? 100 : progress, graduated: status !== 0 }
}

/** A Meteora DBC pool: its config (where the threshold is), quote raised, and whether it has migrated. */
export function decodeDbcPool(b: Uint8Array): { config: string; quoteReserve: bigint; migrated: boolean } | null {
  if (b.length < 306) return null
  return { config: base58(b.slice(72, 104)), quoteReserve: u64(b, 240), migrated: b[305] === 1 }
}

/** A Meteora DBC config's migration threshold (quote raised at graduation). */
export const decodeDbcThreshold = (b: Uint8Array): bigint | null => (b.length >= 272 ? u64(b, 264) : null)

export function dbcCurve(pool: { quoteReserve: bigint; migrated: boolean }, threshold: bigint | null): CurveRead | null {
  if (pool.migrated) return { progress: 100, graduated: true }
  if (!threshold) return null
  return { progress: share(pool.quoteReserve, threshold), graduated: false }
}

// ── mints ────────────────────────────────────────────────────────────────

/** Token-2022 extension types (spl-token-2022 ExtensionType). */
const EXT = { transferFee: 1, closeAuthority: 3, defaultState: 6, nonTransferable: 9, permanentDelegate: 12, transferHook: 14, pausable: 26 } as const

/** What a mint account allows (`owner` is the program that owns it). The base layout (82 bytes): the mint authority
 * (an option, u32 + 32 bytes), supply, decimals, initialized, the freeze authority (u32 + 32 bytes). A Token-2022
 * mint's extensions follow at byte 166 as type-length-value records. */
export function decodeMint(b: Uint8Array, owner: string): MintFlags | null {
  if (b.length < 82) return null
  const flags: MintFlags = {
    mintAuthority: u32(b, 0) === 1 && nonZero(b, 4),
    freezeAuthority: u32(b, 46) === 1 && nonZero(b, 50),
    token2022: owner === PROGRAMS.token2022,
    danger: [],
    risky: [],
  }
  if (!flags.token2022 || b.length <= 166) return flags
  for (let o = 166; o + 4 <= b.length;) {
    const type = u16(b, o), len = u16(b, o + 2), d = o + 4
    if (type === 0 && len === 0) break
    if (type === EXT.permanentDelegate && nonZero(b, d)) flags.danger.push('permanent-delegate')
    // A hook runs on every transfer and could block sales, but some launch partners set one as standard (seen on Meteora
    // DBC coins, 2026-10-04): risky, with the reason shown, not hidden as danger.
    if (type === EXT.transferHook && nonZero(b, d + 32)) flags.risky.push('transfer-hook')
    if (type === EXT.pausable && nonZero(b, d)) flags.danger.push('pausable')
    if (type === EXT.nonTransferable) flags.danger.push('non-transferable')
    if (type === EXT.defaultState && b[d] === 2) flags.danger.push('frozen-by-default')
    if (type === EXT.transferFee) flags.risky.push('transfer-fee')
    if (type === EXT.closeAuthority && nonZero(b, d)) flags.risky.push('close-authority')
    o = d + len
  }
  return flags
}

// ── reading accounts ─────────────────────────────────────────────────────

export interface RawAccount { owner: string; data: Uint8Array }

/** Addresses one getMultipleAccounts call may ask for: Solana's own RPC takes 100; publicnode refuses more than 10
 * ("Request blocked", measured 2026-10-04). */
export const batchFor = (url: string) => (/publicnode/.test(url) ? 10 : 100)

/** Accounts by address (null where there's none), from the first RPC that answers, in calls as big as each allows
 * (`batchFor`). Addresses no RPC answers for are left out, to be asked again. */
export async function readAccounts(addresses: string[], rpcs: string[], fetcher: typeof fetch = fetch): Promise<Map<string, RawAccount | null>> {
  const out = new Map<string, RawAccount | null>()
  for (const url of rpcs) {
    const todo = addresses.filter(a => !out.has(a))
    if (!todo.length) break
    const size = batchFor(url)
    for (let i = 0; i < todo.length; i += size) {
      const keys = todo.slice(i, i + size)
      try {
        const res = await fetcher(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64' }] }),
        })
        const j = await res.json() as { result?: { value?: ({ owner: string; data: [string, string] } | null)[] } }
        const v = j.result?.value
        if (!Array.isArray(v) || v.length !== keys.length) continue
        keys.forEach((k, n) => { const a = v[n]; out.set(k, a ? { owner: a.owner, data: fromBase64(a.data[0]) } : null) })
      } catch { /* the next RPC tries what's left */ }
    }
  }
  return out
}

/** Each coin's curve, read from its main pool account by the program that owns it (DBC pools need their config too:
 * `configs` caches thresholds, which never change). */
export async function readCurves(coins: { address: string; pool: string }[], rpcs: string[], configs: Map<string, bigint | null>, fetcher: typeof fetch = fetch): Promise<Map<string, CurveRead>> {
  const out = new Map<string, CurveRead>()
  const accounts = await readAccounts([...new Set(coins.map(c => c.pool))], rpcs, fetcher)
  const dbc = new Map<string, { config: string; quoteReserve: bigint; migrated: boolean }>()
  for (const c of coins) {
    const a = accounts.get(c.pool)
    if (!a) continue
    if (a.owner === PROGRAMS.pump) { const r = decodePumpCurve(a.data); if (r) out.set(c.address, r) }
    else if (a.owner === PROGRAMS.launchLab) { const r = decodeLaunchLab(a.data); if (r) out.set(c.address, r) }
    else if (a.owner === PROGRAMS.dbc) { const p = decodeDbcPool(a.data); if (p) dbc.set(c.address, p) }
  }
  const missing = [...new Set([...dbc.values()].map(p => p.config))].filter(k => !configs.has(k))
  if (missing.length) {
    const read = await readAccounts(missing, rpcs, fetcher)
    for (const [k, a] of read) configs.set(k, a ? decodeDbcThreshold(a.data) : null)
  }
  for (const [coin, p] of dbc) { const r = dbcCurve(p, configs.get(p.config) ?? null); if (r) out.set(coin, r) }
  return out
}

/** Each mint's flags (`decodeMint`). */
export async function readMints(mints: string[], rpcs: string[], fetcher: typeof fetch = fetch): Promise<Map<string, MintFlags>> {
  const out = new Map<string, MintFlags>()
  const accounts = await readAccounts(mints, rpcs, fetcher)
  for (const [k, a] of accounts) { if (a) { const f = decodeMint(a.data, a.owner); if (f) out.set(k, f) } }
  return out
}
