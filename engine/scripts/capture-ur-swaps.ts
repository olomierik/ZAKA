// Records two real Universal Router buys on Arc (2026-09-30) for engine/test/live.test.ts:
// one in an ERC-20 USDC pool (through Permit2), one in a native-USDC pool (msg.value).
//   bun engine/scripts/capture-ur-swaps.ts
import { HttpRpc } from '../src/chain/http'
const rpc = new HttpRpc(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io'])
const TXS = {
  erc20Buy: '0x9dcd5d4fba405e8142cb89e6a8eb7ac782079b41b6dc2fbc143035c40556a202',
  nativeBuy: '0x92c208f3f62ed9edac1beb83f3883cfc1a88e650198af49b1033cfde48c4d79b',
}
const out: Record<string, unknown> = {}
for (const [name, hash] of Object.entries(TXS)) {
  const [tx, rc] = await Promise.all([rpc.call<any>('eth_getTransactionByHash', [hash]), rpc.call<any>('eth_getTransactionReceipt', [hash])])
  out[name] = { hash, from: tx.from, to: tx.to, value: tx.value, input: tx.input, gasUsed: rc.gasUsed, effectiveGasPrice: rc.effectiveGasPrice, logs: rc.logs.map((l: any) => ({ address: l.address, topics: l.topics, data: l.data })) }
}
await Bun.write(new URL('../test/fixtures/ur-swaps.json', import.meta.url), JSON.stringify(out, null, 1))
console.log('wrote', Object.keys(out))
