// Learns code templates (engine/src/intel/templates.ts) from real contracts
// on Arc mainnet and writes engine/src/intel/templateData.ts. Each template
// needs several deployments of one contract: the bytes that differ between
// them are the values each deployment fills in, and everything else must
// match exactly for a contract to count as that launchpad's.
//
//   bun engine/scripts/learn-templates.ts            # write templateData.ts
//   bun engine/scripts/learn-templates.ts --check    # do today's contracts still match?
//
// Read-only (Blockdaemon getLogs, recent blocks).

import { writeFileSync } from 'node:fs'
import { RECENT_RPC, headBlock, hex, rpcBatch, rpcCall, scanLogs, type RawLog } from '../../api/_arcLogs'
import { POOL_MANAGER, V4_INITIALIZE, topicAddress } from '../../api/_arcSwaps'
import { MERCURI_FACTORY, MERCURI_TOKEN_CREATED, SOLONPAD_FACTORY, SOLON_TOKEN_LAUNCHED } from '../../api/_curves'
import { ARC_LAUNCHPAD, TOKEN_LAUNCHED } from '../src/launchpads/arcLaunchpad'
import { P7_LAUNCH, P8_LAUNCHED, PORTAL7, PORTAL8 } from '../src/launchpads/argus'
import { FAZE, FAZE_LAUNCHED } from '../src/launchpads/faze'
import { asAddress, filledIn, learnTemplate, matchesTemplate, type CodeTemplate } from '../src/intel/templates'

const check = process.argv.includes('--check')
const SAMPLE = 8

/** Recent logs of one event, newest last, over up to `blocks` blocks. */
async function recent(address: string, topic: string, blocks = 400_000): Promise<RawLog[]> {
  const head = await headBlock()
  const out: RawLog[] = []
  for (let to = head; to > head - blocks && out.length < SAMPLE * 3; to -= 100_000) {
    out.unshift(...await rpcCall<RawLog[]>(RECENT_RPC, 'eth_getLogs', [{ address, topics: [topic], fromBlock: hex(Math.max(0, to - 99_999)), toBlock: hex(to) }], 20_000))
  }
  return out
}
const codesOf = async (addrs: string[]) => (await rpcBatch<string>(RECENT_RPC, addrs.map(a => ({ method: 'eth_getCode', params: [a, 'latest'] })))).map(c => c ?? '0x')

interface Source {
  name: string
  /** Deployments to learn from: as varied as possible, so every value a deployment fills in varies. */
  addresses: () => Promise<string[]>
  /** Name masked ranges by a value known to sit there in a given deployment. */
  fields?: () => Promise<Record<string, { address: string; value: string }>>
}

// Peach: the launch event names each coin's own curve contract (topic 2).
const PEACH_LAUNCHER = '0x7e462d220b6b0a4c55b205b613133dc1c1cc9dc1'
const PEACH_LAUNCHED = '0x091220c7b93dbf022367afb0756ee792b7be2ca40436aa65722f233607784d62'

const PEACH_TRADE = '0xeab3e828d2fd17855f356495b10e91df9ddf7d934563edb3895cab88239f3596'
const USDC = '0x3600000000000000000000000000000000000000'
/** Contracts that emitted `topic` recently, from any address. */
async function emitters(topic: string, blocks = 500_000): Promise<string[]> {
  const head = await headBlock()
  const r = await scanLogs<string[]>({ topics: [topic] }, head - blocks, head, { head, reduce: logs => logs.map(l => l.address.toLowerCase()), deadline: Date.now() + 120_000 })
  return [...new Set(r.parts.flat())]
}

/** Logs of one event from one contract: Blockdaemon's recent range first, the archives if that finds too few. */
async function launches(address: string, topic: string, want = SAMPLE + 4): Promise<RawLog[]> {
  const head = await headBlock()
  let found: RawLog[] = []
  for (const blocks of [400_000, 3_000_000]) {
    const r = await scanLogs<RawLog[]>({ address, topics: [topic] }, Math.max(0, head - blocks), head, { head, reduce: l => l, deadline: Date.now() + 240_000 })
    found = r.parts.flat()
    if (found.length >= want) break
  }
  return found
}
const topic1 = (ls: RawLog[]) => ls.map(l => topicAddress(l.topics[1]))
/** The v4 hook each launch's pool was initialized with (from the launch transaction's receipt). */
async function launchHooks(ls: RawLog[]): Promise<string[]> {
  const rcs = await rpcBatch<{ logs: RawLog[] }>(RECENT_RPC, ls.slice(-SAMPLE * 2).map(l => ({ method: 'eth_getTransactionReceipt', params: [l.transactionHash] })))
  return rcs.flatMap(rc => rc?.logs.filter(x => x.address.toLowerCase() === POOL_MANAGER && x.topics[0] === V4_INITIALIZE).map(x => '0x' + x.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64)) ?? [])
    .filter(h => h !== '0x' + '0'.repeat(40))
}

// Coins traced to Aka.fun, o1 and Minara's launch contracts (engine/scripts/discover-launchpads.ts, 2026-09-30).
const TRACED: Record<string, string[]> = {
  'Aka.fun token': ['0x2a7a8c69a7462a2737a3b41188bc7a36d5555f2f', '0x6cf4e84588ae60f18c23a049bc55202d951a8e3d', '0xc5e17f0a9ee6fdac73c03e24fb4baacce9c58ea9'],
  'o1 token': ['0x28f986a61e078795639f239675582a12b4cf7f01', '0xafa78bc7c2e1142f4b2a225ae4aee17d6b7d7f01', '0xf80457274fa646c7a8e0942d48be703864ef3d01'],
  'Minara token': ['0xa163d7624da3b5d9182c50eab5b8cd247ae861bb', '0x1e849f5960f02503939cbcbd44ab99b6dfcc4735', '0x83fd0bdddafa9a499582899d49515060c361b9aa'],
}

