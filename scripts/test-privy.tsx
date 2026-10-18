// Email and social sign-in through Privy (src/arcdex/privy, the build pack's Phase 1 and 04): the step-up rules, the
// sign-in and export calls, the Solana signer, the wagmi connector, the withdraw guard's step-up rendered, and the
// source: Privy's code is loaded only by its host, the connect window doesn't list Privy's connector as a browser
// wallet, the bridge guards Privy sends, and the CSP lets Privy's frames and bot check in.
//   bun scripts/test-privy.tsx
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

process.env.VITE_PRIVY_APP_ID = 'cm1testprivyappid000000x'
const { STEP_UP, accountLabel, isOwnAddress, isPrivyAppId, stepUpNeed } = await import('../src/arcdex/privy/stepUp')
const S = await import('../src/arcdex/privy/state')

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

const EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const AWAY = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const now = 1_800_000_000_000

console.log('the step-up rules')
check(stepUpNeed('export', { lastAuthAt: null, mfa: false, now }) === 'relogin', 'no sign-in on this tab: export asks to sign in again')
check(stepUpNeed('export', { lastAuthAt: now - STEP_UP.exportFreshMs, mfa: false, now }) === 'none', `export within ${STEP_UP.exportFreshMs / 60_000} minutes of a sign-in: none`)
check(stepUpNeed('export', { lastAuthAt: now - STEP_UP.exportFreshMs - 1, mfa: false, now }) === 'relogin', '…a millisecond later: sign in again')
check(stepUpNeed('send', { lastAuthAt: now - 10 * 60_000, mfa: false, now }) === 'none' && stepUpNeed('export', { lastAuthAt: now - 10 * 60_000, mfa: false, now }) === 'relogin', 'a send has 15 minutes, an export 5')
check(stepUpNeed('send', { lastAuthAt: now + 60_000, mfa: false, now }) === 'relogin', 'a sign-in time in the future doesn’t count')
check(stepUpNeed('export', { lastAuthAt: now, mfa: true, now }) === 'mfa' && stepUpNeed('send', { lastAuthAt: null, mfa: true, now }) === 'mfa', 'two-step verification on: Privy’s code, every time')
check(isOwnAddress(EVM.toLowerCase(), { evm: EVM, sol: SOL }) && isOwnAddress(` ${SOL} `, { evm: EVM, sol: SOL }), 'its own EVM address (any case) and Solana address are its own')
check(!isOwnAddress(SOL.toLowerCase(), { evm: EVM, sol: SOL }) && !isOwnAddress(AWAY, { evm: EVM, sol: SOL }) && !isOwnAddress('', { evm: EVM, sol: SOL }), 'a Solana address in the wrong case, another address or nothing isn’t')
check(accountLabel({ email: { address: 'a@b.co' }, google: { email: 'g@x.com' } }) === 'a@b.co' && accountLabel({ twitter: { username: 'arc' } }) === '@arc' && accountLabel(null) === null, 'the label: email first, then social, never an address')
check(isPrivyAppId('cm1testprivyappid000000x') && !isPrivyAppId('privy_app_secret_abcdefghijklmnop') && !isPrivyAppId('CM1TESTPRIVYAPPID000000X') && !isPrivyAppId(''), 'an app id, not a secret or a typo')

