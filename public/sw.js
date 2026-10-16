const CACHE_NAME = 'gateway-pwa-v3';

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
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-container">
      <div class="spinner"></div>
      <div class="pulse-dot"></div>
    </div>
    <h1 id="titleText">Reconnecting to Gateway...</h1>
    <p id="msgText">Re-establishing connection. Retrying in <b id="countdown">3</b>s...</p>
    <button class="btn-retry" onclick="location.reload()">
      🔄 <span id="btnText">Retry Now</span>
    </button>
  </div>
  <script>
    const isEs = navigator.language && navigator.language.startsWith('es');
    if (isEs) {
      document.getElementById('titleText').innerText = 'Reconectando con el Gateway...';
      document.getElementById('msgText').innerHTML = 'Restableciendo conexión. Reintentando en <b id="countdown">3</b>s...';
      document.getElementById('btnText').innerText = 'Reintentar Ahora';
    }
    let secondsLeft = 3;
    const interval = setInterval(() => {
      secondsLeft--;
      const el = document.getElementById('countdown');
      if (el) el.innerText = secondsLeft;
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
});

self.addEventListener('activate', (event) => {
  // Purge ALL caches on activation to eliminate any corrupted/white cached responses
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always pass-through directly to network with ngrok bypass header
  const reqHeaders = new Headers(event.request.headers);
  reqHeaders.set('ngrok-skip-browser-warning', 'true');
  const reqClone = new Request(event.request, {
    headers: reqHeaders,
    credentials: 'include'
  });

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(reqClone).then((networkResponse) => {
        // If ngrok returns error code (404/502/503), show reconnecting screen
        if (!networkResponse || networkResponse.status === 404 || networkResponse.status >= 500) {
          return new Response(RECONNECTING_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        return networkResponse;
      }).catch(() => {
        return new Response(RECONNECTING_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(reqClone).catch(() => new Response('', { status: 408, statusText: 'Request Timeout' }))
  );
});
