// A tiny read-only PostgREST client for ARCDEX's public arcdex_* tables:
// the handful of supabase-js calls the app makes, with the same chaining
// shape — `await c.from(t).select(…).eq(…).limit(n)` → { data, error, count }
// — without shipping supabase-js (~270 KB: auth, realtime, storage) to
// every visitor. Writes never happen here; they go through /api/social.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>
export interface Result<T> { data: T | null; error: { message: string; code?: string } | null; count: number | null }

// Values inside in.(…) that contain PostgREST's reserved characters are quoted.
const quote = (v: string | number) => {
  const s = String(v)
  return /[,()"\\:]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}

class Query<T> implements PromiseLike<Result<T>> {
  private params: [string, string][] = []
  private prefer: string | null = null
  private head = false
  private one = false

  constructor(private url: string, private key: string) {}

  select(columns = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): Query<Row[]> {
    this.params.push(['select', columns.replace(/\s+/g, '')])
    if (opts?.count) this.prefer = `count=${opts.count}`
    if (opts?.head) this.head = true
    return this as unknown as Query<Row[]>
  }
  private filter(col: string, op: string, v: string | number) { this.params.push([col, `${op}.${v}`]); return this }
  eq(col: string, v: string | number) { return this.filter(col, 'eq', v) }
  neq(col: string, v: string | number) { return this.filter(col, 'neq', v) }
  gt(col: string, v: string | number) { return this.filter(col, 'gt', v) }
  gte(col: string, v: string | number) { return this.filter(col, 'gte', v) }
  lt(col: string, v: string | number) { return this.filter(col, 'lt', v) }
  lte(col: string, v: string | number) { return this.filter(col, 'lte', v) }
  ilike(col: string, pattern: string) { return this.filter(col, 'ilike', pattern) }
  in(col: string, values: (string | number)[]) { this.params.push([col, `in.(${values.map(quote).join(',')})`]); return this }
  or(expr: string) { this.params.push(['or', `(${expr})`]); return this }
  order(col: string, opts?: { ascending?: boolean }) { this.params.push(['order', `${col}.${opts?.ascending === false ? 'desc' : 'asc'}`]); return this }
  limit(n: number) { this.params.push(['limit', String(n)]); return this }
  /** First row or null (like supabase-js; more than one row is an error). */
  maybeSingle(): Query<Row> { this.one = true; return this as unknown as Query<Row> }

  then<A = Result<T>, B = never>(ok?: ((r: Result<T>) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(ok, fail)
  }

  private async run(): Promise<Result<T>> {
    const headers: Record<string, string> = { apikey: this.key, Authorization: `Bearer ${this.key}` }
    if (this.prefer) headers.Prefer = this.prefer
    try {
      const res = await fetch(`${this.url}?${new URLSearchParams(this.params)}`, { method: this.head ? 'HEAD' : 'GET', headers })
      const range = res.headers.get('content-range')
      const count = range && range.includes('/') ? Number(range.split('/')[1]) : null
      if (!res.ok) {
        const body = this.head ? null : await res.json().catch(() => null) as { message?: string; code?: string } | null
        return { data: null, error: { message: body?.message ?? `HTTP ${res.status}`, code: body?.code }, count: null }
      }
      if (this.head) return { data: null, error: null, count: Number.isFinite(count) ? count : null }
      const rows = (await res.json()) as Row[]
      if (this.one) {
        if (rows.length > 1) return { data: null, error: { message: 'more than one row' }, count }
        return { data: (rows[0] ?? null) as T, error: null, count }
      }
      return { data: rows as T, error: null, count: Number.isFinite(count) ? count : null }
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : 'network error' }, count: null }
    }
  }
}

export interface PostgrestClient {
  from(table: string): Query<Row[]>
  rpc(fn: string, args?: Record<string, unknown>): Promise<Result<any>>
}

export function createPostgrest(supabaseUrl: string, key: string): PostgrestClient {
  const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`
  return {
    from: table => new Query<Row[]>(`${base}/${table}`, key),
    async rpc(fn, args = {}) {
      try {
        const res = await fetch(`${base}/rpc/${fn}`, {
          method: 'POST',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        })
        const body = await res.json().catch(() => null)
        if (!res.ok) return { data: null, error: { message: (body as { message?: string } | null)?.message ?? `HTTP ${res.status}` }, count: null }
        return { data: body, error: null, count: null }
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : 'network error' }, count: null }
      }
    },
  }
}
