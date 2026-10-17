// Which errors mean "this page's code file is gone after a deploy" (src/arcdex/lib/chunkReload.ts): each browser's own
// wording, and ordinary errors that must not trigger a reload.
//   bun scripts/test-chunk-reload.ts

import { isChunkError } from '../src/arcdex/lib/chunkReload'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }

const chunk: [string, unknown][] = [
  ['Chrome', new TypeError('Failed to fetch dynamically imported module: https://arcsense.site/assets/RoutesPage-ZQcaWdwU.js')],
  ['Firefox', new TypeError('error loading dynamically imported module: https://arcsense.site/assets/RoutesPage-ZQcaWdwU.js')],
  ['Safari', new TypeError('Importing a module script failed.')],
  ['Vite CSS preload', new Error('Unable to preload CSS for /assets/PerpsPage-x.css')],
  ['webpack-style', Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' })],
]
const other: [string, unknown][] = [
  ['a render bug', new TypeError("Cannot read properties of undefined (reading 'coin')")],
  ['a network call', new Error('Hyperliquid answered 429')],
  ['a string', 'something else'],
]
console.log('reloads for a missing code file')
for (const [name, e] of chunk) ok(isChunkError(e), name)
console.log('not for other errors')
for (const [name, e] of other) ok(!isChunkError(e), name)

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall chunk-reload checks passed')
