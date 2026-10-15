// The site's side of the trade switch (src/arcdex/lib/tradeSwitch.ts): what assertTradingOn lets through.
//   bun scripts/test-trade-switch.ts
import type { TradeSwitchState } from '../api/_marketProtocol'
import { assertTradingOn, offReason, setTradeSwitchForTest, TradingPausedError } from '../src/arcdex/lib/tradeSwitch'
import { fourErrorText } from '../src/arcdex/lib/fourMeme'
import { relayErrorText } from '../src/arcdex/lib/relay'
import { txErrorText } from '../src/arcdex/lib/tx'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const refused = (p: Promise<void>) => p.then(() => null, (e: Error) => (e instanceof TradingPausedError ? e.message : `other error: ${e.message}`))
const state = (o: Partial<TradeSwitchState>): TradeSwitchState => ({ at: Date.now(), on: true, all: null, venues: {}, env: { all: false, venues: [] }, history: [], ...o })

console.log('nothing read yet (no engine, or it never answered)')
setTradeSwitchForTest(null)
check(await refused(assertTradingOn('arc')) === null, 'trades go ahead: trading doesn\'t depend on the engine being up')

console.log('one venue off')
setTradeSwitchForTest(state({ venues: { solana: { reason: 'Relay incident', at: 1 } } }))
check(await refused(assertTradingOn('solana')) === 'Trading on Solana is paused: Relay incident', 'a Solana trade is refused before signing, with where and why')
check(await refused(assertTradingOn('arc')) === null, 'an Arc trade goes ahead')
check(offReason('bnb') === null, 'BNB Chain is on')

console.log('everything off')
setTradeSwitchForTest(state({ on: false, all: { reason: 'incident drill', at: 1 }, venues: { bnb: { reason: 'four.meme upgrade', at: 1 } } }))
for (const v of ['arc', 'robinhood', 'solana', 'starknet', 'hyperliquid'] as const) check((await refused(assertTradingOn(v)))?.endsWith('is paused: incident drill') === true, `${v}: refused, with the reason for everything`)
check(offReason('bnb') === 'incident drill', 'the reason for everything comes first')

console.log('the reason reaches the trader word for word')
// A reason with words the error helpers look for ("cancel", "min", "denied") must not turn into "You cancelled" or "slippage".
const paused = new TradingPausedError('Trading on BNB Chain is paused: admin cancelled routing, min risk, access denied')
for (const [name, f] of [['txErrorText', txErrorText], ['relayErrorText', relayErrorText], ['fourErrorText', fourErrorText]] as const) check(f(paused) === paused.message, `${name} shows it as is`)

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
