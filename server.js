require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const ngrok = require('@ngrok/ngrok');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Middleware para parsear JSON
app.use(express.json());

// Helper para logs formateados con timestamp [HH:MM:SS]
function log(message) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
  console.log(`${timestamp} ${message}`);
}

// Variables de estado en Runtime
let browserBrowserAbierto = false;
let browserPresenciaActiva = false;
let browserIntervalMs = 240000; // 4 minutos por defecto
let browserBrowserContext = null;
let browserPage = null;
let browserIntervalId = null;

// URL del túnel público ngrok
let ngrokUrl = '';
let ngrokListener = null;

// Middleware de Autenticación para rutas de la API (interviene en /browser, /sistema, y /gateway/status)
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/favicon.ico') {
    return next();
  }

  const clientApiKey = req.headers['x-api-key'];
  log(`Solicitud API interceptada: ${req.method} ${req.originalUrl}`);

  if (!clientApiKey || clientApiKey !== API_KEY) {
    log('Acceso denegado: API Key inválida o ausente.');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Acceso no autorizado. El encabezado X-API-KEY es requerido y debe ser válido.'
    });
  }

  next();
});

// Helper para limpiar el contexto e intervalo de Browser de forma segura
async function cleanupBrowserSession() {
  if (browserIntervalId) {
    clearInterval(browserIntervalId);
    browserIntervalId = null;
    log('Intervalo de simulación de presencia destruido.');
  }
  browserPresenciaActiva = false;

  if (browserBrowserContext) {
    try {
      await browserBrowserContext.close();
      log('Contexto de navegador Playwright cerrado.');
    } catch (err) {
      log(`Error al cerrar el contexto de Playwright: ${err.message}`);
    } finally {
      browserBrowserContext = null;
      browserPage = null;
    }
  }
  browserBrowserAbierto = false;
}

// Endpoint GET /gateway/status
app.get('/gateway/status', (req, res) => {
  res.json({
    browserBrowserAbierto,
    browserPresenciaActiva,
    browserIntervalMs,
    ngrokUrl: ngrokUrl || 'Inactivo',
    hasEmulatorPath: !!process.env.EMULATOR_BAT_PATH
  });
});

// 1. Endpoint POST /browser/browser para controlar el ciclo del navegador Browser
app.post('/browser/browser', async (req, res) => {
  const { accion } = req.body;

  if (accion !== 'abrir' && accion !== 'cerrar') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "La 'accion' debe ser 'abrir' o 'cerrar'."
    });
  }

  try {
    if (accion === 'abrir') {
      if (browserBrowserContext) {
        log('El navegador ya se encuentra abierto.');
        return res.status(200).json({
          status: 'ok',
          message: 'El navegador de Browser ya está abierto.'
        });
      }

      const userDataDir = path.join(__dirname, 'browser_user_data');
      log(`Abriendo ventana de Playwright en: ${userDataDir}`);
      
      browserBrowserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: null
      });

      const pages = browserBrowserContext.pages();
      if (pages.length > 0) {
        browserPage = pages[0];
      } else {
        browserPage = await browserBrowserContext.newPage();
      }

      log('Navegando asíncronamente a https://example.com...');
      browserPage.goto('https://example.com').catch((err) => {
        log(`Error al navegar a Browser: ${err.message}`);
      });

      browserBrowserAbierto = true;
      return res.status(200).json({
        status: 'ok',
        message: 'Navegador de Browser abierto con éxito y cargando página.'
      });

    } else {
      await cleanupBrowserSession();
      return res.status(200).json({
        status: 'ok',
        message: 'Navegador de Browser cerrado y simulación desactivada.'
      });
    }
  } catch (error) {
    log(`Error al controlar el navegador de Browser: ${error.message}`);
    await cleanupBrowserSession();
    return res.status(500).json({
      error: 'Internal Server Error',
      message: `Fallo al modificar estado del navegador: ${error.message}`
    });
  }
});

