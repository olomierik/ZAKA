// The Trenches' live feed (engine/src/trench): decoding each chain's real events (recorded 2026-10-12, nothing sent:
// fixtures/trench.json), the per-second ticks, launches, and which wallets count as smart.
import { describe, expect, test } from 'bun:test'
import { decodeEventLog, parseAbi } from 'viem'
import { TrenchBook, SMART_RULES, type FeedTrade } from '../src/trench/book'
import { BscFeed, decodeFourLog, FOUR_CREATE, type RawLog } from '../src/trench/bsc'
import { decodeHoodSwap, HoodFeed } from '../src/trench/hood'
import { NativePrices } from '../src/trench/prices'
import { decodePumpData, fetchImage, httpUrl, pumpCurve, SolFeed } from '../src/trench/sol'
import { TrenchService } from '../src/trench/service'
import type { TrenchMessage } from '../../api/_trenchProtocol'

const fx = JSON.parse(await Bun.file(`${import.meta.dir}/fixtures/trench.json`).text()) as {
  sol: Record<'create' | 'trade' | 'buy' | 'sell' | 'weird', string>
  bsc: Record<'create' | 'buy' | 'sale', RawLog>
  hood: { row: { address: string; pool: string; quote: string; decimals: number; priceUsd: number }; log: RawLog }
}
const prices = (p: Partial<Record<'SOL' | 'BNB' | 'ETH', number>>) => { const n = new NativePrices(); n.set(p); return n }
const sink = () => { const out: TrenchMessage[] = []; return { out, publish: (m: TrenchMessage) => { out.push(m) } } }

