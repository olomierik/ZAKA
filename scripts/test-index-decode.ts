// Checks api/index-trades.ts decodes ArcDexSwapRouter events correctly.
//   bun scripts/test-index-decode.ts
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem'
import { decode } from '../api/index-trades'

const abi = parseAbi([
  'event Swapped(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address feeToken, uint256 fee)',
  'event ReferrerBound(address indexed user, address indexed referrer)',
  'event ReferralPaid(address indexed referrer, address indexed user, address indexed token, uint256 amount)',
])
const USDC = '0x3600000000000000000000000000000000000000'
const TOKEN = '0x816de78fabdd52922964647529e304a0c86489cd'
const USER = '0x1111111111111111111111111111111111111111'
const REF = '0x000000000000000000000000000000000000beef'
const ROUTER = '0xc519b929981f5375d67ab3930ffb100f0a606088'

const log = (topics: string[], data: string, i: number) => ({
  topics, data, blockNumber: '0x1580000', blockTimestamp: '0x6ab56a0d', transactionHash: '0xAB' + '0'.repeat(62), logIndex: '0x' + i.toString(16),
})
const t = (eventName: 'Swapped' | 'ReferrerBound' | 'ReferralPaid', args: Record<string, string>) =>
  encodeEventTopics({ abi, eventName, args } as never) as string[]

const logs = [
  // buy: 20 USDC in (incl. 0.4 fee), 1,091,756 tokens out
  log(t('Swapped', { user: USER, tokenIn: USDC, tokenOut: TOKEN }),
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [20_000_000n, 1_091_756_515_641_894_861_235_622n, USDC, 400_000n]), 1),
  log(t('ReferrerBound', { user: USER, referrer: REF }), '0x', 2),
  log(t('ReferralPaid', { referrer: REF, user: USER, token: USDC }), encodeAbiParameters([{ type: 'uint256' }], [60_000n]), 3),
  // sell: those tokens back for 17.367672 USDC after fee
  log(t('Swapped', { user: USER, tokenIn: TOKEN, tokenOut: USDC }),
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [1_091_756_515_641_894_861_235_622n, 17_367_672n, USDC, 354_442n]), 4),
]

const { trades, bound, paid } = decode(ROUTER, logs)
let fails = 0
const eq = (a: unknown, b: unknown, m: string) => { if (a === b) console.log('  ✓', m); else { fails++; console.log('  ✗', m, '→ got', a, 'want', b) } }

eq(trades.length, 2, 'two trades')
eq(trades[0].side, 'buy', 'first is a buy'); eq(trades[0].token, TOKEN, 'buy token'); eq(trades[0].trader, USER, 'trader')
eq(trades[0].usdc, '20.000000', 'buy USDC in'); eq(trades[0].token_amount, '1091756515641894861235622', 'buy tokens (raw)')
eq(trades[0].fee_usdc, '0.400000', 'buy fee'); eq(trades[0].log_index, 1, 'log index'); eq(trades[0].tx_hash, '0xab' + '0'.repeat(62), 'tx hash lowercased')
eq(trades[0].block_time, new Date(0x6ab56a0d * 1000).toISOString(), 'block time from blockTimestamp')
eq(trades[1].side, 'sell', 'second is a sell'); eq(trades[1].usdc, '17.367672', 'sell USDC out'); eq(trades[1].token, TOKEN, 'sell token')
eq(bound.length, 1, 'one referral binding'); eq(bound[0].user_address, USER, 'bound user'); eq(bound[0].referrer, REF, 'bound referrer')
eq(paid.length, 1, 'one payout'); eq(paid[0].amount, '0.060000', 'payout in USDC'); eq(paid[0].referrer, REF, 'payout referrer')

console.log(fails ? `\n${fails} FAILED` : '\nALL DECODE CHECKS PASSED')
process.exit(fails ? 1 : 0)