console.log('the state and the calls')
check(S.privyConfigured && S.privyOn(), 'on with the app id set and the flag on')
check(S.privyNeed('send') === 'relogin', 'a session restored on load hasn’t signed in on this tab')
const calls: string[] = []
const actions = {
  login: () => { calls.push('login') },
  logout: async () => { calls.push('logout'); S.setPrivyState({ authenticated: false }) },
  exportEvm: async () => { calls.push('export-evm') },
  exportSol: async () => { calls.push('export-sol') },
  promptMfa: async () => { calls.push('mfa') },
  enrollMfa: () => { calls.push('enroll') },
  identityToken: async () => 'id.token.here',
}
S.registerPrivy(actions)
S.setPrivyState({ ready: true, authenticated: true, evm: EVM, sol: SOL, mfa: false, lastAuthAt: null })
// The admin sign-in sends Privy's identity token only for the account's own EVM wallet (engine/src/admin/privyIdentity.ts).
check(await S.privyIdentityFor(EVM) === 'id.token.here' && await S.privyIdentityFor('0x000000000000000000000000000000000000dEaD') === null, 'identity token: for the Privy wallet only')
const stale = await rejects(S.privyExport('evm', 'sign in again first'))
check(stale instanceof S.StepUpRequired && (stale as Error).message === 'sign in again first' && !calls.includes('export-evm'), 'export without a fresh sign-in: refused, nothing exported')
S.markSignedIn()
await S.privyExport('evm', 'x')
await S.privyExport('sol', 'x')
check(calls.join() === 'export-evm,export-sol', 'export just after a sign-in: Privy’s window for each key')
calls.length = 0
S.setPrivyState({ mfa: true, lastAuthAt: null })
await S.privyExport('evm', 'x')
check(calls.join() === 'mfa,export-evm', 'with two-step verification: Privy’s code first, then the key')
const mfaFail = await rejects((S.registerPrivy({ ...actions, promptMfa: async () => { throw new Error('mfa cancelled') } }), S.privyExport('evm', 'x')))
check(mfaFail instanceof Error && (mfaFail as Error).message === 'mfa cancelled', 'a cancelled code: no export')
S.registerPrivy(actions)
S.setPrivyState({ mfa: false })

calls.length = 0
S.setPrivyState({ authenticated: false })
const signIn = S.privySignIn()
await new Promise(r => setTimeout(r, 150))
check(calls.join() === 'login', 'sign in: Privy’s window opens')
S.loginSettled(null)
check((await rejects(signIn)) === null, '…and it resolves when the sign-in completes')
check(S.takePrivyConnectWish() && !S.takePrivyConnectWish(), 'a sign-in here asks for the wallet to connect, once')
const cancelled = S.privySignIn()
await new Promise(r => setTimeout(r, 150))
S.loginSettled('exited_auth_flow')
const why = await rejects(cancelled)
check(why instanceof Error && (why as { cancelled?: boolean }).cancelled === true, 'closing Privy’s window: a cancellation, not an error to show')
check(!S.takePrivyConnectWish(), '…and nothing waits to connect afterwards')
S.setPrivyState({ started: false })
S.initPrivy('privy')
check(S.privyState().started && S.takePrivyConnectWish(), 'the wallet in use last time: Privy loads and reconnects it')

console.log('the Solana wallet')
const sw = await import('../src/arcdex/lib/solanaWallet')
const { Keypair, TransactionMessage, VersionedTransaction, Transaction } = await import('@solana/web3.js')
const kp = Keypair.generate()
const signedBy: Uint8Array[] = []
sw.setPrivySolana({
  address: kp.publicKey.toBase58(),
  signTransaction: async bytes => { signedBy.push(bytes); const t = VersionedTransaction.deserialize(bytes); t.sign([kp]); return t.serialize() },
  signMessage: async m => Uint8Array.from(m.map(x => x ^ 1)),
})
check(sw.signerAddress('external') === kp.publicKey.toBase58(), 'with no wallet app connected, Privy’s Solana wallet is the one that signs')
const vt = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message())
const out = await sw.signSolana('external', vt)
check(signedBy.length === 1 && out.signatures[0].some(b => b !== 0), 'a transaction goes to Privy as bytes and comes back signed')
check((await rejects(sw.signSolana('external', new Transaction() as never))) instanceof Error, 'a legacy transaction is refused, not mangled')
check((await sw.signSolanaMessage(Uint8Array.of(1, 2)))[0] === 0, 'messages are signed by Privy too')
sw.setPrivySolana(null)
check(sw.signerAddress('external') === null, 'signed out: no Solana signer')

