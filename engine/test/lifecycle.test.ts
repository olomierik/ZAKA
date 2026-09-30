// Keeping the engine up (engine/src/lifecycle.ts): a failed start is retried,
// not fatal; a timer that throws runs again next time.
import { describe, expect, test } from 'bun:test'
import { guarded, startWithRetry } from '../src/lifecycle'

describe('keeping the engine up', () => {
  test('a start that fails (an RPC answering with an error page) is tried again until it works', async () => {
    let calls = 0
    const waits: number[] = []
    const attempt = await startWithRetry('chain stream', async () => { if (++calls < 3) throw new Error('Failed to parse JSON') }, { sleep: async ms => { waits.push(ms) } })
    expect(attempt).toBe(3)
    expect(waits).toEqual([5_000, 10_000]) // longer each time
  })
  test('the wait between tries stops growing at a minute', async () => {
    let calls = 0
    const waits: number[] = []
    await startWithRetry('x', async () => { if (++calls < 20) throw new Error('down') }, { sleep: async ms => { waits.push(ms) } })
    expect(Math.max(...waits)).toBe(60_000)
  })
  test('a timer that throws is logged, not fatal', () => {
    let after = false
    expect(() => guarded('bot tick', () => { throw new TypeError('bad data') })).not.toThrow()
    guarded('bot tick', () => { after = true })
    expect(after).toBe(true)
  })
})
