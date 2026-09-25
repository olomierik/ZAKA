// Record real RPC answers once (engine/scripts/capture-fixtures.ts), replay
// them in tests — so adapter and parser tests run on genuine Arc mainnet
// data without touching the network.

import type { Rpc } from '../../src/chain/http'

export type Recording = Record<string, unknown>
const key = (method: string, params: unknown[]) => `${method} ${JSON.stringify(params)}`

export class RecordingRpc implements Rpc {
  readonly calls: Recording = {}
  constructor(private inner: Rpc) {}
  async call<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T> {
    const r = await this.inner.call<T>(method, params, timeoutMs)
    this.calls[key(method, params)] = r
    return r
  }
  async batch<T>(calls: { method: string; params: unknown[] }[], timeoutMs?: number): Promise<(T | null)[]> {
    const r = await this.inner.batch<T>(calls, timeoutMs)
    calls.forEach((c, i) => { this.calls[key(c.method, c.params)] = r[i] })
    return r
  }
}

export class ReplayRpc implements Rpc {
  readonly missed: string[] = []
  constructor(private rec: Recording) {}
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const k = key(method, params)
    if (!(k in this.rec)) { this.missed.push(k); throw new Error(`not recorded: ${k}`) }
    return this.rec[k] as T
  }
  async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
    return calls.map(c => {
      const k = key(c.method, c.params)
      if (!(k in this.rec)) { this.missed.push(k); return null }
      return this.rec[k] as T
    })
  }
}
