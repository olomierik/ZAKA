// Simulates ArcDexSwapRouter against Arc mainnet's real node — real pools,
// real Argus hooks, real USDC precompile — without broadcasting anything.
// See contracts/test/sim/ArcDexRouterSimHarness.sol for why this isn't a
// Foundry fork test.
//
//   forge build && node scripts/sim-swap-router.mjs
import { readFileSync } from 'node:fs'
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, keccak256, encodeAbiParameters, parseEther } from 'viem'

const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ transport: http(RPC, { retryCount: 6, retryDelay: 1500 }) })

const artifact = JSON.parse(readFileSync('contracts/out/ArcDexRouterSimHarness.sol/ArcDexRouterSimHarness.json', 'utf8'))
const abi = artifact.abi
const code = artifact.deployedBytecode.object
const HARNESS = '0x00000000000000000000000000000000000abcde'

const USDC = '0x3600000000000000000000000000000000000000'
const ARGUS = '0xeCe5cA8bf9220718E5727754026757512212cb3c'
const FEE = 100n // bps

const key = (currency0, currency1, fee, tickSpacing, hooks) => ({ currency0, currency1, fee, tickSpacing, hooks })
const KEYS = {
  argusMain: key(USDC, ARGUS, 9850, 99, '0x0000000000000000000000000000000000000000'),
  usdcQuoted: key(USDC, '0xcA178326937DCF04157F2E6370674655c57D7A75', 10000, 200, '0x5bc3A06e837bCc45D6aD34ECa0663F5620FCa044'),
  argusQuoted: key('0x816de78fabDD52922964647529e304a0c86489Cd', ARGUS, 10000, 200, '0x031368443A47f2E56523661316E29F2e4679E044'),
}
const EXPECTED_IDS = {
  argusMain: '0xb3f441e8871840ecfcb284e5cbb5b9c21a50e961e1c50109bdced25e429f00cc',
  usdcQuoted: '0xed979d863d639a72771df12f12fc2c9d7e21a6cf79b2859ea07ebde1314175ab',
  argusQuoted: '0x5113edb1d418c9fec0008a3f7ffa97ef8d5852167164f4e7be9b0615b7f50d5d',
}
const POOLKEY_TYPE = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }]

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ ${msg}`) } }

async function sim(functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args })
  const res = await client.call({
    to: HARNESS,
    data,
    gas: 30_000_000n,
    stateOverride: [{ address: HARNESS, code, balance: parseEther('1000') }], // = 1,000 USDC
  })
  return decodeFunctionResult({ abi, functionName, data: res.data })
}

function checkBuy(label, r, usdcIn) {
  console.log(`  ${label}: out=${r.amountOut} received=${r.received} fee=${r.feeWalletGain}`)
  check(r.amountOut > 0n, 'tokens received')
  check(r.amountOut === r.received, 'reported amount matches actual balance gain')
  check(r.feeWalletGain === (usdcIn * FEE) / 10_000n, `fee wallet got exactly 1% of ${usdcIn} USDC`)
  check(r.routerLeftIn === 0n && r.routerLeftOut === 0n, 'router holds nothing afterwards')
}

async function run(name, fn) {
  console.log(`\n${name}`)
  try { await fn() } catch (e) { failures++; console.log(`  ✗ reverted: ${e.shortMessage ?? e.message}`.slice(0, 400)) }
  await new Promise(r => setTimeout(r, 1200)) // stay under the public RPC's rate limit
}

console.log(`block ${await client.getBlockNumber()} via ${RPC}`)

await run('PoolKeys hash to the real on-chain PoolIds', async () => {
  for (const [k, id] of Object.entries(EXPECTED_IDS)) {
    check(keccak256(encodeAbiParameters(POOLKEY_TYPE, [KEYS[k]])) === id, `${k} → ${id.slice(0, 10)}…`)
  }
})

await run('Buy ARGUS — v4 main pool (no hook), 100 USDC', async () => {
  checkBuy('buy', await sim('buyV4', [[KEYS.argusMain], ARGUS, 100_000_000n]), 100_000_000n)
})

await run('Buy USDC-quoted Argus launch — through its tax hook, 20 USDC', async () => {
  checkBuy('buy', await sim('buyV4', [[KEYS.usdcQuoted], KEYS.usdcQuoted.currency1, 20_000_000n]), 20_000_000n)
})

await run('Buy ARGUS-quoted Argus launch — 2 hops USDC→ARGUS→token, 20 USDC', async () => {
  checkBuy('buy', await sim('buyV4', [[KEYS.argusMain, KEYS.argusQuoted], KEYS.argusQuoted.currency0, 20_000_000n]), 20_000_000n)
})

await run('Round trip USDC-quoted launch — sell fee comes out of USDC output', async () => {
  const [buy, sell] = await sim('roundTripV4', [[KEYS.usdcQuoted], KEYS.usdcQuoted.currency1, 20_000_000n])
  checkBuy('buy', buy, 20_000_000n)
  console.log(`  sell: usdcOut=${sell.amountOut} fee=${sell.feeWalletGain}`)
  check(sell.amountOut > 0n && sell.amountOut === sell.received, 'USDC received on sell')
  const gross = sell.amountOut + sell.feeWalletGain
  check(sell.feeWalletGain === (gross * FEE) / 10_000n, 'sell fee is exactly 1% of gross USDC out')
  check(sell.routerLeftIn === 0n && sell.routerLeftOut === 0n, 'router holds nothing afterwards')
})

await run('Round trip ARGUS (a transfer-tax token) — v4 main pool, 50 USDC', async () => {
  const [buy, sell] = await sim('roundTripV4', [[KEYS.argusMain], ARGUS, 50_000_000n])
  checkBuy('buy', buy, 50_000_000n)
  console.log(`  sell: usdcOut=${sell.amountOut} fee=${sell.feeWalletGain}`)
  check(sell.amountOut > 0n && sell.amountOut === sell.received, 'USDC received on sell')
  check(sell.routerLeftIn === 0n && sell.routerLeftOut === 0n, 'router holds nothing afterwards')
})

await run('Buy ARGUS — legacy v3 pool via SwapRouter02, 50 USDC', async () => {
  checkBuy('buy', await sim('buyV3', [ARGUS, 10000, 50_000_000n]), 50_000_000n)
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
