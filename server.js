require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const ngrok = require('@ngrok/ngrok');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Middleware para parsear JSON
app.use(express.json());

// Helper para logs formateados con timestamp [HH:MM:SS]
const logFile = path.join(__dirname, 'gateway_server.log');
function log(message) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
  const formatted = `${timestamp} ${message}`;
  console.log(formatted);
  try {
    fs.appendFileSync(logFile, formatted + '\n');
  } catch (e) {}
}

// Helper para leer cookies de forma manual (evita dependencias adicionales)
function getApiKeyFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (let cookie of cookies) {
    const trimmed = cookie.trim();
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const name = trimmed.substring(0, index);
    const value = trimmed.substring(index + 1);
    if (name === 'api_key') return decodeURIComponent(value);
  }
  return null;
}

// Variables de estado en Runtime
let browserBrowserAbierto = false;
let browserPresenciaActiva = false;
let browserIntervalMs = 240000; // 4 minutos por defecto
let browserBrowserContext = null;
let browserPage = null;
let browserIntervalId = null;
let lastAutoCierreMinute = null; // evita re-disparar auto-cierre en el mismo minuto
let isLaunchingBrowser = false;  // guard anti-concurrencia al abrir/cerrar navegador
let lastActivityTime = null;     // timestamp de la ultima simulacion de actividad
let browserSimulacionStartHour = '09:00';
let browserSimulacionEndHour = '18:00';
let browserSimulacionDays = [1, 2, 3, 4, 5]; // Lunes a Viernes por defecto
let browserBrowserCloseHour = '18:03';
let browserBrowserCloseEnabled = true;

function isSimulationInSchedule() {
  const now = new Date();
  const day = now.getDay(); // 0 = Domingo, 1 = Lunes, etc.

  // 1. Verificar si el día de hoy está habilitado
  if (!browserSimulacionDays.includes(day)) {
    return false;
  }

  // 2. Verificar si la hora actual está dentro del rango
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentMinutesSinceMidnight = currentHour * 60 + currentMinute;

  const [startHour, startMin] = browserSimulacionStartHour.split(':').map(Number);
  const startMinutes = startHour * 60 + startMin;

  const [endHour, endMin] = browserSimulacionEndHour.split(':').map(Number);
  const endMinutes = endHour * 60 + endMin;

  if (startMinutes <= endMinutes) {
    // Rango normal (ej. 09:00 a 18:00)
    return currentMinutesSinceMidnight >= startMinutes && currentMinutesSinceMidnight <= endMinutes;
  } else {
    // Rango nocturno cruzando la medianoche (ej. 22:00 a 06:00)
    return currentMinutesSinceMidnight >= startMinutes || currentMinutesSinceMidnight <= endMinutes;
  }
}

const stateFilePath = path.join(__dirname, 'simulation_state.json');

function saveSimulationState() {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify({
      browserPresenciaActiva,
      browserIntervalMs,
      browserSimulacionStartHour,
      browserSimulacionEndHour,
      browserSimulacionDays,
      browserBrowserCloseHour,
      browserBrowserCloseEnabled
    }, null, 2));
  } catch (err) {
    log(`Error al guardar estado de simulación: ${err.message}`);
  }
}

function loadSimulationState() {
  try {
    if (fs.existsSync(stateFilePath)) {
      const data = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (data.browserPresenciaActiva !== undefined) {
        browserPresenciaActiva = data.browserPresenciaActiva;
      }
      if (data.browserIntervalMs !== undefined) {
        browserIntervalMs = data.browserIntervalMs;
      }
      if (data.browserSimulacionStartHour !== undefined) {
        browserSimulacionStartHour = data.browserSimulacionStartHour;
      }
      if (data.browserSimulacionEndHour !== undefined) {
        browserSimulacionEndHour = data.browserSimulacionEndHour;
      }
      if (data.browserSimulacionDays !== undefined) {
        browserSimulacionDays = data.browserSimulacionDays;
      }
      if (data.browserBrowserCloseHour !== undefined) {
        browserBrowserCloseHour = data.browserBrowserCloseHour;
      }
      if (data.browserBrowserCloseEnabled !== undefined) {
        browserBrowserCloseEnabled = data.browserBrowserCloseEnabled;
      }
      log(`Estado de simulación cargado: Habilitada=${browserPresenciaActiva}, Intervalo=${browserIntervalMs}ms, Horario=${browserSimulacionStartHour}-${browserSimulacionEndHour}, Cierre=${browserBrowserCloseHour} (Activo=${browserBrowserCloseEnabled})`);
    }
  } catch (err) {
    log(`Error al cargar estado de simulación: ${err.message}`);
  }
}

// URL del túnel público ngrok
let ngrokUrl = '';
let ngrokListener = null;

// Middleware de Autenticación para rutas de la API (interviene en /browser, /sistema, y /gateway/status)
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/favicon.ico') {
    return next();
  }

  const clientApiKey = req.headers['x-api-key'] || getApiKeyFromCookie(req.headers.cookie);
  log(`Solicitud API interceptada: ${req.method} ${req.originalUrl}`);

  if (!clientApiKey || clientApiKey !== API_KEY) {
    log('Acceso denegado: API Key inválida o ausente.');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Acceso no autorizado. El encabezado X-API-KEY o cookie es requerido y debe ser válido.'
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

// Bucle asíncrono para automatizar el login de Browser en las redirecciones de Microsoft
async function autoLoginTargetSession(page) {
  log('Iniciando monitoreo de auto-login de Browser Session...');
  
  const startTime = Date.now();
  const maxWaitMs = 120000; // 120 segundos máximo de tolerancia para cargas lentas

  while (Date.now() - startTime < maxWaitMs) {
    try {
      await new Promise(r => setTimeout(r, 2000));

      if (page.isClosed()) {
        log('Auto-Login: La página se cerró, cancelando monitoreo.');
        break;
      }

      const url = page.url();

      // Si la URL contiene "theme=light" o "theme=default", forzar modo oscuro redirigiendo
      if (url.includes('theme=light') || url.includes('theme=default')) {
        let newUrl = url;
        if (url.includes('theme=light')) {
          newUrl = url.replace('theme=light', 'theme=dark');
        } else if (url.includes('theme=default')) {
          newUrl = url.replace('theme=default', 'theme=dark');
        }
        log(`Auto-Login: Detectado tema claro/default en la URL. Redirigiendo a modo oscuro: ${newUrl}`);
        await page.goto(newUrl).catch((err) => {
          log(`Error al redirigir a modo oscuro: ${err.message}`);
        });
        continue;
      }

      // Si ya estamos en Browser
      if (url.includes('cloud.example.com') || url.includes('example.com')) {
        // Verificar si está la pantalla de carga lenta
        const loadingText = page.locator('text="We\'re setting things up for you"');
        const isSettingUp = await loadingText.isVisible().catch(() => false);
        if (isSettingUp) {
          log('Auto-Login: Pantalla "We\'re setting things up for you" detectada. Esperando a que finalice...');
          continue;
        }

        // Si ya cargó la app (por ejemplo, el buscador o la barra lateral)
        const chatInput = page.locator('input[placeholder*="Search"], input[placeholder*="Buscar"], div[data-testid="chat-list"]');
        const isLoaded = await chatInput.first().isVisible().catch(() => false);
        if (isLoaded) {
          log('¡Auto-Login exitoso! Browser Session ha cargado por completo.');
          break;
        }
      }

      // Si estamos en la página de login de Microsoft
      if (url.includes('login.microsoftonline.com')) {
        // Verificar si estamos en la pantalla de ingresar contraseña
        const passwordInput = page.locator('input[type="password"], input[name="passwd"]');
        const isPasswordPage = await passwordInput.first().isVisible().catch(() => false);

        if (isPasswordPage) {
          // Intentar presionar el botón de inicio o confirmación (Sign in)
          const btnSelectors = [
            '#idSIButton9',
            'input[type="submit"]',
            'button[type="submit"]',
            'input[value="Sign in"]',
            'input[value="Iniciar sesión"]'
          ];

          let clickedButton = false;
          for (let sel of btnSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
              const val = await loc.getAttribute('value') || await loc.innerText() || 'Submit';
              log(`Auto-Login: Botón de firma detectado (${val}). Presionando selector: ${sel}`);
              await loc.click({ force: true });
              clickedButton = true;
              break;
            }
          }
          if (clickedButton) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        } else {
          // No es la página de contraseña -> Puede ser "Pick an account" o "Stay signed in?"
          
          // 1. Intentar hacer clic en la fila de la cuenta ("Pick an account")
          // Excluimos selectores de texto simple que puedan confundirse con etiquetas
          const accountSelectors = [
            'div[data-username*="user@example.com"]',
            '[data-username*="user@example.com"]',
            'div[role="button"]:has-text("user@example.com")',
            '.tile:has-text("user@example.com")'
          ];

          let clickedAccount = false;
          for (let sel of accountSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
              log(`Auto-Login: Fila de cuenta detectada. Clickeando selector: ${sel}`);
              await loc.click({ force: true });
              clickedAccount = true;
              break;
            }
          }
          if (clickedAccount) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          // 2. Si no es selección de cuenta, puede ser la pantalla "Stay signed in?" (¿Quiere mantener la sesión?)
          const staySignedSelectors = [
            '#idSIButton9',
            'input[type="submit"]',
            'input[value="Yes"]',
            'input[value="Sí"]'
          ];
          let clickedStay = false;
          for (let sel of staySignedSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
              const val = await loc.getAttribute('value') || await loc.innerText() || 'Yes';
              log(`Auto-Login: Botón "Stay signed in" detectado (${val}). Presionando selector: ${sel}`);
              await loc.click({ force: true });
              clickedStay = true;
              break;
            }
          }
          if (clickedStay) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        }
      }
    } catch (err) {
      log(`Auto-Login (Aviso en bucle): ${err.message}`);
    }
  }
  log('Monitoreo de auto-login finalizado.');
}

