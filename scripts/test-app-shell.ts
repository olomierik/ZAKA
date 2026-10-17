// The app shell in index.html (the build pack's Phase 3): what its boot script decides for each path, language and
// stored chain, that the frame it draws is the app's own (labels, chains, breakpoints), and that the CSP allows the
// script by hash (scripts/check-csp.ts checks the hash itself).
//   bun scripts/test-app-shell.ts
import { readFileSync } from 'node:fs'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const html = src('index.html')
const script = html.match(/<script>(\(function\(d\)[\s\S]*?)<\/script>/)?.[1] ?? ''
check(script.length > 0, 'index.html has the boot script')

/** Runs the boot script as a page would, and returns the attributes it set on <html>. */
function boot(path: string, opts: { lang?: string; navLang?: string; chain?: string; theme?: string; blocked?: boolean; returning?: boolean } = {}): Record<string, string> {
  const attrs: Record<string, string> = {}
  const store: Record<string, string> = {}
  if (opts.lang) store['arcdex:lang'] = opts.lang
  if (opts.chain) store['arcdex:chain'] = opts.chain
  if (opts.theme) store['arcdex:theme'] = opts.theme
  if (opts.returning) store['arcdex:returning'] = '1'
  const localStorage = { getItem: (k: string) => { if (opts.blocked) throw new Error('blocked'); return store[k] ?? null } }
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v } } }
  new Function('document', 'localStorage', 'navigator', 'location', script)(document, localStorage, { language: opts.navLang ?? 'en-US' }, { pathname: path })
  return attrs
}

console.log('the boot script')
check(boot('/')['data-adx'] === 'light' && boot('/', { theme: 'dark' })['data-adx'] === 'dark', 'the theme, as before')
check(boot('/', { blocked: true })['data-adx'] === 'light', 'storage blocked: light, and no error')
for (const p of ['/app', '/markets', '/trenches', '/arc', '/launchpad', '/robinhood', '/solana', '/bnb', '/bsc', '/solana/']) {
  check(boot(p)['data-boot'] === 'tr', `${p}: the Trenches frame`)
}
// / is the landing page for a first visit, the Trenches for a trader who signed in here before (lib/returning.ts).
check(boot('/')['data-boot'] === 'ld' && boot('/about')['data-boot'] === 'ld' && boot('/about', { returning: true })['data-boot'] === 'ld', '/ and /about: the landing page, no app frame')
check(boot('/', { returning: true })['data-boot'] === 'tr', '/ for a returning trader: the Trenches frame')
check(boot('/', { blocked: true })['data-boot'] === 'ld', 'storage blocked: the landing page')
check(html.includes('html[data-boot=ld] .bt{display:none}'), 'the landing page hides the app frame')
check(src('src/arcdex/lib/returning.ts').includes("RETURNING_KEY = 'arcdex:returning'") && script.includes('"arcdex:returning"'), 'the same key as lib/returning.ts')
for (const p of ['/portfolio', '/futures', '/token/0x4b93446882d29e094181b2fae14b126577a2676c', '/solana/token/So11111111111111111111111111111111111111112', '/robinhood/token/0x0000000000000000000000000000000000000001', '/bnb/token/0x0000000000000000000000000000000000000001', '/predict', '/admin']) {
  check(!('data-boot' in boot(p)), `${p}: the top bar only`)
}
check(boot('/robinhood')['data-boot-c'] === 'hood' && boot('/solana')['data-boot-c'] === 'sol' && boot('/bsc')['data-boot-c'] === 'bnb' && boot('/arc', { chain: 'sol' })['data-boot-c'] === 'arc', 'a chain’s own path marks its chain')
check(boot('/', { chain: 'sol', returning: true })['data-boot-c'] === 'sol' && boot('/app', { chain: 'hood' })['data-boot-c'] === 'hood', '/ marks the chain picked last (lib/chains.ts)')
check(boot('/trenches', { chain: 'evil' })['data-boot-c'] === 'arc' && boot('/trenches')['data-boot-c'] === 'arc', '…else Arc')
check('data-boot-en' in boot('/') && 'data-boot-en' in boot('/', { navLang: 'ja-JP' }), 'English labels for English readers, and for languages the app doesn’t have')
check(!('data-boot-en' in boot('/', { lang: 'fr' })) && !('data-boot-en' in boot('/', { navLang: 'sw-TZ' })) && 'data-boot-en' in boot('/', { lang: 'en', navLang: 'de-DE' }), 'no English labels when the app will be in another language (stored, else the browser’s)')

console.log('the frame')
const shell = html.match(/<div id="root">([\s\S]*?)<\/div><\/div>\n/)?.[1] ?? ''
check(/class="bt" aria-hidden="true"/.test(shell), 'it’s hidden from screen readers (the app replaces it)')
const lanes = src('src/arcdex/components/TrenchLane.tsx')
for (const l of ['New', 'Almost bonded', 'Migrated']) check(lanes.includes(`N_('${l}')`) && shell.includes(`>${l}<`), `the lane “${l}” is the app’s own`)
check(src('src/arcdex/pages/Trenches.tsx').includes("T('Trending')") && src('src/arcdex/components/TrenchTrendLane.tsx').includes("T('Trending now')") && shell.includes('>Trending<') && shell.includes('>Trending now<'), 'Trending and Trending now are the app’s own')
const nav = src('src/arcdex/components/NavBar.tsx')
// The top bar's links after Trenches come from the one page list (lib/navItems.ts PRIMARY).
const navItems = src('src/arcdex/lib/navItems.ts')
const primary = navItems.slice(navItems.indexOf('export const PRIMARY'), navItems.indexOf('export const MORE_ITEMS'))
for (const l of ['Trenches', 'Futures', 'Predict', 'Portfolio', 'Swap', 'Bridge']) check((nav.includes(`T('${l}')`) || primary.includes(`N_('${l}')`)) && shell.includes(`>${l}<`), `the link “${l}” is the app’s own`)
for (const c of ['arc', 'hood', 'sol', 'bnb']) check(shell.includes(`bt-c-${c}`) && html.includes(`html[data-boot-c=${c}] .bt-c-${c}`), `the ${c} chip can be marked`)
const term = src('src/arcdex/terminal.css')
check(/@media \(max-width: 900px\) \{\s*\.tm-links \{ display: none; \}/.test(term) && html.includes('@media (max-width:900px){.bt-links{display:none}'), 'the links go at the app’s breakpoint (900px)')
check(/@media \(max-width: 767px\)/.test(term) && html.includes('@media (max-width:767px){') && /\.tr-mtabs \{ display: flex;/.test(term), 'the phone layout at the app’s breakpoint (767px)')
check(/\.tr-bar \{ height: 44px;/.test(term) && html.includes('.bt-bar{height:44px') && /\.tr-coinbar \{ flex-shrink: 0; height: 34px;/.test(term) && html.includes('.bt-coinbar{height:34px'), 'the bars are the app’s heights')
check(html.includes('src="/arcdex-mark-48.png"') && src('src/arcdex/components/NavBar.tsx').includes('/arcdex-mark-48.png'), 'the small logo, as the top bar uses')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
