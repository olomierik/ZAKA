// Checks api/_argusBonded.ts against real Argus launches on Arc mainnet.
//   bun scripts/test-bonded.ts
import { bondedFlags } from '../api/_argusBonded'
const ARGUS = '0xece5ca8bf9220718e5727754026757512212cb3c'          // Portal 1, known bonded
const ARGEN = '0xeb5294495134c29d40b38a51986ab98144ab8a52'          // Portal 7, known bonded
const WETH = '0x93ffd195481e8c08eb25a158689e4d9e61313111'           // not an Argus launch
const t0 = Date.now()
const m = await bondedFlags([ARGUS, ARGEN, WETH])
console.log(`took ${Date.now() - t0}ms`, Object.fromEntries(m))
let fails = 0
const ok = (c: boolean, s: string) => { console.log(c ? '  ✓' : '  ✗', s); if (!c) fails++ }
ok(m.get(ARGUS) === true, 'ARGUS (legacy Portal 1) bonded')
ok(m.get(ARGEN) === true, 'ARGEN (hooked Portal 7) bonded via hook')
ok(!m.has(WETH), 'WETH is not an Argus launch')
process.exit(fails ? 1 : 0)
