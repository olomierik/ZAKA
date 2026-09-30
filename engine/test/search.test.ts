// Finding a coin by name, ticker or address (GET /v1/search, DataApi.search):
// the ranking the site's search and the Launchpad share (searchScore).
import { describe, expect, test } from 'bun:test'
import { searchScore, type LaunchInfo } from '../../api/_marketProtocol'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi } from '../src/ws/server'

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const coin = (n: number, symbol: string, name: string): LaunchInfo => ({ token: A(n), name, symbol, decimals: 18, creator: null, txHash: '0x', blockNumber: 1, timestamp: n, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' })

describe('search', () => {
  const stored = [coin(1, 'APEPE', 'A Pepe'), coin(2, 'PEPEX', 'Pepe Extra'), coin(3, 'PEPE', 'Pepe'), coin(4, 'DOG', 'Big Pepe Dog')]
  const history = Object.assign(new NullHistoryStore(), { searchTokens: async () => stored })
  const hot = new MemoryHotStore()
  const api = new DataApi(null, hot, history)

  test('exact ticker first, then ticker prefix, then a name word, then anywhere', async () => {
    expect((await api.search('pepe', 10)).map(h => h.symbol)).toEqual(['PEPE', 'PEPEX', 'DOG', 'APEPE'])
  })
  test('with a $ and in capitals too', async () => {
    expect((await api.search('$PEPE', 1)).map(h => h.symbol)).toEqual(['PEPE'])
  })
  test('one character is not a search', async () => {
    expect(await api.search('p', 10)).toEqual([])
  })
  test('a full address finds the coin it names', async () => {
    hot.putMeta(A(7), coin(7, 'NATFLEX', 'Natflex'))
    expect((await api.search(A(7).toUpperCase().replace('0X', '0x'), 5)).map(h => h.symbol)).toEqual(['NATFLEX'])
    expect(await api.search(A(8), 5)).toEqual([])
  })
  test('the shared score', () => {
    const c = { symbol: 'ARCD', name: 'ARCDEX token', address: A(9) }
    expect(searchScore(c, 'arcd')).toBe(6)
    expect(searchScore(c, 'arc')).toBe(4)
    expect(searchScore(c, 'token')).toBe(3)
    expect(searchScore(c, 'dex')).toBe(2)
    expect(searchScore(c, 'zzz')).toBe(0)
  })
})