describe('Solana: pump.fun and PumpSwap events', () => {
  test('a launch: name, symbol, uri, mint, curve and its opening reserves', () => {
    const e = decodePumpData(fx.sol.create)!
    expect(e.k).toBe('create')
    if (e.k !== 'create') return
    expect(e.symbol).toBe('KNIGHTDOG')
    expect(e.mint).toBe('8EvVyGzPgo8Wm4MvM65UL8Zg3TYYYji2w9Jjvnhepump')
    expect(e.uri.startsWith('https://ipfs.io/ipfs/')).toBe(true)
    expect(e.vSol).toBe(30_000_000_000n)
    expect(e.vTok).toBe(1_073_000_000_000_000n)
    expect(e.rTok).toBe(793_100_000_000_000n)
    expect(e.supply).toBe(1_000_000_000_000_000n)
  })
  test('the creator’s first buy, in the same transaction: SOL in, coins out, the curve after it', () => {
    const e = decodePumpData(fx.sol.trade)!
    expect(e.k).toBe('trade')
    if (e.k !== 'trade') return
    expect(e.buy).toBe(true)
    expect(e.mint).toBe('8EvVyGzPgo8Wm4MvM65UL8Zg3TYYYji2w9Jjvnhepump')
    expect(e.sol).toBe(157_816_865n)
    // The curve's virtual SOL grew by exactly what was paid in.
    expect(e.vSol - 30_000_000_000n).toBe(e.sol)
    expect(1_073_000_000_000_000n - e.vTok).toBe(e.tok)
    const c = pumpCurve(e.vSol, e.vTok, e.rTok)!
    expect(c.priceSol).toBeCloseTo((30.157816865 / 1_067_384_955.090678), 15)
    expect(c.mcapSol).toBeCloseTo(c.priceSol * 1e9, 6)
    expect(c.progress).toBe(0.7) // 5.6M of the 793.1M for sale
  })
  test('PumpSwap buys and sells: the pool and trader sit at bytes 120 and 152', () => {
    const b = decodePumpData(fx.sol.buy)!, s = decodePumpData(fx.sol.sell)!
    expect(b.k === 'amm' && b.buy && b.pool === 'FEhPD5ZNLW4sxSwtp7FX3Wt1DBgHyou3ELYPfxUoeXpd').toBe(true)
    expect(s.k === 'amm' && !s.buy && s.pool === 'B4X58TNrEDHA7gTBCseyxtndboWmEoicUkh1kwT79iPK').toBe(true)
    if (b.k === 'amm') expect(b.user).toBe('4aNP9gQi72oiixqH6YvYDS4k1UK1dSomsNUJsDwUqtEJ')
  })
  test('a curve quoted in something other than SOL is left out', () => {
    const e = decodePumpData(fx.sol.weird)!
    expect(e.k).toBe('trade')
    if (e.k === 'trade') expect(pumpCurve(e.vSol, e.vTok, e.rTok)).toBeNull()
    expect(pumpCurve(2_913_927_195_744n, 1_073_000_000_000_000n, 793_100_000_000_000n)).toBeNull()
  })
  test('garbage and other programs’ events are ignored', () => {
    expect(decodePumpData('')).toBeNull()
    expect(decodePumpData(Buffer.from('not an anchor event at all').toString('base64'))).toBeNull()
    expect(decodePumpData(fx.sol.trade.slice(0, 40))).toBeNull()
  })
  test('the feed: a launch goes out at once, its first buy moves its numbers and ticks', () => {
    const { out, publish } = sink()
    const book = new TrenchBook('sol')
    const feed = new SolFeed({ book, prices: prices({ SOL: 100 }), publish, fetcher: (async () => new Response('{}')) as unknown as typeof fetch })
    const now = 1_791_818_600_000
    feed.onEvent(decodePumpData(fx.sol.create)!, now)
    feed.onEvent(decodePumpData(fx.sol.trade)!, now)
    const launch = out.find(m => m.t === 'TLAUNCH')
    expect(launch && launch.t === 'TLAUNCH' && launch.d.s).toBe('KNIGHTDOG')
    if (launch?.t === 'TLAUNCH') expect(launch.d.m).toBe(Math.round((30 / 1_073_000_000) * 1e9 * 100)) // $2,796 at $100 SOL
    const [tick] = book.ticks()
    expect(tick[0]).toBe('8EvVyGzPgo8Wm4MvM65UL8Zg3TYYYji2w9Jjvnhepump')
    expect(tick[1]).toBe(1) // one buy
    expect(tick[3]).toBeCloseTo(15.78, 2) // 0.1578 SOL at $100
    expect(tick[7]).toBe(0.7)
    expect(book.recentLaunches()[0].b).toBe(1)
  })
  test('without a SOL price, nothing is priced (or shown)', () => {
    const { out, publish } = sink()
    const book = new TrenchBook('sol')
    const feed = new SolFeed({ book, prices: new NativePrices(), publish })
    feed.onEvent(decodePumpData(fx.sol.create)!)
    feed.onEvent(decodePumpData(fx.sol.trade)!)
    expect(out).toEqual([])
    expect(book.ticks()).toEqual([])
  })
  test('a PumpSwap trade waits for its pool to be read, then counts', () => {
    const { publish } = sink()
    const book = new TrenchBook('sol', undefined, t => t === 'COIN')
    const feed = new SolFeed({ book, prices: prices({ SOL: 100 }), publish })
    const e = decodePumpData(fx.sol.buy)!
    feed.onEvent(e)
    expect(book.ticks()).toEqual([])
    // The pool read (what resolvePools stores), then the wait list played:
    ;(feed as unknown as { pools: Map<string, unknown> }).pools.set('FEhPD5ZNLW4sxSwtp7FX3Wt1DBgHyou3ELYPfxUoeXpd', { base: 'COIN', quote: 'So11111111111111111111111111111111111111112', baseDec: 6, quoteDec: 9, supply: 1e9 })
    feed.onEvent(e)
    const [t] = book.ticks()
    expect(t[0]).toBe('COIN')
    expect(t[3]).toBeCloseTo(4.46, 2) // 0.0446 SOL at $100, to the cent
  })
  test('pictures: ipfs links through a gateway, https only, JSON only', async () => {
    expect(httpUrl('ipfs://bafy123')).toBe('https://ipfs.io/ipfs/bafy123')
    const ok = (async () => new Response(JSON.stringify({ image: 'ipfs://bafyimg' }))) as unknown as typeof fetch
    expect(await fetchImage('https://x.test/meta.json', ok)).toBe('https://ipfs.io/ipfs/bafyimg')
    expect(await fetchImage('http://x.test/meta.json', ok)).toBeNull()
    const bad = (async () => new Response(JSON.stringify({ image: 'javascript:alert(1)' }))) as unknown as typeof fetch
    expect(await fetchImage('https://x.test/meta.json', bad)).toBeNull()
  })
})

