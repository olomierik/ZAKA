// Offline test of the other Arc launchpads (api/_launchpads.ts, the market
// list in api/_argusCore.ts): recognising each launchpad from GeckoTerminal's
// dex ids and names, discovering new ones, building one list across all of
// them, and the v4 PoolKey read from a pool's Initialize log.
// Run: bun scripts/test-launchpads.ts

import { encodeAbiParameters, keccak256, pad, toBytes, type Address, type Hex } from 'viem'

const { LAUNCHPADS, KNOWN_LAUNCHPAD_DEXES, launchpadOf, launchpadNamed, isLaunchpadDex, launchpadLabel } = await import('../api/_launchpads')
const { buildMarket, discoverLaunchpads, normalize, ARGUS_TOKEN } = await import('../api/_argusCore')
const { keyFromInitializeLog, V4_INITIALIZE } = await import('../src/arcdex/api/argusMarket')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

console.log('recognising launchpads')
const cases: [string, string, string | null][] = [
  ['argus', 'Argus', 'Argus'],
  ['minara-fun', 'Minara.fun', 'Minara'],
  ['tolly-arc', 'Tolly (Arc)', 'Tolly'],
  ['radardex', 'RadarDEX', 'RadarDEX'],
  ['warp-arc', 'Warp', 'Warp'],
  ['circlewarp', '', 'Warp'],
  ['archemist-arc', 'Archemist', 'Archemist'],
  ['o1-launchpad-arc', 'o1 Launchpad', 'o1'],
  ['o1_launchpad', '', 'o1'],
  ['ubi-fun', 'UBI.fun', 'UBI.fun'],
  ['ubidotfun', '', 'UBI.fun'],
  ['sashimi', 'Sashimi', 'Sashimi'],
  ['solonpad', 'SolonPad', 'SolonPad'],
  ['mercuri-launch', 'mercuri launch', 'Mercuri'],
  ['rubicon', 'Rubicon', null],
  ['uniswap-v3-arc', 'Uniswap V3 (Arc)', null],
  ['pegd-arc', 'PEGD', null],
]
for (const [id, name, want] of cases) ok((launchpadOf(id, name)?.name ?? null) === want, `${id}${name ? ` / ${name}` : ''} → ${want ?? 'not a launchpad'}`)
ok(KNOWN_LAUNCHPAD_DEXES.every(d => LAUNCHPADS.filter(l => l.match.test(`${d.id} ${d.name}`.toLowerCase().replace(/_/g, '-'))).length === 1), 'each known GeckoTerminal id matches exactly one launchpad')
ok(new Set(LAUNCHPADS.map(l => l.name)).size === LAUNCHPADS.length && new Set(LAUNCHPADS.map(l => l.color)).size === LAUNCHPADS.length, `${LAUNCHPADS.length} launchpads, names and colors all different`)
ok(LAUNCHPADS.every(l => !l.site || /^https:\/\/[a-z0-9.-]+\.[a-z]+$/.test(l.site)), 'every site link is a plain https origin')
ok(['ArcPad', 'Arc.fun', 'Flipt', 'Onmi', 'NebulaPad'].every(n => launchpadNamed(n) && !launchpadNamed(n)!.site), 'no link where the address isn\'t confirmed')
ok(launchpadNamed('tolly')?.site === 'https://tollylabs.com' && launchpadNamed('Minara')?.name === 'Minara', 'looked up by display name, any case')

console.log('which GeckoTerminal dexes are launch venues')
ok(isLaunchpadDex('tolly-arc', 'Tolly') && isLaunchpadDex('minara-fun'), 'known launchpads')
ok(!isLaunchpadDex('uniswap-v3-arc', 'Uniswap V3') && !isLaunchpadDex('uniswap_v4', 'Uniswap V4') && !isLaunchpadDex('curve-arc', 'Curve') && !isLaunchpadDex('pegd-arc', 'PEGD'), 'plain DEXes are not')
ok(isLaunchpadDex('rocket-fun', 'Rocket.fun') && isLaunchpadDex('memepad-arc', 'MemePad') && !isLaunchpadDex('hydrex-arc', 'Hydrex'), 'a new venue named like a launchpad is picked up; an unknown DEX is not')
ok(launchpadLabel('tolly-arc', 'Tolly (Arc)') === 'Tolly' && launchpadLabel('rocket-fun', 'Rocket.fun (Arc)') === 'Rocket.fun' && launchpadLabel('uniswap-v3-arc', 'Uniswap V3 (Arc)') === 'Uniswap V3' && launchpadLabel('mystery', '') === 'mystery', 'badges: the launchpad, else GeckoTerminal\'s name')

