// Keeping the engine up (2026-09-30). The engine went unreachable when a
// failed start ended the process: the chain stream's first call hit an RPC
// that answered with an error page while Railway redeployed ("engine failed
// to start"), Railway restarted it into the same failure, then left it down.
// Nothing here is fatal any more: the start is retried while the API serves,
// and a timer that throws is logged and runs again next time.

import { errMsg, log } from './log'
import { metrics } from './metrics'

/** Runs `start` until it succeeds, waiting 5s, 10s, … (at most a minute) between tries. Resolves with the attempt that worked. */
export async function startWithRetry(name: string, start: () => Promise<void>, o: { stepMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const step = o.stepMs ?? 5_000, max = o.maxMs ?? 60_000
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      await start()
      if (attempt > 1) log.info(`${name} started`, { attempt })
      return attempt
    } catch (e) {
      metrics.inc('start_failures')
      const waitMs = Math.min(max, step * attempt)
      log.error(`${name} did not start; trying again`, { attempt, retryInSec: waitMs / 1000, error: errMsg(e) })
      await sleep(waitMs)
    }
  }
}

/** setInterval whose failures are logged, not fatal: a throw in a timer callback ends a Bun process. */
export function every(ms: number, name: string, fn: () => void): ReturnType<typeof setInterval> {
  return setInterval(() => guarded(name, fn), ms)
}

/** Runs `fn`; a throw is logged and counted instead of escaping. */
export function guarded(name: string, fn: () => void) {
  try { fn() } catch (e) { metrics.inc('timer_errors'); log.error(`${name} failed`, { error: errMsg(e) }) }
}

/** A promise that fails with no one to catch it is logged and counted, not fatal. */
export function keepAliveOnUnhandled() {
  process.on('unhandledRejection', e => { metrics.inc('unhandled_rejections'); log.error('unhandled rejection', { error: errMsg(e) }) })
}
