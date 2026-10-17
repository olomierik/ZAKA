// Copy trading from the user's own wallet (src/arcdex/lib/copyTrade.ts, copySettings.ts): sizing and the day's budget,
// the safety and price checks (ARCDEX's fee aside), proportional sales, the dry-pool revert, the rules' bounds and the
// browser storage. Offline. Live, nothing sent: VITE_ARCDEX_WS_URL=… bun scripts/check-copy-trade.ts
//   bun scripts/test-copy-trade.ts

// A browser's storage, for the settings, lots and log.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear(), key: () => null, length: 0,
}

const C = await import('../src/arcdex/lib/copyTrade')
const { t } = await import('../src/arcdex/lib/i18n')
const { COPY, DEFAULT_RULE, cleanRule, planBuy, safetyAllows, priceAllows, sellAmount, dryPool } = C

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), ME = '0x' + 'cc'.repeat(20)
const why = (p: unknown) => (p && typeof p === 'object' && 'why' in p ? t((p as { why: string }).why, (p as { whyVars?: Record<string, string | number> }).whyVars) : '')

console.log('sizing')
const on = { on: true, dailyCapUsd: 50 }
const rule = DEFAULT_RULE(A)
let p = planBuy({ rule, settings: on, spentTodayUsd: 0, cashUsd: 100, leaderUsd: 400, ageMs: 2_000 })
check('usd' in p && p.usd === 5, 'fixed: $5 a copy, whatever the leader spent')
p = planBuy({ rule: { ...rule, sizing: 'match', maxUsd: 40 }, settings: on, spentTodayUsd: 0, cashUsd: 100, leaderUsd: 12.345, ageMs: 2_000 })
check('usd' in p && p.usd === 12.34, 'match: the leader’s own size, rounded down to the cent')
p = planBuy({ rule: { ...rule, sizing: 'match', maxUsd: 40 }, settings: on, spentTodayUsd: 0, cashUsd: 100, leaderUsd: 900, ageMs: 2_000 })
check('usd' in p && p.usd === 40, 'match: never past the rule’s most')
p = planBuy({ rule: { ...rule, maxUsd: 30 }, settings: on, spentTodayUsd: 42, cashUsd: 100, leaderUsd: 30, ageMs: 2_000 })
check('usd' in p && p.usd === 8, 'what’s left of the day’s budget: $8 of $50')
p = planBuy({ rule, settings: on, spentTodayUsd: 49.5, cashUsd: 100, leaderUsd: 30, ageMs: 2_000 })
check(why(p) === 'the day’s budget is spent', 'under $1 of budget left: skipped, and says so')
p = planBuy({ rule, settings: on, spentTodayUsd: 0, cashUsd: 3.3, leaderUsd: 30, ageMs: 2_000 })
check('usd' in p && p.usd === 3, 'the wallet’s cash less the gas reserve ($3.30 → $3)')
p = planBuy({ rule, settings: on, spentTodayUsd: 0, cashUsd: 1.2, leaderUsd: 30, ageMs: 2_000 })
check(why(p) === 'not enough USDC in the trading wallet', 'too little cash: skipped')
p = planBuy({ rule, settings: on, spentTodayUsd: 0, cashUsd: 100, leaderUsd: 30, ageMs: 61_000 })
check(why(p) === 'the leader’s trade reached ARCDEX 61s late', 'a trade over a minute old isn’t copied')
p = planBuy({ rule: { ...rule, on: false }, settings: on, spentTodayUsd: 0, cashUsd: 100, leaderUsd: 30, ageMs: 1_000 })
check(why(p) === 'this leader is paused', 'a paused leader isn’t copied')
p = planBuy({ rule, settings: { ...on, on: false }, spentTodayUsd: 0, cashUsd: 100, leaderUsd: 30, ageMs: 1_000 })
check(why(p) === 'copying is off', 'nothing is copied with copying off')
check(t('the leader’s trade reached ARCDEX {s}s late', { s: 61 }) !== '' && t('under the ${n} minimum', { n: 1 }) === 'under the $1 minimum', 'reasons read with their numbers filled in')

console.log('safety')
check(safetyAllows('danger', rule) !== null, 'Danger: never')
check(safetyAllows('unrated', rule) !== null && safetyAllows('checking', rule) !== null, 'a coin nothing has rated, or still being checked: not copied')
check(safetyAllows('risky', rule) === null, 'Risky under "Skip Danger": copied')
check(safetyAllows('risky', { ...rule, safety: 'safe-only' }) !== null && safetyAllows('safe', { ...rule, safety: 'safe-only' }) === null, '"Safe coins only": Risky skipped, Safe copied')

console.log('price against the leader’s')
check(priceAllows(1.02, 1, 3, 200) === null, 'paying 2% more because of ARCDEX’s 2% fee is no slippage')
check(priceAllows(1.02, 1, 1, 0) !== null, 'without the fee taken off, the same copy reads 2% worse')
const off = priceAllows(1.08, 1, 3, 200)
check(off !== null && off.whyVars?.pct === '5.8', 'a copy 5.8% worse at the pool is skipped, and says by how much')
check(priceAllows(0.97, 1, 3, 200) === null, 'a better price than the leader’s is fine')
check(priceAllows(0, 1, 3) === null && priceAllows(1, 0, 3) === null, 'no price to compare: not held up here (the minimum received still applies)')