const found = discoverLaunchpads({ data: [
  { id: 'argus', type: 'dex', attributes: { name: 'Argus' } },
  { id: 'minara-fun', type: 'dex', attributes: { name: 'Minara.fun' } },
  { id: 'tolly-arc', type: 'dex', attributes: { name: 'Tolly' } },
  { id: 'uniswap-v3-arc', type: 'dex', attributes: { name: 'Uniswap V3' } },
  { id: 'uniswap-v4-arc', type: 'dex', attributes: { name: 'Uniswap V4' } },
  { id: 'rocket-fun', type: 'dex', attributes: { name: 'Rocket.fun' } },
  { id: 'pegd-arc', type: 'dex', attributes: { name: 'PEGD' } },
] })
ok(found.map(d => d.id).join() === 'minara-fun,tolly-arc,rocket-fun', `discovered: ${found.map(d => d.id).join(', ')} (Argus is listed its own way; Uniswap and PEGD left out)`)
ok(discoverLaunchpads(null).length === 0, 'nothing when the dex list can\'t be read')

console.log('one list across every launchpad')
const USDC = '0x3600000000000000000000000000000000000000'
type Res = { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } }> }
const DEX_NAMES: Record<string, string> = { argus: 'Argus', 'minara-fun': 'Minara.fun', 'tolly-arc': 'Tolly (Arc)', 'radardex': 'RadarDEX', 'uniswap-v3-arc': 'Uniswap V3 (Arc)', 'uniswap-v4-arc': 'Uniswap V4 (Arc)', 'pegd-arc': 'PEGD' }
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0')
function pool(dex: string, token: string, symbol: string, liq: number, vol: number, opts: { quote?: string; caps?: boolean; poolId?: string } = {}) {
  const quote = opts.quote ?? USDC
  const p = opts.poolId ?? addr(Math.floor(Math.random() * 1e12))
  return {
    data: { id: `arc_${p}`, type: 'pool', attributes: { address: p, base_token_price_usd: '0.001', price_change_percentage: { m5: '1', h1: '2', h6: '3', h24: '4' }, volume_usd: { h24: String(vol) }, reserve_in_usd: String(liq), fdv_usd: opts.caps === false ? null : '100000', market_cap_usd: null, transactions: { h24: { buys: 3, sells: 2 } }, pool_created_at: '2026-09-20T00:00:00Z' },
      relationships: { base_token: { data: { id: `arc_${token}` } }, quote_token: { data: { id: `arc_${quote}` } }, dex: { data: { id: dex } } } } as Res,
    included: [
      { id: `arc_${token}`, type: 'token', attributes: { address: token, symbol, name: `${symbol} coin`, image_url: 'missing.png' } },
      { id: `arc_${quote}`, type: 'token', attributes: { address: quote, symbol: quote === USDC ? 'USDC' : 'ARGUS', name: 'q' } },
      { id: dex, type: 'dex', attributes: { name: DEX_NAMES[dex] ?? dex } },
    ] as Res[],
  }
}
const list = (...ps: ReturnType<typeof pool>[]) => ({ data: ps.map(p => p.data), included: ps.flatMap(p => p.included) })

const labelled = normalize(list(pool('tolly-arc', addr(1), 'TOL', 5000, 900), pool('uniswap-v3-arc', addr(2), 'UNI', 100, 10)))
ok(labelled[0].launchpad === 'Tolly' && labelled[1].launchpad === 'Uniswap V3', 'each row carries its launchpad (Tolly) or its DEX (Uniswap V3)')
ok(normalize(list(pool('tolly-arc', addr(1), 'TOL', 5000, 900), pool('pegd-arc', addr(2), 'P', 1, 1)), new Set(['tolly-arc'])).length === 1, 'rows filtered to a set of dexes')

