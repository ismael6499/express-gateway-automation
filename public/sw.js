const CACHE_NAME = 'gateway-pwa-v2';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

const RECONNECTING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Gateway Reconnecting</title>
  <meta name="theme-color" content="#0b0f19">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0b0f19;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 32px 24px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      backdrop-filter: blur(10px);
    }
    .icon-container {
      position: relative;
      width: 72px;
      height: 72px;
      margin: 0 auto 20px auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .spinner {
      position: absolute;
      width: 100%;
      height: 100%;
      border: 3px solid rgba(59, 130, 246, 0.15);
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1.2s linear infinite;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    .pulse-dot {
      width: 18px;
      height: 18px;
      background: #3b82f6;
      border-radius: 50%;
      box-shadow: 0 0 16px #3b82f6;
      animation: pulse 1.8s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(0.85); opacity: 0.6; }
      50% { transform: scale(1.15); opacity: 1; }
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 10px;
      color: #ffffff;
    }
    p {
      color: #94a3b8;
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .countdown-bar {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    .countdown-fill {
      height: 100%;
      width: 100%;
      background: #3b82f6;
      transition: width 1s linear;
    }
    .status-badge {
      display: inline-block;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
      margin-bottom: 16px;
    }
    .btn-retry {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px 20px;
      border-radius: 12px;
      background: #3b82f6;
      color: #ffffff;
      font-size: 0.95rem;
      font-weight: 600;
      border: none;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s, transform 0.1s;
    }
    .btn-retry:active {
      transform: scale(0.98);
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-container">
      <div class="spinner"></div>
      <div class="pulse-dot"></div>
    </div>
    <div class="status-badge" id="badgeText">Connecting Tunnel</div>
    <h1 id="titleText">Reconnecting to Gateway...</h1>
    <p id="msgText">The secure tunnel is re-establishing automatically. Retrying in <b id="countdown">4</b>s...</p>
    <div class="countdown-bar">
      <div class="countdown-fill" id="countdownFill"></div>
    </div>
    <button class="btn-retry" onclick="location.reload()">
      🔄 <span id="btnText">Retry Now</span>
    </button>
  </div>
  <script>
    const isEs = navigator.language && navigator.language.startsWith('es');
    if (isEs) {
      document.getElementById('badgeText').innerText = 'Conectando Túnel';
      document.getElementById('titleText').innerText = 'Reconectando con el Gateway...';
      document.getElementById('msgText').innerHTML = 'El túnel seguro se está reestableciendo automáticamente. Reintentando en <b id="countdown">4</b>s...';
      document.getElementById('btnText').innerText = 'Reintentar Ahora';
    }
    let secondsLeft = 4;
    const total = 4;
    const countdownEl = document.getElementById('countdown');
    const fillEl = document.getElementById('countdownFill');
    const interval = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.innerText = secondsLeft;
      if (fillEl) fillEl.style.width = ((secondsLeft / total) * 100) + '%';
      if (secondsLeft <= 0) {
        clearInterval(interval);
        location.reload();
      }
    }, 1000);
  </script>
</body>
</html>`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(asset);
        } catch (e) {
          // Ignore individual asset caching failures during initial install
        }
      }
    })
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
    url.pathname.startsWith('/sistema') ||
    url.pathname.startsWith('/gateway') ||
    url.pathname.startsWith('/api')
  ) {
    return;
  }

  // Network-first for navigation/pages with bulletproof offline/reconnecting fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(event.request);
          // If response is successful, update cache and return
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
            return networkResponse;
          }

          // If ngrok returned 404 (ERR_NGROK_3200) or 502/503/504 edge errors
          if (!networkResponse || networkResponse.status === 404 || networkResponse.status >= 500) {
            const cachedPage = await caches.match(event.request) || await caches.match('/');
            if (cachedPage) return cachedPage;
            return new Response(RECONNECTING_HTML, {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          }

          return networkResponse;
        } catch (networkErr) {
          // Network failed or offline: try cache first, then reconnecting fallback page
          const cachedPage = await caches.match(event.request) || await caches.match('/');
          if (cachedPage) return cachedPage;
          return new Response(RECONNECTING_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      })()
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
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Default network with cache fallback
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || new Response('', { status: 408, statusText: 'Request Timeout' });
    })
  );
});