console.log('sales')
check(sellAmount(1000n, 50n, 50n) === 500n, 'the leader sold half its holding: half the copied coins')
check(sellAmount(1000n, 99n, 1n) === 1000n, 'sold out (1% or less left): every copied coin goes')
check(sellAmount(1000n, 1n, 999n) === 1n, 'a sliver sold: a sliver sold')
check(sellAmount(0n, 50n, 50n) === 0n && sellAmount(1000n, 0n, 50n) === 0n, 'nothing copied, or nothing sold: nothing')

console.log('a pool with no liquidity at its price')
// Recorded from Arc's V4Quoter on 2026-10-17: NotEnoughLiquidity(poolId) in UnexpectedRevertBytes, after the pool's only
// position was withdrawn.
const RAW = '0x6190b2b0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000247a5ed7344cd0beeca9ecd944460741317062f9e02cd6370f197c37b3b54c623da42cc39100000000000000000000000000000000000000000000000000000000'
check(dryPool({ name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError', raw: RAW } }), 'the quoter’s wrapped NotEnoughLiquidity is a dry pool (a skip, not a failure)')
check(dryPool({ cause: { cause: { cause: { data: RAW } } } }), 'found deeper in the error chain too')
check(!dryPool({ cause: { raw: '0x6190b2b0' + '00'.repeat(64) + 'deadbeef' } }) && !dryPool(new Error('timeout')) && !dryPool(null), 'any other revert stays a failure')

console.log('rules')
const r = cleanRule({ leader: A.toUpperCase().replace('0X', '0x'), maxUsd: 9_999, slippagePct: 0, sizing: 'bogus' as never, safety: 'bogus' as never })
check(r.leader === A && r.maxUsd === COPY.maxUsd && r.slippagePct === COPY.minSlip && r.sizing === 'fixed' && r.safety === 'skip-danger', 'numbers and choices kept within bounds; addresses in lower case')
check(cleanRule({ leader: A, maxUsd: Number.NaN }).maxUsd === COPY.minUsd, 'a number that isn’t one is the minimum')

console.log('storage')
C.setCopySettings({ dailyCapUsd: 1e9, on: true })
check(C.getCopySettings().dailyCapUsd === COPY.maxDailyUsd, 'the day’s budget is capped at $5,000')
C.upsertRule(DEFAULT_RULE(A))
C.upsertRule({ leader: A, maxUsd: 25 })
check(C.getCopySettings().rules.length === 1 && C.getCopySettings().rules[0].maxUsd === 25, 'a rule is changed in place, not added twice')
for (let i = 0; i < COPY.maxLeaders - 1; i++) C.upsertRule(DEFAULT_RULE('0x' + i.toString(16).padStart(40, '0')))
let threw = false
try { C.upsertRule(DEFAULT_RULE(B)) } catch { threw = true }
check(threw && C.getCopySettings().rules.length === COPY.maxLeaders, `a ${COPY.maxLeaders + 1}st leader is refused`)
C.upsertRule({ leader: A, on: false })
check(C.getCopySettings().rules.length === COPY.maxLeaders, 'a leader already copied can still be changed at the limit')
C.removeRule(A.toUpperCase().replace('0X', '0x'))
check(!C.getCopySettings().rules.some(x => x.leader === A), 'removed, whatever the case')
store.set('arcdex:copy:v1', JSON.stringify({ on: true, rules: [{ leader: 'nope' }, { leader: B, maxUsd: 7 }] }))
check(C.getCopySettings().rules.length === 1 && C.getCopySettings().rules[0].leader === B, 'a stored rule with a bad address is dropped')

const NOW = Date.UTC(2026, 9, 17, 12)
const ev = (o: Partial<import('../src/arcdex/lib/copySettings').CopyEvent>) => ({ id: String(Math.random()), at: NOW, leader: A, token: B, symbol: 'X', side: 'B' as const, status: 'filled' as const, usd: 10, ...o })
C.logEvent(ME, ev({}))
C.logEvent(ME, ev({ usd: 5, at: Date.UTC(2026, 9, 16, 23) }))
C.logEvent(ME, ev({ status: 'skipped', usd: undefined }))
C.logEvent(ME, ev({ side: 'S', usd: 40 }))
check(C.spentToday(ME, NOW) === 10, 'spent today: filled buys since 00:00 UTC only (not yesterday’s, skips or sales)')
for (let i = 0; i < 250; i++) C.logEvent(ME, ev({ status: 'skipped' }))
check(C.getCopyLog(ME).length === 200, 'the log keeps the newest 200')
C.setLots(ME, [{ leader: A, token: B, symbol: 'X', raw: '100', decimals: 18, spentUsd: 5, at: NOW }, { leader: B, token: B, symbol: 'X', raw: '0', decimals: 18, spentUsd: 5, at: NOW }])
check(C.getLots(ME).length === 1, 'sold-out lots are dropped')
check(C.getLots(ME.toUpperCase().replace('0X', '0x')).length === 1, 'kept per trading wallet, whatever the case')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
