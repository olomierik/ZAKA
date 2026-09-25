// HTTP JSON-RPC with provider failover. Endpoints are tried in order; one
// that fails 3 times in a row is skipped for 30s (circuit breaker), so a dead
// provider costs one timeout, not one per call. Adding a provider = adding a
// URL to ARC_HTTP_URLS.

import { RpcError, rpcBatch, rpcCall } from '../../../api/_arcLogs'
import { metrics } from '../metrics'

interface Endpoint { url: string; host: string; fails: number; openUntil: number }

export interface Rpc {
  call<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T>
  batch<T>(calls: { method: string; params: unknown[] }[], timeoutMs?: number): Promise<(T | null)[]>
}

export class HttpRpc implements Rpc {
  private eps: Endpoint[]

  constructor(urls: string[]) {
    if (!urls.length) throw new Error('HttpRpc needs at least one endpoint')
    this.eps = urls.map(url => ({ url, host: safeHost(url), fails: 0, openUntil: 0 }))
  }

  private order(): Endpoint[] {
    const now = Date.now()
    const up = this.eps.filter(e => e.openUntil <= now)
    return up.length ? up : [...this.eps].sort((a, b) => a.openUntil - b.openUntil)
  }

  private async withFailover<T>(fn: (url: string) => Promise<T>): Promise<T> {
    let last: unknown
    for (const ep of this.order()) {
      try {
        const r = await fn(ep.url)
        ep.fails = 0
        return r
      } catch (e) {
        last = e
        // A JSON-RPC error that isn't throttling is the call's own fault
        // (e.g. execution reverted) — another provider won't change it.
        if (e instanceof RpcError && e.code !== 429 && !/rate|limit|timeout|unavailable|busy/i.test(e.message)) throw e
        metrics.inc('rpc_errors')
        if (++ep.fails >= 3) { ep.openUntil = Date.now() + 30_000; ep.fails = 0; metrics.inc('rpc_circuit_open') }
      }
    }
    throw last
  }

  call<T>(method: string, params: unknown[], timeoutMs = 8_000): Promise<T> {
    return this.withFailover(url => rpcCall<T>(url, method, params, timeoutMs))
  }

  batch<T>(calls: { method: string; params: unknown[] }[], timeoutMs = 8_000): Promise<(T | null)[]> {
    return this.withFailover(url => rpcBatch<T>(url, calls, timeoutMs))
  }

  status() { return this.eps.map(e => ({ host: e.host, open: e.openUntil > Date.now() })) }
}

export function safeHost(u: string) { try { return new URL(u).host } catch { return '?' } }