// Helper para limpiar las variables cuando el usuario cierra manualmente la ventana sin matar el proceso a la fuerza
function handleManualCloseCleanup() {
  if (browserIntervalId) {
    clearInterval(browserIntervalId);
    browserIntervalId = null;
    log('Intervalo de simulación destruido tras cierre manual del navegador.');
  }
  browserPresenciaActiva = false;
  browserBrowserContext = null;
  browserPage = null;
  browserBrowserAbierto = false;
}

// Endpoint GET /gateway/status
app.get('/gateway/status', (req, res) => {
  const helperPath = path.join(__dirname, 'AudioHelper.exe');
  exec(`"${helperPath}"`, { timeout: 1500 }, (error, stdout) => {
    let audioData = { volume: null, muted: null, playing: null };
    if (!error && stdout) {
      try {
        audioData = JSON.parse(stdout.trim());
      } catch (e) {}
    }

    let lastActivityFormatted = 'Sin actividad';
    let lastActivitySecondsAgo = null;
    if (lastActivityTime) {
      const now = new Date();
      lastActivitySecondsAgo = Math.floor((now - lastActivityTime) / 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const d = lastActivityTime;
      lastActivityFormatted = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    res.json({
      browserBrowserAbierto,
      browserPresenciaActiva,
      browserIntervalMs,
      browserSimulacionStartHour,
      browserSimulacionEndHour,
      browserSimulacionDays,
      browserBrowserCloseHour,
      browserBrowserCloseEnabled,
      ngrokUrl: ngrokUrl || 'Inactivo',
      hasEmulatorPath: !!process.env.EMULATOR_BAT_PATH,
      audioVolume: audioData.volume,
      audioMuted: audioData.muted,
      audioPlaying: audioData.playing,
      lastActivityFormatted,
      lastActivitySecondsAgo
    });
  });
});

// Endpoint POST /browser/browser para controlar el ciclo del navegador Browser
app.post('/browser/browser', async (req, res) => {
  const { accion } = req.body;

  if (accion !== 'abrir' && accion !== 'cerrar' && accion !== 'minimizar' && accion !== 'restaurar') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "La 'accion' debe ser 'abrir', 'cerrar', 'minimizar' o 'restaurar'."
    });
  }

  // Permitir la acción "cerrar" siempre (incluso si isLaunchingBrowser está activo)
  if (accion === 'cerrar') {
    isLaunchingBrowser = false;
  } else if (isLaunchingBrowser && accion === 'abrir') {
    return res.status(409).json({
      error: 'Conflict',
      message: 'Ya hay una operación de navegador en curso. Por favor espera.',
      msg: 'Operación en curso'
    });
  }

  if (accion === 'abrir') {
    isLaunchingBrowser = true;
  }

  try {
    if (accion === 'minimizar') {
      if (!browserBrowserContext || !browserPage || browserPage.isClosed()) {
        return res.status(400).json({
          error: 'Precondition Failed',
          message: 'El navegador no está abierto.',
          msg: 'Navegador cerrado'
        });
      }
      log('Minimizando la ventana del navegador manualmente...');
      const session = await browserPage.context().newCDPSession(browserPage);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' }
      });
      return res.status(200).json({
        status: 'ok',
        message: 'Ventana del navegador minimizada.',
        msg: 'Ventana minimizada'
      });
    }

    if (accion === 'restaurar') {
      if (!browserBrowserContext || !browserPage || browserPage.isClosed()) {
        return res.status(400).json({
          error: 'Precondition Failed',
          message: 'El navegador no está abierto.',
          msg: 'Navegador cerrado'
        });
      }
      log('Restaurando la ventana del navegador...');
      const session = await browserPage.context().newCDPSession(browserPage);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' }
      });
      return res.status(200).json({
        status: 'ok',
        message: 'Ventana del navegador restaurada.',
        msg: 'Ventana restaurada'
      });
    }

    if (accion === 'abrir') {
      if (browserBrowserContext) {
        log('El navegador ya se encuentra abierto.');
        return res.status(200).json({
          status: 'ok',
          message: 'El navegador de Browser ya está abierto.',
          msg: 'Navegador ya abierto'
        });
      }

      const userDataDir = path.join(__dirname, 'browser_user_data');
      log(`Abriendo ventana de Playwright en: ${userDataDir}`);
      
      try {
        log('Intentando iniciar con Google Chrome oficial...');
        browserBrowserContext = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          channel: 'chrome', // Google Chrome no integra las cuentas de Windows SSO de la misma forma que Edge
          viewport: null,
          ignoreDefaultArgs: ['--no-sandbox'], // Elimina el cartel molesto de advertencia de sandbox
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=ImplicitSignin', // Evita que use el inicio de sesión automático del S.O.
            '--test-type', // Elimina la advertencia de bandera experimental no soportada
            '--restore-last-session', // Restaura la sesión anterior y cookies temporales
            '--hide-crash-restore-bubble', // Oculta el cartel molesto de restauración de páginas por cierre sucio
            '--window-size=900,700', // Iniciar el navegador con tamaño pequeño
            '--window-position=0,0' // Ubicar en la esquina superior izquierda
          ]
        });
      } catch (errChrome) {
        try {
          log('Chrome oficial no disponible, iniciando con Chromium por defecto...');
          browserBrowserContext = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            viewport: null,
            ignoreDefaultArgs: ['--no-sandbox'],
            args: [
              '--disable-blink-features=AutomationControlled',
              '--disable-features=ImplicitSignin',
              '--test-type',
              '--restore-last-session',
              '--hide-crash-restore-bubble',
              '--window-size=900,700',
              '--window-position=0,0'
            ]
          });
        } catch (errChromium) {
          log('Error al iniciar Chromium, intentando con Microsoft Edge...');
          browserBrowserContext = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            channel: 'msedge',
            viewport: null,
            ignoreDefaultArgs: ['--no-sandbox'],
            args: [
              '--disable-blink-features=AutomationControlled',
              '--disable-features=ImplicitSignin',
              '--test-type',
              '--restore-last-session',
              '--hide-crash-restore-bubble',
              '--window-size=900,700',
              '--window-position=0,0'
            ]
          });
        }
      }

      // Esperar un breve instante para dar tiempo a que se restauren las páginas de la sesión anterior
      await new Promise(resolve => setTimeout(resolve, 800));

      const pages = browserBrowserContext.pages();
      // Buscar si ya hay alguna pestaña restaurada de Browser
      const restoredBrowserPage = pages.find(p => p.url().includes('example.com') || p.url().includes('cloud.example.com'));

      if (restoredBrowserPage) {
        log('Auto-Login: Reutilizando pestaña de Browser restaurada automáticamente.');
        browserPage = restoredBrowserPage;

        // Cerrar las pestañas about:blank sobrantes
        for (let p of pages) {
          if (p !== browserPage && (p.url() === 'about:blank' || p.url() === '')) {
            await p.close().catch(() => {});
          }
        }
      } else {
        log('Auto-Login: No se encontró pestaña restaurada. Usando o creando pestaña por defecto...');
        if (pages.length > 0) {
          browserPage = pages[0];
        } else {
          browserPage = await browserBrowserContext.newPage();
        }

        log('Navegando asíncronamente a https://example.com...');
        browserPage.goto('https://example.com').catch((err) => {
          log(`Error al navegar a Browser: ${err.message}`);
        });
      }

      // Detectar si el usuario cierra la página de Browser directamente
      browserPage.on('close', async () => {
        log('Aviso: La página de Browser fue cerrada manualmente por el usuario.');
        handleManualCloseCleanup();
      });

      // Detectar si el contexto entero se cierra
      browserBrowserContext.on('close', async () => {
        log('Aviso: El navegador de Browser fue cerrado manualmente por el usuario.');
        handleManualCloseCleanup();
      });

      // Ejecutar el asistente de auto-login en segundo plano
      autoLoginTargetSession(browserPage).catch((err) => {
        log(`Error de fondo en auto-login: ${err.message}`);
      });

      browserBrowserAbierto = true;

      // Auto-minimizar la ventana a los 10 segundos de abrirse
      setTimeout(async () => {
        if (browserBrowserContext && browserPage && !browserPage.isClosed()) {
          try {
            const session = await browserPage.context().newCDPSession(browserPage);
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
            log('Ventana de Browser minimizada automáticamente a los 10 segundos.');
          } catch (err) {
            log(`Error al auto-minimizar: ${err.message}`);
          }
        }
      }, 10000);

      // Si la simulación (Mantener Activo) está activa, iniciarla automáticamente después de 20 segundos
      if (browserPresenciaActiva) {
        log('Mantener Activo está encendido. Iniciando simulación automática en 20 segundos...');
        setTimeout(() => {
          if (browserBrowserContext && browserPresenciaActiva) {
            if (!browserIntervalId) {
              log('Iniciando simulación automática planificada...');
              setupBrowserInterval();
              runBrowserActivityLoop().catch((err) => {
                log(`Error en simulación inicial automática: ${err.message}`);
              });
            }
          }
        }, 20000);
      }

      isLaunchingBrowser = false;
      return res.status(200).json({
        status: 'ok',
        message: 'Navegador de Browser abierto con éxito y cargando página.',
        msg: 'Navegador abierto'
      });

    } else {
      await cleanupBrowserSession();
      isLaunchingBrowser = false;
      return res.status(200).json({
        status: 'ok',
        message: 'Navegador de Browser cerrado y simulación desactivada.',
        msg: 'Navegador cerrado'
      });
    }
  } catch (error) {
    log(`Error al controlar el navegador de Browser: ${error.message}`);
    isLaunchingBrowser = false;
    await cleanupBrowserSession();
    return res.status(500).json({
      error: 'Internal Server Error',
      message: `Fallo al modificar estado del navegador: ${error.message}`
    });
  }
});

