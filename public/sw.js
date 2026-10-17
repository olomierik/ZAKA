// ARCDEX's service worker: shows the alerts the market engine pushes (engine/src/alerts) with ARCDEX closed, and opens
// the page an alert names when it's clicked. It caches nothing and answers no requests, so the site's files always come
// from the network, as before it existed.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

const pathOnly = u => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/')

self.addEventListener('push', event => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { title: 'ARCDEX', body: event.data ? event.data.text() : '' } }
  const url = pathOnly(d.url)
  const tag = String(d.tag || 'arcdex').slice(0, 64)
  event.waitUntil(Promise.all([
    // The same alert's notification replaces the one before (an open tab may have shown it too).
    self.registration.showNotification(String(d.title || 'ARCDEX').slice(0, 120), {
      body: String(d.body || '').slice(0, 200), tag, renotify: true, icon: '/icon-192.png', badge: '/favicon-64.png', data: { url, at: d.at || Date.now() },
    }),
    // Open tabs mark it reached in their lists.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ type: 'arcdex-push', tag, at: d.at || Date.now() }))),
  ]))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(pathOnly(event.notification.data && event.notification.data.url), self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const same = cs.find(c => c.url === url)
    if (same) return same.focus()
    const any = cs.find(c => 'navigate' in c)
    if (any) return any.navigate(url).then(c => (c ? c.focus() : self.clients.openWindow(url)), () => self.clients.openWindow(url))
    return self.clients.openWindow(url)
  }))
})