describe('BNB Chain: four.meme and PancakeSwap', () => {
  const ABI = parseAbi([
    'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
    'event TokenPurchase(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
    'event TokenSale(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
  ])
  const viemDecode = (l: RawLog) => decodeEventLog({ abi: ABI, data: l.data as `0x${string}`, topics: l.topics as [`0x${string}`] })

  test('the create topic is TokenCreate’s', () => expect(fx.bsc.create.topics[0]).toBe(FOUR_CREATE))
  test('a launch, as viem decodes it independently', () => {
    const e = decodeFourLog(fx.bsc.create)!
    const v = viemDecode(fx.bsc.create).args as { token: string; creator: string; symbol: string; name: string }
    expect(e).toEqual({ k: 'create', token: v.token.toLowerCase(), creator: v.creator.toLowerCase(), name: v.name, symbol: v.symbol, supply: 1e9 })
  })
  test('a buy and a sale: trader, amounts and what the curve holds', () => {
    for (const l of [fx.bsc.buy, fx.bsc.sale]) {
      const e = decodeFourLog(l)!
      const v = viemDecode(l).args as { token: string; account: string; amount: bigint; cost: bigint; offers: bigint; funds: bigint }
      expect(e.k).toBe('trade')
      if (e.k !== 'trade') continue
      expect(e.token).toBe(v.token.toLowerCase())
      expect(e.account).toBe(v.account.toLowerCase())
      expect(e.amount).toBeCloseTo(Number(v.amount) / 1e18, 9)
      expect(e.cost).toBeCloseTo(Number(v.cost) / 1e18, 15)
      expect(e.offers).toBeCloseTo(Number(v.offers) / 1e18, 6)
      expect(e.buy).toBe(l === fx.bsc.buy)
    }
  })
  test('another contract’s logs aren’t four.meme’s', () => {
    expect(decodeFourLog({ ...fx.bsc.buy, address: '0x0000000000000000000000000000000000000001' })).toBeNull()
  })

  const rpcWith = (logs: RawLog[]) => { let head = 0x100; return {
    call: async <T,>(method: string) => (method === 'eth_blockNumber' ? `0x${(head++).toString(16)}` : logs) as T,
    batch: async <T,>() => [] as (T | null)[],
  } }
  test('the feed: a launch waits for its quote, then goes out; its creator’s buy prices it', async () => {
    const { out, publish } = sink()
    const book = new TrenchBook('bnb')
    let asked: string[] = []
    const feed = new BscFeed({ book, prices: prices({ BNB: 600 }), publish, pools: () => [], rpc: rpcWith([fx.bsc.create, fx.bsc.buy]), readQuotes: async ts => { asked = ts; return new Map(ts.map(t => [t, { quote: '0x0000000000000000000000000000000000000000' }])) } })
    await feed.poll(1_791_819_000_000)
    const token = (decodeFourLog(fx.bsc.create) as { token: string }).token
    expect(asked).toEqual([token])
    const launch = out.find(m => m.t === 'TLAUNCH')
    expect(launch?.t === 'TLAUNCH' && launch.d.s).toBe('HOLYSI')
    const coin = book.recentLaunches()[0]
    expect(coin.b).toBe(1)
    expect(coin.m).toBe(Math.round(4.272962169e-9 * 600 * 1e9)) // $2,564: four.meme's opening price at $600 BNB
    expect(coin.q).toBe('BNB')
  })
  test('a coin four.meme doesn’t vouch for never shows', async () => {
    const { out, publish } = sink()
    const book = new TrenchBook('bnb')
    const feed = new BscFeed({ book, prices: prices({ BNB: 600 }), publish, pools: () => [], rpc: rpcWith([fx.bsc.create, fx.bsc.buy]), readQuotes: async ts => new Map(ts.map(t => [t, null])) })
    await feed.poll()
    expect(out).toEqual([])
    expect(book.recentLaunches()).toEqual([])
    // Its later trades are dropped too, once its answer is known.
    await feed.poll()
    expect(out).toEqual([])
    expect(book.ticks()).toEqual([])
  })
})

