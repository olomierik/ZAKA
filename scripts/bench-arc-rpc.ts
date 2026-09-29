// Compares Arc endpoints from this machine: the dedicated one
// (VITE_ARC_RPC_URL / VITE_ARC_WSS_URL, read from .env by Bun), Arc's public
// RPC and Blockdaemon. It never prints the dedicated URLs (they carry a token).
// Run: bun scripts/bench-arc-rpc.ts
// Cost on QuickNode: about 50 calls (~1,000 credits) and 20s of new blocks.
//
// The dedicated endpoint only answers whitelisted referrers, so requests say
// they come from localhost, as a local dev page would.

const FAST = process.env.VITE_ARC_RPC_URL?.trim()
const FAST_WS = process.env.VITE_ARC_WSS_URL?.trim()
if (!FAST || !FAST_WS) { console.error('Set VITE_ARC_RPC_URL and VITE_ARC_WSS_URL in .env first.'); process.exit(1) }

const LOCAL = { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' }
const HTTP: [string, string, Record<string, string>][] = [
  ['dedicated', FAST, LOCAL],
  ['public', 'https://rpc.mainnet.arc.io', {}],
  ['blockdaemon', 'https://rpc.blockdaemon.mainnet.arc.io', {}],
]
const USDC_BALANCE = { to: '0x3600000000000000000000000000000000000000', data: '0x70a08231' + '0'.repeat(64) }

async function call(url: string, headers: Record<string, string>, method: string, params: unknown[]): Promise<{ ms: number; result?: unknown; error?: string }> {
  const t = performance.now()
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8_000) })
    const ms = performance.now() - t
    if (!r.ok) return { ms, error: `HTTP ${r.status}` }
    const j = await r.json() as { result?: unknown; error?: { message?: string } }
    return j.error ? { ms, error: j.error.message ?? 'rpc error' } : { ms, result: j.result }
  } catch (e) { return { ms: performance.now() - t, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 80) } }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const f = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '—').padStart(8)

console.log('Request speed (15 of each, one at a time; after a warm-up call)')
console.log('                 eth_blockNumber      eth_call (balance)   errors')
console.log('                 median     p90       median     p90')
for (const [name, url, h] of HTTP) {
  await call(url, h, 'eth_chainId', [])
  const bn: number[] = [], ec: number[] = []
  const errors = new Map<string, number>()
  const fail = (m: string) => errors.set(m, (errors.get(m) ?? 0) + 1)
  for (let i = 0; i < 15; i++) {
    const a = await call(url, h, 'eth_blockNumber', [])
    if (a.error) fail(a.error); else bn.push(a.ms)
    const b = await call(url, h, 'eth_call', [USDC_BALANCE, 'latest'])
    if (b.error) fail(b.error); else ec.push(b.ms)
  }
  console.log(`${name.padEnd(14)}${f(pct(bn, 0.5))}${f(pct(bn, 0.9))}  ${f(pct(ec, 0.5))}${f(pct(ec, 0.9))}   ${errors.size ? [...errors].map(([m, n]) => `${n}× ${m}`).join('; ') : 'none'}`)
}

console.log('\nFreshness (10 rounds, all asked at once): blocks behind the newest answer')
const behind: Record<string, number[]> = {}
for (let i = 0; i < 10; i++) {
  const got = await Promise.all(HTTP.map(([, url, h]) => call(url, h, 'eth_blockNumber', [])))
  const nums = got.map(g => (typeof g.result === 'string' ? parseInt(g.result, 16) : NaN))
  const top = Math.max(...nums.filter(Number.isFinite))
  HTTP.forEach(([name], j) => { if (Number.isFinite(nums[j])) (behind[name] ??= []).push(top - nums[j]) })
  await new Promise(r => setTimeout(r, 300))
}
for (const [name] of HTTP) {
  const b = behind[name] ?? []
  console.log(`${name.padEnd(14)}${b.length ? `avg ${(b.reduce((s, x) => s + x, 0) / b.length).toFixed(2)} blocks behind, newest in ${b.filter(x => x === 0).length}/${b.length}` : 'no answers'}`)
}

console.log('\nNew blocks over WebSocket (20s, newHeads on both at once)')
const seen: Record<string, Map<number, number>> = { dedicated: new Map(), public: new Map() }
const socks = ([['dedicated', FAST_WS, LOCAL], ['public', 'wss://rpc.mainnet.arc.io', {}]] as const).map(([name, url, headers]) => {
  const ws = new WebSocket(url, { headers } as never)
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }))
  ws.onmessage = ev => {
    const m = JSON.parse(String(ev.data)) as { params?: { result?: { number?: string } }; error?: { message?: string } }
    if (m.error) console.log(`  ${name}: ${m.error.message}`)
    const n = m.params?.result?.number
    if (n) seen[name].set(parseInt(n, 16), performance.now())
  }
  ws.onerror = () => console.log(`  ${name}: socket error`)
  return ws
})
await new Promise(r => setTimeout(r, 20_000))
socks.forEach(s => s.close())
const both = [...seen.dedicated.keys()].filter(n => seen.public.has(n))
const lead = both.map(n => seen.public.get(n)! - seen.dedicated.get(n)!)
console.log(`dedicated: ${seen.dedicated.size} blocks, public: ${seen.public.size} blocks, ${both.length} seen by both`)
if (lead.length) {
  const firstFast = lead.filter(x => x > 0).length
  console.log(`dedicated delivered first on ${firstFast}/${lead.length}; median lead ${Math.round(pct(lead, 0.5))} ms (positive = dedicated earlier), p10 ${Math.round(pct(lead, 0.1))} ms, p90 ${Math.round(pct(lead, 0.9))} ms`)
}
process.exit(0)