// Endpoint POST /browser/programacion - Actualizar horario y días de la simulación
app.post('/browser/programacion', (req, res) => {
  const { startHour, endHour, days, browserCloseHour, browserCloseEnabled } = req.body;

  if (startHour && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(startHour)) {
    browserSimulacionStartHour = startHour;
  }
  if (endHour && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(endHour)) {
    browserSimulacionEndHour = endHour;
  }
  if (days && Array.isArray(days)) {
    browserSimulacionDays = days.map(Number);
  }
  if (browserCloseHour && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(browserCloseHour)) {
    browserBrowserCloseHour = browserCloseHour;
  }
  if (browserCloseEnabled !== undefined) {
    browserBrowserCloseEnabled = !!browserCloseEnabled;
  }

  saveSimulationState();
  log(`Programación actualizada: Rango: ${browserSimulacionStartHour}-${browserSimulacionEndHour}, Días: ${browserSimulacionDays.join(',')}, Cierre: ${browserBrowserCloseHour} (Activo=${browserBrowserCloseEnabled})`);

  res.json({
    status: 'ok',
    message: 'Programación actualizada con éxito.',
    browserSimulacionStartHour,
    browserSimulacionEndHour,
    browserSimulacionDays,
    browserBrowserCloseHour,
    browserBrowserCloseEnabled
  });
});

// Endpoint POST /browser/presencia para controlar la simulación de actividad
app.post('/browser/presencia', (req, res) => {
  const { accion, intervaloMs } = req.body;

  if (accion !== 'iniciar' && accion !== 'pausar') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "La 'accion' de presencia debe ser 'iniciar' o 'pausar'."
    });
  }

  if (intervaloMs && typeof intervaloMs === 'number' && intervaloMs > 0) {
    browserIntervalMs = intervaloMs;
    log(`Intervalo de Browser actualizado a: ${browserIntervalMs} ms`);
  }

  if (accion === 'iniciar') {

    if (browserIntervalId) {
      log('La simulación de presencia ya está activa. Reconfigurando intervalo.');
      clearInterval(browserIntervalId);
    }

    setupBrowserInterval();
    browserPresenciaActiva = true;
    saveSimulationState();
    log('Simulación de presencia activada.');
    
    // Ejecutar una simulación inicial inmediatamente
    runBrowserActivityLoop().catch((err) => {
      log(`Error en simulación inicial inmediata: ${err.message}`);
    });
    
    return res.status(200).json({
      status: 'ok',
      message: 'Simulación de presencia activada e iniciada inmediatamente.',
      config: { browserIntervalMs }
    });
  } else {
    if (browserIntervalId) {
      clearInterval(browserIntervalId);
      browserIntervalId = null;
      log('Simulación de presencia pausada.');
    }
    browserPresenciaActiva = false;
    saveSimulationState();
    return res.status(200).json({
      status: 'ok',
      message: 'Simulación de presencia pausada.'
    });
  }
});

// Función centralizada para simular la actividad
async function runBrowserActivityLoop() {
  try {
    if (!browserBrowserContext) return;

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

    // 3. Simular enfoque en buscador usando atajos de teclado (Ctrl+Alt+E o Ctrl+Shift+F)
    try {
      const usarFiltroLateral = Math.random() > 0.5;
      if (usarFiltroLateral) {
        await browserPage.keyboard.press('Control+Shift+F');
      } else {
        await browserPage.keyboard.press('Control+Alt+E');
      }
      await new Promise(r => setTimeout(r, 300));
      await browserPage.keyboard.press('Escape'); // Presionar Escape para cerrar el menú desplegable y limpiar el foco
    } catch (e) {
      // Ignorar
    }
    
    lastActivityTime = new Date();
    log('Actividad simulada con éxito.');
  } catch (err) {
    log(`Error al ejecutar simulación de actividad de Browser: ${err.message}`);
  }
}

// Iniciar intervalo de actividad de Browser
function setupBrowserInterval() {
  browserIntervalId = setInterval(async () => {
    await runBrowserActivityLoop();
  }, browserIntervalMs);
}

// 2.A Endpoint POST /browser/simular-accion para ejecutar acciones de test manuales e inmediatas
app.post('/browser/simular-accion', async (req, res) => {
  const { accion } = req.body;

  if (!browserBrowserContext || !browserPage || browserPage.isClosed()) {
    log('Fallo de prueba: Intento de simular acción sin ventana de Browser abierta.');
    return res.status(400).json({
      error: 'Precondition Failed',
      message: 'No se puede simular la acción si la ventana de Browser está cerrada.'
    });
  }

  try {
    log(`Ejecutando acción de test manual: '${accion}'`);

    if (accion === 'mover-mouse') {
      const x = Math.floor(Math.random() * 500) + 100;
      const y = Math.floor(Math.random() * 500) + 100;
      await browserPage.mouse.move(x, y);
      log('Movimiento manual de cursor completado.');
      return res.status(200).json({
        status: 'ok',
        message: `Mouse desplazado con éxito a (${x}, ${y}).`,
        msg: 'Mouse movido'
      });
    } else if (accion === 'tipear-buscador') {
      try {
        log('Simulando enfoque de buscador por atajo de teclado...');
        // Alternamos al azar entre Ctrl+E (Buscador Global) y Ctrl+Shift+F (Filtro Lateral de chats)
        const usarFiltroLateral = Math.random() > 0.5;
        
        if (usarFiltroLateral) {
          log('Usando atajo Ctrl+Shift+F (Filtro de chats)...');
          await browserPage.keyboard.press('Control+Shift+F');
        } else {
          log('Usando atajo Control+Alt+E (Buscador global)...');
          await browserPage.keyboard.press('Control+Alt+E');
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Intentar escribir el texto
        await browserPage.keyboard.type('Activo', { delay: 80 });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Seleccionar todo y borrar
        await browserPage.keyboard.press('Control+A');
        await browserPage.keyboard.press('Backspace');
        
        // Cerrar el menú desplegable presionando Escape
        await browserPage.keyboard.press('Escape');
        
        log('Simulación de tipeo y borrado de prueba completado usando atajos.');
        return res.status(200).json({
          status: 'ok',
          message: `Tipeado de texto "Activo" completado usando atajo (${usarFiltroLateral ? 'Ctrl+Shift+F' : 'Ctrl+E'}) y borrado.`,
          msg: 'Buscador tipeado'
        });
      } catch (err) {
        log(`Error al usar atajos, intentando clic físico de respaldo: ${err.message}`);
        // Fallback al selector físico por si los atajos no respondieron
        const selector = 'input[placeholder*="Search"], input[placeholder*="Buscar"], input[placeholder*="go right to a chat"], input[placeholder*="Ctrl+Alt+G"], input#ngx-search-box-input, input[data-testid="search-box-input"], .ms-searchux-input, input[class*="ms-searchux-input"]';
        try {
          await browserPage.click(selector, { timeout: 2000, force: true }).catch(async () => {
            await browserPage.focus(selector);
          });
          await browserPage.keyboard.type('Activo', { delay: 80 });
          await new Promise(resolve => setTimeout(resolve, 1000));
          await browserPage.keyboard.press('Control+A');
          await browserPage.keyboard.press('Backspace');
          await browserPage.keyboard.press('Escape');
          return res.status(200).json({
            status: 'ok',
            message: 'Tipeado de texto "Activo" y borrado completado usando clic físico de respaldo.',
            msg: 'Buscador tipeado'
          });
        } catch (fallbackErr) {
          log(`Error en el selector físico de respaldo: ${fallbackErr.message}`);
          return res.status(400).json({
            error: 'Element Not Found',
            message: 'No se pudo interactuar con el buscador de Browser ni usando atajos ni selectores.'
          });
        }
      }
    } else if (accion === 'pulsar-shift') {
      await browserPage.keyboard.press('Shift');
      log('Pulsación manual de Shift completada.');
      return res.status(200).json({
        status: 'ok',
        message: 'Pulsación de tecla Shift simulada correctamente.',
        msg: 'Shift presionado'
      });
    } else {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Acción de prueba no reconocida.'
      });
    }
  } catch (err) {
    log(`Error al ejecutar acción de test manual: ${err.message}`);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
});

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

      // Iniciar simulación inmediatamente
      runBrowserActivityLoop().catch(() => {});

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