describe('Robinhood Chain: a listed pool’s swaps', () => {
  const r = fx.hood.row
  const pool = { pool: r.pool, coin: r.address, quote: r.quote, coinDecimals: r.decimals, supply: 1e9, quoteUsd: 226, quoteDecimals: 18 }
  test('a v4 swap by pool id', () => {
    const d = decodeHoodSwap(fx.hood.log, pool)!
    expect(d.buy).toBe(true)
    expect(d.tokens).toBeGreaterThan(0)
    expect(d.price * 226).toBeGreaterThan(r.priceUsd * 0.5)
    expect(d.price * 226).toBeLessThan(r.priceUsd * 2)
  })
  test('another pool’s swap isn’t this one’s', () => {
    expect(decodeHoodSwap(fx.hood.log, { ...pool, pool: `0x${'1'.repeat(64)}` })).toBeNull()
  })
  test('the feed prices a pool quoted in another listed coin from that coin’s price', async () => {
    const book = new TrenchBook('hood', undefined, t => t === r.address)
    const feed = new HoodFeed({ book, prices: new NativePrices(), publish: () => {}, pools: () => [pool], rpc: { call: async <T,>(m: string) => (m === 'eth_blockNumber' ? `0x${(parseInt(fx.hood.log.blockNumber, 16) + 5).toString(16)}` : m === 'eth_getLogs' ? [fx.hood.log] : { from: '0xabc' }) as T, batch: async <T,>() => [] as (T | null)[] } })
    ;(feed as unknown as { last: number }).last = parseInt(fx.hood.log.blockNumber, 16) - 1
    await feed.poll()
    const [t] = book.ticks()
    expect(t[0]).toBe(r.address)
    expect(t[1]).toBe(1)
  })
})

// ── smart wallets ────────────────────────────────────────────────────────

/** A wallet's round trips: buy $100 of a coin, sell it `holdSec` later for `back` dollars. */
function roundTrips(book: TrenchBook, wallet: string, coins: string[], { holdSec = 120, back = 200, start = 1_000_000 } = {}) {
  let ts = start
  for (const c of coins) {
    book.trade({ token: c, wallet, side: 'buy', usd: 100, tokens: 1_000, ts } as FeedTrade)
    ts += holdSec * 1000
    book.trade({ token: c, wallet, side: 'sell', usd: back, tokens: 1_000, ts } as FeedTrade)
    ts += 1000
  }
  return ts
}

