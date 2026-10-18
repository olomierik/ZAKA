// The prediction pool's keeper rules (predictpool/keeper.ts), the practice book's reads it uses (practice/predict.ts:
// tradeableMid, settlementOf), the service before it has a wallet, and its routes.
import { describe, expect, test } from 'bun:test'
import { setLogLevel } from '../src/log'
import { MemoryPracticeStore, PredictPractice, type HlInfo } from '../src/practice/predict'
import { dueRequests, revertOf, toPx, type OpenRequest } from '../src/predictpool/keeper'
import { PredictPoolService } from '../src/predictpool/service'
import { PREDICT_POOL_ABI } from '../src/predictpool/abi'
import { PRICE_TYPES, SETTLEMENT_TYPES } from '../src/predictpool/shared'
import type { PerpsService } from '../src/perps/service'

setLogLevel('error')
const T0 = Date.UTC(2026, 9, 17, 12)

function fakeHl() {
  const state = {
    outcomes: [
      { outcome: 13000, name: 'template:binaryPrice', description: 'perp:BTC|threshold:82016|time:20261020-0400', sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }] },
      { outcome: 5000, name: 'template:binaryPrice', description: 'perp:BTC|threshold:86775|time:20261017-1100', sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }] },
    ],
    mids: { '#130000': '0.40', '#50000': '0.97' } as Record<string, string>,
    settled: {} as Record<number, string>,
    calls: [] as string[],
  }
  const info: HlInfo = async body => {
    state.calls.push(`${String(body.type)}${body.outcome != null ? `:${String(body.outcome)}` : ''}`)
    if (body.type === 'outcomeMeta') return { outcomes: state.outcomes, questions: [] }
    if (body.type === 'allMids') return state.mids
    if (body.type === 'settledOutcome') {
      const f = state.settled[Number(body.outcome)]
      return f === undefined ? null : { settleFraction: f }
    }
    throw new Error('unexpected')
  }
  return { state, info }
}

const req = (id: number, createdAt: number): OpenRequest => ({
  id: BigInt(id), trader: '0x0000000000000000000000000000000000000001', outcome: 1, side: 0, buy: true, amount: 1_000_000n, limitPx: 990_000n, createdAt,
})

describe('the prediction pool keeper', () => {
  test('a request is priced only after its own second, and not in its last three seconds', () => {
    const rs = [req(2, 100), req(1, 100), req(3, 99), req(4, 40)]
    expect(dueRequests(rs, 100, 60).map(r => r.id)).toEqual([3n])
    expect(dueRequests(rs, 101, 60).map(r => r.id)).toEqual([1n, 2n, 3n]) // oldest first
    expect(dueRequests(rs, 156, 60).map(r => r.id)).toEqual([1n, 2n, 3n])
    expect(dueRequests(rs, 157, 60).map(r => r.id)).toEqual([1n, 2n]) // 3: too close to its timeout
    expect(dueRequests(rs, 101, 60, id => id === 2n).map(r => r.id)).toEqual([1n, 3n])
  })

  test('a mid becomes the pool’s price, kept inside 0–1', () => {
    expect(toPx(0.4)).toBe(400_000n)
    expect(toPx(0.6666666)).toBe(666_667n)
    expect(toPx(1.2)).toBe(999_999n) // never $1 (the contract refuses it)
    expect(toPx(-0.1)).toBe(0n)
  })

  test('a revert is named', () => {
    const e = { message: 'reverted', cause: { cause: { data: { errorName: 'StalePrice' } } } }
    expect(revertOf(e)).toBe('StalePrice')
    expect(revertOf(new Error('network'))).toBeNull()
  })

  test('the typed data matches the contract’s type strings', () => {
    const typeString = (name: string, fields: readonly { name: string; type: string }[]) => `${name}(${fields.map(f => `${f.type} ${f.name}`).join(',')})`
    expect(typeString('Price', PRICE_TYPES.Price)).toBe('Price(uint32 outcome,uint8 side,uint64 px,uint64 ts)')
    expect(typeString('Settlement', SETTLEMENT_TYPES.Settlement)).toBe('Settlement(uint32 outcome,uint64 fraction,uint64 ts)')
    expect(PREDICT_POOL_ABI.some(x => x.type === 'function' && x.name === 'execute')).toBe(true)
  })
})

describe('the practice book’s reads for the pool', () => {
  test('a mid only for a listed market before its end', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    expect(await p.tradeableMid(13000, 0, T0)).toBe(0.4)
    expect(await p.tradeableMid(13000, 1, T0)).toBeCloseTo(0.6) // the other side's complement
    expect(await p.tradeableMid(5000, 0, T0)).toBeNull() // past its end
    expect(await p.tradeableMid(777, 0, T0)).toBeNull() // not listed
    expect(p.specOf(13000)?.o.outcome).toBe(13000)
  })

  test('settlement is asked only once a market has ended or left the list, at most once a minute', async () => {
    const hl = fakeHl()
    const p = new PredictPractice({ store: new MemoryPracticeStore(), info: hl.info })
    expect(await p.settlementOf(13000, null, T0)).toBeNull()
    expect(hl.state.calls.filter(c => c.startsWith('settledOutcome'))).toEqual([]) // still live: not asked
    expect(await p.settlementOf(5000, null, T0)).toBeNull()
    expect(await p.settlementOf(5000, null, T0 + 10_000)).toBeNull()
    expect(hl.state.calls.filter(c => c.startsWith('settledOutcome'))).toEqual(['settledOutcome:5000'])
    hl.state.settled[5000] = '1'
    expect(await p.settlementOf(5000, null, T0 + 61_000)).toBe(1)
    expect(await p.tradeableMid(5000, 0, T0 + 61_000)).toBeNull()
  })
})

describe('the prediction pool service', () => {
  test('without a wallet secret it says so, and serves its routes', async () => {
    const settings = new Map<string, string>()
    const perps = { algoAccess: () => null, deployment: null } as unknown as PerpsService
    const svc = new PredictPoolService({
      settings: { getSetting: async k => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v) } },
      vault: null, perps, data: { tradeableMid: async () => null, settlementOf: async () => null, specOf: () => null },
    })
    await svc.start()
    svc.stop()
    expect(svc.status().waiting).toContain('BOT_WALLET_SECRET')
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const st = svc.handle(new URL('http://x/v1/predict/pool/status'), json)!
    expect(st.status).toBe(200)
    expect(((await st.json()) as { deployment: unknown }).deployment).toBeNull()
    expect(svc.handle(new URL('http://x/v1/predict/pool/fills?account=nope'), json)!.status).toBe(400)
    const fills = await svc.handle(new URL('http://x/v1/predict/pool/fills'), json)!.json() as { fills: unknown[] }
    expect(fills.fills).toEqual([])
    expect(svc.handle(new URL('http://x/v1/predict/pool/other'), json)).toBeNull()
  })
})