// Endpoint POST /sistema/teclado para enviar atajos al sistema operativo (Alt+X o Ctrl)
app.post('/sistema/teclado', (req, res) => {
  const { accion } = req.body;

  if (accion !== 'apagar-pantalla' && accion !== 'encender-pantalla') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "La 'accion' de teclado debe ser 'apagar-pantalla' o 'encender-pantalla'."
    });
  }

  try {
    if (accion === 'apagar-pantalla') {
      log('Haciendo clic en la barra de tareas y simulando Alt + X en Windows para apagar pantalla...');
      const psCommand = 'powershell -Command "$sig = \'[DllImport(\\"user32.dll\\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo); [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);\'; $win = Add-Type -MemberDefinition $sig -Name \\"WinAPI1\\" -Namespace \\"Win32\\" -PassThru; $win::SetCursorPos(500, 1070); $win::mouse_event(2, 0, 0, 0, 0); $win::mouse_event(4, 0, 0, 0, 0); Start-Sleep -Milliseconds 200; $win::keybd_event(0x12, 0, 0, 0); $win::keybd_event(0x58, 0, 0, 0); $win::keybd_event(0x58, 0, 2, 0); $win::keybd_event(0x12, 0, 2, 0);"';
      exec(psCommand, (error) => {
        if (error) {
          log(`Error al simular Alt+X: ${error.message}`);
        }
      });
      return res.status(200).json({
        status: 'ok',
        message: 'Comando de apagar pantalla (Alt+X con click previo) enviado.',
        msg: 'Pantalla apagada'
      });
    } else {
      log('Simulando pulsación de Control en Windows para encender pantalla...');
      const psCommand = 'powershell -Command "$sig = \'[DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);\'; $win = Add-Type -MemberDefinition $sig -Name \\"WinAPI2\\" -Namespace \\"Win32\\" -PassThru; $win::keybd_event(0xA2, 0, 0, 0); $win::keybd_event(0xA2, 0, 2, 0);"';
      exec(psCommand, (error) => {
        if (error) {
          log(`Error al simular Control: ${error.message}`);
        }
      });
      return res.status(200).json({
        status: 'ok',
        message: 'Comando de encender pantalla (Control) enviado.',
        msg: 'Pantalla encendida'
      });
    }
  } catch (err) {
    log(`Error en simulación de teclado: ${err.message}`);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
});

// Endpoint POST /sistema/energia - Suspender y Bloquear PC
app.post('/sistema/energia', (req, res) => {
  const { accion } = req.body;

  if (accion !== 'bloquear' && accion !== 'suspender') {
    return res.status(400).json({ error: 'Bad Request', message: "Acción de energía debe ser 'bloquear' o 'suspender'." });
  }

  if (accion === 'bloquear') {
    log('Comando de bloqueo de PC recibido. Bloqueando estación de trabajo...');
    exec('rundll32.exe user32.dll,LockWorkStation', (error) => {
      if (error) log(`Error al bloquear PC: ${error.message}`);
    });
    return res.json({ status: 'ok', message: 'PC Bloqueada.', msg: 'PC Bloqueada' });
  } else {
    log('Comando de suspensión de PC recibido. Suspendiendo sistema...');
    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (error) => {
      if (error) log(`Error al suspender PC: ${error.message}`);
    });
    return res.json({ status: 'ok', message: 'PC Suspendida.', msg: 'PC Suspendida' });
  }
});

// Endpoint GET /sistema/portapapeles - Leer portapapeles de la PC
app.get('/sistema/portapapeles', (req, res) => {
  exec('cmd /c "chcp 65001 > nul && powershell.exe -Command Get-Clipboard"', { encoding: 'buffer' }, (error, stdout) => {
    if (error) {
      return res.status(500).json({ error: 'Error al obtener portapapeles', message: error.message });
    }
    const text = stdout.toString('utf8').trim();
    res.json({ text });
  });
});

// Endpoint POST /sistema/portapapeles - Escribir portapapeles de la PC
app.post('/sistema/portapapeles', (req, res) => {
  const { text } = req.body;
  if (text === undefined) {
    return res.status(400).json({ error: 'Bad Request', message: 'Falta parámetro text.' });
  }

  const escaped = text.replace(/'/g, "''");
  const psCommand = `powershell -Command "Set-Clipboard -Value '${escaped}'"`;

  exec(psCommand, (error) => {
    if (error) {
      log(`Error al escribir en portapapeles: ${error.message}`);
      return res.status(500).json({ error: 'Error al escribir portapapeles', message: error.message });
    }
    res.json({ status: 'ok', message: 'Texto copiado al portapapeles de la PC.', msg: 'Copiado en PC' });
  });
});

// Endpoint GET /sistema/screenshot - Captura de pantalla de Windows
app.get('/sistema/screenshot', (req, res) => {
  const screenshotPath = path.join(__dirname, 'temp_screenshot.png');
  const escapedPath = screenshotPath.replace(/\\/g, '\\\\');
  // SetProcessDPIAware para obtener dimensiones físicas reales (incluye barra de tareas)
  const scriptPath = path.join(__dirname, 'screenshot.ps1');
  const psCommand = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" "${screenshotPath}"`;
  
  exec(psCommand, (error) => {
    if (error) {
      log(`Error al capturar pantalla: ${error.message}`);
      return res.status(500).json({ error: 'Error al capturar pantalla', message: error.message });
    }
    if (fs.existsSync(screenshotPath)) {
      res.sendFile(screenshotPath);
    } else {
      res.status(500).json({ error: 'Archivo de captura no encontrado.' });
    }
  });
});



// Endpoint POST /sistema/tts - Text to Speech nativo en Windows
app.post('/sistema/tts', (req, res) => {
  const { texto } = req.body;
  if (!texto || texto.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Falta el texto a reproducir.' });
  }

  log(`TTS: Reproduciendo texto: "${texto}"`);
  const escapedText = texto.replace(/'/g, "''");
  const psCommand = `powershell -Command "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.Speak('${escapedText}')"`;

  exec(psCommand, (error) => {
    if (error) {
      log(`Error en TTS: ${error.message}`);
      return res.status(500).json({ error: 'Error al reproducir texto', message: error.message });
    }
    res.json({ status: 'ok', message: 'Texto reproducido correctamente.', msg: 'Voz reproducida' });
  });
});

// Endpoint POST /sistema/media - Controles multimedia nativos en Windows
app.post('/sistema/media', (req, res) => {
  const { accion } = req.body;
  const vks = {
    'mute': '0xAD',
    'vol-': '0xAE',
    'vol+': '0xAF',
    'prev': '0xB1',
    'play-pausa': '0xB3',
    'next': '0xB0'
  };

  const vk = vks[accion];
  if (!vk) {
    return res.status(400).json({ error: 'Bad Request', message: 'Acción multimedia no reconocida.' });
  }

  log(`Multimedia: Enviando acción '${accion}' (VK: ${vk})`);

  const psCommand = `powershell -Command "$sig = '[DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);'; $win = Add-Type -MemberDefinition $sig -Name \\"WinAPIMedia\\" -Namespace \\"Win32\\" -PassThru; $win::keybd_event(${vk}, 0, 0, 0); $win::keybd_event(${vk}, 0, 2, 0);"`;

  exec(psCommand, (error) => {
    if (error) {
      log(`Error en multimedia: ${error.message}`);
      return res.status(500).json({ error: 'Error al enviar comando multimedia', message: error.message });
    }
    res.json({ status: 'ok', message: `Comando ${accion} enviado correctamente.`, msg: accion });
  });
});



// Endpoint GET /sistema/ping - Test de latencia de red
app.get('/sistema/ping', (req, res) => {
  exec('ping -n 1 8.8.8.8', (error, stdout) => {
    if (error) {
      return res.json({ status: 'error', latencyMs: null, msg: 'Error de red' });
    }
    const match = stdout.match(/(?:tiempo|time)[=<](\d+)ms/i);
    const latency = match ? parseInt(match[1]) : null;
    res.json({
      status: 'ok',
      latencyMs: latency,
      msg: latency ? `${latency} ms` : 'Desconocido'
    });
  });
});

// Endpoint GET /browser/ultima-actividad - Tiempo desde el ultimo movimiento simulado
app.get('/browser/ultima-actividad', (req, res) => {
  if (!lastActivityTime) {
    return res.json({ lastActivityTime: null, formatted: 'Sin actividad registrada', secondsAgo: null, msg: 'Sin actividad' });
  }
  const now = new Date();
  const secondsAgo = Math.floor((now - lastActivityTime) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const d = lastActivityTime;
  const formatted = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return res.json({
    lastActivityTime: lastActivityTime.toISOString(),
    formatted,
    secondsAgo,
    msg: `Hace ${secondsAgo}s`
  });
});

// Endpoint POST /sistema/ejecutar para lanzar programas locales como el Emulador
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
    message: 'Script de inicio del emulador ejecutado con éxito en background.',
    msg: 'Emulador iniciado'
  });
});

