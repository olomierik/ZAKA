// Offline test of the roadmap (src/arcdex/landing/roadmap.ts): the week-by-week
// dates, each phase's status on the landing page, and that every line is
// translated in all six languages.
// Run: bun scripts/test-roadmap.ts

const { ROADMAP_START, PHASE_DAYS, PHASES, LIVE_NOW, phaseDays, phaseRange, phaseStatus } = await import('../src/arcdex/landing/roadmap')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)

console.log('dates')
ok(new Date(`${ROADMAP_START}T00:00:00Z`).getUTCDay() === 1, `Phase 1 starts on a Monday (${ROADMAP_START})`)
ok(PHASE_DAYS >= 5 && PHASE_DAYS <= 7, `each phase takes 5–7 days (${PHASE_DAYS})`)
ok(PHASES.map(p => p.n).join() === '1,2,3,4,5,6,7', 'seven phases, numbered 1 to 7')
const [s1, e1] = phaseDays(1), [s7, e7] = phaseDays(7)
ok(iso(s1) === '2026-09-28' && iso(e1) === '2026-10-04', `Phase 1: ${iso(s1)} → ${iso(e1)}`)
ok(iso(s7) === '2026-11-09' && iso(e7) === '2026-11-15', `Phase 7: ${iso(s7)} → ${iso(e7)}`)
ok(PHASES.every(p => phaseDays(p.n)[0].getUTCDay() === 1 && phaseDays(p.n)[1].getUTCDay() === 0), 'every phase runs Monday to Sunday')
ok(PHASES.slice(1).every(p => phaseDays(p.n)[0].getTime() - phaseDays(p.n - 1)[1].getTime() === DAY), 'each phase starts the day after the last one ends: no gaps, no overlaps')
ok(/^28 Sept? – 4 Oct$/.test(phaseRange(1)), `range label: "${phaseRange(1)}"`)
ok(['fr', 'es', 'pt', 'sw', 'de', 'zh'].every(l => /28/.test(phaseRange(1, l)) && /4/.test(phaseRange(1, l))), `labels in every language (sw: "${phaseRange(1, 'sw')}", zh: "${phaseRange(1, 'zh')}")`)

console.log('status on the landing page')
const at = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min)
ok(PHASES.every(p => phaseStatus(p.n, at(2026, 9, 26, 12)) === 'next'), 'before the start (today, 26 Sep): all Planned')
ok(phaseStatus(1, at(2026, 9, 27, 23, 59)) === 'next' && phaseStatus(1, at(2026, 9, 28)) === 'now', 'Phase 1 turns In progress at 00:00 UTC on Monday 28 Sep')
ok(phaseStatus(1, at(2026, 10, 4, 23, 59)) === 'now' && phaseStatus(1, at(2026, 10, 5, 0, 1)) === 'done', 'and Done once Sunday 4 Oct is over')
for (let t = at(2026, 9, 28); t < at(2026, 11, 16); t += 6 * 3_600_000) {
  const now = PHASES.filter(p => phaseStatus(p.n, t) === 'now').map(p => p.n)
  if (now.length !== 1) throw new Error(`FAIL: ${new Date(t).toISOString()} has phases ${now.join()} in progress`)
}
ok(true, 'from 28 Sep to 15 Nov exactly one phase is In progress at a time')
ok(PHASES.every(p => phaseStatus(p.n, at(2026, 11, 16, 12)) === 'done'), 'after 15 Nov: all Done')

console.log('content and translations')
ok(LIVE_NOW.length === 6 && PHASES.every(p => p.items.length >= 3 && p.items.length <= 4), 'Phase 0 lists 6 live things; each phase has 3–4 items')
const lines = [...LIVE_NOW, ...PHASES.flatMap(p => [p.title, ...p.items.map(i => i.text)])]
ok(new Set(lines).size === lines.length, `${lines.length} lines, no duplicates`)
for (const l of ['fr', 'es', 'pt', 'sw', 'de', 'zh']) {
  const d = (await import(`../src/arcdex/lib/i18n/${l}.ts`) as { default: Record<string, string> }).default
  const missing = lines.filter(s => !d[s])
  ok(!missing.length, `${l}: every line translated${missing.length ? ` (missing: ${missing.join(' | ')})` : ''}`)
}
console.log('ALL ROADMAP CHECKS PASSED')