describe('smart wallets', () => {
  test('a wallet that closed 4 winning trades over 4 coins, in profit and holding minutes, is smart', () => {
    const book = new TrenchBook('sol')
    roundTrips(book, 'W', ['a', 'b', 'c', 'd'])
    book.refreshSmart()
    expect(book.smartCount).toBe(1)
    // Its next buy is a smart trade, and its coin is one smart wallets are buying.
    const st = book.trade({ token: 'e', wallet: 'W', side: 'buy', usd: 50, tokens: 10, ts: Date.now(), mcapUsd: 40_000 })!
    expect(st).toMatchObject({ w: 'W', t: 'e', side: 'B', u: 50, n: 4, wr: 1, pnl: 400, m: 40_000 })
    const v = book.smartView()
    expect(v.buying[0]).toMatchObject({ t: 'e', buyers: 1, buyUsd: 50 })
    expect(v.top[0]).toMatchObject({ w: 'W', n: 4, pnl: 400 })
    expect(v.rule).toEqual({ minTrades: 4, minWinRate: 0.6, minProfitUsd: SMART_RULES.sol.minRealizedUsd, minHoldSec: 45 })
  })
  test('the same record flipped in seconds is a bot, not smart', () => {
    const book = new TrenchBook('sol')
    roundTrips(book, 'B', ['a', 'b', 'c', 'd'], { holdSec: 5 })
    book.refreshSmart()
    expect(book.smartCount).toBe(0)
  })
  test('too few trades, losing trades, or too little profit: not smart', () => {
    const book = new TrenchBook('sol')
    roundTrips(book, 'few', ['a', 'b', 'c'])
    roundTrips(book, 'losing', ['a', 'b', 'c', 'd'], { back: 60 })
    roundTrips(book, 'small', ['a', 'b', 'c', 'd'], { back: 150 }) // +$200 in all, under Solana's $250
    book.refreshSmart()
    expect(book.smartCount).toBe(0)
  })
  test('coins smart wallets sold more of than they bought aren’t “buying now”', () => {
    const book = new TrenchBook('sol')
    roundTrips(book, 'W', ['a', 'b', 'c', 'd'])
    book.refreshSmart()
    const now = Date.now()
    book.trade({ token: 'e', wallet: 'W', side: 'buy', usd: 50, tokens: 10, ts: now })
    book.trade({ token: 'e', wallet: 'W', side: 'sell', usd: 80, tokens: 10, ts: now + 1 })
    expect(book.smartView(now + 2).buying).toEqual([])
    expect(book.smartView(now + 2).trades.map(t => t.side)).toEqual(['S', 'B'])
  })
  test('a coin only a smart wallet bought shows in “buying now” but doesn’t tick in the lanes', () => {
    const book = new TrenchBook('sol', undefined, () => false)
    roundTrips(book, 'W', ['a', 'b', 'c', 'd'])
    book.refreshSmart()
    book.ticks()
    book.trade({ token: 'unlisted', wallet: 'W', side: 'buy', usd: 30, tokens: 1, ts: Date.now() })
    expect(book.ticks()).toEqual([])
    expect(book.smartView().buying.map(b => b.t)).toEqual(['unlisted'])
  })
  test('kept across a restart', async () => {
    const book = new TrenchBook('sol')
    roundTrips(book, 'W', ['a', 'b', 'c', 'd'])
    book.refreshSmart()
    let saved = ''
    await book.save({ load: async () => null, save: async j => { saved = j } })
    const again = new TrenchBook('sol')
    await again.load({ load: async () => saved, save: async () => {} })
    expect(again.smartCount).toBe(1)
    expect(again.since).toBe(book.since)
  })
})

describe('ticks', () => {
  test('only coins the lanes show tick (launched while watching, or listed), the busiest first', () => {
    const book = new TrenchBook('sol', undefined, t => t === 'listed')
    book.launch({ token: 'new', symbol: 'NEW', name: 'New', image: null, launchpad: 'pump.fun', quote: 'SOL', pool: null, createdAt: Date.now(), creator: null, priceUsd: 0, mcapUsd: 0, liquidityUsd: 0, progress: 0 })
    book.trade({ token: 'new', wallet: 'a', side: 'buy', usd: 5, tokens: 1, ts: 1 })
    book.trade({ token: 'listed', wallet: 'b', side: 'sell', usd: 50, tokens: 1, ts: 1, mcapUsd: 1_000_000 })
    book.trade({ token: 'other', wallet: 'c', side: 'buy', usd: 500, tokens: 1, ts: 1 })
    const ticks = book.ticks()
    expect(ticks.map(t => t[0])).toEqual(['listed', 'new'])
    expect(ticks[0]).toEqual(['listed', 0, 1, 0, 50, 0, 1_000_000, -1, -50])
    expect(book.ticks()).toEqual([])
    expect(book.perMin()).toBe(3)
  })
})