// Endpoint POST /sistema/cerrar para cerrar programas locales como el Emulador
app.post('/sistema/cerrar', (req, res) => {
  const { programa } = req.body;

  if (programa !== 'emulador') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "Programa no soportado. Actualmente solo se soporta 'emulador'."
    });
  }

  log('Solicitado cierre del emulador Android...');

  // Intentamos matar los procesos del emulador de Android estándar
  exec('taskkill /f /im emulator.exe & taskkill /f /im qemu-system-x86_64.exe', (error, stdout, stderr) => {
    if (error) {
      log(`Cierre de emulador: Algunos procesos no estaban activos o dieron error: ${error.message}`);
    }
    log(`Cierre de emulador completado. Salida: ${stdout || 'sin salida'}`);
  });

  return res.status(200).json({
    status: 'ok',
    message: 'Comando de cierre de emulador enviado con éxito.',
    msg: 'Emulador cerrado'
  });
});

// Endpoint POST /gateway/restart para reiniciar el servidor de forma remota y controlada
app.post('/gateway/restart', (req, res) => {
  log('Solicitud de reinicio remoto del servidor recibida.');
  res.json({
    status: 'ok',
    message: 'Reiniciando el Gateway Server en la PC. Por favor espera unos segundos...',
    msg: 'Servidor reiniciando'
  });

  const { spawn } = require('child_process');
  const vbsPath = path.join(__dirname, 'remote_restart.vbs');

  // Lanzar wscript.exe directamente de forma detached para evitar la muerte por árbol de procesos
  const child = spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // Apagar este proceso después de 2 segundos para dar tiempo a enviar la respuesta y guardar logs
  setTimeout(() => {
    log('Cerrando proceso actual para reiniciar...');
    process.exit(0);
  }, 2000);
});

// HTML para la Pantalla de Login Segura (Glassmorphism)
const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acceso requerido - Gateway</title>
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
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --danger: #ef4444;
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
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .login-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 35px 30px;
      width: 100%;
      max-width: 400px;
      backdrop-filter: blur(16px);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      text-align: center;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 8px;
      background: linear-gradient(to right, #818cf8, #c084fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p.subtitle {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 25px;
    }

    .form-group {
      text-align: left;
      margin-bottom: 20px;
    }

    label {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-weight: 500;
    }

    input {
      width: 100%;
      padding: 14px 16px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      margin-top: 6px;
      transition: border-color 0.2s ease;
    }

    input:focus {
      border-color: var(--primary);
    }

    .btn {
      width: 100%;
      background: var(--primary);
      border: 1px solid var(--primary);
      color: var(--text);
      padding: 14px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      box-shadow: 0 4px 15px var(--primary-glow);
      transition: all 0.2s ease;
    }

    .btn:hover {
      background: #4f46e5;
      transform: translateY(-2px);
    }

    .error-msg {
      color: var(--danger);
      font-size: 0.8rem;
      margin-top: 15px;
      display: none;
      font-weight: 500;
    }
  </style>
