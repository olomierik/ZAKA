// Alerts by push, the site's side (src/arcdex/lib/push.ts): every alert the page hands the engine is one the engine
// takes (its own check, engine/src/alerts/service.ts cleanAlert), reached price alerts aren't sent again, 50 at most,
// and the service worker (public/sw.js) only ever opens this site's pages.
//   bun scripts/test-push.ts
import { readFileSync } from 'node:fs'
import { cleanAlert } from '../engine/src/alerts/service'
import { addCoinAlert, hlServerAlert, outgoing, pushState, removeCoinAlert, setHlAlertSource, setWalletAlertSource, walletServerAlert } from '../src/arcdex/lib/push'
import { flag } from '../src/arcdex/lib/flags'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const COIN = '0x' + 'ab'.repeat(20)

console.log('what the page sends, the engine takes')
addCoinAlert({ kind: 'price', market: COIN, symbol: 'PEPE', dir: 'above', px: 0.0123, title: 'PEPE rises to $0.0123', body: 'Price alert on ARCDEX', url: `/token/${COIN}` })
addCoinAlert({ kind: 'activity', market: COIN, symbol: 'PEPE', minUsd: 5000, side: 'any', title: '{side} of {usd} on PEPE', body: 'A single trade on ARCDEX’s Arc feed', url: `/token/${COIN}`, buyWord: 'Achat', sellWord: 'Vente' })
setHlAlertSource(() => [
  hlServerAlert({ id: crypto.randomUUID(), coin: 'BTC', dir: 'above', px: 70000 }, 'BTC monte à 70 000', 'Alerte de prix sur ARCDEX'),
  hlServerAlert({ id: crypto.randomUUID(), coin: 'xyz:NVDA', dir: 'below', px: 120.5 }, 'NVDA fällt auf 120,5', 'Preisalarm auf ARCDEX'),
])
// Followed wallets (the wallet tracker): an EVM one and a Solana one, the longest ids an address makes.
setWalletAlertSource(() => [
  walletServerAlert({ address: '0x' + 'cd'.repeat(20) }, 'Wallet tracker', 'Alice {side} {usd} of {coin} on {chain}', 'a acheté', 'a vendu'),
  walletServerAlert({ address: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS' }, 'Wallet tracker', 'Bob {side} {usd} of {coin} on {chain}', 'bought', 'sold'),
])
const out = outgoing()
check(out.length === 6, `six alerts handed over (${out.length})`)
for (const a of out) {
  const r = cleanAlert(a)
  check(typeof r !== 'string', `${a.kind} on ${a.venue} ${a.market}: taken${typeof r === 'string' ? ` (refused: ${r})` : ''}`)
}
check(!out.some(a => 'symbol' in a || 'created' in a || 'firedAt' in a), 'only what the engine needs leaves the browser')
check(out.every(a => a.url.startsWith('/') && !a.url.startsWith('//')), 'every alert opens a page on this site')

console.log('reached price alerts aren’t sent again; deleting one stops it')
const price = pushState().coin.find(a => a.kind === 'price')!
pushState().coin.splice(pushState().coin.indexOf(price), 1, { ...price, firedAt: Date.now() })
check(!outgoing().some(a => a.id === price.id), 'a reached price alert stays out')
const whale = pushState().coin.find(a => a.kind === 'activity')!
removeCoinAlert(whale.id)
check(!outgoing().some(a => a.id === whale.id), 'a deleted whale alert stays out')
setHlAlertSource(() => Array.from({ length: 80 }, (_, i) => hlServerAlert({ id: `hl-${i}-xxxx`, coin: 'BTC', dir: 'above', px: 1 + i }, 't', 'b')))
check(outgoing().length === 50, '50 at most, as the engine takes')

console.log('the flag and the service worker')
check(flag('pushAlerts', {}) === true && flag('pushAlerts', { VITE_FLAG_PUSH_ALERTS: 'off' }) === false, 'on by default; VITE_FLAG_PUSH_ALERTS=off (or /admin) turns it off')
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
check(/u\.startsWith\('\/'\) && !u\.startsWith\('\/\/'\)/.test(sw) && /new URL\(pathOnly\(/.test(sw), 'the service worker opens paths on this site only')
check(!/addEventListener\('fetch'/.test(sw) && !/caches\./.test(sw), 'it caches nothing and answers no requests')
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8')
check(/for = "\/sw\.js"[\s\S]*?Cache-Control = "no-cache"/.test(toml) && /worker-src 'self'/.test(toml), 'served with no-cache, and allowed by the CSP')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
