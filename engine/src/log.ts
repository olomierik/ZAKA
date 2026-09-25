// Structured logging: one JSON object per line (easy to ship to any log
// store). Never pass secrets or full provider URLs here — URLs can embed
// API keys; log hosts instead.

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
let min: Level = 'info'

export function setLogLevel(l: Level) { min = l }

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[min]) return
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