// 2. Endpoint POST /browser/presencia para controlar la simulación de actividad
app.post('/browser/presencia', (req, res) => {
  const { accion, intervaloMs } = req.body;

  if (accion !== 'iniciar' && accion !== 'pausar') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "La 'accion' de presencia debe ser 'iniciar' o 'pausar'."
    });
  }

  // Actualizar intervalo en runtime si se especifica
  if (intervaloMs && typeof intervaloMs === 'number' && intervaloMs > 0) {
    browserIntervalMs = intervaloMs;
    log(`Intervalo de Browser actualizado a: ${browserIntervalMs} ms`);
  }

  if (accion === 'iniciar') {
    if (!browserBrowserContext || !browserPage) {
      log('Error de presencia: Se intentó simular actividad sin tener el navegador abierto.');
      return res.status(400).json({
        error: 'Precondition Failed',
        message: 'No se puede iniciar la simulación si la ventana de Browser no está abierta.'
      });
    }

    if (browserIntervalId) {
      log('La simulación de presencia ya está activa. Reconfigurando intervalo.');
      clearInterval(browserIntervalId);
    }

    setupBrowserInterval();
    browserPresenciaActiva = true;
    log('Simulación de presencia activada.');
    
    return res.status(200).json({
      status: 'ok',
      message: 'Simulación de presencia activada correctamente.',
      config: { browserIntervalMs }
    });
  } else {
    // Pausar
    if (browserIntervalId) {
      clearInterval(browserIntervalId);
      browserIntervalId = null;
      log('Simulación de presencia pausada.');
    }
    browserPresenciaActiva = false;
    return res.status(200).json({
      status: 'ok',
      message: 'Simulación de presencia pausada.'
    });
  }
});

// Iniciar intervalo de actividad de Browser
function setupBrowserInterval() {
  browserIntervalId = setInterval(async () => {
    try {
      if (!browserBrowserContext) {
        clearInterval(browserIntervalId);
        browserIntervalId = null;
        browserPresenciaActiva = false;
        return;
      }

      // Validar si la página sigue abierta
      if (!browserPage || browserPage.isClosed()) {
        const pages = browserBrowserContext.pages();
        if (pages.length > 0) {
          browserPage = pages[0];
        } else {
          log('Advertencia: No hay páginas en Browser para simular presencia.');
          return;
        }
      }

      log('Simulando actividad en Browser (movimiento de mouse y teclado)...');
      
      // 1. Movimiento del mouse
      const x = Math.floor(Math.random() * 500) + 100;
      const y = Math.floor(Math.random() * 500) + 100;
      await browserPage.mouse.move(x, y);
      
      // 2. Pulsación de Shift
      await browserPage.keyboard.press('Shift');

      // 3. Intento de click en caja de búsqueda
      try {
        await browserPage.click('#search-input-selector', { timeout: 1000 });
      } catch (e) {
        // Ignorar, ya cubierto con mouse y teclado
      }
      
      log('Actividad simulada con éxito.');
    } catch (err) {
      log(`Error al simular actividad de Browser: ${err.message}`);
    }
  }, browserIntervalMs);
}

// Endpoint POST /browser/status (Compatibilidad hacia atrás)
app.post('/browser/status', async (req, res) => {
  const { estado, intervaloMs } = req.body;
  log(`[Compatibilidad] POST /browser/status recibido con estado '${estado}'`);

  if (intervaloMs) {
    browserIntervalMs = intervaloMs;
  }

  try {
    if (estado === 'activo') {
      if (!browserBrowserContext) {
        const userDataDir = path.join(__dirname, 'browser_user_data');
        browserBrowserContext = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          viewport: null
        });
        const pages = browserBrowserContext.pages();
        browserPage = pages.length > 0 ? pages[0] : await browserBrowserContext.newPage();
        browserPage.goto('https://example.com').catch(() => {});
        browserBrowserAbierto = true;
      }
      if (browserIntervalId) clearInterval(browserIntervalId);
      setupBrowserInterval();
      browserPresenciaActiva = true;

      return res.status(200).json({
        status: 'ok',
        message: 'Sesión de Browser iniciada e intervalo de actividad configurado.'
      });
    } else {
      await cleanupBrowserSession();
      return res.status(200).json({
        status: 'ok',
        message: 'Sesión y telemetría de Browser detenidas.'
      });
    }
  } catch (error) {
    await cleanupBrowserSession();
    return res.status(500).json({ error: 'Internal Error', message: error.message });
  }
});

