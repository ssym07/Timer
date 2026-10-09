// The build script injects a content version and the complete production asset list.
const VERSION = 'development';
const PRECACHE = [];
const PREFIX = `tempo-${self.registration.scope}-`;
const CACHE = `${PREFIX}${VERSION}`;
// Static hosts such as Cloudflare redirect /index.html to /. Cache the final
// document URL so Safari never receives a redirected navigation response.
const pageURL = new URL(self.registration.scope).href;
const assetURLs = new Set(PRECACHE.map(path => path === 'index.html'
  ? pageURL : new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  // A new version waits until the existing app windows close, protecting running timers.
  if (PRECACHE.length) event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...assetURLs])));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (!PRECACHE.length || event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(self.registration.scope)) return;
  const isAppPage = event.request.mode === 'navigate'
    && (url.pathname === new URL(self.registration.scope).pathname
      || url.pathname === new URL('index.html', self.registration.scope).pathname);
  const key = isAppPage ? pageURL : url.href;
  if (!isAppPage && !assetURLs.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(key) || fetch(event.request);
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const target = clients.find(client => client.url.startsWith(self.registration.scope));
    if (target) return target.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
