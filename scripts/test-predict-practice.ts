// Practice predictions, the site's side (components/PredictPractice.tsx, api/_practiceProtocol.ts), on Hyperliquid's
// recorded prediction markets (scripts/fixtures/hl-outcomes.json): the engine's "when it ends" agrees with the page's
// for every market, each one has a readable name and sides, prices and names behave. The engine's book has its own
// tests (engine/test/predictPractice.test.ts).
//
//   bun scripts/test-predict-practice.ts

import { readFileSync } from 'node:fs'
import { describeOutcome, type RawOutcome, type RawQuestion } from '../src/arcdex/hl/markets'
import { cleanPracticeName, practiceEndsAt, sideMid, type PracticeSpec } from '../api/_practiceProtocol'

let failed = 0
const check = (ok: boolean, what: string) => { if (!ok) { failed++; console.log(`✗ ${what}`) } }

const meta = JSON.parse(readFileSync(new URL('./fixtures/hl-outcomes.json', import.meta.url), 'utf8')) as { outcomes: RawOutcome[]; questions: RawQuestion[] }
const qOf = new Map<number, RawQuestion>()
for (const q of meta.questions) for (const id of [...q.namedOutcomes, q.fallbackOutcome]) qOf.set(id, q)

// The engine refuses buys after a market's end; it must read the same end the page shows.
let ends = 0
for (const o of meta.outcomes) {
  const q = qOf.get(o.outcome) ?? null
  const spec: PracticeSpec = { o: { outcome: o.outcome, name: o.name, description: o.description, sideSpecs: o.sideSpecs }, q }
  const page = describeOutcome(o, q)
  const engine = practiceEndsAt(spec)
  check(engine === page.endsAt, `ends at for #${o.outcome}: engine ${engine}, page ${page.endsAt}`)
  if (engine !== null) ends++
  check(page.title.length > 0 && page.sides[0].name.length > 0 && page.sides[1].name.length > 0, `#${o.outcome} has a name and two sides`)
  check(!/\{\w+\}|template:/.test(page.title + page.sides[0].name + page.sides[1].name), `#${o.outcome} has no raw template words: ${page.title} / ${page.sides.map(s => s.name).join(' / ')}`)
}
check(ends > meta.outcomes.length / 2, `most markets say when they end (${ends} of ${meta.outcomes.length})`)

// Prices: a side's own mid, else the other's complement; nothing at 0 or 1.
check(sideMid({ '#104640': 0.42 }, 10464, 0) === 0.42, 'own mid')
check(Math.abs((sideMid({ '#104641': 0.3 }, 10464, 0) ?? 0) - 0.7) < 1e-12, 'complement')
check(sideMid({ '#104640': 0, '#104641': 1 }, 10464, 0) === null, 'no price at 0 or 1')

// Names on the leaderboard.
check(cleanPracticeName('  Night   Owl ') === 'Night Owl', 'name trimmed')
check(cleanPracticeName('Ëlena_99') === 'Ëlena_99', 'letters of any language')
check(cleanPracticeName('<img src=x>') === null, 'no markup')
check(cleanPracticeName('x') === null && cleanPracticeName('a'.repeat(25)) === null, '2 to 24 characters')
check(cleanPracticeName('visit https://scam.io') === null, 'no links')

console.log(failed ? `${failed} failed` : `practice predictions: all good (${meta.outcomes.length} markets)`)
process.exit(failed ? 1 : 0)
