// Offline test of the wallet tracker's site side (lib/walletTracker.ts, the /tracker routes): which addresses can be
// followed, following and unfollowing (the limit, labels, duplicates in any case), matching a trade to its wallet, the
// coin page a trade opens, and the routes. Run: bun scripts/test-wallet-tracker.ts

const wt = await import('../src/arcdex/lib/walletTracker')
const { pageToPath, pathToPage } = await import('../src/arcdex/lib/router')

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const throws = (f: () => unknown, msg: string, m: string) => { try { f() } catch (e) { if ((e as Error).message === msg) { console.log('  ✓', m); return } throw e } throw new Error('FAIL: ' + m) }
const EVM = '0xAbCdEf0000000000000000000000000000001234'
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

console.log('addresses')
ok(wt.normWallet(` ${EVM} `) === EVM.toLowerCase(), 'an EVM address is kept in lower case, trimmed')
ok(wt.normWallet(SOL) === SOL, 'a Solana address keeps its case')
ok(wt.normWallet('0x1234') === null && wt.normWallet('hello world') === null && wt.normWallet('0OIl' + 'x'.repeat(30)) === null, 'anything else is refused')

console.log('following')
const a = wt.trackWallet(EVM, 'whale')
ok(a.address === EVM.toLowerCase() && a.label === 'whale' && a.alerts, 'a wallet is followed with its label, alerts on')
wt.trackWallet(EVM.toUpperCase().replace('0X', '0x'))
ok(wt.getTracked().length === 1, 'the same wallet in another case isn’t added twice')
wt.trackWallet(SOL)
ok(wt.getTracked()[0].address === SOL && wt.isTracked(SOL) && wt.isTracked(EVM), 'the newest first; both followed')
wt.updateTracked(EVM, { label: 'x'.repeat(50), alerts: false })
const e = wt.getTracked().find(w => w.address === EVM.toLowerCase())!
ok(e.label.length === 32 && !e.alerts, 'labels are cut to 32 characters; alerts can be turned off')
throws(() => wt.trackWallet('nope'), 'not a wallet address', 'a bad address is refused')
for (let i = 0; wt.getTracked().length < wt.TRACK_LIMIT; i++) wt.trackWallet(`0x${i.toString(16).padStart(40, '0')}`)
throws(() => wt.trackWallet('0x' + 'f'.repeat(40)), 'limit', `no more than ${wt.TRACK_LIMIT} wallets`)
wt.untrackWallet(SOL)
ok(!wt.isTracked(SOL) && wt.getTracked().length === wt.TRACK_LIMIT - 1, 'unfollowing removes it')

console.log('trades and pages')
const list = wt.getTracked()
ok(wt.ownerOf({ w: EVM, c: 'bnb' }, list)?.address === EVM.toLowerCase(), 'an EVM trade on any chain finds its wallet, in any case')
ok(wt.ownerOf({ w: SOL.toLowerCase(), c: 'sol' }, [{ address: SOL, label: '', added: 0, alerts: true }]) === null, 'a Solana trade matches its address exactly')
ok(JSON.stringify(wt.coinPageOf('arc', '0xAB')) === JSON.stringify({ name: 'argus', address: '0xab', pool: '' }), 'an Arc coin opens its coin page')
ok(wt.coinPageOf('sol', 'MintAbc').name === 'sol-token' && (wt.coinPageOf('sol', 'MintAbc') as { address: string }).address === 'MintAbc', 'a Solana coin keeps its case')
ok(wt.coinPageOf('hood', '0xA').name === 'rh-token' && wt.coinPageOf('bnb', '0xA').name === 'bsc-token', 'Robinhood Chain and BNB Chain coins open theirs')

console.log('routes')
ok(pageToPath({ name: 'tracker' }) === '/tracker' && pageToPath({ name: 'tracker', address: SOL }) === `/tracker/${SOL}`, 'the tracker and one wallet on it')
ok(JSON.stringify(pathToPage(`/tracker/${EVM}`, '')) === JSON.stringify({ name: 'tracker', address: EVM.toLowerCase() }), 'an EVM wallet link, lower case')
ok(JSON.stringify(pathToPage(`/track/${SOL}`, '')) === JSON.stringify({ name: 'tracker', address: SOL }), 'a Solana wallet link, as written')
ok(JSON.stringify(pathToPage('/tracker/not-a-wallet', '')) === JSON.stringify({ name: 'tracker' }), 'anything else opens the tracker')
console.log('\nall wallet-tracker checks passed')