// 3. Endpoint POST /sistema/ejecutar para lanzar programas locales como el Emulador
app.post('/sistema/ejecutar', (req, res) => {
  const { programa } = req.body;

  if (programa !== 'emulador') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "Programa no soportado. Actualmente solo se soporta 'emulador'."
    });
  }

  const batPath = process.env.EMULATOR_BAT_PATH;

  if (!batPath || batPath.trim() === '') {
    log('Error de ejecución: Se solicitó iniciar emulador pero EMULATOR_BAT_PATH no está configurado.');
    return res.status(400).json({
      error: 'Configuration Error',
      message: "La variable EMULATOR_BAT_PATH no está configurada en el archivo '.env'."
    });
  }

  log(`Iniciando comando del emulador en background: ${batPath}`);
  
  exec(`cmd.exe /c "${batPath}"`, (error, stdout, stderr) => {
    if (error) {
      log(`Error al ejecutar el script de emulador: ${error.message}`);
      return;
    }
    if (stderr) {
      log(`Salida de error en ejecución de emulador: ${stderr}`);
    }
    log(`Emulador ejecutado. Salida estándar: ${stdout}`);
  });

  return res.status(200).json({
    status: 'ok',
    message: 'Script de inicio del emulador ejecutado con éxito en background.'
  });
});

