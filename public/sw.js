const CACHE_NAME = 'gateway-pwa-v1';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always pass-through non-GET, API calls, and mutation routes directly to network
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/browser') ||
    url.pathname.startsWith('/system') ||
    url.pathname.startsWith('/gateway')
  ) {
    return;
  }

  // Network-first for navigation/pages (so dashboard and auth status are always up to date)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/') || caches.match(event.request))
    );
    return;
  }

  // Cache-first for icons and manifest
  if (url.pathname.endsWith('.png') || url.pathname.endsWith('.json') || url.pathname.endsWith('.ico')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Default network with cache fallback
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