describe('a launch’s first moments: bundlers, snipers, dev sold', () => {
  const at = 1_800_000_000_000
  const launch = (book: TrenchBook, creator: string | null) => book.launch({ token: 'T', symbol: 'T', name: 'T', image: null, launchpad: 'pump.fun', quote: 'SOL', pool: null, createdAt: at, creator, priceUsd: 0, mcapUsd: 0, liquidityUsd: 0, progress: 0 })
  const buy = (wallet: string, ms: number, tokens = 100) => ({ token: 'T', wallet, side: 'buy' as const, usd: 1, tokens, ts: at + ms })
  test('counted from the launch time, the creator left out', () => {
    const book = new TrenchBook('sol')
    launch(book, 'Dev1')
    book.trade(buy('Dev1', 0, 1_000))
    book.trade(buy('b1', 400)); book.trade(buy('b2', 1_000)); book.trade(buy('b2', 900))
    book.trade(buy('s1', 4_000)); book.trade(buy('s2', 15_000))
    book.trade(buy('late', 15_001))
    book.trade({ token: 'T', wallet: 's1', side: 'sell', usd: 1, tokens: 50, ts: at + 2_000 })
    const w = book.recentLaunches()[0]
    expect(w.bn).toBe(2)
    expect(w.sn).toBe(4)
    expect(w.dv).toBe(0)
    book.trade({ token: 'T', wallet: 'dev1', side: 'sell', usd: 1, tokens: 400, ts: at + 60_000 })
    expect(book.recentLaunches()[0].dv).toBe(40)
    book.trade({ token: 'T', wallet: 'Dev1', side: 'sell', usd: 1, tokens: 900, ts: at + 61_000 })
    expect(book.recentLaunches()[0].dv).toBe(100)
  })
  test('no creator known: dev sold is unknown, never 0', () => {
    const book = new TrenchBook('bnb')
    launch(book, null)
    book.trade(buy('b1', 100))
    const w = book.recentLaunches()[0]
    expect(w.dv).toBeNull()
    expect(w.bn).toBe(1)
  })
  test('a coin only seen through the list carries none of it', () => {
    const book = new TrenchBook('sol', undefined, t => t === 'L')
    book.trade({ token: 'L', wallet: 'a', side: 'buy', usd: 1, tokens: 1, ts: at })
    expect(book.metaOf('L')).not.toBeNull()
    expect(book.recentLaunches()).toEqual([])
  })
})

describe('the service', () => {
  test('Arc’s trades teach Arc’s book, and a smart wallet’s trade goes out on trench_arc with the coin’s name', () => {
    const sent: { topics: string[]; msg: unknown }[] = []
    const svc = new TrenchService({
      publish: (topics, msg) => { sent.push({ topics, msg }) }, wants: () => true,
      settings: { getSetting: async () => null, setSetting: async () => {} }, listBase: 'http://127.0.0.1:1',
      arcMeta: t => ({ symbol: t.toUpperCase(), name: t, image: null, launchedAt: 0 }),
    })
    const trade = (token: string, side: 'BUY' | 'SELL', usd: number, ts: number) => svc.onTrade({ tradeId: `${token}${ts}`, chain: 'ARC', token, pair: '', pool: '', quote: '', side, baseAmount: 10, quoteAmount: usd, tokenAmount: 10, price: 1, priceUsd: 1, usdValue: usd, wallet: '0xw', txHash: '', blockNumber: 1, logIndex: 0, timestamp: ts, dex: '', launchpad: null, liquidity: null }, { replay: false })
    let ts = 1_000
    for (const c of ['a', 'b', 'c']) { trade(c, 'BUY', 20, ts); ts += 120_000; trade(c, 'SELL', 40, ts); ts += 1_000 }
    svc.books.arc.refreshSmart()
    trade('d', 'BUY', 20, Date.now())
    const smart = sent.find(s => (s.msg as { t: string }).t === 'TSMART')
    expect(smart?.topics).toEqual(['trench_arc'])
    expect((smart?.msg as { d: { s: string } }).d.s).toBe('D')
    expect(svc.snapshot('arc').smart.smart).toBe(1)
  })
})
