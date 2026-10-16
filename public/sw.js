// Gateway PWA Service Worker v4 - Zero-failure native pass-through
const CACHE_NAME = 'gateway-pwa-v4';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Purge ALL existing caches on activation to eliminate any corrupted/white responses
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => self.clients.claim())
  );
});

// An empty fetch listener satisfies PWA installability criteria in Chromium/Brave
// while allowing the browser to handle 100% of network traffic natively with zero risk of crashing.
self.addEventListener('fetch', (event) => {
  // Native browser pass-through
});