const SHARED = addr(77) // a coin with pools on two launchpads: the deeper one wins
const responses: Record<string, ReturnType<typeof list>> = {
  [`/networks/arc/tokens/${ARGUS_TOKEN}/pools?page=1`]: list(pool('uniswap-v4-arc', ARGUS_TOKEN, 'ARGUS', 900_000, 50_000)),
  '/networks/arc/dexes/argus/pools?page=1': list(pool('argus', addr(10), 'ARG1', 20_000, 9_000), pool('argus', SHARED, 'BOTH', 1_000, 10)),
  '/networks/arc/dexes/minara-fun/pools?page=1': list(pool('minara-fun', addr(20), 'MIN1', 8_000, 7_000, { caps: false })),
  '/networks/arc/dexes/tolly-arc/pools?page=1': list(pool('tolly-arc', addr(30), 'TOL1', 6_000, 6_000), pool('tolly-arc', SHARED, 'BOTH', 9_000, 20)),
  '/networks/arc/dexes/radardex/pools?page=1': list(pool('radardex', addr(40), 'RAD1', 4_000, 5_000)),
  '/networks/arc/new_pools?page=1': list(pool('tolly-arc', addr(31), 'TOLNEW', 50, 5), pool('pegd-arc', addr(60), 'STABLE', 1e6, 1e6), pool('argus', addr(11), 'ARGNEW', 10, 1)),
}
const calls: string[] = []
let inFlight = 0, maxLaunchpadInFlight = 0
const fake = async (path: string) => {
  calls.push(path)
  const lp = /\/dexes\/(?!argus)/.test(path)
  inFlight++
  if (lp) maxLaunchpadInFlight = Math.max(maxLaunchpadInFlight, inFlight)
  await new Promise(r => setTimeout(r, 15))
  inFlight--
  if (path.startsWith('/networks/arc/tokens/multi/')) return { data: [{ id: 'x', type: 'token', attributes: { address: addr(20), fdv_usd: '42000', market_cap_usd: '41000' } }] }
  return responses[path.split('&')[0]] ?? { data: [] }
}
const partials: number[] = []
const lps = [{ id: 'minara-fun', name: 'Minara.fun' }, { id: 'tolly-arc', name: 'Tolly' }, { id: 'radardex', name: 'RadarDEX' }]
const market = await buildMarket(fake, p => partials.push(p.length), { launchpads: lps, concurrency: 2 })
const by = new Map(market.map(p => [p.token.symbol, p]))
ok(calls[0].startsWith(`/networks/arc/tokens/${ARGUS_TOKEN}/pools`) && calls[1].startsWith('/networks/arc/dexes/argus/pools?page=1'), 'Argus first: $ARGUS, then its top 20 by volume')
ok(lps.every(d => calls.some(c => c.startsWith(`/networks/arc/dexes/${d.id}/pools?page=1&sort=h24_volume_usd_desc`))), 'then each other launchpad\'s top 20 by volume')
ok(maxLaunchpadInFlight === 2, `launchpads fetched ${maxLaunchpadInFlight} at a time (asked for 2)`)
ok(by.get('ARGUS')?.launchpad === 'Argus' && by.get('ARG1')?.launchpad === 'Argus' && by.get('MIN1')?.launchpad === 'Minara' && by.get('TOL1')?.launchpad === 'Tolly' && by.get('RAD1')?.launchpad === 'RadarDEX', '$ARGUS and every coin labelled with its launchpad')
ok(by.get('TOLNEW')?.launchpad === 'Tolly' && by.get('ARGNEW') && !by.get('STABLE'), 'new pools kept from listed launchpads only (a PEGD stable pool left out)')
ok(by.get('BOTH')?.dex === 'tolly-arc' && market.filter(p => p.token.symbol === 'BOTH').length === 1, 'a coin on two launchpads: one row, its deepest pool')
ok(by.get('MIN1')?.fdvUsd === 42000 && by.get('MIN1')?.marketCapUsd === 41000, 'caps GeckoTerminal left out are filled in')
ok(partials.length >= 5 && partials[partials.length - 1] === market.length && partials.every((n, i) => i === 0 || n >= partials[i - 1]), `streams as it goes (${partials.join(' → ')} rows)`)
ok(market.every((p, i) => i === 0 || market[i - 1].volume24h >= p.volume24h), 'sorted by 24h volume')

const sparse = await buildMarket(path => Promise.resolve(path.includes('/dexes/argus/') ? responses['/networks/arc/dexes/argus/pools?page=1'] : null))
ok(sparse.length === 2 && sparse.every(p => p.launchpad === 'Argus'), 'a throttled build still returns what it got')
const noOpts: string[] = []
await buildMarket(path => { noOpts.push(path); return Promise.resolve(null) })
ok(KNOWN_LAUNCHPAD_DEXES.every(d => noOpts.some(c => c.includes(`/dexes/${d.id}/`))), 'without a discovered list, the known launchpads are used')

console.log('a v4 pool\'s key from its Initialize log')
ok(V4_INITIALIZE === keccak256(toBytes('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')), 'the topic is PoolManager\'s Initialize event')
const key = { currency0: USDC as Address, currency1: '0x1111111111111111111111111111111111111111' as Address, fee: 8_388_608, tickSpacing: -60, hooks: '0xabcdef0000000000000000000000000000002acc' as Address }
const POOLKEY = [{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }] as const
const poolId = keccak256(encodeAbiParameters(POOLKEY, [key]))
const log = {
  topics: [V4_INITIALIZE, poolId, pad(key.currency0), pad(key.currency1)] as Hex[],
  data: encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [key.fee, key.tickSpacing, key.hooks, 2n ** 96n, -12345]),
}
const back = keyFromInitializeLog(log)
ok(back.currency0.toLowerCase() === key.currency0.toLowerCase() && back.currency1.toLowerCase() === key.currency1 && back.hooks.toLowerCase() === key.hooks, 'currencies and hook read back')
ok(back.fee === key.fee && back.tickSpacing === -60, 'fee (dynamic-fee flag) and a negative tick spacing read back')
ok(keccak256(encodeAbiParameters(POOLKEY, [back])) === poolId, 'the key read back hashes to the pool id (the check before it\'s trusted)')

console.log('ALL LAUNCHPAD CHECKS PASSED')
