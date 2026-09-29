// Which token contract code and which v4 pool hooks recent Argus launches
// use, grouped. Feeds the safety scanner's allowlist of launchpad token
// templates (engine/src/intel/templates.ts): a token whose code matches its
// launchpad's standard template can't have a mint, blacklist or sell block
// that the template doesn't.
//
//   bun engine/scripts/launch-templates.ts [blocks=6000]
//
// Read-only: getLogs, receipts and getCode on public endpoints.

import { RECENT_RPC, headBlock, rpcBatch, scanLogs, type RawLog } from '../../api/_arcLogs'
import { POOL_MANAGER, V4_INITIALIZE, topicAddress, word } from '../../api/_arcSwaps'
import { P7_LAUNCH, P8_LAUNCHED, PORTAL7, PORTAL8 } from '../src/launchpads/argus'

const blocks = Number(process.argv[2] ?? 6_000)
const head = await headBlock()
const r = await scanLogs<RawLog[]>({ address: [PORTAL7, PORTAL8], topics: [[P7_LAUNCH, P8_LAUNCHED]] }, head - blocks, head, { head, reduce: l => l, deadline: Date.now() + 60_000 })
const launches = r.parts.flat()
console.log(`${launches.length} Argus launches in the last ${blocks} blocks (to ${r.scannedTo})`)

const hash = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 12)
/** Code with the token's own address (immutables that store `address(this)`) masked. */
export const normalize = (code: string, self: string) => code.toLowerCase().split(self.slice(2).toLowerCase()).join('_'.repeat(40))

/** EIP-1167 minimal proxy (45 bytes): the implementation it delegates to. */
export const cloneTarget = (code: string) => {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code)
  return m ? '0x' + m[1].toLowerCase() : null
}
/** v4 hook permissions: the low 14 bits of its address. */
const FLAGS = ['afterRemoveLiquidityReturnDelta', 'afterAddLiquidityReturnDelta', 'afterSwapReturnDelta', 'beforeSwapReturnDelta', 'afterDonate', 'beforeDonate', 'afterSwap', 'beforeSwap', 'afterRemoveLiquidity', 'beforeRemoveLiquidity', 'afterAddLiquidity', 'beforeAddLiquidity', 'afterInitialize', 'beforeInitialize']
export const hookFlags = (hook: string) => { const bits = parseInt(hook.slice(-4), 16) & 0x3fff; return FLAGS.filter((_, i) => bits & (1 << i)) }

const rows: { portal: number; token: string; codeKey: string; impl: string | null; hooks: string | null; hookKey: string | null; flags: string }[] = []
for (let i = 0; i < launches.length; i += 50) {
  const batch = launches.slice(i, i + 50)
  const tokens = batch.map(l => topicAddress(l.topics[1]))
  const [codes, receipts] = await Promise.all([
    rpcBatch<string>(RECENT_RPC, tokens.map(t => ({ method: 'eth_getCode', params: [t, 'latest'] }))),
    rpcBatch<{ logs: RawLog[] }>(RECENT_RPC, batch.map(l => ({ method: 'eth_getTransactionReceipt', params: [l.transactionHash] }))),
  ])
  batch.forEach((l, j) => {
    const token = tokens[j]
    const code = codes[j] ?? '0x'
    const init = receipts[j]?.logs.find(x => x.address.toLowerCase() === POOL_MANAGER && x.topics[0] === V4_INITIALIZE && (topicAddress(x.topics[2]) === token || topicAddress(x.topics[3]) === token))
    const hooks = init ? '0x' + word(init.data, 2).slice(24) : null
    rows.push({ portal: l.address.toLowerCase() === PORTAL7 ? 7 : 8, token, codeKey: `${(code.length - 2) / 2}B ${hash(normalize(code, token))}`, impl: cloneTarget(code), hooks, hookKey: null, flags: hooks ? hookFlags(hooks).join('+') : '' })
  })
}
// The hooks' own code, and the code behind cloned tokens.
const hookAddrs = rows.map(x => x.hooks).filter((h): h is string => !!h)
const hookCodes = await rpcBatch<string>(RECENT_RPC, hookAddrs.map(h => ({ method: 'eth_getCode', params: [h, 'latest'] })))
const hookKey = new Map(hookAddrs.map((h, i) => { const c = hookCodes[i] ?? '0x'; const t = cloneTarget(c); return [h, t ? `clone of ${t}` : `${(c.length - 2) / 2}B ${hash(normalize(c, h))}`] }))
for (const x of rows) x.hookKey = x.hooks ? hookKey.get(x.hooks) ?? null : null
const impls = [...new Set(rows.map(x => x.impl).filter((i): i is string => !!i))]
const implCodes = await rpcBatch<string>(RECENT_RPC, impls.map(i => ({ method: 'eth_getCode', params: [i, 'latest'] })))
impls.forEach((i, k) => console.log(`clone implementation ${i}: ${((implCodes[k] ?? '0x').length - 2) / 2} bytes, code ${hash(implCodes[k] ?? '')}`))

for (const portal of [7, 8]) {
  const mine = rows.filter(x => x.portal === portal)
  if (!mine.length) continue
  const count = (key: (x: typeof rows[number]) => string) => {
    const m = new Map<string, number>()
    for (const x of mine) m.set(key(x), (m.get(key(x)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }
  console.log(`\nPortal ${portal}: ${mine.length} launches`)
  console.log('  token code:', count(x => x.codeKey).slice(0, 6).map(([k, n]) => `${n}× ${k}`).join(' | '))
  console.log('  token impl:', count(x => x.impl ?? 'not a clone').slice(0, 4).map(([k, n]) => `${n}× ${k}`).join(' | '))
  console.log('  hook code: ', count(x => x.hookKey ?? 'none found').slice(0, 6).map(([k, n]) => `${n}× ${k}`).join(' | '))
  console.log('  hook flags:', count(x => x.flags || 'none').slice(0, 4).map(([k, n]) => `${n}× ${k}`).join(' | '))
  const odd = mine.filter(x => x.codeKey !== count(y => y.codeKey)[0][0]).slice(0, 5)
  if (odd.length) console.log('  not the usual code, e.g.:', odd.map(x => x.token).join(', '))
}
