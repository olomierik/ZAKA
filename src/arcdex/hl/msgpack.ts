// The MessagePack encoding Hyperliquid hashes its "L1" actions with (signing.ts actionHash), written to match Python's
// msgpack.packb exactly, since that is what the venue checks a signature against: maps keep their keys' insertion
// order, every integer takes its smallest form, strings are UTF-8 str types, byte arrays are bin types, and other
// numbers are float64. Nothing else is needed for Hyperliquid's actions.

// Objects are any plain object (typed interfaces such as an order's wire form included); what's inside is checked as
// it's packed, and anything else (a function, a Date, a Map) is refused.
type Packable = null | boolean | number | bigint | string | Uint8Array | readonly Packable[] | object

class Out {
  private buf = new Uint8Array(256)
  private n = 0
  private room(k: number) {
    if (this.n + k <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k))
    next.set(this.buf.subarray(0, this.n))
    this.buf = next
  }
  byte(b: number) { this.room(1); this.buf[this.n++] = b }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length }
  uint(v: bigint, size: number) { for (let i = size - 1; i >= 0; i--) this.byte(Number((v >> BigInt(8 * i)) & 0xffn)) }
  result() { return this.buf.slice(0, this.n) }
}

const utf8 = new TextEncoder()

function int(out: Out, v: bigint) {
  if (v >= 0n) {
    if (v < 128n) out.byte(Number(v))
    else if (v < 0x100n) { out.byte(0xcc); out.uint(v, 1) }
    else if (v < 0x10000n) { out.byte(0xcd); out.uint(v, 2) }
    else if (v < 0x100000000n) { out.byte(0xce); out.uint(v, 4) }
    else if (v < 0x10000000000000000n) { out.byte(0xcf); out.uint(v, 8) }
    else throw new Error('msgpack: integer too large')
    return
  }
  if (v >= -32n) out.byte(Number(v & 0xffn))
  else if (v >= -0x80n) { out.byte(0xd0); out.uint(v & 0xffn, 1) }
  else if (v >= -0x8000n) { out.byte(0xd1); out.uint(v & 0xffffn, 2) }
  else if (v >= -0x80000000n) { out.byte(0xd2); out.uint(v & 0xffffffffn, 4) }
  else if (v >= -0x8000000000000000n) { out.byte(0xd3); out.uint(v & 0xffffffffffffffffn, 8) }
  else throw new Error('msgpack: integer too small')
}

function head(out: Out, len: number, fix: number | null, fixMax: number, c8: number | null, c16: number, c32: number) {
  if (fix !== null && len <= fixMax) out.byte(fix | len)
  else if (c8 !== null && len < 0x100) { out.byte(c8); out.uint(BigInt(len), 1) }
  else if (len < 0x10000) { out.byte(c16); out.uint(BigInt(len), 2) }
  else { out.byte(c32); out.uint(BigInt(len), 4) }
}

function pack(out: Out, v: Packable): void {
  if (v === null) return out.byte(0xc0)
  if (v === true) return out.byte(0xc3)
  if (v === false) return out.byte(0xc2)
  if (typeof v === 'bigint') return int(out, v)
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (!Number.isSafeInteger(v)) throw new Error('msgpack: unsafe integer, pass a bigint')
      return int(out, BigInt(v))
    }
    out.byte(0xcb)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v)
    return out.bytes(b)
  }
  if (typeof v === 'string') {
    const b = utf8.encode(v)
    head(out, b.length, 0xa0, 31, 0xd9, 0xda, 0xdb)
    return out.bytes(b)
  }
  if (v instanceof Uint8Array) {
    head(out, v.length, null, 0, 0xc4, 0xc5, 0xc6)
    return out.bytes(v)
  }
  if (Array.isArray(v)) {
    head(out, v.length, 0x90, 15, null, 0xdc, 0xdd)
    for (const x of v as readonly Packable[]) pack(out, x)
    return
  }
  // A plain object: its defined keys in insertion order (Python dicts keep theirs; an absent key is not packed).
  if (typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`msgpack: can't pack ${typeof v === 'object' ? (v as object).constructor?.name ?? 'this object' : typeof v}`)
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter(k => o[k] !== undefined)
  head(out, keys.length, 0x80, 15, null, 0xde, 0xdf)
  for (const k of keys) { pack(out, k); pack(out, o[k] as Packable) }
}

export function msgpack(v: Packable): Uint8Array {
  const out = new Out()
  pack(out, v)
  return out.result()
}

export type { Packable }
