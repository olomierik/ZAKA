// ARCDEX's fees on the site (docs/REPO_MAP.md D2/D4): 0.5% on spot off Arc, the fee wallet from VITE_FEE_RECIPIENT_EVM,
// and the Arc routers' owner control refusing what it must before anything is signed. Offline.
//   bun scripts/test-fees.ts
import type { Address } from 'viem'
import { DEFAULT_FEE_WALLET, FEE_WALLET, feeRecipientFrom, SPOT_FEE_BPS } from '../src/arcdex/lib/platform'
import { ROUTES } from '../src/arcdex/lib/routes'
import { setRouterFee, TARGET_FEE_BPS, type RouterFee } from '../src/arcdex/lib/routerFees'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

console.log('the fee level (D2)')
check(SPOT_FEE_BPS === 50 && TARGET_FEE_BPS === 50, 'spot is 0.5%, and that is what the Arc routers are set to')
for (const id of ['sol', 'bsc', 'rh', 'sol-wallet']) check(ROUTES.find(r => r.id === id)?.fee === '0.5%', `/routes shows 0.5% for ${id}`)
for (const id of ['arc-spot', 'arc-curves', 'arc-native']) check(!!ROUTES.find(r => r.id === id)?.onchain, `/routes reads ${id}'s fee from its router`)

console.log('the fee wallet (D4)')
check(FEE_WALLET === DEFAULT_FEE_WALLET, 'nothing set: the fee wallet since ARCDEX')
check(feeRecipientFrom(' 0x5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A ') === '0x' + '5a'.repeat(20), 'an address moves it (lowercased, as every comparison expects)')
check(feeRecipientFrom('0x274262a0321a0701b0a46a3576e07ae881c286b') === DEFAULT_FEE_WALLET && feeRecipientFrom('safe.eth') === DEFAULT_FEE_WALLET, 'a typo keeps the default')

console.log('the owner control refuses before anything is signed')
const OWNER = '0x414B6Be4CF906739FbF7D49165beCa5F4CeEC3dA' as Address
const router: RouterFee = { id: 'swap', name: 'ArcDexSwapRouter', address: '0xD07583f7DB671521AAcFdA2b4612AD187aA2924e', owner: OWNER, feeBps: 200, maxFeeBps: 200, feeWallet: '0x274262A0321A0701b0A46a3576e07aE881c286Bb', referralShareBps: 1500 }
const why = (p: Promise<unknown>) => p.then(() => 'sent', (e: Error) => e.message)
check(/Only the router’s owner \(0x414B…C3dA\)/.test(await why(setRouterFee(router, 50, '0x000000000000000000000000000000000000beef', 'wallet'))), 'a wallet that isn’t the owner is told whose it is')
check(/between 0 and 200/.test(await why(setRouterFee(router, 201, OWNER, 'wallet'))) && /between 0 and 200/.test(await why(setRouterFee(router, 0.5, OWNER, 'wallet'))), 'a fee over the router’s cap, or not whole basis points, is refused')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