</head>
<body>

  <div class="login-container">
    <h1>Acceso al Gateway</h1>
    <p class="subtitle">Introduce tu X-API-KEY para continuar</p>
    
    <div class="form-group">
      <label for="apiKeyInput">Clave X-API-KEY</label>
      <input type="password" id="apiKeyInput" placeholder="Introduce la API Key del servidor" onkeydown="if(event.key === 'Enter') login()">
    </div>
    
    <button class="btn" onclick="login()">Acceder</button>
    <div id="errorMsg" class="error-msg">Clave API incorrecta. Inténtalo de nuevo.</div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const savedKey = localStorage.getItem('X-API-KEY');
      if (savedKey) {
        document.getElementById('apiKeyInput').value = savedKey;
        login();
      }
    });

    async function login() {
      const key = document.getElementById('apiKeyInput').value.trim();
      const errorDiv = document.getElementById('errorMsg');
      
      if (!key) {
        errorDiv.innerText = 'Por favor, ingresa una clave.';
        errorDiv.style.display = 'block';
        return;
      }

      errorDiv.style.display = 'none';

      try {
        const response = await fetch('/gateway/status', {
          headers: { 'X-API-KEY': key }
        });

        if (response.ok) {
          // Guardar en cookie para la sesión de navegación GET /
          document.cookie = "api_key=" + encodeURIComponent(key) + "; path=/; max-age=" + (365*24*60*60) + "; SameSite=Lax";
          // Guardar en localStorage para migrar/mantener sesiones guardadas y auto-login
          localStorage.setItem('X-API-KEY', key);
          window.location.reload();
        } else {
          errorDiv.innerText = 'Clave API incorrecta o rechazada por el servidor.';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        errorDiv.innerText = 'Error al comunicar con el servidor.';
        errorDiv.style.display = 'block';
      }
    }
  </script>
</body>
</html>
`;

// HTML para el Dashboard de Control Premium
const DASHBOARD_HTML = `
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

    .header-buttons {
      display: flex;
      gap: 10px;
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

    @media (max-width: 480px) {
      body { padding: 15px; }
      .card { padding: 20px; }
    }

    /* Estilos para Toggle Switches */
    .switch-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin-top: 10px;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      margin-top: 0 !important;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider-toggle {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: rgba(255, 255, 255, 0.1);
      transition: .3s;
      border-radius: 24px;
      border: 1px solid var(--card-border);
    }
    .slider-toggle:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    input:checked + .slider-toggle {
      background-color: var(--success);
      border-color: var(--success);
    }
    input:checked + .slider-toggle:before {
      transform: translateX(20px);
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-container">
      <h1>Gateway Control Center</h1>
      <p>API Gateway & Automatizaciones</p>
    </div>
    <div class="header-buttons">
      <button class="btn-icon" onclick="logout()" title="Cerrar Sesión">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
      </button>
    </div>
  </header>

  <main>
    <!-- CARD 1: MICROSOFT TEAMS -->
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
      <div class="btn-row" style="margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 8px;">
        <button class="btn btn-primary" id="btnBrowserOpen" onclick="controlBrowser('abrir')" style="flex: 1 1 calc(50% - 4px); min-width: 120px; margin-top: 0;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          Abrir Ventana
        </button>
        <button class="btn btn-danger" id="btnBrowserClose" onclick="controlBrowser('cerrar')" style="flex: 1 1 calc(50% - 4px); min-width: 120px; margin-top: 0;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>
          Cerrar Ventana
        </button>
        <button class="btn" id="btnBrowserMinimize" onclick="controlBrowser('minimizar')" style="flex: 1 1 calc(50% - 4px); min-width: 120px; margin-top: 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text);">
          Minimizar
        </button>
        <button class="btn" id="btnBrowserRestore" onclick="controlBrowser('restaurar')" style="flex: 1 1 calc(50% - 4px); min-width: 120px; margin-top: 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text);">
          Restaurar/Ver
        </button>
      </div>

      <div class="divider"></div>

      <!-- SECCIÓN 1.B: AUTOMATIZACIÓN DE ACTIVIDAD -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
        <div class="card-section-title" style="margin-bottom: 0;">Mantener Activo (Presencia)</div>
        <div id="lastActivityLabel" style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500; letter-spacing: 0.3px;">Última: Sin actividad</div>
      </div>
      
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


      <div class="divider"></div>

      <!-- SECCIÓN 1.C: PLANIFICACIÓN Y CONTROL HORARIO -->
      <div class="card-section-title">Programación de la Simulación</div>
      <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 5px;">
        <div style="display: flex; gap: 10px; width: 100%;">
          <div style="flex: 1;">
            <label style="font-size: 0.75rem; color: var(--text-muted);">Inicio Simulación</label>
            <input type="time" id="browserStartHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
          </div>
          <div style="flex: 1;">
            <label style="font-size: 0.75rem; color: var(--text-muted);">Fin Simulación</label>
            <input type="time" id="browserEndHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
          </div>
        </div>

        <div>
          <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 6px;">Días Permitidos</label>
          <div style="display: flex; justify-content: space-between; gap: 4px;">
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-0">
              <input type="checkbox" class="day-checkbox" value="0" style="display:none;" onchange="updateSchedule()">D
            </label>
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-1">
              <input type="checkbox" class="day-checkbox" value="1" style="display:none;" onchange="updateSchedule()">L
            </label>
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-2">
              <input type="checkbox" class="day-checkbox" value="2" style="display:none;" onchange="updateSchedule()">M
            </label>
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-3">
              <input type="checkbox" class="day-checkbox" value="3" style="display:none;" onchange="updateSchedule()">M
            </label>
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-4">
              <input type="checkbox" class="day-checkbox" value="4" style="display:none;" onchange="updateSchedule()">J
            </label>
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-5">
              <input type="checkbox" class="day-checkbox" value="5" style="display:none;" onchange="updateSchedule()">V
            </label>
            <label style="flex: 1; text-align: center; font-size: 0.75rem; padding: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; display: block;" id="lbl-day-6">
              <input type="checkbox" class="day-checkbox" value="6" style="display:none;" onchange="updateSchedule()">S
            </label>
          </div>
        </div>
      </div>

      <div style="border-top: 1px dashed rgba(255,255,255,0.15); margin: 20px 0 15px 0;"></div>

      <div class="card-section-title">Auto-Cierre del Navegador</div>
      <div style="display: flex; gap: 10px; width: 100%; align-items: center;">
        <div style="flex: 1.2;">
          <label style="font-size: 0.75rem; color: var(--text-muted);">Hora de Cierre</label>
          <input type="time" id="browserBrowserCloseHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
        </div>
        <div style="flex: 0.8; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; margin-top: 14px;">
          <div class="switch-container" style="margin-top: 0; justify-content: flex-end; gap: 10px;">
            <span style="font-size: 0.85rem; color: var(--text-muted);">Auto-Cierre</span>
            <label class="switch">
              <input type="checkbox" id="browserBrowserCloseEnabled" onchange="updateSchedule()">
              <span class="slider-toggle"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="divider"></div>

      <!-- SECCIÓN 1.C: PRUEBAS MANUALES EN CALIENTE -->
      <div class="card-section-title">Pruebas Manuales (Acciones al Instante)</div>
      <div class="btn-row" style="gap: 8px; margin-top: 10px;">
        <button class="btn" id="btnTestMouse" onclick="enviarAccionPrueba('mover-mouse')" style="padding: 8px; font-size: 0.75rem;">
          Mover Mouse
        </button>
        <button class="btn" id="btnTestTipeo" onclick="enviarAccionPrueba('tipear-buscador')" style="padding: 8px; font-size: 0.75rem;">
          Tipear Buscador
        </button>
        <button class="btn" id="btnTestShift" onclick="enviarAccionPrueba('pulsar-shift')" style="padding: 8px; font-size: 0.75rem;">
          Pulsar Shift
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
      <div style="display: flex; gap: 8px; margin-top: 5px; width: 100%;">
        <button class="btn btn-primary" id="btnEmulador" style="flex: 1; margin-top: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="ejecutarPrograma('emulador')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Iniciar
        </button>
        <button class="btn btn-danger" id="btnCerrarEmulador" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68); display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="cerrarPrograma('emulador')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
          Cerrar
        </button>
      </div>
      <div class="divider"></div>
      <div class="card-section-title">Control de Pantalla (PC Físico)</div>
      <div style="display: flex; gap: 8px; margin-top: 5px; width: 100%;">
        <button class="btn btn-danger" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68); display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="controlarTeclado('apagar-pantalla')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>
          Apagar (Alt+X)
        </button>
        <button class="btn btn-success" style="flex: 1; margin-top: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="controlarTeclado('encender-pantalla')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
          Encender (Ctrl)
        </button>
      </div>

      <div class="divider"></div>
      <div class="card-section-title">Energía y Sesión de PC</div>
      <div style="display: flex; gap: 8px; margin-top: 5px; width: 100%;">
        <button class="btn btn-danger" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68); display: inline-flex; align-items: center; justify-content: center;" onclick="controlarEnergia('bloquear')">
          Bloquear PC
        </button>
        <button class="btn btn-danger" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68); display: inline-flex; align-items: center; justify-content: center;" onclick="controlarEnergia('suspender')">
          Suspender PC
        </button>
      </div>

      <div class="divider"></div>
      <div class="card-section-title">Portapapeles de la PC</div>
      <div style="display: flex; gap: 8px; margin-top: 5px;">
        <input type="text" id="inputPortapapeles" placeholder="Texto para enviar a la PC..." style="flex: 2; padding: 10px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 0;">
        <button class="btn" onclick="enviarPortapapeles()" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.75rem;">
          Copiar a PC
        </button>
        <button class="btn" onclick="obtenerPortapapeles()" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.75rem;">
          Leer de PC
        </button>
      </div>

      <div class="divider"></div>
      <div class="card-section-title">Captura de Pantalla & Latencia</div>
      <div style="display: flex; gap: 8px; margin-top: 5px;">
        <button class="btn" onclick="tomarScreenshot()" style="flex: 1; padding: 10px 12px; font-size: 0.75rem; margin-top: 0;">
          Capturar Pantalla
        </button>
        <button class="btn" onclick="probarPing()" style="flex: 1; padding: 10px 12px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px; justify-content: center; margin-top: 0;">
          Test Ping: <span id="pingResultText" style="color: var(--success); font-weight: 700;">--</span>
        </button>
      </div>
      <img id="screenshotPreview" class="screenshot-preview" alt="Captura de Pantalla" style="width: 100%; border-radius: 10px; border: 1px solid var(--card-border); margin-top: 10px; display: none; cursor: pointer;" onclick="window.open(this.src, '_blank')">
    </div>

    <!-- CARD 3: REINICIAR GATEWAY -->
    <div class="card" id="cardReiniciar" style="margin-top: 10px; border-color: rgba(239, 68, 68, 0.15);">
      <div class="card-header" style="margin-bottom: 0; display: flex; align-items: center; justify-content: space-between;">
        <div class="card-title-group" style="flex: 1;">
          <h2>Reiniciar Servidor</h2>
          <p>Reinicia el gateway y reconecta el túnel</p>
        </div>
        <button class="btn btn-danger" onclick="confirmarReinicio()" style="padding: 10px 16px; font-size: 0.85rem; flex: 0 0 auto; width: auto; margin-top: 0; display: inline-flex; align-items: center; gap: 4px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Reiniciar
        </button>
      </div>
    </div>



    <!-- CARD 5: AUDIO, MULTIMEDIA & VOZ -->
    <div class="card" id="cardMultimedia" style="margin-top: 10px;">
      <div class="card-header" style="margin-bottom: 15px;">
        <div class="card-title-group">
          <h2>Controles Multimedia & Voz</h2>
          <p>Audio del sistema y Lector de voz (TTS)</p>
        </div>
      </div>
      
      <!-- Controles de Audio y Pistas -->
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="card-section-title" style="margin-bottom: 0;">Control de Audio y Reproducción</div>
        <div id="audioStatusText" style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500; letter-spacing: 0.3px;">Volumen: --% | --</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 8px;">
        <div style="display: flex; gap: 8px; width: 100%;">
          <button class="btn" onclick="enviarMultimedia('vol-')" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.8rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text);">
            Vol -
          </button>
          <button class="btn" onclick="enviarMultimedia('mute')" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.8rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68);">
            Mute
          </button>
          <button class="btn" onclick="enviarMultimedia('vol+')" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.8rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text);">
            Vol +
          </button>
        </div>
        
        <div style="display: flex; gap: 8px; width: 100%;">
          <button class="btn" onclick="enviarMultimedia('prev')" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.8rem; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>
            Atrás
          </button>
          <button class="btn" onclick="enviarMultimedia('play-pausa')" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.8rem; display: inline-flex; align-items: center; justify-content: center; gap: 4px; background: var(--primary);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            Play/Pausa
          </button>
          <button class="btn" onclick="enviarMultimedia('next')" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.8rem; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
            Siguiente
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>
          </button>
        </div>
      </div>

      <div class="divider"></div>

      <!-- Lector de Voz (TTS) -->
      <div class="card-section-title">Lector de Voz Remoto (TTS)</div>
      <div style="display: flex; gap: 8px; margin-top: 8px;">
        <input type="text" id="inputTTS" placeholder="Texto para reproducir con voz..." style="flex: 2; padding: 10px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 0;" onkeydown="checkTTSEnter(event)">
        <button class="btn" onclick="enviarTTS()" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.75rem;">
          Hablar
        </button>
      </div>
    </div>



    <!-- Barra de info de túnel ngrok -->
    <div class="tunnel-bar" id="tunnelBar" style="display: none;">
      <span class="badge">Remoto</span>
      <span>Túnel seguro activo: <a id="tunnelLink" href="#" target="_blank">Cargando...</a></span>
    </div>
  </main>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let currentBrowserInterval = 4.0;

    document.addEventListener('DOMContentLoaded', () => {
      pollGatewayStatus();
      setInterval(pollGatewayStatus, 5000);
      probarPing();
      setInterval(probarPing, 20000);
    });

    function logout() {
      document.cookie = "api_key=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;";
      window.location.reload();
    }


    function checkTTSEnter(e) {
      if (e.key === 'Enter') {
        enviarTTS();
      }
    }

    async function enviarTTS() {
      const inputEl = document.getElementById('inputTTS');
      const texto = inputEl.value;

      if (!texto || texto.trim() === '') {
        showToast('Por favor escribe algún texto para reproducir.', 'warning');
        return;
      }

      showToast('Enviando texto a voz...', 'info');

      try {
        const response = await fetch('/sistema/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texto })
        });
        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
          inputEl.value = '';
        } else {
          showToast(data.message || 'Error en la reproducción', 'error');
        }
      } catch (err) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    async function enviarMultimedia(accion) {
      try {
        const response = await fetch('/sistema/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accion })
        });
        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
        } else {
          showToast(data.message || 'Error al ejecutar comando multimedia', 'error');
        }
      } catch (err) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    function updateBrowserSliderLabel(val) {
      document.getElementById('browserIntervalVal').innerText = parseFloat(val).toFixed(1) + ' minutos';
    }

    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      
      let icon = '';
      if (type === 'success') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
      } else if (type === 'error') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      } else {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
      }

      toast.innerHTML = icon + ' <span>' + message + '</span>';
      
      toast.onclick = () => {
        toast.style.animation = 'slideInRight 0.3s ease reverse forwards';
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
      };

      // Descartar por swipe lateral (táctil)
      let startX = 0;
      let currentX = 0;
      let isSwiping = false;

      toast.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        toast.style.transition = 'none';
        isSwiping = true;
      }, { passive: false });

      toast.addEventListener('touchmove', (e) => {
        if (!isSwiping) return;
        currentX = e.touches[0].clientX;
        const diffX = currentX - startX;
        if (diffX > 0) {
          // Prevenir el scroll y overscroll del navegador para que no mueva la página
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
          toast.style.transform = 'translateX(' + diffX + 'px)';
          toast.style.opacity = 1 - (diffX / 300);
        }
      }, { passive: false });

      toast.addEventListener('touchend', () => {
        if (!isSwiping) return;
        isSwiping = false;
        const diffX = currentX - startX;
        toast.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        if (diffX > 60) {
          toast.style.transform = 'translateX(100%)';
          toast.style.opacity = '0';
          setTimeout(() => { if (toast.parentNode) toast.remove(); }, 200);
        } else {
          toast.style.transform = 'translateX(0)';
          toast.style.opacity = '1';
        }
      }, { passive: false });

      container.appendChild(toast);
      
      setTimeout(() => {
        if (toast.parentNode) {
          toast.style.animation = 'slideInRight 0.3s ease reverse forwards';
          setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
        }
      }, 4000);
    }

    async function pollGatewayStatus() {
      try {
        const response = await fetch('/gateway/status');
        
        if (response.status === 403) {
          logout();
          return;
        }

        const data = await response.json();
        
        // Sincronizar UI de Navegador Browser
        const browserBadge = document.getElementById('browserBadge');
        const browserBadgeText = document.getElementById('browserBadgeText');
        const btnBrowserOpen = document.getElementById('btnBrowserOpen');
        const btnBrowserClose = document.getElementById('btnBrowserClose');

        const testMouseBtn = document.getElementById('btnTestMouse');
        const testTipeoBtn = document.getElementById('btnTestTipeo');
        const testShiftBtn = document.getElementById('btnTestShift');

        if (data.browserBrowserAbierto) {
          browserBadge.className = 'status-badge active';
          browserBadgeText.innerText = 'Navegador: Abierto';
          btnBrowserOpen.className = 'btn btn-primary btn-disabled';
          btnBrowserClose.className = 'btn btn-danger';
          
          document.getElementById('btnBrowserMinimize').classList.remove('btn-disabled');
          document.getElementById('btnBrowserRestore').classList.remove('btn-disabled');
          
          document.getElementById('browserIntervalSlider').classList.remove('btn-disabled');

          testMouseBtn.classList.remove('btn-disabled');
          testTipeoBtn.classList.remove('btn-disabled');
          testShiftBtn.classList.remove('btn-disabled');
        } else {
          browserBadge.className = 'status-badge';
          browserBadgeText.innerText = 'Navegador: Cerrado';
          btnBrowserOpen.className = 'btn btn-primary';
          btnBrowserClose.className = 'btn btn-disabled';

          document.getElementById('btnBrowserMinimize').classList.add('btn-disabled');
          document.getElementById('btnBrowserRestore').classList.add('btn-disabled');

          document.getElementById('browserIntervalSlider').classList.add('btn-disabled');

          testMouseBtn.classList.add('btn-disabled');
          testTipeoBtn.classList.add('btn-disabled');
          testShiftBtn.classList.add('btn-disabled');
        }

        // Sincronizar UI de Presencia Browser
        const presenciaBadge = document.getElementById('presenciaBadge');
        const presenciaBadgeText = document.getElementById('presenciaBadgeText');
        const cardBrowser = document.getElementById('cardBrowser');

        if (data.browserPresenciaActiva) {
          presenciaBadge.className = 'status-badge active';
          presenciaBadgeText.innerText = 'Mantener Activo: On';
          cardBrowser.classList.add('active-state');
        } else {
          presenciaBadge.className = 'status-badge';
          presenciaBadgeText.innerText = 'Mantener Activo: Off';
          if (!data.browserBrowserAbierto) {
            cardBrowser.classList.remove('active-state');
          }
        }

        // Sincronizar estado de botones Iniciar/Pausar segun browserPresenciaActiva
        const btnPlay = document.getElementById('btnPresenciaPlay');
        const btnPause = document.getElementById('btnPresenciaPause');
        if (data.browserPresenciaActiva) {
          btnPlay.classList.add('btn-disabled');
          btnPause.classList.remove('btn-disabled');
        } else {
          btnPlay.classList.remove('btn-disabled');
          btnPause.classList.add('btn-disabled');
        }

        if (document.activeElement !== document.getElementById('browserIntervalSlider')) {
          const mins = data.browserIntervalMs / 60000;
          document.getElementById('browserIntervalSlider').value = mins;
          updateBrowserSliderLabel(mins);
        }

        // Sincronizar campos de planificación si no están en foco
        if (document.activeElement !== document.getElementById('browserStartHour')) {
          document.getElementById('browserStartHour').value = data.browserSimulacionStartHour || '09:00';
        }
        if (document.activeElement !== document.getElementById('browserEndHour')) {
          document.getElementById('browserEndHour').value = data.browserSimulacionEndHour || '18:00';
        }
        if (document.activeElement !== document.getElementById('browserBrowserCloseHour')) {
          document.getElementById('browserBrowserCloseHour').value = data.browserBrowserCloseHour || '18:03';
        }
        if (document.activeElement !== document.getElementById('browserBrowserCloseEnabled')) {
          document.getElementById('browserBrowserCloseEnabled').checked = !!data.browserBrowserCloseEnabled;
        }

        // Sincronizar días permitidos
        if (data.browserSimulacionDays) {
          const checkboxes = document.querySelectorAll('.day-checkbox');
          checkboxes.forEach(cb => {
            if (document.activeElement !== cb) {
              cb.checked = data.browserSimulacionDays.includes(Number(cb.value));
            }
          });
          drawDayLabels();
        }

        const btnEmulador = document.getElementById('btnEmulador');
        if (!data.hasEmulatorPath) {
          btnEmulador.classList.add('btn-disabled');
          btnEmulador.title = 'Configura EMULATOR_BAT_PATH en el archivo .env';
        } else {
          btnEmulador.classList.remove('btn-disabled');
          btnEmulador.title = '';
        }

        const tunnelBar = document.getElementById('tunnelBar');
        if (data.ngrokUrl && data.ngrokUrl !== 'Inactivo') {
          tunnelBar.style.display = 'flex';
          const link = document.getElementById('tunnelLink');
          link.href = data.ngrokUrl;
          link.innerText = data.ngrokUrl;
        } else {
          tunnelBar.style.display = 'none';
        }

        // Actualizar estado de Audio y Reproducción
        const audioTextEl = document.getElementById('audioStatusText');
        if (audioTextEl && data.audioVolume !== undefined && data.audioVolume !== null) {
          const vol = data.audioVolume;
          const muted = data.audioMuted;
          const playing = data.audioPlaying;
          let statusStr = 'Volumen: ' + vol + '%';
          if (muted) {
            statusStr += ' (Silenciado)';
          }
          statusStr += ' | ' + (playing ? '▶ Reproduciendo' : '⏸ Pausado');
          audioTextEl.innerText = statusStr;
        }

        // Actualizar label de última actividad
        const lastActEl = document.getElementById('lastActivityLabel');
        if (lastActEl && data.lastActivityFormatted) {
          let actStr = 'Última: ' + data.lastActivityFormatted;
          if (data.lastActivitySecondsAgo !== null) {
            actStr += ' (Hace ' + data.lastActivitySecondsAgo + 's)';
          }
          lastActEl.innerText = actStr;
        }

      } catch (err) {
        console.error('Error polling status:', err);
      }
    }

    function drawDayLabels() {
      const checkboxes = document.querySelectorAll('.day-checkbox');
      checkboxes.forEach(cb => {
        const lbl = document.getElementById('lbl-day-' + cb.value);
        if (lbl) {
          if (cb.checked) {
            lbl.style.background = 'rgba(16, 185, 129, 0.2)';
            lbl.style.borderColor = '#10b981';
            lbl.style.color = '#fff';
          } else {
            lbl.style.background = 'rgba(255,255,255,0.05)';
            lbl.style.borderColor = 'var(--card-border)';
            lbl.style.color = 'var(--text)';
          }
        }
      });
    }

    async function updateSchedule() {
      const startHour = document.getElementById('browserStartHour').value;
      const endHour = document.getElementById('browserEndHour').value;
      const browserCloseHour = document.getElementById('browserBrowserCloseHour').value;
      const browserCloseEnabled = document.getElementById('browserBrowserCloseEnabled').checked;

      const checkedDays = [];
      const checkboxes = document.querySelectorAll('.day-checkbox');
      checkboxes.forEach(cb => {
        if (cb.checked) {
          checkedDays.push(Number(cb.value));
        }
      });

      drawDayLabels();

      try {
        const response = await fetch('/browser/programacion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startHour,
            endHour,
            days: checkedDays,
            browserCloseHour,
            browserCloseEnabled
          })
        });
        const data = await response.json();
        if (!response.ok) {
          showToast(data.message || 'Error al actualizar programación', 'error');
        }
      } catch (error) {
        console.error('Error al actualizar programación:', error);
      }
    }

    async function controlBrowser(accion) {
      const msgs = {
        'abrir': 'Iniciando navegador...',
        'cerrar': 'Cerrando navegador...',
        'minimizar': 'Minimizando ventana...',
        'restaurar': 'Restaurando ventana...'
      };
      showToast(msgs[accion] || 'Procesando...', 'info');

      try {
        const response = await fetch('/browser/browser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    async function controlPresencia(accion) {
      const mins = parseFloat(document.getElementById('browserIntervalSlider').value);
      const ms = mins * 60000;
      showToast(accion === 'iniciar' ? 'Activando simulación...' : 'Pausando simulación...', 'info');
      try {
        const response = await fetch('/browser/presencia', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    async function enviarAccionPrueba(accion) {
      showToast('Enviando acción de prueba...', 'info');

      try {
        const response = await fetch('/browser/simular-accion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accion })
        });

        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
        } else {
          showToast(data.message || 'Error en la prueba', 'error');
        }
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    async function ejecutarPrograma(programa) {
      const msgs = {
        'emulador': '¿Estás seguro de que deseas iniciar el emulador Android?'
      };
      const conf = confirm(msgs[programa] || '¿Deseas iniciar este programa?');
      if (!conf) return;

      showToast('Enviando señal de ejecución...', 'info');

      try {
        const response = await fetch('/sistema/ejecutar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    async function cerrarPrograma(programa) {
      const msgs = {
        'emulador': '¿Estás seguro de que deseas cerrar el emulador Android?'
      };
      const conf = confirm(msgs[programa] || '¿Deseas cerrar este programa?');
      if (!conf) return;

      showToast('Cerrando programa...', 'info');

      try {
        const response = await fetch('/sistema/cerrar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ programa })
        });

        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
        } else {
          showToast(data.message || 'Error al cerrar programa', 'error');
        }
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    async function controlarTeclado(accion) {
      showToast('Enviando atajo de teclado...', 'info');
      try {
        const response = await fetch('/sistema/teclado', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accion })
        });
        const data = await response.json();
        showToast(data.message, response.ok ? 'success' : 'error');
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    async function controlarEnergia(accion) {
      showToast('Enviando comando de energía...', 'info');
      try {
        const response = await fetch('/sistema/energia', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accion })
        });
        const data = await response.json();
        showToast(data.message, response.ok ? 'success' : 'error');
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    async function enviarPortapapeles() {
      const text = document.getElementById('inputPortapapeles').value;
      if (!text) {
        showToast('Por favor escribe algún texto para enviar.', 'warning');
        return;
      }
      showToast('Enviando al portapapeles de la PC...', 'info');
      try {
        const response = await fetch('/sistema/portapapeles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const data = await response.json();
        showToast(data.message, response.ok ? 'success' : 'error');
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    async function obtenerPortapapeles() {
      showToast('Leyendo portapapeles de la PC...', 'info');
      try {
        const response = await fetch('/sistema/portapapeles');
        const data = await response.json();
        if (response.ok) {
          document.getElementById('inputPortapapeles').value = data.text;
          showToast('Portapapeles leído con éxito.', 'success');
        } else {
          showToast(data.message || 'Error al leer portapapeles', 'error');
        }
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    function tomarScreenshot() {
      showToast('Actualizando captura de pantalla...', 'info');
      const preview = document.getElementById('screenshotPreview');
      preview.src = '/sistema/screenshot?t=' + Date.now();
      preview.style.display = 'block';
      showToast('Captura cargada.', 'success');
    }

    async function probarPing() {
      try {
        const response = await fetch('/sistema/ping');
        const data = await response.json();
        const pingTxt = document.getElementById('pingResultText');
        if (response.ok && data.latencyMs !== null) {
          pingTxt.innerText = data.latencyMs + ' ms';
          pingTxt.style.color = 'var(--success)';
        } else {
          pingTxt.innerText = 'Error';
          pingTxt.style.color = 'var(--danger)';
        }
      } catch (error) {
        console.error('Error al probar ping:', error);
      }
    }

    async function confirmarReinicio() {
      const confirmar = confirm("¿Estás seguro de que deseas reiniciar el Gateway Server? La conexión se perderá temporalmente.");
      if (!confirmar) return;

      document.getElementById('restartOverlay').style.display = 'flex';
      showToast('Enviando señal de reinicio...', 'info');

      try {
        fetch('/gateway/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).catch(() => {});
      } catch (e) {}

      // Iniciar sondeo activo para detectar cuándo vuelve a estar en línea
      function pollServerBackOnline() {
        setTimeout(async () => {
          try {
            const res = await fetch('/gateway/status');
            if (res.ok) {
              window.location.reload();
            } else {
              pollServerBackOnline();
            }
          } catch (e) {
            pollServerBackOnline();
          }
        }, 1500);
      }
      
      // Empezar a sondear después de un pequeño delay de 3 segundos
      setTimeout(pollServerBackOnline, 3000);
    }
  </script>
  <div id="restartOverlay" style="display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 10, 12, 0.9); z-index: 9999; align-items: center; justify-content: center; flex-direction: column; color: #fff; text-align: center; padding: 20px; box-sizing: border-box;">
    <div style="border: 4px solid rgba(255,255,255,0.1); border-left-color: var(--primary || #3b82f6); border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
    <div style="font-weight: 600; font-size: 1.25rem; margin-bottom: 8px; font-family: 'Outfit', sans-serif;">Reiniciando Gateway Server...</div>
    <div style="font-size: 0.9rem; color: var(--text-muted || #9ca3af); font-family: 'Outfit', sans-serif; max-width: 300px; line-height: 1.4;">La conexión se ha perdido temporalmente. Esperando a que el servidor vuelva a estar en línea.</div>
  </div>
  
  <style>
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</body>
</html>
`;

// Ruta principal GET /
app.get('/', (req, res) => {
  const cookieKey = getApiKeyFromCookie(req.headers.cookie);
  if (cookieKey === API_KEY) {
    res.send(DASHBOARD_HTML);
  } else {
    res.send(LOGIN_HTML);
  }
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

// Hilo de control de horario en background (corre cada 15 segundos para mayor precision)
setInterval(async () => {
  const now = new Date();
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const currentTimeString = `${HH}:${mm}`;

  // 1. Auto-cierre por hora programada fija
  // Usamos >= y guardamos el minuto en que ya se ejecuto para no re-disparar
  if (browserBrowserCloseEnabled && browserBrowserCloseHour) {
    const [closeHH, closeMM] = browserBrowserCloseHour.split(':').map(Number);
    const nowTotalMins = now.getHours() * 60 + now.getMinutes();
    const closeTotalMins = closeHH * 60 + closeMM;
    const minuteKey = `${HH}:${mm}`;

    if (nowTotalMins >= closeTotalMins && lastAutoCierreMinute !== minuteKey) {
      // Solo actuar si estamos dentro del mismo minuto o lo pasamos (y no se actuo hoy ya)
      const diffMins = nowTotalMins - closeTotalMins;
      if (diffMins <= 1) { // hasta 1 minuto de gracia
        lastAutoCierreMinute = minuteKey;
        if (browserBrowserContext || browserBrowserAbierto) {
          log(`Cron Horario: Auto-cierre del navegador programado a las ${browserBrowserCloseHour} (ahora ${currentTimeString}).`);
          await cleanupBrowserSession();
        }
        exec('taskkill /f /im emulator.exe & taskkill /f /im qemu-system-x86_64.exe', (error) => {});
      }
    } else if (nowTotalMins < closeTotalMins) {
      lastAutoCierreMinute = null; // resetear para el proximo dia
    }
  }

  // 2. Auto-cierre/pausa por estar fuera del horario general de la simulacion
  if (browserPresenciaActiva) {
    if (!isSimulationInSchedule()) {
      // Si estamos fuera de horario, asegurar que el navegador y el emulador esten cerrados
      if (browserBrowserContext || browserBrowserAbierto) {
        log('Cron Horario: Cerrando navegador de Browser por estar fuera de horario de simulacion.');
        await cleanupBrowserSession();
      }
      
      // Intentar matar los procesos del emulador silenciosamente
      exec('taskkill /f /im emulator.exe & taskkill /f /im qemu-system-x86_64.exe', (error) => {
        // Ignorar
      });
    }
  }
}, 15000);

// Inicializar el servidor Express
app.listen(PORT, async () => {
  loadSimulationState();
  log(`Servidor unificado (API Gateway Local) escuchando en http://localhost:${PORT}`);
  
  // Inicialización del túnel ngrok con reintentos para evitar el error ERR_NGROK_3200
  const token = process.env.NGROK_AUTHTOKEN;
  if (token && token.trim() !== '') {
    let retriesRemaining = 5;
    const connectNgrok = async () => {
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
        if (retriesRemaining > 0) {
          retriesRemaining--;
          log(`Reintentando conexión ngrok en 5 segundos... (Reintentos restantes: ${retriesRemaining})`);
          setTimeout(connectNgrok, 5000);
        } else {
          log('Se agotaron los reintentos para establecer el túnel ngrok.');
        }
      }
    };
    connectNgrok();
  } else {
    log('Variable NGROK_AUTHTOKEN vacía o no configurada. Servidor operando solo localmente.');
  }
});