// Endpoint GET /: Interfaz Web Dashboard Premium con controles desacoplados y acciones de sistema
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gateway Control Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0d0e15 0%, #151722 100%);
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.4);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.4);
      --danger: #ef4444;
      --danger-glow: rgba(239, 68, 68, 0.4);
      --warning: #f59e0b;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Outfit', sans-serif;
    }

    body {
      background: var(--bg-gradient);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px;
      overflow-x: hidden;
    }

    header {
      width: 100%;
      max-width: 600px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 25px;
      padding: 10px 5px;
    }

    .logo-container h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(to right, #818cf8, #c084fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-container p {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .btn-icon {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 50%;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--text);
      transition: all 0.2s ease;
      backdrop-filter: blur(10px);
    }

    .btn-icon:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: scale(1.05);
    }

    main {
      width: 100%;
      max-width: 600px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 24px;
      backdrop-filter: blur(16px);
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
      position: relative;
      overflow: hidden;
      transition: border-color 0.3s ease;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 4px;
      background: transparent;
      transition: background 0.3s ease;
    }

    .card.active-state::before {
      background: linear-gradient(90deg, var(--primary), var(--success));
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .card-title-group h2 {
      font-size: 1.15rem;
      font-weight: 600;
    }

    .card-title-group p {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .status-badge-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-end;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.65rem;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 10px;
      border-radius: 30px;
      border: 1px solid var(--card-border);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-badge .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .status-badge.active {
      color: var(--success);
      border-color: rgba(16, 185, 129, 0.2);
      background: rgba(16, 185, 129, 0.1);
    }

    .status-badge.active .dot {
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 1.5s infinite alternate;
    }

    .form-group {
      margin-bottom: 18px;
    }

    .form-label-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .slider {
      -webkit-appearance: none;
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.1);
      outline: none;
      margin: 10px 0;
    }

    .slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--primary);
      cursor: pointer;
      box-shadow: 0 0 10px var(--primary-glow);
      transition: transform 0.1s ease;
    }

    .slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }

    .btn-row {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }

    .btn {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 12px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-2px);
    }

    .btn-primary {
      background: var(--primary);
      border-color: var(--primary);
      box-shadow: 0 4px 15px var(--primary-glow);
    }

    .btn-primary:hover {
      background: #4f46e5;
    }

    .btn-success {
      background: var(--success);
      border-color: var(--success);
      box-shadow: 0 4px 15px var(--success-glow);
    }

    .btn-success:hover {
      background: #059669;
    }

    .btn-danger {
      background: var(--danger);
      border-color: var(--danger);
      box-shadow: 0 4px 15px var(--danger-glow);
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    .btn-disabled {
      opacity: 0.4;
      cursor: not-allowed !important;
      pointer-events: none;
    }

    /* Modal de Configuración */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
      padding: 20px;
    }

    .modal-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }

    .modal {
      background: #11131c;
      border: 1px solid var(--card-border);
      border-radius: 24px;
      width: 100%;
      max-width: 450px;
      padding: 28px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      transform: translateY(-20px);
      transition: transform 0.3s ease;
    }

    .modal-overlay.open .modal {
      transform: translateY(0);
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .modal-header h3 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .modal-body input {
      width: 100%;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      color: var(--text);
      font-size: 0.9rem;
      outline: none;
      margin-top: 8px;
    }

    /* Advertencias */
    .warning-banner {
      width: 100%;
      max-width: 600px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 14px 20px;
      border-radius: 14px;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.85rem;
      animation: slideInDown 0.3s ease;
    }

    .warning-banner button {
      background: var(--danger);
      border: none;
      color: white;
      padding: 6px 12px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.75rem;
    }

    /* Tunnel Bar */
    .tunnel-bar {
      width: 100%;
      max-width: 600px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 14px;
      padding: 12px 20px;
      margin-top: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 0.8rem;
    }

    .tunnel-bar span.badge {
      background: var(--primary);
      color: white;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .tunnel-bar a {
      color: #a5b4fc;
      text-decoration: none;
      word-break: break-all;
    }

    .tunnel-bar a:hover {
      text-decoration: underline;
    }

    /* Toast Notifications */
    .toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 2000;
    }

    .toast {
      background: rgba(17, 19, 28, 0.9);
      border-left: 4px solid var(--primary);
      border-top: 1px solid var(--card-border);
      border-bottom: 1px solid var(--card-border);
      border-right: 1px solid var(--card-border);
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 250px;
      animation: slideInRight 0.3s ease forwards;
      backdrop-filter: blur(10px);
    }

    .toast.success { border-left-color: var(--success); }
    .toast.error { border-left-color: var(--danger); }

    @keyframes pulse {
      from { box-shadow: 0 0 4px rgba(16, 185, 129, 0.3); }
      to { box-shadow: 0 0 12px rgba(16, 185, 129, 0.7); }
    }

    @keyframes slideInRight {
      from { transform: translateX(120%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    @keyframes slideInDown {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .divider {
      height: 1px;
      background: var(--card-border);
      margin: 15px 0;
    }

    .card-section-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-muted);
      letter-spacing: 0.5px;
      margin-bottom: 10px;
      font-weight: 600;
    }

    @media (max-width: 480px) {
      body { padding: 15px; }
      .card { padding: 20px; }
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-container">
      <h1>Gateway Control Center</h1>
      <p>API Gateway & Automatizaciones</p>
    </div>
    <button class="btn-icon" onclick="openSettings()" title="Configuración de Credenciales">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
    </button>
  </header>

  <main>
    <div id="apiKeyWarning" class="warning-banner" style="display: none;">
      <span>⚠️ No has configurado tu clave X-API-KEY en el panel.</span>
      <button onclick="openSettings()">Configurar</button>
    </div>

    <!-- CARD 1: MICROSOFT TEAMS (CONTROLES DESACOPLADOS) -->
    <div class="card" id="cardBrowser">
      <div class="card-header">
        <div class="card-title-group">
          <h2>Presencia en Browser</h2>
          <p>Navegador Playwright y simulación independientes</p>
        </div>
        <div class="status-badge-container">
          <div class="status-badge" id="browserBadge">
            <div class="dot"></div>
            <span id="browserBadgeText">Navegador: Cerrado</span>
          </div>
          <div class="status-badge" id="presenciaBadge">
            <div class="dot"></div>
            <span id="presenciaBadgeText">Mantener Activo: Off</span>
          </div>
        </div>
      </div>

      <!-- SECCIÓN 1.A: NAVEGADOR -->
      <div class="card-section-title">Ventana del Navegador</div>
      <div class="btn-row" style="margin-bottom: 20px;">
        <button class="btn btn-primary" id="btnBrowserOpen" onclick="controlBrowser('abrir')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          Abrir Ventana
        </button>
        <button class="btn btn-danger" id="btnBrowserClose" onclick="controlBrowser('cerrar')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>
          Cerrar Ventana
        </button>
      </div>

      <div class="divider"></div>

      <!-- SECCIÓN 1.B: AUTOMATIZACIÓN DE ACTIVIDAD -->
      <div class="card-section-title">Mantener Activo (Simulador de Presencia)</div>
      
      <div class="form-group">
        <div class="form-label-row">
          <span>Intervalo de Simulación</span>
          <span id="browserIntervalVal">4.0 minutos</span>
        </div>
        <input type="range" class="slider" id="browserIntervalSlider" min="1" max="15" step="0.5" value="4" oninput="updateBrowserSliderLabel(this.value)">
      </div>

      <div class="btn-row">
        <button class="btn btn-success" id="btnPresenciaPlay" onclick="controlPresencia('iniciar')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Iniciar Simulación
        </button>
        <button class="btn" id="btnPresenciaPause" onclick="controlPresencia('pausar')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
          Pausar
        </button>
      </div>
    </div>

    <!-- CARD 2: ACCIONES DE SISTEMA -->
    <div class="card" id="cardSistema">
      <div class="card-header">
        <div class="card-title-group">
          <h2>Acciones de Sistema</h2>
          <p>Ejecutar programas y scripts en la PC</p>
        </div>
      </div>
      <div class="form-group" style="margin-bottom: 10px;">
        <p style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
          Permite iniciar el emulador configurado en el archivo <code>.env</code> desde tu celular.
        </p>
      </div>
      <button class="btn btn-primary" id="btnEmulador" style="width: 100%; margin-top: 5px;" onclick="ejecutarPrograma('emulador')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="12" y1="2" x2="12" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line></svg>
        Iniciar Emulador (.bat)
      </button>
    </div>

    <!-- Barra de info de túnel ngrok -->
    <div class="tunnel-bar" id="tunnelBar" style="display: none;">
      <span class="badge">Remoto</span>
      <span>Túnel seguro activo: <a id="tunnelLink" href="#" target="_blank">Cargando...</a></span>
    </div>
  </main>

  <!-- MODAL DE AJUSTES -->
  <div class="modal-overlay" id="settingsModal">
    <div class="modal">
      <div class="modal-header">
        <h3>Credenciales de Acceso</h3>
        <button class="btn-icon" onclick="closeSettings()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label style="font-size: 0.85rem; color: var(--text-muted);">Clave X-API-KEY</label>
          <input type="password" id="inputApiKey" placeholder="Introduce la API Key del servidor">
        </div>
        <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="saveSettings()">
          Guardar Configuración
        </button>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let currentBrowserInterval = 4.0;

    document.addEventListener('DOMContentLoaded', () => {
      const savedKey = localStorage.getItem('X-API-KEY');
      if (savedKey) {
        document.getElementById('inputApiKey').value = savedKey;
      } else {
        document.getElementById('apiKeyWarning').style.display = 'flex';
      }
      
      pollGatewayStatus();
      setInterval(pollGatewayStatus, 5000);
    });

    function getApiKey() {
      return localStorage.getItem('X-API-KEY') || '';
    }

    function openSettings() {
      document.getElementById('settingsModal').classList.add('open');
    }

    function closeSettings() {
      document.getElementById('settingsModal').classList.remove('open');
    }

    function saveSettings() {
      const key = document.getElementById('inputApiKey').value.trim();
      if (!key) {
        showToast('Debes ingresar una clave API', 'error');
        return;
      }
      localStorage.setItem('X-API-KEY', key);
      document.getElementById('apiKeyWarning').style.display = 'none';
      closeSettings();
      showToast('Configuración guardada correctamente', 'success');
      pollGatewayStatus();
    }

    function updateBrowserSliderLabel(val) {
      document.getElementById('browserIntervalVal').innerText = parseFloat(val).toFixed(1) + ' minutos';
    }

    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = \`toast \${type}\`;
      
      let icon = '';
      if (type === 'success') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
      } else if (type === 'error') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      } else {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
      }

      toast.innerHTML = \`\${icon} <span>\${message}</span>\`;
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s ease reverse forwards';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // Consultar el estado en tiempo real del Gateway
    async function pollGatewayStatus() {
      const key = getApiKey();
      if (!key) return;

      try {
        const response = await fetch('/gateway/status', {
          headers: { 'X-API-KEY': key }
        });
        
        if (response.status === 403) {
          document.getElementById('apiKeyWarning').style.display = 'flex';
          return;
        }

        const data = await response.json();
        
        // Sincronizar UI de Navegador Browser
        const browserBadge = document.getElementById('browserBadge');
        const browserBadgeText = document.getElementById('browserBadgeText');
        const btnBrowserOpen = document.getElementById('btnBrowserOpen');
        const btnBrowserClose = document.getElementById('btnBrowserClose');

        if (data.browserBrowserAbierto) {
          browserBadge.className = 'status-badge active';
          browserBadgeText.innerText = 'Navegador: Abierto';
          btnBrowserOpen.className = 'btn btn-primary btn-disabled';
          btnBrowserClose.className = 'btn btn-danger';
          
          // Habilitar controles de presencia
          document.getElementById('btnPresenciaPlay').classList.remove('btn-disabled');
          document.getElementById('btnPresenciaPause').classList.remove('btn-disabled');
          document.getElementById('browserIntervalSlider').classList.remove('btn-disabled');
        } else {
          browserBadge.className = 'status-badge';
          browserBadgeText.innerText = 'Navegador: Cerrado';
          btnBrowserOpen.className = 'btn btn-primary';
          btnBrowserClose.className = 'btn btn-disabled';

          // Deshabilitar controles de presencia (requiere navegador abierto)
          document.getElementById('btnPresenciaPlay').classList.add('btn-disabled');
          document.getElementById('btnPresenciaPause').classList.add('btn-disabled');
          document.getElementById('browserIntervalSlider').classList.add('btn-disabled');
        }

        // Sincronizar UI de Presencia Browser
        const presenciaBadge = document.getElementById('presenciaBadge');
        const presenciaBadgeText = document.getElementById('presenciaBadgeText');
        const cardBrowser = document.getElementById('cardBrowser');
        const btnPresenciaPlay = document.getElementById('btnPresenciaPlay');
        const btnPresenciaPause = document.getElementById('btnPresenciaPause');

        if (data.browserPresenciaActiva) {
          presenciaBadge.className = 'status-badge active';
          presenciaBadgeText.innerText = 'Mantener Activo: On';
          cardBrowser.classList.add('active-state');
          btnPresenciaPlay.className = 'btn btn-success btn-disabled';
          btnPresenciaPause.className = 'btn';
        } else {
          presenciaBadge.className = 'status-badge';
          presenciaBadgeText.innerText = 'Mantener Activo: Off';
          if (!data.browserBrowserAbierto) {
            cardBrowser.classList.remove('active-state');
          }
          btnPresenciaPlay.className = 'btn btn-success';
          btnPresenciaPause.className = 'btn btn-disabled';
        }

        // Sincronizar Slider de Browser (solo si el usuario no lo está manipulando)
        if (document.activeElement !== document.getElementById('browserIntervalSlider')) {
          const mins = data.browserIntervalMs / 60000;
          document.getElementById('browserIntervalSlider').value = mins;
          updateBrowserSliderLabel(mins);
        }

        // Sincronizar emulador
        const btnEmulador = document.getElementById('btnEmulador');
        if (!data.hasEmulatorPath) {
          btnEmulador.classList.add('btn-disabled');
          btnEmulador.title = 'Configura EMULATOR_BAT_PATH en el archivo .env';
        } else {
          btnEmulador.classList.remove('btn-disabled');
          btnEmulador.title = '';
        }

        // Configuración de Ngrok Link
        const tunnelBar = document.getElementById('tunnelBar');
        if (data.ngrokUrl && data.ngrokUrl !== 'Inactivo') {
          tunnelBar.style.display = 'flex';
          const link = document.getElementById('tunnelLink');
          link.href = data.ngrokUrl;
          link.innerText = data.ngrokUrl;
        } else {
          tunnelBar.style.display = 'none';
        }

      } catch (err) {
        console.error('Error polling status:', err);
      }
    }

    // Controlar Navegador Browser (abrir/cerrar)
    async function controlBrowser(accion) {
      const key = getApiKey();
      if (!key) { openSettings(); return; }

      showToast(accion === 'abrir' ? 'Iniciando navegador...' : 'Cerrando navegador...', 'info');

      try {
        const response = await fetch('/browser/browser', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': key
          },
          body: JSON.stringify({ accion })
        });

        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
          pollGatewayStatus();
        } else {
          showToast(data.message || 'Error en la petición', 'error');
        }
      } catch (error) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    // Controlar Simulación de Presencia (iniciar/pausar)
    async function controlPresencia(accion) {
      const key = getApiKey();
      if (!key) { openSettings(); return; }

      const mins = parseFloat(document.getElementById('browserIntervalSlider').value);
      const ms = mins * 60000;

      showToast(accion === 'iniciar' ? 'Activando simulación...' : 'Pausando simulación...', 'info');

      try {
        const response = await fetch('/browser/presencia', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': key
          },
          body: JSON.stringify({ accion, intervaloMs: ms })
        });

        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
          pollGatewayStatus();
        } else {
          showToast(data.message || 'Error en la petición', 'error');
        }
      } catch (error) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    // Ejecutar programa en la PC (.bat del emulador)
    async function ejecutarPrograma(programa) {
      const key = getApiKey();
      if (!key) { openSettings(); return; }

      showToast('Enviando señal de ejecución...', 'info');

      try {
        const response = await fetch('/sistema/ejecutar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': key
          },
          body: JSON.stringify({ programa })
        });

        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
        } else {
          showToast(data.message || 'Error al ejecutar programa', 'error');
        }
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }
  </script>
</body>
</html>
  `);
});

// Manejo centralizado de cierre de proceso
async function gracefulShutdown() {
  log('Iniciando apagado ordenado del servidor...');
  await cleanupBrowserSession();
  
  if (ngrokListener) {
    try {
      await ngrokListener.close();
      log('Túnel ngrok cerrado correctamente.');
    } catch (err) {
      log(`Error al cerrar túnel ngrok: ${err.message}`);
    }
  }
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Inicializar el servidor Express
app.listen(PORT, async () => {
  log(`Servidor unificado (API Gateway Local) escuchando en http://localhost:${PORT}`);
  
  // Inicialización del túnel ngrok
  const token = process.env.NGROK_AUTHTOKEN;
  if (token && token.trim() !== '') {
    try {
      log('Iniciando túnel seguro ngrok...');
      const forwardOpts = {
        addr: PORT,
        authtoken: token
      };
      
      const domain = process.env.NGROK_DOMAIN;
      if (domain && domain.trim() !== '') {
        forwardOpts.domain = domain;
        log(`Usando dominio estático configurado: ${domain}`);
      }

      ngrokListener = await ngrok.forward(forwardOpts);
      ngrokUrl = ngrokListener.url();
      log(`¡Túnel ngrok establecido! URL Pública: ${ngrokUrl}`);
    } catch (error) {
      log(`Error al establecer el túnel ngrok: ${error.message}`);
    }
  } else {
    log('Variable NGROK_AUTHTOKEN vacía o no configurada. Servidor operando solo localmente.');
  }
});
