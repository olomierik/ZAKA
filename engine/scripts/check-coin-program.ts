// Runs $ARCDEX's ledger (src/coin/program.ts) against Arc mainnet, in memory, nothing saved or sent:
// every burn since the coin was created, the dead address's balance, and the fee wallet's activity
// since the program started. Prints what the landing page would show.
// Run: bun engine/scripts/check-coin-program.ts [rpc-url] [--out view.json]
import { HttpRpc } from '../src/chain/http'
import { CoinProgram } from '../src/coin/program'
import { setLogLevel } from '../src/log'

setLogLevel('warn')
// The engine's own default endpoints (config.ts ARC_HTTP_URLS); old blocks' burns come from the archives (api/_arcLogs.ts).
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : null
const urls = args[0] ? [args[0]] : ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io']
const settings = new Map<string, string>()
const p = new CoinProgram({
  rpc: new HttpRpc(urls),
  settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } },
  priceOf: () => null,
})
const started = Date.now()
for (let i = 0; i < 40; i++) {
  await p.tick(Date.now() + 20_000)
  const v = p.view()
  process.stdout.write(`\rtick ${i + 1}: fee ledger to ${v.scannedTo}, burns to ${v.burned.scannedTo}, ${v.burned.count} burns   `)
  if (v.burned.complete && v.scannedTo > 0) break
}
const v = p.view()
console.log(`\n\ndone in ${Math.round((Date.now() - started) / 1000)}s`)
console.log('burned', v.burned)
console.log('burned by day', v.burnDays)
console.log('latest burns', v.burns.slice(0, 5).map(b => ({ amount: b.amount, from: b.from, at: b.at ? new Date(b.at).toISOString() : null, tx: b.tx })))
console.log('totals', v.totals)
console.log('actions', v.actions.slice(0, 5))
if (out) { await Bun.write(out, JSON.stringify(v)); console.log('view written to', out) }