const SOURCES: Source[] = [
  { name: 'Argus P7 hook', addresses: async () => launchHooks(await launches(PORTAL7, P7_LAUNCH)) },
  { name: 'Argus P8 token', addresses: async () => topic1(await launches(PORTAL8, P8_LAUNCHED)) },
  {
    name: 'Argus P8 hook',
    addresses: async () => (await launches(PORTAL8, P8_LAUNCHED)).map(l => '0x' + l.data.slice(26, 66)),
    // The escrow each launch's hook works with (Launched: hook, escrow, locker, …).
    fields: async () => { const l = (await launches(PORTAL8, P8_LAUNCHED)).at(-1)!; return { escrow: { address: '0x' + l.data.slice(26, 66), value: '0x' + l.data.slice(2 + 64 + 24, 2 + 128) } } },
  },
  { name: 'Peach token', addresses: async () => topic1(await launches(PEACH_LAUNCHER, PEACH_LAUNCHED)) },
  { name: 'Faze token', addresses: async () => topic1(await launches(FAZE, FAZE_LAUNCHED, 3)) },
  { name: 'Mercuri token', addresses: async () => topic1(await launches(MERCURI_FACTORY, MERCURI_TOKEN_CREATED, 3)) },
  { name: 'SolonPad token', addresses: async () => topic1(await launches(SOLONPAD_FACTORY, SOLON_TOKEN_LAUNCHED, 3)) },
  { name: 'ARCDEX token', addresses: async () => topic1(await launches(ARC_LAUNCHPAD, TOKEN_LAUNCHED, 3)) },
  ...Object.entries(TRACED).map(([name, addrs]) => ({ name, addresses: async () => addrs })),
  {
    // New launches and every curve that traded over ~3 days: curves quoted in
    // USDC and in other tokens, with different fee settings.
    name: 'Peach curve',
    addresses: async () => [
      ...(await recent(PEACH_LAUNCHER, PEACH_LAUNCHED)).map(l => topicAddress(l.topics[2])),
      ...await emitters(PEACH_TRADE),
    ],
    // The quote token: a launch whose event names USDC.
    fields: async () => {
      const l = (await recent(PEACH_LAUNCHER, PEACH_LAUNCHED)).find(x => ('0x' + x.data.slice(26, 66)).toLowerCase() === USDC)!
      return { quote: { address: topicAddress(l.topics[2]), value: USDC } }
    },
  },
]

const learned: Record<string, CodeTemplate> = {}
let failures = 0
for (const src of SOURCES) {
  const addrs = [...new Set(await src.addresses())].slice(-SAMPLE * 6)
  const codes = (await codesOf(addrs)).filter(c => c !== '0x')
  if (check) {
    const { TEMPLATES } = await import('../src/intel/templateData')
    const t = TEMPLATES[src.name]
    const ok = codes.filter(c => t && matchesTemplate(c, t)).length
    console.log(`${src.name}: ${ok}/${codes.length} of today's contracts match the stored template`)
    if (ok < codes.length) failures++
    continue
  }
  // Learn from all but a few, confirm the template on those it didn't see.
  const learnFrom = codes.slice(0, Math.max(3, codes.length - 4)), confirm = codes.slice(learnFrom.length)
  let t: CodeTemplate
  try { t = learnTemplate(src.name, learnFrom) } catch (e) { console.log(`${src.name}: can't learn from ${codes.length} contracts: ${(e as Error).message}`); failures++; continue }
  if (src.fields) {
    t.fields = {}
    for (const [name, { address, value }] of Object.entries(await src.fields())) {
      const [code] = await codesOf([address])
      const i = filledIn(code, t).findIndex(v => (asAddress(v) ?? v) === value.toLowerCase())
      if (i < 0) { console.log(`${src.name}: couldn't find ${name} (${value}) in ${address}`); failures++; continue }
      t.fields[name] = i
    }
  }
  const ok = confirm.filter(c => matchesTemplate(c, t)).length
  console.log(`${src.name}: ${t.size}B, ${t.mask.length} varying ranges ${JSON.stringify(t.mask)}; ${ok}/${confirm.length} unseen instances match`)
  if (ok < confirm.length) { failures++; continue }
  learned[src.name] = t
}

if (!check) {
  // A source that couldn't be relearned this time keeps its last template.
  const { TEMPLATES: previous } = await import('../src/intel/templateData').catch(() => ({ TEMPLATES: {} as Record<string, CodeTemplate> }))
  for (const src of SOURCES) if (!learned[src.name] && previous[src.name]) { learned[src.name] = previous[src.name]; console.log(`${src.name}: kept the previous template`) }
  const body = `// Generated by engine/scripts/learn-templates.ts from contracts on Arc mainnet: do not edit.
// Learned ${new Date().toISOString().slice(0, 10)}. Still current? bun engine/scripts/learn-templates.ts --check

import type { CodeTemplate } from './templates'

export const TEMPLATES: Record<string, CodeTemplate> = ${JSON.stringify(learned, null, 2)}
`
  writeFileSync(new URL('../src/intel/templateData.ts', import.meta.url), body)
  console.log(`wrote engine/src/intel/templateData.ts (${Object.keys(learned).length} templates)`)
}
if (failures) { console.error(`${failures} template(s) failed`); process.exit(1) }
