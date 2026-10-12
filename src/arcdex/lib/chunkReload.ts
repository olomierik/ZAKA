// After a deploy, the site's code files have new names and the old ones are gone (Netlify deploys are atomic). A page
// left open still asks for the old names the first time it opens a part of the app it hadn't loaded, and that request
// fails: the app went blank. Now such a failure reloads the page once, which loads the new version.

const KEY = 'arcdex:chunk-reload'
const QUIET_MS = 30_000

/** A failure to load one of the app's own code files (the browsers word it differently). */
export function isChunkError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk \S+ failed/i.test(m)
}

/** Reloads to pick up the new version, at most once in 30 seconds (a file that's really missing can't loop). Returns
 * whether it reloads. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < QUIET_MS) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch { /* storage blocked: reload anyway, once per page load */ }
  window.location.reload()
  return true
}

/** Vite reports a failed preload of a lazy part of the app as `vite:preloadError`. */
export function watchChunkErrors() {
  window.addEventListener('vite:preloadError', e => { if (reloadForNewVersion()) e.preventDefault() })
}
