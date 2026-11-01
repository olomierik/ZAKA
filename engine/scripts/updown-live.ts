// Runs the BTC Up/Down autotrader (src/updown) locally against Polymarket's live markets, on paper, and prints what it
// sees every 15 s: each live window's price to beat, the engine's BTC estimate, the model against the market, the edge
// after fees and why it isn't trading, then the paper book. Nothing is signed or sent anywhere.
// Run: bun engine/scripts/updown-live.ts [minutes]
import { UpdownService } from '../src/updown/service'

const settings = new Map<string, string>()
const svc = new UpdownService({ store: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } } })
await svc.load()
svc.start()
const until = Date.now() + Number(process.argv[2] ?? 12) * 60_000
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`)
const timer = setInterval(() => {
  const s = svc.status()
  const f = s.feeds
  console.log(`\n${new Date().toISOString().slice(11, 19)} feeds ${f.sources.map(x => `${x.name}:${x.ageMs ?? '—'}ms basis ${x.basisBp ?? '?'}bp`).join(' ')} · book ${f.bookConnected ? 'on' : 'off'} lag ${f.bookLagMs ?? '—'}ms · vol ${f.volPct ?? '—'}% · geo ${JSON.stringify(f.geoblock)}`)
  for (const w of s.windows) console.log(`  ${w.slug} left ${w.secondsLeft}s open ${w.open ?? '—'} btc ${w.btc ?? '—'} model ${pct(w.model)} market ${pct(w.market)} up ${w.up.ask ?? '—'} down ${w.down.ask ?? '—'} edge ${w.edge ? `${w.edge.side} ${(w.edge.value * 100).toFixed(1)}¢` : '—'} · ${w.waiting ?? 'TRADING'}`)
  const st = s.stats
  console.log(`  paper: ${st.trades} trades (${st.open} open, ${st.won} won, ${st.lost} lost) staked $${st.staked.toFixed(2)} pnl $${st.pnl.toFixed(2)} missed ${st.missed} · brier model ${st.brier.model?.toFixed(4) ?? '—'} market ${st.brier.market?.toFixed(4) ?? '—'} (${st.brier.samples})`)
  if (Date.now() > until) { clearInterval(timer); svc.stop(); console.log(JSON.stringify(svc.trades(50), null, 1)); process.exit(0) }
}, 15_000)
