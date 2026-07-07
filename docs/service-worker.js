const CACHE_VERSION = 'whitetree-shell-v68';
const APP_SHELL = [
  './',
  './static/manifest.webmanifest?v=pwa-start-1',
  './static/supabase-config.js?v=account-name-2',
  './static/local-api.js?v=account-name-5',
  './static/fullcalendar-6.1.18.min.js?v=fc-local-1',
  './static/icons/icon-192.png',
  './static/icons/icon-512.png',
  './static/icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    if (request.mode === 'navigate') {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_VERSION);
        await cache.put('./', fresh.clone());
        return fresh;
      } catch (error) {
        const shell = await caches.match('./');
        if (shell) return shell;
        throw error;
      }
    }

    const cached = await caches.match(request);
    if (cached) {
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_VERSION);
          await cache.put(request, fresh.clone());
        } catch (error) {
          // Keep serving the cached response while offline.
        }
      })());
      return cached;
    }

    const response = await fetch(request);
    const cache = await caches.open(CACHE_VERSION);
    await cache.put(request, response.clone());
    return response;
  })());
});