console.log('the wagmi connector')
const { wagmiConfig } = await import('../src/arcdex/wagmi')
const conn = wagmiConfig.connectors.find(c => c.id === 'privy')
check(!!conn && conn.type === 'injected', 'a `privy` connector is in the app’s wagmi config')
S.setPrivyEvmProvider(null)
check((await conn!.getProvider()) === undefined, 'no provider until Privy has made the wallet')
const fake = { request: async () => null, on: () => {}, removeListener: () => {} }
S.setPrivyEvmProvider(fake)
// wagmi looks for providers only in a browser.
const g = globalThis as { window?: unknown }
const hadWindow = 'window' in g
g.window ??= globalThis
check((await conn!.getProvider()) === fake, 'then the wallet’s own EIP-1193 provider')
if (!hadWindow) delete g.window
S.setPrivyEvmProvider(null)

console.log('the withdraw guard, rendered')
const { useWithdrawGuard, PasscodeField } = await import('../src/arcdex/components/WithdrawGuard')
type Guard = ReturnType<typeof useWithdrawGuard>
function guardFor(trader: { address: `0x${string}` | null; kind: 'wallet' | 'trading-wallet' | null }, to: string): { g: Guard; html: string } {
  let g: Guard | null = null
  function Form() { g = useWithdrawGuard(trader, to, 10); return <PasscodeField guard={g} /> }
  const html = renderToStaticMarkup(<Form />)
  return { g: g!, html }
}
S.setPrivyState({ ready: true, authenticated: true, evm: EVM, sol: SOL, mfa: false, lastAuthAt: null })
const away = guardFor({ address: EVM, kind: 'wallet' }, AWAY)
check(away.g.privy && away.g.privyStep === 'relogin' && away.g.missing, 'Privy sending elsewhere, no fresh sign-in: the send waits')
check(away.html.includes('data-testid="privy-stepup"') && away.html.includes('Sign in again'), '…and says why, with Sign in again')
check((await rejects(away.g.confirm())) instanceof S.StepUpRequired, '…and confirm refuses it')
for (const [to, what] of [[EVM, 'its own EVM address'], [SOL, 'its own Solana address'], ['', 'no address yet']] as const) {
  const r = guardFor({ address: EVM, kind: 'wallet' }, to)
  check(r.g.privyStep === 'none' && !r.g.missing && !r.html.includes('privy-stepup'), `to ${what}: no step-up`)
}
S.markSignedIn()
const fresh = guardFor({ address: EVM, kind: 'wallet' }, AWAY)
check(fresh.g.privyStep === 'none' && !fresh.g.missing && (await rejects(fresh.g.confirm())) === null, 'just signed in: the send goes ahead')
calls.length = 0
S.setPrivyState({ mfa: true, lastAuthAt: null })
const mfa = guardFor({ address: EVM, kind: 'wallet' }, AWAY)
check(mfa.g.privyStep === 'mfa' && !mfa.g.missing && mfa.html.includes('two-step verification code'), 'two-step verification on: Privy will ask for the code')
await mfa.g.confirm()
check(calls.join() === 'mfa', '…and confirm asks for it')
const other = guardFor({ address: AWAY as `0x${string}`, kind: 'wallet' }, EVM)
check(!other.g.privy && other.g.privyStep === 'none' && !other.g.missing, 'another connected wallet: untouched (it confirms in its own app)')
S.setPrivyState({ authenticated: false })
check(!guardFor({ address: EVM, kind: 'wallet' }, AWAY).g.privy, 'signed out: not a Privy send')

