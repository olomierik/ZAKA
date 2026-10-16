// Offline test of the trading wallet's fast buy (lib/fastBuy.ts, ArgusSwapWidget's submit): the approval and the swap
// are sent back to back through the trading wallet's real client, against a stand-in node that still reports the old
// transaction count. The swap must get the next nonce, and must go out with nothing asked of the node (no estimate, no
// call, no eth_fillTransaction), since the node can't see the approval yet. Also the allowance slot.
// Run: bun scripts/test-fast-buy.ts
import { custom, decodeFunctionData, erc20Abi, keccak256, encodeAbiParameters, numberToHex, parseTransaction, type Hex } from 'viem'

const { openAccountKey, getEmbeddedWalletClientOn, recordBroadcasts, lock } = await import('../src/arcdex/lib/embeddedWallet')
const { usdcAllowanceSlot, usdcAllowanceOverride, USDC_ALLOWANCE_BASE } = await import('../src/arcdex/lib/fastBuy')
const { arc } = await import('../src/arcdex/wagmi')

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
// Anvil's first published test key.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ROUTER = '0xD07583f7DB671521AAcFdA2b4612AD187aA2924e'
const USDC = '0x3600000000000000000000000000000000000000'

console.log('the allowance slot')
const expect = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [numberToHex(BigInt(ROUTER), { size: 32 }),
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [numberToHex(BigInt(ME), { size: 32 }), numberToHex(10n, { size: 32 })]))]))
ok(USDC_ALLOWANCE_BASE === 10n && usdcAllowanceSlot(ME, ROUTER) === expect, 'allowed[owner][spender] in FiatToken’s base slot 10')
ok(usdcAllowanceSlot(ME.toLowerCase(), ROUTER.toLowerCase()) === expect, 'the same slot whatever the addresses’ case')
const o = usdcAllowanceOverride(ME, ROUTER, 5_000_000n)
ok(o.length === 1 && o[0].address === USDC && BigInt(o[0].stateDiff[0].value) === 5_000_000n, 'the override names USDC and exactly the amount')

console.log('two transactions back to back')
const calls: string[] = []
const sent: ReturnType<typeof parseTransaction>[] = []
const node = custom({
  async request({ method, params }: { method: string; params?: unknown[] }) {
    calls.push(method)
    switch (method) {
      case 'eth_chainId': return numberToHex(arc.id)
      case 'eth_getTransactionCount': return '0x7' // a node one block behind: the approval isn't counted yet
      case 'eth_estimateGas': return '0xc350'
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
      case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00', number: '0x1', timestamp: '0x1', transactions: [] }
      case 'eth_fillTransaction': throw new Error('eth_fillTransaction is not available')
      case 'eth_sendRawTransaction': { const tx = parseTransaction((params as [Hex])[0]); sent.push(tx); return keccak256((params as [Hex])[0]) }
      default: throw new Error('unexpected ' + method)
    }
  },
})
openAccountKey(KEY, ME)
const wallet = getEmbeddedWalletClientOn(arc, recordBroadcasts(node))
await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [ROUTER, 5_000_000n] })
const afterApprove = calls.length
await wallet.writeContract({ address: ROUTER, abi: erc20Abi, functionName: 'transfer', args: [ME, 1n], gas: 489_121n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chainId: arc.id } as never)
const swapCalls = calls.slice(afterApprove)
ok(sent.length === 2, 'both transactions are broadcast')
ok(sent[0].nonce === 7 && sent[1].nonce === 8, `consecutive nonces (${sent[0].nonce}, ${sent[1].nonce}) though the node still reports 7`)
ok(!swapCalls.some(m => /estimateGas|fillTransaction|eth_call/.test(m)), `the swap asks the node nothing it can’t answer yet (${swapCalls.join(', ')})`)
ok(sent[1].gas === 489_121n && sent[1].maxFeePerGas === 2_000_000_000n, 'it carries the gas and fees measured beforehand')
const a = decodeFunctionData({ abi: erc20Abi, data: sent[0].data! })
ok(a.functionName === 'approve' && a.args[1] === 5_000_000n && sent[0].to?.toLowerCase() === USDC, 'the approval is exactly the amount, on USDC')
lock()
console.log('\nall fast-buy checks passed')