console.log('the source')
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const { readdirSync, statSync } = await import('node:fs')
const files = (d: string): string[] => readdirSync(new URL(`../${d}`, import.meta.url)).flatMap(f => statSync(new URL(`../${d}/${f}`, import.meta.url)).isDirectory() ? files(`${d}/${f}`) : [`${d}/${f}`])
const importers = files('src').filter(f => /\.tsx?$/.test(f) && /from '@privy-io\/react-auth|import\('[^']*PrivyRoot'\)|from '[^']*PrivyRoot'/.test(src(f)))
check(importers.length === 2 && importers.includes('src/arcdex/privy/PrivyRoot.tsx') && importers.includes('src/arcdex/privy/PrivyHost.tsx'), `Privy's SDK is imported by PrivyRoot only, and PrivyRoot by its host only (${importers.join(', ')})`)
check(/lazy\(\(\) => import\('\.\/PrivyRoot'\)\)/.test(src('src/arcdex/privy/PrivyHost.tsx')), '…lazily, so no other page carries it')
check(!/console\.(log|info|debug)/.test(files('src/arcdex/privy').map(src).join('\n')), 'nothing in the Privy code logs')
check(/c\.type === 'injected' && c\.id !== 'privy'/.test(src('src/arcdex/components/ConnectWallet.tsx')), 'the connect window doesn’t list Privy’s connector as a browser wallet')
check(/initPrivy\(recent \?\? null\)\s*\n\s*if \(!recent \|\| recent === 'privy'\) return/.test(src('src/arcdex/lib/reconnect.ts')), 'a Privy session is restored by Privy, not by wagmi’s reconnect')
check(/const guarded = fromTrading \|\| guard\.privy/.test(src('src/arcdex/pages/Bridge.tsx')) && /if \(guarded\) \{\s*\n\s*try \{ await guard\.confirm\(\) \}/.test(src('src/arcdex/pages/Bridge.tsx')), 'the bridge holds a Privy send for its step-up')
const csp = src('netlify.toml').match(/Content-Security-Policy = "([^"]+)"/)?.[1] ?? ''
check(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/.test(csp) && /frame-src 'self' https:/.test(csp), 'the CSP lets in Privy’s frames (https:) and its bot check (Turnstile)')
const root = src('src/arcdex/privy/PrivyRoot.tsx')
check(/showWalletUIs: false/.test(root) && !/showWalletUIs: true/.test(root), 'Privy’s own wallets sign trades, approvals and sign-in messages without a confirmation window (2026-10-18)')
check(/platform = connector\?\.id === 'privy'/.test(src('src/arcdex/components/WalletPrompt.tsx')) && /embedded \|\| platform \|\|/.test(src('src/arcdex/components/WalletPrompt.tsx')), 'no “another network” bar for Privy’s wallet: every Arc send switches it first, silently')
check(/walletConnectCloudProjectId: WC_PROJECT_ID/.test(root) && /'wallet_connect'/.test(root) && /export const WC_PROJECT_ID/.test(src('src/arcdex/wagmi.ts')), 'Privy’s wallet list opens phone wallets through WalletConnect, with the same project id as wagmi')
check(/"@privy-io\/react-auth": "\d+\.\d+\.\d+"/.test(src('package.json')), 'the SDK is pinned to an exact version')
// Netlify's secret scan fails a deploy on values that look like secrets: the publishable keys inside Privy's SDK are
// listed as public in netlify.toml, and the app id's variable is left out of the scan.
const sdkKeys = [...new Set(files('node_modules/@privy-io/react-auth/dist/esm').filter(f => f.endsWith('.mjs')).flatMap(f => src(f).match(/pk_(?:live|test)_[0-9A-Za-z]{10,}/g) ?? []))].sort()
const omitted = (src('netlify.toml').match(/SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES = "([^"]*)"/)?.[1] ?? '').split(',').filter(Boolean).sort()
check(JSON.stringify(sdkKeys) === JSON.stringify(omitted), `netlify.toml lists exactly the publishable keys Privy's SDK ships (${sdkKeys.length})`)
check(/SECRETS_SCAN_OMIT_KEYS = "[^"]*\bVITE_PRIVY_APP_ID\b/.test(src('netlify.toml')), 'the app id is left out of Netlify’s secret scan (it ships in the page by design)')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
