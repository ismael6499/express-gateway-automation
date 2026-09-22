require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const ngrok = require('@ngrok/ngrok');
const fs = require('fs');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const TARGET_WEB_URL = process.env.TARGET_WEB_URL || 'https://example.com';
const TARGET_ACCOUNT_EMAIL = process.env.TARGET_ACCOUNT_EMAIL || '';
const USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || path.join(__dirname, 'browser_user_data');
let targetHost = '';
try {
  targetHost = new URL(TARGET_WEB_URL).hostname;
} catch (e) {}

// Middleware para parsear JSON
app.use(express.json());

// Middleware para omitir advertencia de navegador ngrok y cabeceras CORS
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
  next();
});

// Servir archivos estáticos de PWA (manifest, service worker, iconos)
app.use(express.static(path.join(__dirname, 'public')));

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
let browserAbierto = false;
let browserPresenciaActiva = false;
let browserIntervalMs = 240000; // 4 minutos por defecto
let browserContext = null;
let browserPage = null;
let browserIntervalId = null;
let browserSignInCheckIntervalId = null; // intervalo de 1 min para verificar banner de re-autenticación "Sign In"
let lastAutoCierreMinute = null; // evita re-disparar auto-cierre en el mismo minuto
let lastFlexCierreMinute = null; // evita re-disparar flex-cierre en el mismo minuto
let isLaunchingBrowser = false;  // guard anti-concurrencia al abrir/cerrar navegador
let lastActivityTime = null;     // timestamp de la ultima simulacion de actividad
let browserPresenciaActiveSince = null; // timestamp de cuando se inicio la simulacion activa
let browserSimulacionStartHour = '09:00';
let browserSimulacionEndHour = '18:00';
let browserSimulacionDays = [1, 2, 3, 4, 5]; // Lunes a Viernes por defecto
let browserCloseHour = '18:03';
let browserCloseEnabled = true;
let browserFlexCloseDate = '';
let browserFlexCloseHour = '';
let browserFlexCloseEnabled = false;
let browserPausaTemporalUntil = null;
let browserPausaTemporalTimeoutId = null;
let mealPauseCutoffHour = '15:15';
let mealPauseIntervals = [
  { start: '00:00', end: '15:15', mins: 25 },
  { start: '15:15', end: '23:59', mins: 15 }
];

function getMealPauseDefaultMins() {
  const now = new Date();
  const curMinutes = now.getHours() * 60 + now.getMinutes();

  if (Array.isArray(mealPauseIntervals) && mealPauseIntervals.length > 0) {
    for (const item of mealPauseIntervals) {
      if (!item.start || !item.end) continue;
      const [sH, sM] = item.start.split(':').map(Number);
      const [eH, eM] = item.end.split(':').map(Number);
      const startMin = sH * 60 + sM;
      const endMin = eH * 60 + eM;

      if (startMin <= endMin) {
        if (curMinutes >= startMin && curMinutes <= endMin) {
          return Number(item.mins) || 20;
        }
      } else {
        if (curMinutes >= startMin || curMinutes <= endMin) {
          return Number(item.mins) || 20;
        }
      }
    }
  }

  const [cutoffH, cutoffM] = (mealPauseCutoffHour || '15:15').split(':').map(Number);
  const curH = now.getHours();
  const curM = now.getMinutes();

  if (curH > cutoffH || (curH === cutoffH && curM >= cutoffM)) {
    return 15;
  }
  return 25;
}

function iniciarPausaTemporal(minutos) {
  if (browserPausaTemporalTimeoutId) {
    clearTimeout(browserPausaTemporalTimeoutId);
    browserPausaTemporalTimeoutId = null;
  }
  const ms = minutos * 60000;
  browserPausaTemporalUntil = Date.now() + ms;

  const pad = (n) => String(n).padStart(2, '0');
  const endDate = new Date(browserPausaTemporalUntil);
  const endTimeStr = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:${pad(endDate.getSeconds())}`;
  log(`Pausa temporal de simulación activada por ${minutos} minutos (hasta las ${endTimeStr}).`);

  browserPausaTemporalTimeoutId = setTimeout(() => {
    log('La pausa temporal de simulación ha finalizado.');
    browserPausaTemporalUntil = null;
    browserPausaTemporalTimeoutId = null;
    if (browserPresenciaActiva) {
      log('Reanudando simulación de presencia tras finalizar pausa temporal.');
      runBrowserActivityLoop().catch((err) => {
        log(`Error en simulación al finalizar pausa temporal: ${err.message}`);
      });
    }
  }, ms);
}

function cancelarPausaTemporal() {
  if (browserPausaTemporalTimeoutId) {
    clearTimeout(browserPausaTemporalTimeoutId);
    browserPausaTemporalTimeoutId = null;
  }
  if (browserPausaTemporalUntil) {
    log('Pausa temporal de simulación cancelada.');
    browserPausaTemporalUntil = null;
  }
}

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
      browserCloseHour,
      browserCloseEnabled,
      browserFlexCloseDate,
      browserFlexCloseHour,
      browserFlexCloseEnabled,
      mealPauseCutoffHour,
      mealPauseIntervals
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
      if (data.browserCloseHour !== undefined) {
        browserCloseHour = data.browserCloseHour;
      }
      if (data.browserCloseEnabled !== undefined) {
        browserCloseEnabled = data.browserCloseEnabled;
      }
      if (data.browserFlexCloseDate !== undefined) {
        browserFlexCloseDate = data.browserFlexCloseDate;
      }
      if (data.browserFlexCloseHour !== undefined) {
        browserFlexCloseHour = data.browserFlexCloseHour;
      }
      if (data.browserFlexCloseEnabled !== undefined) {
        browserFlexCloseEnabled = data.browserFlexCloseEnabled;
      }
      if (data.mealPauseCutoffHour !== undefined) {
        mealPauseCutoffHour = data.mealPauseCutoffHour;
      }
      if (Array.isArray(data.mealPauseIntervals) && data.mealPauseIntervals.length > 0) {
        mealPauseIntervals = data.mealPauseIntervals;
      }
      log(`Estado de simulación cargado: Habilitada=${browserPresenciaActiva}, Intervalo=${browserIntervalMs}ms, Horario=${browserSimulacionStartHour}-${browserSimulacionEndHour}, Cierre=${browserCloseHour} (Activo=${browserCloseEnabled}), FlexCierre=${browserFlexCloseDate} ${browserFlexCloseHour} (Activo=${browserFlexCloseEnabled})`);
    }
  } catch (err) {
    log(`Error al cargar estado de simulación: ${err.message}`);
  }
}

// URL del túnel público ngrok
let ngrokUrl = '';
let ngrokListener = null;

// ==========================================
// NATIVE INPUT HELPER (Trackpad, Mouse & Keystrokes)
// ==========================================
let inputHelperProcess = null;

function getInputHelper() {
  if (inputHelperProcess && !inputHelperProcess.killed && inputHelperProcess.exitCode === null) {
    return inputHelperProcess;
  }
  const helperPath = path.join(__dirname, 'InputHelper.exe');
  if (!fs.existsSync(helperPath)) {
    log('Aviso: InputHelper.exe no encontrado en el directorio raíz.');
    return null;
  }
  try {
    inputHelperProcess = spawn(helperPath, ['--pipe'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    });
    inputHelperProcess.on('error', (err) => {
      log(`InputHelper error: ${err.message}`);
      inputHelperProcess = null;
    });
    inputHelperProcess.on('exit', () => {
      inputHelperProcess = null;
    });
    return inputHelperProcess;
  } catch (err) {
    log(`Error al iniciar InputHelper: ${err.message}`);
    return null;
  }
}

function sendInputCommand(cmd) {
  const proc = getInputHelper();
  if (proc && proc.stdin && proc.stdin.writable) {
    proc.stdin.write(cmd + '\n');
    return true;
  }
  const helperPath = path.join(__dirname, 'InputHelper.exe');
  exec(`"${helperPath}" ${cmd}`, () => {});
  return false;
}

// Middleware de Autenticación para rutas de la API (interviene en /browser, /sistema, y /gateway/status)
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/favicon.ico' || req.path === '/manifest.json' || req.path === '/sw.js' || req.path.startsWith('/icon-') || req.path === '/gateway/login' || req.path === '/gateway/restart' || req.path === '/system/restart') {
    return next();
  }

  const clientApiKey = req.headers['x-api-key'] || getApiKeyFromCookie(req.headers.cookie);
  if (req.path !== '/system/mouse' && req.path !== '/sistema/mouse' && req.path !== '/gateway/status' && req.path !== '/system/status') {
    log(`Solicitud API interceptada: ${req.method} ${req.originalUrl}`);
  }

  if (!clientApiKey || clientApiKey !== API_KEY) {
    log('Acceso denegado: API Key inválida o ausente.');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Acceso no autorizado. El encabezado X-API-KEY o cookie es requerido y debe ser válido.'
    });
  }

  next();
});

// Endpoint POST /gateway/login para autenticación web segura con Set-Cookie de servidor
app.post('/gateway/login', (req, res) => {
  const { apiKey } = req.body || {};
  const key = apiKey || req.headers['x-api-key'];

  if (key === API_KEY) {
    res.setHeader('Set-Cookie', [
      `api_key=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
      `ngrok-skip-browser-warning=true; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
    ]);
    log('Autenticación exitosa en /gateway/login. Cookie de sesión establecida.');
    return res.json({
      status: 'ok',
      message: 'Autenticación exitosa.'
    });
  } else {
    log('Intento de login fallido en /gateway/login: API Key incorrecta.');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Clave API incorrecta.'
    });
  }
});

// Endpoint POST /gateway/restart (and /system/restart) para reiniciar el servidor de forma segura
app.post(['/gateway/restart', '/system/restart'], (req, res) => {
  log('Recibida petición de reinicio del Gateway Server (/gateway/restart)...');
  res.json({ status: 'ok', message: 'Reiniciando servidor...' });
  const vbsPath = path.join(__dirname, 'remote_restart.vbs');
  const child = spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Helper para detectar y presionar el botón "Sign In" de re-autenticación en la barra/banner superior de autenticación web
async function checkAndClickSignInBanner(page) {
  if (!page || page.isClosed()) return false;
  try {
    const result = await page.evaluate(() => {
      // Helper para verificar si un elemento está dentro del área de mensajes/conversaciones del chat
      function isInsideChatMessage(el) {
        let current = el;
        while (current && current !== document.body) {
          const tid = (current.getAttribute && current.getAttribute('data-tid')) || '';
          const role = (current.getAttribute && current.getAttribute('role')) || '';
          const className = typeof current.className === 'string' ? current.className : '';
          
          if (
            tid.includes('chat') || 
            tid.includes('message') || 
            tid.includes('thread') ||
            role === 'article' || 
            role === 'listitem' || 
            className.includes('ChatMessage') || 
            className.includes('ui-chat') ||
            className.includes('message-body') ||
            className.includes('fui-ChatMessage')
          ) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }

      // Buscar todos los botones, enlaces e inputs clickeables
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], div[role="button"]'));
      
      for (const el of elements) {
        const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        const textLower = text.toLowerCase();

        // Verificar si la etiqueta coincide con "Sign In", "Sign in", "Iniciar sesión", "Iniciar Sesión", etc.
        if (
          textLower === 'sign in' || 
          textLower === 'iniciar sesión' || 
          textLower === 'iniciar sesion' ||
          textLower === 're-authenticate' ||
          textLower === 'reautenticar'
        ) {
          // 1. STRICT SAFEGUARD: Descartar si el botón está dentro del cuerpo o historial de mensajes de un chat
          if (isInsideChatMessage(el)) continue;

          // 2. Verificar visibilidad física en la pantalla
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.right <= 0) continue;

          // 3. Confirmar que está situado en la barra superior o dentro de un banner/alert/bar de notificación
          let isTopOrBanner = rect.top < 300;
          if (!isTopOrBanner) {
            let p = el.parentElement;
            while (p && p !== document.body) {
              const role = (p.getAttribute && p.getAttribute('role')) || '';
              const className = typeof p.className === 'string' ? p.className : '';
              const tid = (p.getAttribute && p.getAttribute('data-tid')) || '';
              if (
                role === 'alert' || 
                role === 'banner' || 
                role === 'region' || 
                className.includes('banner') || 
                className.includes('MessageBar') || 
                className.includes('notification') ||
                tid.includes('banner') ||
                tid.includes('alert')
              ) {
                isTopOrBanner = true;
                break;
              }
              p = p.parentElement;
            }
          }

          if (isTopOrBanner) {
            el.click();
            try {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            } catch (e) {}
            return { clicked: true, text: text, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
      }
      return { clicked: false };
    });

    if (result && result.clicked) {
      log(`Auto-Login/Banner: Detectado y presionado botón "Sign In" superior ("${result.text}") en coords (${Math.round(result.x)}, ${Math.round(result.y)}).`);
      try {
        await page.mouse.click(result.x, result.y).catch(() => {});
      } catch (e) {}
      return true;
    }
  } catch (err) {
    // Si la página navega o se destruye durante la lectura, ignorar silenciosamente
  }
  return false;
}

// Iniciar intervalo de chequeo del banner Sign In cada 1 minuto (60000ms)
function setupSignInCheckInterval() {
  if (browserSignInCheckIntervalId) {
    clearInterval(browserSignInCheckIntervalId);
    browserSignInCheckIntervalId = null;
  }
  log('Iniciando monitoreo periódico de banner "Sign In" (cada 60 segundos)...');
  browserSignInCheckIntervalId = setInterval(async () => {
    if (browserContext && browserPage && !browserPage.isClosed()) {
      await checkAndClickSignInBanner(browserPage);
    }
  }, 60000);
}

// Helper para limpiar el contexto e intervalo de navegación web de forma segura
async function cleanupBrowserSession() {
  if (browserIntervalId) {
    clearInterval(browserIntervalId);
    browserIntervalId = null;
    log('Intervalo de simulación de presencia destruido.');
  }

  if (browserSignInCheckIntervalId) {
    clearInterval(browserSignInCheckIntervalId);
    browserSignInCheckIntervalId = null;
    log('Intervalo de monitoreo "Sign In" destruido.');
  }

  if (browserContext) {
    try {
      await browserContext.close();
      log('Contexto de navegador Playwright cerrado.');
    } catch (err) {
      log(`Error al cerrar el contexto de Playwright: ${err.message}`);
    } finally {
      browserContext = null;
      browserPage = null;
    }
  }
  browserAbierto = false;
}

// Bucle asíncrono para automatizar el login en redirecciones de autenticación corporativa
async function autoLoginTargetSession(page) {
  log('Iniciando monitoreo de auto-login web...');
  
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

      // Si la aplicación web ya ha cargado
      const isAppLoadedUrl = (targetHost && url.includes(targetHost)) || 
                             url.includes('.cloud.microsoft') ||
                             (TARGET_WEB_URL && TARGET_WEB_URL.includes('browser') && url.includes('browser'));
      if (isAppLoadedUrl) {
        // Verificar y presionar el botón de Sign In superior si aparece en la barra de re-autenticación
        await checkAndClickSignInBanner(page);

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
          log('¡Auto-Login exitoso! La sesión web ha cargado por completo.');
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
          
          const accountSelectors = [];
          if (TARGET_ACCOUNT_EMAIL) {
            accountSelectors.push(
              `div[data-username*="${TARGET_ACCOUNT_EMAIL}"]`,
              `[data-username*="${TARGET_ACCOUNT_EMAIL}"]`,
              `div[role="button"]:has-text("${TARGET_ACCOUNT_EMAIL}")`,
              `.tile:has-text("${TARGET_ACCOUNT_EMAIL}")`
            );
          }
          accountSelectors.push(
            'div.table[role="button"]',
            '.tile-container .tile',
            'div[data-test-id*="account"]',
            'div[role="button"].tile'
          );

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
  if (browserSignInCheckIntervalId) {
    clearInterval(browserSignInCheckIntervalId);
    browserSignInCheckIntervalId = null;
    log('Intervalo de monitoreo "Sign In" destruido tras cierre manual del navegador.');
  }
  // Mantener browserPresenciaActiva intacto
  browserContext = null;
  browserPage = null;
  browserAbierto = false;
}

// Helper para formatear los segundos de forma amigable (horas, minutos, segundos)
function formatSecondsAgo(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}

let lastAudioCheckTime = 0;
let cachedAudioData = { volume: null, muted: null, playing: null };

function getAudioStatusCached(callback) {
  const now = Date.now();
  if (now - lastAudioCheckTime < 3500) {
    return callback(cachedAudioData);
  }
  const helperPath = path.join(__dirname, 'AudioHelper.exe');
  exec(`"${helperPath}"`, { timeout: 1200 }, (error, stdout) => {
    if (!error && stdout) {
      try {
        cachedAudioData = JSON.parse(stdout.trim());
        lastAudioCheckTime = Date.now();
      } catch (e) {}
    }
    callback(cachedAudioData);
  });
}

// Endpoint GET /gateway/status
app.get(['/gateway/status', '/system/status'], (req, res) => {
  getAudioStatusCached((audioData) => {

    let lastActivityFormatted = 'Sin actividad';
    let lastActivitySecondsAgo = null;
    let lastActivityTimeStr = null;
    if (lastActivityTime) {
      const now = new Date();
      lastActivitySecondsAgo = Math.floor((now - lastActivityTime) / 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const d = lastActivityTime;
      lastActivityTimeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      lastActivityFormatted = formatSecondsAgo(lastActivitySecondsAgo);
    }

    let browserPausaTemporalRemainingMs = 0;
    if (browserPausaTemporalUntil) {
      const diff = browserPausaTemporalUntil - Date.now();
      if (diff > 0) {
        browserPausaTemporalRemainingMs = diff;
      } else {
        browserPausaTemporalUntil = null;
      }
    }

    let screenGuardActive = false;
    try {
      const statePath = path.join(__dirname, 'screenguard_state.json');
      if (fs.existsSync(statePath)) {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (raw && raw.active && raw.pid) {
          try {
            process.kill(raw.pid, 0);
            screenGuardActive = true;
          } catch (e) {
            screenGuardActive = false;
          }
        }
      }
    } catch (e) {}

    return res.json({
      browserAbierto,
      browserPresenciaActiva,
      browserIntervalMs,
      browserSimulacionStartHour,
      browserSimulacionEndHour,
      browserSimulacionDays,
      browserCloseHour,
      browserCloseEnabled,
      browserFlexCloseDate,
      browserFlexCloseHour,
      browserFlexCloseEnabled,
      browserPausaTemporalUntil,
      browserPausaTemporalRemainingMs,
      mealPauseDefaultMins: getMealPauseDefaultMins(),
      mealPauseCutoffHour,
      mealPauseIntervals,
      ngrokUrl: ngrokUrl || 'Inactivo',
      hasEmulatorPath: !!process.env.EMULATOR_BAT_PATH,
      audioVolume: audioData.volume,
      audioMuted: audioData.muted,
      audioPlaying: audioData.playing,
      lastActivityFormatted,
      lastActivitySecondsAgo,
      lastActivityTimeStr,
      screenGuardActive
    });
  });
});

// Endpoint POST /browser/window (and legacy /browser/browser) para controlar el ciclo del navegador web
app.post(['/browser/window', '/browser/browser'], async (req, res) => {
  let accion = req.body.action || req.body.accion;
  if (accion === 'open') accion = 'abrir';
  if (accion === 'close') accion = 'cerrar';
  if (accion === 'minimize') accion = 'minimizar';
  if (accion === 'restore') accion = 'restaurar';

  if (accion !== 'abrir' && accion !== 'cerrar' && accion !== 'minimizar' && accion !== 'restaurar') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "The 'action' must be 'open', 'close', 'minimize', or 'restore' ('abrir', 'cerrar', 'minimizar', 'restaurar')."
    });
  }

  // Permitir la acción "cerrar" siempre (incluso si isLaunchingBrowser está activo)
  if (accion === 'cerrar') {
    isLaunchingBrowser = false;
  } else if (accion === 'abrir' && browserContext) {
    isLaunchingBrowser = false;
    log('El navegador ya se encuentra abierto.');
    return res.status(200).json({
      status: 'ok',
      message: 'El navegador web ya está abierto.',
      msg: 'Navegador ya abierto'
    });
  } else if (isLaunchingBrowser && accion === 'abrir') {
    return res.status(200).json({
      status: 'ok',
      message: 'Ya hay una operación de navegador en curso. Por favor espera.',
      msg: 'Operación en curso'
    });
  }

  if (accion === 'abrir') {
    isLaunchingBrowser = true;
  }

  try {
    if (accion === 'minimizar') {
      if (!browserContext || !browserPage || browserPage.isClosed()) {
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
      if (!browserContext || !browserPage || browserPage.isClosed()) {
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

      const userDataDir = USER_DATA_DIR;
      log(`Abriendo ventana de Playwright en: ${userDataDir}`);
      
      try {
        log('Intentando iniciar con Google Chrome oficial...');
        browserContext = await chromium.launchPersistentContext(userDataDir, {
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
          browserContext = await chromium.launchPersistentContext(userDataDir, {
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
          browserContext = await chromium.launchPersistentContext(userDataDir, {
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

      const pages = browserContext.pages();
      // Buscar si ya hay alguna pestaña restaurada
      let targetHost = '';
      try { targetHost = new URL(TARGET_WEB_URL).hostname; } catch (e) {}
      const restoredBrowserPage = pages.find(p => {
        const u = p.url();
        return (targetHost && u.includes(targetHost)) || 
               u.includes('.cloud.microsoft') ||
               (TARGET_WEB_URL && TARGET_WEB_URL.includes('browser') && u.includes('browser'));
      });

      if (restoredBrowserPage) {
        log('Auto-Login: Reutilizando pestaña restaurada automáticamente.');
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
          browserPage = await browserContext.newPage();
        }

        log(`Navegando asíncronamente a ${TARGET_WEB_URL}...`);
        browserPage.goto(TARGET_WEB_URL).catch((err) => {
          log(`Error al navegar a la URL objetivo: ${err.message}`);
        });
      }

      // Detectar si el usuario cierra la página web directamente
      browserPage.on('close', async () => {
        log('Aviso: La página web fue cerrada manualmente por el usuario.');
        handleManualCloseCleanup();
      });

      // Detectar si el contexto entero se cierra
      browserContext.on('close', async () => {
        log('Aviso: El navegador web fue cerrado manualmente por el usuario.');
        handleManualCloseCleanup();
      });

      // Ejecutar el asistente de auto-login en segundo plano
      autoLoginTargetSession(browserPage).catch((err) => {
        log(`Error de fondo en auto-login: ${err.message}`);
      });

      // Iniciar el monitoreo periódico de "Sign In" en la barra superior
      setupSignInCheckInterval();

      browserAbierto = true;

      // Auto-minimizar la ventana a los 10 segundos de abrirse
      setTimeout(async () => {
        if (browserContext && browserPage && !browserPage.isClosed()) {
          try {
            const session = await browserPage.context().newCDPSession(browserPage);
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
            log('Ventana del navegador minimizada automáticamente a los 10 segundos.');
          } catch (err) {
            log(`Error al auto-minimizar: ${err.message}`);
          }
        }
      }, 10000);

      // Si la simulación (Mantener Activo) está activa, iniciarla automáticamente después de 20 segundos
      if (browserPresenciaActiva) {
        log('Mantener Activo está encendido. Iniciando simulación automática en 20 segundos...');
        setTimeout(() => {
          if (browserContext && browserPresenciaActiva) {
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
        message: 'Navegador web abierto con éxito y cargando página.',
        msg: 'Navegador abierto'
      });

    } else {
      await cleanupBrowserSession();
      isLaunchingBrowser = false;
      return res.status(200).json({
        status: 'ok',
        message: 'Navegador web cerrado (la automatización continuará activa al abrirlo de nuevo).',
        msg: 'Navegador cerrado'
      });
    }
  } catch (error) {
    log(`Error al controlar el navegador web: ${error.message}`);
    isLaunchingBrowser = false;
    await cleanupBrowserSession();
    return res.status(500).json({
      error: 'Internal Server Error',
      message: `Fallo al modificar estado del navegador: ${error.message}`
    });
  }
});

// Endpoint POST /browser/schedule (and legacy /browser/programacion) - Actualizar horario y días de la automatización
app.post(['/browser/schedule', '/browser/programacion'], (req, res) => {
  const b = req.body || {};

  if (b.startHour && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(b.startHour)) {
    browserSimulacionStartHour = b.startHour;
  }
  if (b.endHour && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(b.endHour)) {
    browserSimulacionEndHour = b.endHour;
  }
  if (b.days && Array.isArray(b.days)) {
    browserSimulacionDays = b.days.map(Number);
  }
  const closeHourVal = b.closeHour || b.browserCloseHour;
  if (closeHourVal && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(closeHourVal)) {
    browserCloseHour = closeHourVal;
  }
  const closeEnabledVal = b.closeEnabled !== undefined ? b.closeEnabled : b.browserCloseEnabled;
  if (closeEnabledVal !== undefined) {
    browserCloseEnabled = !!closeEnabledVal;
  }
  const flexDateVal = b.flexCloseDate !== undefined ? b.flexCloseDate : b.browserFlexCloseDate;
  if (flexDateVal !== undefined) {
    browserFlexCloseDate = flexDateVal;
  }
  const flexHourVal = b.flexCloseHour !== undefined ? b.flexCloseHour : b.browserFlexCloseHour;
  if (flexHourVal !== undefined && (flexHourVal === '' || /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(flexHourVal))) {
    browserFlexCloseHour = flexHourVal;
  }
  const flexEnabledVal = b.flexCloseEnabled !== undefined ? b.flexCloseEnabled : b.browserFlexCloseEnabled;
  if (flexEnabledVal !== undefined) {
    browserFlexCloseEnabled = !!flexEnabledVal;
  }
  if (b.mealPauseCutoffHour && /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(b.mealPauseCutoffHour)) {
    mealPauseCutoffHour = b.mealPauseCutoffHour;
  }
  if (Array.isArray(b.mealPauseIntervals)) {
    const validIntervals = b.mealPauseIntervals.slice(0, 4).filter(item => {
      return item && typeof item.start === 'string' && typeof item.end === 'string' && !isNaN(Number(item.mins));
    }).map(item => ({
      start: item.start,
      end: item.end,
      mins: Math.max(1, Math.min(480, Number(item.mins) || 20))
    }));
    if (validIntervals.length > 0) {
      mealPauseIntervals = validIntervals;
    }
  }

  saveSimulationState();
  log(`Programación actualizada: Rango: ${browserSimulacionStartHour}-${browserSimulacionEndHour}, Días: ${browserSimulacionDays.join(',')}, Cierre: ${browserCloseHour} (Activo=${browserCloseEnabled}), Flex: ${browserFlexCloseDate} ${browserFlexCloseHour} (Activo=${browserFlexCloseEnabled}), IntervalosPausa: ${JSON.stringify(mealPauseIntervals)}`);

  res.json({
    status: 'ok',
    message: 'Programación actualizada con éxito.',
    browserSimulacionStartHour,
    browserSimulacionEndHour,
    browserSimulacionDays,
    browserCloseHour,
    browserCloseEnabled,
    closeHour: browserCloseHour,
    closeEnabled: browserCloseEnabled,
    browserFlexCloseDate,
    browserFlexCloseHour,
    browserFlexCloseEnabled,
    flexCloseDate: browserFlexCloseDate,
    flexCloseHour: browserFlexCloseHour,
    flexCloseEnabled: browserFlexCloseEnabled,
    mealPauseCutoffHour,
    mealPauseIntervals
  });
});

// Endpoint POST /browser/presence (and legacy /browser/presencia) para controlar la actividad web
app.post(['/browser/presence', '/browser/presencia'], (req, res) => {
  let accion = req.body.action || req.body.accion;
  if (accion === 'start') accion = 'iniciar';
  if (accion === 'pause' || accion === 'stop') accion = 'pausar';
  if (accion === 'temporary_pause' || accion === 'temp_pause' || accion === 'pause_temporary') accion = 'pausa_temporal';

  const intervaloMs = req.body.intervalMs || req.body.intervaloMs;

  if (accion !== 'iniciar' && accion !== 'pausar' && accion !== 'pausa_temporal') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "The 'action' must be 'start', 'pause', or 'temporary_pause' ('iniciar', 'pausar', 'pausa_temporal')."
    });
  }

  if (intervaloMs && typeof intervaloMs === 'number' && intervaloMs > 0) {
    let mins = Math.round(intervaloMs / 60000);
    if (mins < 1) mins = 1;
    if (mins > 9999) mins = 9999;
    browserIntervalMs = mins * 60000;
    log(`Intervalo web actualizado a: ${browserIntervalMs} ms (${mins} minutes)`);
  }

  if (accion === 'iniciar') {
    cancelarPausaTemporal();
    let yaEstabaActiva = false;
    let tiempoActivaFormatted = '';

    if (browserIntervalId || browserPresenciaActiva) {
      yaEstabaActiva = true;
      if (browserPresenciaActiveSince) {
        const seconds = Math.floor((new Date() - browserPresenciaActiveSince) / 1000);
        tiempoActivaFormatted = formatSecondsAgo(seconds);
      }
    }

    if (browserIntervalId) {
      log('La simulación de presencia ya está activa. Reconfigurando intervalo.');
      clearInterval(browserIntervalId);
    }

    setupBrowserInterval();
    browserPresenciaActiva = true;
    if (!browserPresenciaActiveSince) {
      browserPresenciaActiveSince = new Date();
    }
    saveSimulationState();
    log('Simulación de presencia activada.');
    
    // Ejecutar una simulación inicial inmediatamente
    runBrowserActivityLoop().catch((err) => {
      log(`Error en simulación inicial inmediata: ${err.message}`);
    });
    
    if (yaEstabaActiva) {
      return res.status(200).json({
        status: 'ok',
        message: tiempoActivaFormatted 
          ? `La simulación de presencia reanudada (estaba activa desde hace ${tiempoActivaFormatted}).`
          : 'La simulación de presencia reanudada normalmente.',
        msg: tiempoActivaFormatted 
          ? `Reanudada (activa hace ${tiempoActivaFormatted})`
          : 'Simulación reanudada',
        config: { browserIntervalMs }
      });
    }

    return res.status(200).json({
      status: 'ok',
      message: 'Simulación de presencia activada e iniciada inmediatamente.',
      msg: 'Simulación activa',
      config: { browserIntervalMs }
    });
  } else if (accion === 'pausa_temporal') {
    let defaultMins = getMealPauseDefaultMins();
    let duracionMins = Number(req.body.durationMins || req.body.duracionMins || req.body.minutes || req.body.minutos || defaultMins);
    if (isNaN(duracionMins) || duracionMins < 1) duracionMins = defaultMins;
    if (duracionMins > 1440) duracionMins = 1440;

    if (!browserIntervalId) {
      setupBrowserInterval();
    }
    browserPresenciaActiva = true;
    if (!browserPresenciaActiveSince) {
      browserPresenciaActiveSince = new Date();
    }

    iniciarPausaTemporal(duracionMins);
    saveSimulationState();

    const pad = (n) => String(n).padStart(2, '0');
    const endDate = new Date(browserPausaTemporalUntil);
    const endTimeStr = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;

    return res.status(200).json({
      status: 'ok',
      message: `Simulación de actividad pausada temporalmente por ${duracionMins} minutos (hasta ${endTimeStr}).`,
      msg: `Pausa de ${duracionMins}m activada`,
      config: { browserIntervalMs, browserPausaTemporalUntil }
    });
  } else {
    cancelarPausaTemporal();
    const yaEstabaPausada = !browserPresenciaActiva && !browserIntervalId;

    if (browserIntervalId) {
      clearInterval(browserIntervalId);
      browserIntervalId = null;
      log('Simulación de presencia pausada por completo.');
    }
    browserPresenciaActiva = false;
    browserPresenciaActiveSince = null;
    saveSimulationState();

    if (yaEstabaPausada) {
      return res.status(200).json({
        status: 'ok',
        message: 'La simulación de presencia ya estaba pausada.',
        msg: 'Ya estaba pausada'
      });
    }

    return res.status(200).json({
      status: 'ok',
      message: 'Simulación de presencia pausada.',
      msg: 'Simulación pausada'
    });
  }
});

async function runBrowserActivityLoop() {
  try {
    if (browserPausaTemporalUntil) {
      if (Date.now() < browserPausaTemporalUntil) {
        const remainingSecs = Math.ceil((browserPausaTemporalUntil - Date.now()) / 1000);
        const remainingMins = Math.ceil(remainingSecs / 60);
        log(`Simulación de presencia omitida: Pausa temporal activa (${remainingMins} min restantes).`);
        return;
      } else {
        browserPausaTemporalUntil = null;
        if (browserPausaTemporalTimeoutId) {
          clearTimeout(browserPausaTemporalTimeoutId);
          browserPausaTemporalTimeoutId = null;
        }
      }
    }

    if (!isSimulationInSchedule()) {
      log('Simulación de presencia omitida: Fuera de los días/horas programados.');
      return;
    }
    if (!browserContext) return;

    if (!browserPage || browserPage.isClosed()) {
      const pages = browserContext.pages();
      if (pages.length > 0) {
        browserPage = pages[0];
      } else {
        log('Advertencia: No hay páginas abiertas para mantener sesión.');
        return;
      }
    }

    // Verificar y clickear si existe el banner de Sign In en la barra superior
    await checkAndClickSignInBanner(browserPage);

    log('Ejecutando keepalive de sesión web...');
    
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
    log(`Error al ejecutar actividad de sesión web: ${err.message}`);
  }
}

// Iniciar intervalo de actividad de sesión web
function setupBrowserInterval() {
  browserIntervalId = setInterval(async () => {
    await runBrowserActivityLoop();
  }, browserIntervalMs);
}

// Endpoint POST /browser/simulate-action (and legacy /browser/action, /browser/simular-accion)
app.post(['/browser/simulate-action', '/browser/action', '/browser/simular-accion'], async (req, res) => {
  let accion = req.body.action || req.body.accion;
  if (accion === 'move-mouse' || accion === 'move_mouse') accion = 'mover-mouse';
  if (accion === 'type-search' || accion === 'type_search' || accion === 'type-searchbox') accion = 'tipear-buscador';
  if (accion === 'press-shift' || accion === 'press_shift' || accion === 'shift') accion = 'pulsar-shift';

  if (!browserContext || !browserPage || browserPage.isClosed()) {
    log('Fallo de prueba: Intento de simular acción sin ventana de navegador abierta.');
    return res.status(400).json({
      error: 'Precondition Failed',
      message: 'No se puede simular la acción si el navegador está cerrado.'
    });
  }

  try {
    log(`Ejecutando acción de test manual: '${accion}'`);
    lastActivityTime = new Date();

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
            message: 'No se pudo interactuar con el buscador de la aplicación web ni usando atajos ni selectores.'
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

// Endpoint POST /browser/status
app.post('/browser/status', async (req, res) => {
  let estado = req.body.status || req.body.estado;
  if (estado === 'active') estado = 'activo';
  if (estado === 'inactive' || estado === 'stop' || estado === 'pause') estado = 'inactivo';
  const intervaloMs = req.body.intervalMs || req.body.intervaloMs;
  log(`POST /browser/status recibido con estado '${estado}'`);

  if (intervaloMs) {
    browserIntervalMs = intervaloMs;
  }

  try {
    if (estado === 'activo') {
      if (!browserContext) {
        const userDataDir = USER_DATA_DIR;
        browserContext = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          viewport: null
        });
        const pages = browserContext.pages();
        browserPage = pages.length > 0 ? pages[0] : await browserContext.newPage();
        browserPage.goto(TARGET_WEB_URL).catch(() => {});
        browserAbierto = true;
        setupSignInCheckInterval();
      }
      if (browserIntervalId) clearInterval(browserIntervalId);
      setupBrowserInterval();
      browserPresenciaActiva = true;

      // Iniciar simulación inmediatamente
      runBrowserActivityLoop().catch(() => {});

      return res.status(200).json({
        status: 'ok',
        message: 'Sesión web iniciada e intervalo de actividad configurado.'
      });
    } else {
      await cleanupBrowserSession();
      return res.status(200).json({
        status: 'ok',
        message: 'Sesión web y actividad detenidas.'
      });
    }
  } catch (error) {
    await cleanupBrowserSession();
    return res.status(500).json({ error: 'Internal Error', message: error.message });
  }
});

// Endpoint POST /system/keyboard (and legacy /sistema/teclado)
app.post(['/system/keyboard', '/sistema/teclado'], (req, res) => {
  let accion = req.body.action || req.body.accion;
  if (accion === 'turn-off-screen' || accion === 'screen-off' || accion === 'screen_off') accion = 'apagar-pantalla';
  if (accion === 'turn-on-screen' || accion === 'screen-on' || accion === 'screen_on') accion = 'encender-pantalla';
  if (accion === 'start-screenguard' || accion === 'screenguard-on' || accion === 'screenguard_on' || accion === 'guard-on') accion = 'apagar-guardia';
  if (accion === 'screenguard-status' || accion === 'guard-status' || accion === 'guard_status') accion = 'estado-guardia';

  if (accion !== 'apagar-pantalla' && accion !== 'encender-pantalla' && accion !== 'apagar-guardia' && accion !== 'estado-guardia') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "The 'action' must be 'turn-off-screen', 'turn-on-screen', 'start-screenguard', or 'screenguard-status' ('apagar-pantalla', 'encender-pantalla', 'apagar-guardia', 'estado-guardia')."
    });
  }

  try {
    const screenGuardExe = path.join(__dirname, 'ScreenGuard.exe');

    if (accion === 'apagar-guardia') {
      log('Iniciando ScreenGuard en segundo plano (pantalla protegida anti-notificaciones y anti-remoto)...');
      const child = spawn(screenGuardExe, ['start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();

      return res.status(200).json({
        status: 'ok',
        message: 'Guardián activado: pantalla apagada y protegida.',
        msg: 'Guardián activado'
      });
    } else if (accion === 'apagar-pantalla') {
      log('Simulando doble pulsación de la tecla Windows y Alt + X para apagar pantalla...');
      const psCommand = 'powershell -Command "$sig = \'[DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);\'; $win = Add-Type -MemberDefinition $sig -Name \\"WinAPI1\\" -Namespace \\"Win32\\" -PassThru; $win::keybd_event(0x5B, 0, 0, 0); $win::keybd_event(0x5B, 0, 2, 0); Start-Sleep -Milliseconds 250; $win::keybd_event(0x5B, 0, 0, 0); $win::keybd_event(0x5B, 0, 2, 0); Start-Sleep -Milliseconds 200; $win::keybd_event(0x12, 0, 0, 0); $win::keybd_event(0x58, 0, 0, 0); $win::keybd_event(0x58, 2, 0); $win::keybd_event(0x12, 0, 2, 0);"';
      exec(psCommand, (error) => {
        if (error) {
          log(`Error al simular Alt+X: ${error.message}`);
        }
      });
      return res.status(200).json({
        status: 'ok',
        message: 'Comando de apagar pantalla (Alt+X) enviado.',
        msg: 'Pantalla apagada'
      });
    } else if (accion === 'encender-pantalla') {
      log('Deteniendo ScreenGuard si estuviese activo y simulando Control para encender pantalla...');
      exec(`"${screenGuardExe}" stop`, { timeout: 2000 }, (err) => {
        if (err) {
          log(`Aviso al detener ScreenGuard: ${err.message}`);
        }
      });

      const psCommand = 'powershell -Command "$sig = \'[DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);\'; $win = Add-Type -MemberDefinition $sig -Name \\"WinAPI2\\" -Namespace \\"Win32\\" -PassThru; $win::keybd_event(0xA2, 0, 0, 0); $win::keybd_event(0xA2, 0, 2, 0);"';
      exec(psCommand, (error) => {
        if (error) {
          log(`Error al simular Control: ${error.message}`);
        }
      });
      return res.status(200).json({
        status: 'ok',
        message: 'Comando de encender pantalla enviado y Guardián desactivado.',
        msg: 'Pantalla encendida'
      });
    } else if (accion === 'estado-guardia') {
      let active = false;
      let details = '';
      try {
        const statePath = path.join(__dirname, 'screenguard_state.json');
        if (fs.existsSync(statePath)) {
          const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          if (raw && raw.active && raw.pid) {
            try {
              process.kill(raw.pid, 0);
              active = true;
              details = raw.details || '';
            } catch (e) {}
          }
        }
      } catch (e) {}
      return res.status(200).json({ status: 'ok', active, details });
    }
  } catch (err) {
    log(`Error en simulación de teclado: ${err.message}`);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
});

// Endpoint POST /system/screenguard-toggle (and legacy /sistema/screenguard-toggle)
app.post(['/system/screenguard-toggle', '/sistema/screenguard-toggle'], (req, res) => {
  const screenGuardExe = path.join(__dirname, 'ScreenGuard.exe');
  let active = false;
  try {
    const statePath = path.join(__dirname, 'screenguard_state.json');
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && raw.active && raw.pid) {
        try {
          process.kill(raw.pid, 0);
          active = true;
        } catch (e) {}
      }
    }
  } catch (e) {}

  if (active) {
    log('Deteniendo ScreenGuard por toggle...');
    exec(`"${screenGuardExe}" stop`, { timeout: 2000 }, (err) => {
      if (err) log(`Aviso al detener ScreenGuard: ${err.message}`);
    });
    const psCommand = 'powershell -Command "$sig = \'[DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);\'; $win = Add-Type -MemberDefinition $sig -Name \\"WinAPI2\\" -Namespace \\"Win32\\" -PassThru; $win::keybd_event(0xA2, 0, 0, 0); $win::keybd_event(0xA2, 0, 2, 0);"';
    exec(psCommand, () => {});
    return res.status(200).json({ status: 'ok', active: false, message: 'ScreenGuard desactivado, pantalla encendida.', msg: 'Pantalla encendida' });
  } else {
    log('Iniciando ScreenGuard por toggle...');
    const child = spawn(screenGuardExe, ['start'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return res.status(200).json({ status: 'ok', active: true, message: 'ScreenGuard activado, pantalla protegida en standby.', msg: 'Guardián activado' });
  }
});

// Endpoint GET /system/brightness (and legacy /sistema/brillo) - Obtener brillo actual
app.get(['/system/brightness', '/sistema/brillo'], (req, res) => {
  exec('powershell -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness"', (error, stdout) => {
    if (error) {
      log(`Error al obtener brillo de pantalla: ${error.message}`);
      return res.status(500).json({ error: 'Error al obtener brillo', message: error.message });
    }
    const brillo = parseInt(stdout.trim());
    res.json({ status: 'ok', brightness: isNaN(brillo) ? null : brillo });
  });
});

// Endpoint POST /system/brightness (and legacy /sistema/brillo) - Modificar brillo
app.post(['/system/brightness', '/sistema/brillo'], (req, res) => {
  const brillo = req.body.brightness !== undefined ? req.body.brightness : req.body.brillo;
  if (brillo === undefined || brillo === null) {
    return res.status(400).json({ error: 'Bad Request', message: "Falta el parámetro 'brightness' ('brillo')." });
  }

  const level = Math.max(0, Math.min(100, Math.round(Number(brillo))));
  log(`Ajustando brillo de pantalla a: ${level}%`);

  const psCommand = `powershell -Command "(Get-WmiObject -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${level})"`;
  exec(psCommand, (error) => {
    if (error) {
      log(`Error al ajustar brillo: ${error.message}`);
      return res.status(500).json({ error: 'Error al ajustar brillo', message: error.message });
    }
    res.json({ status: 'ok', brightness: level, message: `Brillo ajustado a ${level}%` });
  });
});

// Endpoint POST /system/power (and legacy /sistema/energia) - Suspender y Bloquear PC
app.post(['/system/power', '/sistema/energia'], (req, res) => {
  let accion = req.body.action || req.body.accion;
  if (accion === 'lock') accion = 'bloquear';
  if (accion === 'sleep' || accion === 'suspend') accion = 'suspender';

  if (accion !== 'bloquear' && accion !== 'suspender') {
    return res.status(400).json({ error: 'Bad Request', message: "Power action must be 'lock' or 'sleep' ('bloquear' o 'suspender')." });
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

// Endpoint GET /system/clipboard (and legacy /sistema/portapapeles) - Leer portapapeles
app.get(['/system/clipboard', '/sistema/portapapeles'], (req, res) => {
  exec('cmd /c "chcp 65001 > nul && powershell.exe -Command Get-Clipboard"', { encoding: 'buffer' }, (error, stdout) => {
    if (error) {
      return res.status(500).json({ error: 'Error al obtener portapapeles', message: error.message });
    }
    const text = stdout.toString('utf8').trim();
    res.json({ text });
  });
});

// Endpoint POST /system/clipboard (and legacy /sistema/portapapeles) - Escribir portapapeles
app.post(['/system/clipboard', '/sistema/portapapeles'], (req, res) => {
  const text = req.body.text !== undefined ? req.body.text : req.body.texto;
  if (text === undefined) {
    return res.status(400).json({ error: 'Bad Request', message: "Falta el parámetro 'text' ('texto')." });
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

// Endpoint GET /system/screenshot (and legacy /sistema/screenshot) - Captura de pantalla
app.get(['/system/screenshot', '/sistema/screenshot'], (req, res) => {
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



// Endpoint POST /system/tts (and legacy /sistema/tts) - Text to Speech nativo en Windows
app.post(['/system/tts', '/sistema/tts'], (req, res) => {
  const texto = req.body.text !== undefined ? req.body.text : req.body.texto;
  if (!texto || String(texto).trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: "Falta el parámetro 'text' ('texto') a reproducir." });
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

// Endpoint POST /system/media (and legacy /sistema/media) - Controles multimedia nativos en Windows
app.post(['/system/media', '/sistema/media'], (req, res) => {
  let accion = req.body.action || req.body.accion;
  if (accion === 'play-pause' || accion === 'playpause' || accion === 'play_pause') accion = 'play-pausa';
  if (accion === 'previous') accion = 'prev';

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
    return res.status(400).json({ error: 'Bad Request', message: "Acción multimedia no reconocida. Valores válidos: 'playpause', 'next', 'prev', 'vol+', 'vol-', 'mute'." });
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



// Endpoint GET /system/ping (and legacy /sistema/ping, /gateway/ping) - Test de latencia
app.get(['/system/ping', '/sistema/ping', '/gateway/ping'], (req, res) => {
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

// Endpoint GET /browser/last-activity (and legacy /browser/ultima-actividad)
app.get(['/browser/last-activity', '/browser/ultima-actividad'], (req, res) => {
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
    msg: `Hace ${formatSecondsAgo(secondsAgo)}`
  });
});

// Endpoint POST /system/execute (and legacy /system/run, /sistema/ejecutar)
app.post(['/system/execute', '/system/run', '/sistema/ejecutar'], (req, res) => {
  let programa = req.body.program || req.body.programa;
  if (programa === 'emulator') programa = 'emulador';

  if (programa !== 'emulador') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "Unsupported program. Currently only 'emulator' ('emulador') is supported."
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

// Endpoint POST /system/mouse (and legacy /sistema/mouse) - Mover, clics y scroll
app.post(['/system/mouse', '/sistema/mouse'], (req, res) => {
  let action = req.body.action || req.body.accion;
  if (!action) {
    return res.status(400).json({ error: 'Bad Request', message: "Missing 'action' parameter." });
  }
  action = String(action).toLowerCase();

  if (action === 'move' || action === 'mover') {
    const dx = parseInt(req.body.dx || req.body.x || 0);
    const dy = parseInt(req.body.dy || req.body.y || 0);
    sendInputCommand(`m ${dx} ${dy}`);
    return res.json({ status: 'ok', action: 'move', dx, dy });
  }

  if (action === 'click' || action === 'clic') {
    let button = req.body.button || req.body.boton || 'left';
    if (button === 'izquierdo') button = 'left';
    if (button === 'derecho') button = 'right';
    if (button === 'medio') button = 'middle';
    sendInputCommand(`c ${button}`);
    return res.json({ status: 'ok', action: 'click', button });
  }

  if (action === 'double-click' || action === 'doble-clic' || action === 'doubleclick') {
    let button = req.body.button || req.body.boton || 'left';
    sendInputCommand(`dc ${button}`);
    return res.json({ status: 'ok', action: 'double-click', button });
  }

  if (action === 'down' || action === 'presionar' || action === 'hold') {
    let button = req.body.button || req.body.boton || 'left';
    if (button === 'izquierdo') button = 'left';
    if (button === 'derecho') button = 'right';
    sendInputCommand(`d ${button}`);
    return res.json({ status: 'ok', action: 'down', button });
  }

  if (action === 'up' || action === 'soltar' || action === 'release') {
    let button = req.body.button || req.body.boton || 'left';
    if (button === 'izquierdo') button = 'left';
    if (button === 'derecho') button = 'right';
    sendInputCommand(`u ${button}`);
    return res.json({ status: 'ok', action: 'up', button });
  }

  if (action === 'scroll' || action === 'rueda') {
    const deltaY = parseInt(req.body.deltaY || req.body.delta || req.body.dy || 0);
    sendInputCommand(`s ${deltaY}`);
    return res.json({ status: 'ok', action: 'scroll', deltaY });
  }

  return res.status(400).json({
    error: 'Bad Request',
    message: "Invalid action. Allowed: 'move', 'click', 'double-click', 'down', 'up', 'scroll'."
  });
});

// Endpoint POST /system/keyboard/type (and legacy /sistema/teclado/escribir, /sistema/escribir) - Escribir texto o pegar prompts
app.post(['/system/keyboard/type', '/system/type', '/sistema/teclado/escribir', '/sistema/escribir'], (req, res) => {
  const text = req.body.text !== undefined ? req.body.text : req.body.texto;
  if (text === undefined || text === null || String(text).length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: "Missing 'text' ('texto') parameter." });
  }
  const str = String(text);
  const usePaste = req.body.paste === true || req.body.mode === 'paste' || str.includes('\n') || str.includes('\r') || str.length > 50;

  if (usePaste) {
    const b64 = Buffer.from(str, 'utf8').toString('base64');
    sendInputCommand(`p ${b64}`);
    return res.json({ status: 'ok', message: 'Text pasted successfully via clipboard.', mode: 'paste', length: str.length });
  } else {
    const cleanText = str.replace(/[\r\n]+/g, ' ');
    sendInputCommand(`t ${cleanText}`);
    return res.json({ status: 'ok', message: 'Text typed successfully.', mode: 'type', text: cleanText });
  }
});

// Endpoint POST /system/keyboard/reset (and legacy /sistema/teclado/reset) - Liberar todas las teclas atascadas
app.post(['/system/keyboard/reset', '/system/reset-keys', '/sistema/teclado/reset'], (req, res) => {
  log('Solicitado reset forzado de teclas modificadoras (soltar Ctrl, Alt, Shift, Win)...');
  sendInputCommand('r');
  return res.json({ status: 'ok', message: 'All modifier keys and mouse buttons released successfully.' });
});

// Endpoint POST /system/keyboard/key (and legacy /sistema/teclado/tecla, /sistema/tecla) - Presionar teclas de PC y atajos
app.post(['/system/keyboard/key', '/system/key', '/sistema/teclado/tecla', '/sistema/tecla'], (req, res) => {
  const key = req.body.key !== undefined ? req.body.key : req.body.tecla;
  if (!key) {
    return res.status(400).json({ error: 'Bad Request', message: "Missing 'key' ('tecla') parameter." });
  }
  const count = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 50);
  for (let i = 0; i < count; i++) {
    sendInputCommand(`k ${key}`);
  }
  // Safety watchdog: auto-release all modifiers 350ms after any keystroke or combo
  setTimeout(() => {
    sendInputCommand('r');
  }, 350);
  return res.json({ status: 'ok', message: `Key ${key} injected successfully.`, key, count });
});

// Endpoint POST /system/close (and legacy /sistema/cerrar)
app.post(['/system/close', '/sistema/cerrar'], (req, res) => {
  let programa = req.body.program || req.body.programa;
  if (programa === 'emulator') programa = 'emulador';

  if (programa !== 'emulador') {
    return res.status(400).json({
      error: 'Bad Request',
      message: "Unsupported program. Currently only 'emulator' ('emulador') is supported."
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

// Endpoint POST /gateway/restart is handled above

// HTML para la Pantalla de Login Segura (Glassmorphism)
const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Required - Gateway Control Center</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0b0f19">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Gateway">
  <link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
  <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
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
        if (!sessionStorage.getItem('auto_login_failed')) {
          login(true);
        }
      }
    });

    async function login(isAutoLogin = false) {
      const key = document.getElementById('apiKeyInput').value.trim();
      const errorDiv = document.getElementById('errorMsg');
      
      if (!key) {
        errorDiv.innerText = 'Por favor, ingresa una clave.';
        errorDiv.style.display = 'block';
        return;
      }

      errorDiv.style.display = 'none';

      try {
        const response = await fetch('/gateway/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });

        if (response.ok) {
          document.cookie = "api_key=" + encodeURIComponent(key) + "; path=/; max-age=" + (365*24*60*60) + "; SameSite=Lax; Secure";
          localStorage.setItem('X-API-KEY', key);
          sessionStorage.removeItem('auto_login_failed');
          window.location.href = '/';
        } else {
          if (isAutoLogin) {
            sessionStorage.setItem('auto_login_failed', 'true');
          }
          errorDiv.innerText = 'Clave API incorrecta o rechazada por el servidor.';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        if (isAutoLogin) {
          sessionStorage.setItem('auto_login_failed', 'true');
        }
        errorDiv.innerText = 'Error al comunicar con el servidor.';
        errorDiv.style.display = 'block';
      }
    }

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function() {});
      });
    }
  </script>
</body>
</html>
`;

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gateway Control Center</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0b0f19">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Gateway">
  <link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
  <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>

    .chip-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 0.72rem;
      padding: 3px 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .chip-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.2);
    }
    .combo-mod-btn {
      transition: all 0.15s ease;
    }
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

    .card.is-collapsed .card-header {
      margin-bottom: 0;
    }

    .card.is-collapsed .card-collapsible-body {
      display: none;
    }

    .card-header-clickable {
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      border-radius: 12px;
    }

    .collapse-chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: transform 0.25s ease, background 0.2s, color 0.2s;
      flex-shrink: 0;
      color: var(--text-muted);
    }

    .card-header-clickable:hover .collapse-chevron {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text);
    }

    .card:not(.is-collapsed) .collapse-chevron {
      transform: rotate(180deg);
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

    .number-input {
      width: 100%;
      padding: 10px 14px;
      font-size: 0.85rem;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      color: var(--text);
      outline: none;
      transition: all 0.3s ease;
      box-sizing: border-box;
    }

    .number-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
      background: rgba(255, 255, 255, 0.05);
    }

    .number-input::-webkit-outer-spin-button,
    .number-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .number-input[type=number] {
      -moz-appearance: textfield;
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
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      z-index: 9999;
      pointer-events: none;
      width: calc(100% - 32px);
      max-width: 420px;
    }

    .toast {
      pointer-events: auto;
      background: rgba(18, 22, 34, 0.95);
      border-left: 4px solid var(--primary);
      border-top: 1px solid var(--card-border);
      border-bottom: 1px solid var(--card-border);
      border-right: 1px solid var(--card-border);
      padding: 12px 18px;
      border-radius: 10px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      box-sizing: border-box;
      animation: slideInDown 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font-size: 0.88rem;
      color: #f3f4f6;
      user-select: none;
      cursor: pointer;
    }

    .toast.success { border-left-color: var(--success); }
    .toast.error { border-left-color: var(--danger); }
    .toast.warning { border-left-color: #f59e0b; }
    .toast.info { border-left-color: var(--primary); }

    @keyframes pulse {
      from { box-shadow: 0 0 4px rgba(16, 185, 129, 0.3); }
      to { box-shadow: 0 0 12px rgba(16, 185, 129, 0.7); }
    }

    @keyframes slideInDown {
      from { transform: translateY(-120%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    @keyframes slideOutUp {
      from { transform: translateY(0); opacity: 1; }
      to { transform: translateY(-120%); opacity: 0; }
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

    /* Modal Pausa Temporal */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 3000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: fadeInModal 0.2s ease forwards;
    }

    .modal-card {
      background: rgba(21, 23, 34, 0.95);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 26px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      animation: scaleUpModal 0.2s ease forwards;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .modal-header h3 {
      font-size: 1.2rem;
      font-weight: 700;
      color: #f59e0b;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .modal-close-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.5rem;
      cursor: pointer;
      line-height: 1;
      transition: color 0.2s ease;
    }

    .modal-close-btn:hover {
      color: var(--text);
    }

    .btn-preset {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 0;
      border-radius: 10px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
    }

    .btn-preset:hover, .btn-preset.active {
      background: rgba(245, 158, 11, 0.2);
      border-color: #f59e0b;
      color: #f59e0b;
    }

    .status-badge.warning {
      color: #f59e0b;
      border-color: rgba(245, 158, 11, 0.3);
      background: rgba(245, 158, 11, 0.1);
    }

    .status-badge.warning .dot {
      background: #f59e0b;
      box-shadow: 0 0 8px #f59e0b;
      animation: pulseWarning 1.5s infinite alternate;
    }

    @keyframes pulseWarning {
      from { box-shadow: 0 0 4px rgba(245, 158, 11, 0.3); }
      to { shadow: 0 0 12px rgba(245, 158, 11, 0.8); }
    }

    @keyframes fadeInModal {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes scaleUpModal {
      from { transform: scale(0.92); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    /* Header Edit Button */
    .btn-icon.active {
      background: rgba(99, 102, 241, 0.25);
      border-color: var(--primary);
      color: #818cf8;
    }

    /* Edit Mode Banner */
    .edit-mode-banner {
      display: none;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.18), rgba(124, 58, 237, 0.18));
      border: 1px solid rgba(99, 102, 241, 0.4);
      border-radius: 16px;
      padding: 12px 18px;
      margin-bottom: 15px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      animation: fadeInModal 0.2s ease forwards;
      backdrop-filter: blur(10px);
    }
    .edit-mode-banner.active {
      display: flex;
    }
    .edit-banner-info {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 0.85rem;
      color: var(--text);
    }
    .edit-banner-info svg {
      color: #818cf8;
      flex-shrink: 0;
    }
    .edit-banner-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-sm {
      padding: 6px 12px !important;
      font-size: 0.75rem !important;
      border-radius: 8px !important;
      margin-top: 0 !important;
      cursor: pointer;
    }
    .btn-outline {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
    }
    .btn-outline:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text);
    }

    /* Card Edit Toolbar */
    .card-edit-bar {
      display: none;
      align-items: center;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 6px 10px;
      margin-bottom: 12px;
      gap: 8px;
    }
    body.is-edit-mode .card-edit-bar {
      display: flex;
    }
    .card-edit-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .card-drag-handle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      color: #cbd5e1;
      cursor: grab;
      user-select: none;
      touch-action: none;
      transition: all 0.2s ease;
    }
    .card-drag-handle:hover {
      background: rgba(99, 102, 241, 0.2);
      border-color: rgba(99, 102, 241, 0.4);
      color: #818cf8;
    }
    .card-drag-handle:active {
      cursor: grabbing;
      background: rgba(99, 102, 241, 0.3);
    }
    .card-edit-arrows {
      display: flex;
      gap: 4px;
    }
    .btn-arrow {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: var(--text-muted);
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0;
      transition: all 0.2s;
    }
    .btn-arrow:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }
    .btn-toggle-vis {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid transparent;
    }
    .btn-toggle-vis.is-visible {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.3);
      color: #34d399;
    }
    .btn-toggle-vis.is-visible:hover {
      background: rgba(16, 185, 129, 0.2);
    }
    .btn-toggle-vis.is-hidden {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }
    .btn-toggle-vis.is-hidden:hover {
      background: rgba(239, 68, 68, 0.2);
    }

    /* Ocultar sección */
    .card.is-hidden-card {
      display: none !important;
    }
    body.is-edit-mode .card.is-hidden-card {
      display: block !important;
      opacity: 0.45;
      border: 1px dashed rgba(239, 68, 68, 0.45) !important;
      background: rgba(239, 68, 68, 0.03) !important;
    }
    body.is-edit-mode .card.is-hidden-card:hover {
      opacity: 0.8;
    }

    /* Animación y Feedback de Drag */
    .card.is-dragging {
      opacity: 0.3 !important;
      transform: scale(0.98);
      border: 2px dashed var(--primary) !important;
    }

    /* Sub-secciones individuales */
    .sub-section {
      position: relative;
      transition: all 0.2s ease;
    }
    .sub-section.is-hidden-sub {
      display: none !important;
    }
    body.is-edit-mode .sub-section.is-hidden-sub {
      display: block !important;
      opacity: 0.45;
      border: 1px dashed rgba(239, 68, 68, 0.45) !important;
      border-radius: 12px;
      padding: 10px;
      margin: 8px 0;
      background: rgba(239, 68, 68, 0.03) !important;
    }
    body.is-edit-mode .sub-section.is-hidden-sub:hover {
      opacity: 0.8;
    }
    .sub-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin-bottom: 6px;
    }
    .btn-sub-vis {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.68rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s;
      margin-left: auto;
    }
    body.is-edit-mode .btn-sub-vis {
      display: inline-flex;
    }
    .btn-sub-vis.is-visible {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.3);
      color: #34d399;
    }
    .btn-sub-vis.is-visible:hover {
      background: rgba(16, 185, 129, 0.2);
    }
    .btn-sub-vis.is-hidden {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }
    .btn-sub-vis.is-hidden:hover {
      background: rgba(239, 68, 68, 0.2);
    }
    .secret-hidden {
      display: none !important;
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-container" id="logoContainer" onclick="handleSecretHeaderClick()" style="cursor: pointer; user-select: none;" title="Gateway Control Center">
      <h1>Gateway Control Center</h1>
      <p data-i18n="appDesc">API Gateway & Automation Server</p>
    </div>
    <div class="header-buttons">
      <button class="btn btn-sm btn-outline" id="btnInstallPwa" onclick="triggerPwaInstall()" style="display: none; font-weight: 600; padding: 4px 10px; border-radius: 8px; font-size: 0.8rem; margin-right: 6px; letter-spacing: 0.5px; border-color: var(--primary); color: var(--text);" title="Instalar WebApp en el celular">
        📲 <span data-i18n="installApp">Install App</span>
      </button>
      <button class="btn btn-sm btn-outline" id="btnLangToggle" onclick="toggleLanguage()" style="font-weight: 600; padding: 4px 10px; border-radius: 8px; font-size: 0.8rem; margin-right: 6px; letter-spacing: 0.5px;" title="Switch Language (English / Español)">
        🌐 EN
      </button>
      <button class="btn-icon" id="btnToggleEditMode" onclick="toggleEditMode()" title="Edit and rearrange sections">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
      <button class="btn-icon" onclick="logout()" title="Cerrar Sesión">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
      </button>
    </div>
  </header>

  <main>
    <!-- BANNER MODO EDICIÓN -->
    <div id="editModeBanner" class="edit-mode-banner">
      <div class="edit-banner-info">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>
        <span data-i18n="editModeBanner"><strong>Edit Mode:</strong> Drag ⠿ to reorder or use 👁️ to hide/show.</span>
      </div>
      <div class="edit-banner-actions">
        <button class="btn btn-sm btn-outline" onclick="resetDashboardLayout()" data-i18n="btnReset">Reset</button>
        <button class="btn btn-sm btn-primary" onclick="toggleEditMode()" data-i18n="btnDone">Done</button>
      </div>
    </div>
    <!-- CARD 1: NAVEGADOR ACTIVO -->
    <div class="card secret-hidden" id="cardBrowser">
      <div class="card-header">
        <div class="card-title-group">
          <h2 data-i18n="browserCardTitle">Active Browser Keepalive</h2>
          <p data-i18n="browserCardDesc">Persistent session and display sleep prevention</p>
        </div>
        <div class="status-badge-container">
          <div class="status-badge" id="browserBadge">
            <div class="dot"></div>
            <span id="browserBadgeText" data-i18n="browserClosedBadge">Browser: Closed</span>
          </div>
          <div class="status-badge" id="presenciaBadge">
            <div class="dot"></div>
            <span id="presenciaBadgeText" data-i18n="keepaliveOffBadge">Keepalive: Off</span>
          </div>
        </div>
      </div>

      <!-- SECCIÓN 1.A: NAVEGADOR -->
      <div class="sub-section" id="sub_browser_window" data-sub-title="Ventana del Navegador">
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subBrowserWindow">Browser Window</div>
        </div>
        <div class="btn-row" style="margin-top: 8px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 8px;">
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
      </div>

      <!-- SECCIÓN 1.B: AUTOMATIZACIÓN DE ACTIVIDAD -->
      <div class="sub-section" id="sub_browser_presencia" data-sub-title="Mantener Sesión Activa">
        <div class="divider"></div>
        <div class="sub-section-header" style="margin-bottom: 5px;">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subKeepalive">Keep Active Session</div>
          <div id="lastActivityLabel" style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500; letter-spacing: 0.3px;">Última: Sin actividad</div>
        </div>
        
        <div class="form-group">
          <div class="form-label-row">
            <span data-i18n="activityIntervalLabel">Activity Interval (minutes)</span>
            <span id="browserIntervalVal">4 minutos</span>
          </div>
          <input type="number" class="number-input" id="browserIntervalInput" min="1" max="9999" step="1" value="4" onchange="cambiarIntervaloEnCaliente(this.value)">
        </div>

        <div class="btn-row" style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-success" id="btnPresenciaPlay" onclick="controlPresencia('iniciar')" style="flex: 1 1 calc(33% - 6px); min-width: 100px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            Iniciar
          </button>
          <button class="btn" id="btnPresenciaPausaTemporal" onclick="abrirModalPausaTemporal()" style="flex: 1 1 calc(33% - 6px); min-width: 110px; background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.4); color: #f59e0b;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            Pausa Temp
          </button>
          <button class="btn" id="btnPresenciaPause" onclick="controlPresencia('pausar')" style="flex: 1 1 calc(33% - 6px); min-width: 100px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
            Pausar
          </button>
        </div>

        <div id="pausaTemporalStatusBanner" style="display: none; margin-top: 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 12px; padding: 10px 14px; font-size: 0.8rem; color: #fbbf24; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <span data-i18n="tempPauseActiveText">Scheduled temporary pause:</span> <span> <strong id="pausaTemporalCountdownText">20m 00s</strong></span>
          </div>
          <button onclick="controlPresencia('iniciar')" style="background: rgba(245, 158, 11, 0.25); border: 1px solid #f59e0b; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; cursor: pointer;" data-i18n="btnResumeNow">Resume Now</button>
        </div>
      </div>

      <!-- SECCIÓN 1.C: PLANIFICACIÓN Y CONTROL HORARIO -->
      <div class="sub-section" id="sub_browser_schedule" data-sub-title="Programación Horaria">
        <div class="divider"></div>
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subSchedule">Scheduled Hours</div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 8px;">
          <div style="display: flex; gap: 10px; width: 100%;">
            <div style="flex: 1;">
              <label style="font-size: 0.75rem; color: var(--text-muted);" data-i18n="lblStartHour">Start Activity</label>
              <input type="time" id="browserStartHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 0.75rem; color: var(--text-muted);" data-i18n="lblEndHour">End Activity</label>
              <input type="time" id="browserEndHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
            </div>
          </div>

          <div>
            <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 6px;" data-i18n="lblAllowedDays">Allowed Days</label>
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
      </div>

      <!-- SUB 1.D: AUTO-CIERRE DEL NAVEGADOR -->
      <div class="sub-section" id="sub_browser_autoclose" data-sub-title="Auto-Cierre del Navegador">
        <div style="border-top: 1px dashed rgba(255,255,255,0.15); margin: 20px 0 15px 0;"></div>
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subAutoClose">Browser Auto-Close</div>
        </div>
        <div style="display: flex; gap: 10px; width: 100%; align-items: center; margin-top: 8px;">
          <div style="flex: 1.2;">
            <label style="font-size: 0.75rem; color: var(--text-muted);" data-i18n="lblCloseHour">Close Hour</label>
            <input type="time" id="browserCloseHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
          </div>
          <div style="flex: 0.8; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; margin-top: 14px;">
            <div class="switch-container" style="margin-top: 0; justify-content: flex-end; gap: 10px;">
              <span style="font-size: 0.85rem; color: var(--text-muted);" data-i18n="lblAutoClose">Auto-Close</span>
              <label class="switch">
                <input type="checkbox" id="browserCloseEnabled" onchange="updateSchedule()">
                <span class="slider-toggle"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- SUB 1.E: CIERRE FLEX -->
      <div class="sub-section" id="sub_browser_flexclose" data-sub-title="Cierre Flex">
        <div style="border-top: 1px dashed rgba(255,255,255,0.15); margin: 20px 0 15px 0;"></div>
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subFlexClose">Flex Close</div>
        </div>
        <div style="display: flex; gap: 10px; width: 100%; align-items: center; flex-wrap: wrap; margin-top: 8px;">
          <div style="flex: 1; min-width: 120px;">
            <label style="font-size: 0.75rem; color: var(--text-muted);" data-i18n="lblDate">Date</label>
            <input type="date" id="browserFlexCloseDate" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
          </div>
          <div style="flex: 1; min-width: 100px;">
            <label style="font-size: 0.75rem; color: var(--text-muted);" data-i18n="lblCloseHour">Close Hour</label>
            <input type="time" id="browserFlexCloseHour" style="width: 100%; padding: 8px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 4px;" onchange="updateSchedule()">
          </div>
          <div style="flex: 0.8; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; margin-top: 14px; min-width: 120px;">
            <div class="switch-container" style="margin-top: 0; justify-content: flex-end; gap: 10px;">
              <span style="font-size: 0.85rem; color: var(--text-muted);">Cierre Flex</span>
              <label class="switch">
                <input type="checkbox" id="browserFlexCloseEnabled" onchange="updateSchedule()">
                <span class="slider-toggle"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- SECCIÓN 1.F: PRUEBAS MANUALES EN CALIENTE -->
      <div class="sub-section" id="sub_browser_manualtests" data-sub-title="Pruebas de Entrada">
        <div class="divider"></div>
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subInputTests">Input Tests (Instant Actions)</div>
        </div>
        <div class="btn-row" style="gap: 8px; margin-top: 10px;">
          <button class="btn" id="btnTestMouse" onclick="enviarAccionPrueba('mover-mouse')" style="padding: 8px; font-size: 0.75rem;">
            Mover Cursor
          </button>
          <button class="btn" id="btnTestTipeo" onclick="enviarAccionPrueba('tipear-buscador')" style="padding: 8px; font-size: 0.75rem;">
            Probar Enfoque
          </button>
          <button class="btn" id="btnTestShift" onclick="enviarAccionPrueba('press-shift')" style="padding: 8px; font-size: 0.75rem;" data-i18n="btnPressShift">
            Press Shift
          </button>
        </div>
      </div>
    </div>


    <!-- CARD: VIRTUAL TRACKPAD & MOUSE -->
    <div class="card is-collapsed" id="cardMousePad">
      <div class="card-header card-header-clickable" onclick="toggleCardCollapse('cardMousePad', event)">
        <div class="card-title-group">
          <h2 data-i18n="trackpadTitle">Virtual Trackpad & Mouse</h2>
          <p data-i18n="trackpadDesc">Touchpad navigation, gestures, drag lock, and clicking</p>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); enterTrackpadFullscreen()" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;" data-i18n="btnFullscreen">
            ⛶ Fullscreen
          </button>
          <span style="font-size: 0.72rem; color: var(--text-muted);" data-i18n="trackpadSpeed">Speed:</span>
          <span id="trackpadSpeedLabel" style="font-size: 0.75rem; font-weight: 600; color: var(--accent-primary);">1.2x</span>
          <div class="collapse-chevron" title="Colapsar / Expandir">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
      </div>

      <div class="card-collapsible-body">
        <!-- TRACKPAD TOUCH SURFACE -->
        <div style="position: relative; width: 100%; height: 260px; background: rgba(15, 23, 42, 0.6); border: 1.5px solid rgba(255, 255, 255, 0.1); border-radius: 14px; overflow: hidden; margin-bottom: 12px; touch-action: none; user-select: none;" id="touchpadSurface">
          <div style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; opacity: 0.35;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span style="font-size: 0.8rem; font-weight: 500; text-align: center; max-width: 80%; line-height: 1.4;" data-i18n="touchpadHint">Slide 1 finger to move • Tap for Left Click • Double-tap for 2x • 2 fingers for Right Click</span>
          </div>
          <!-- RIGHT EDGE SCROLL STRIP -->
          <div id="touchpadScrollStrip" style="position: absolute; right: 0; top: 0; bottom: 0; width: 44px; background: rgba(255, 255, 255, 0.03); border-left: 1px dashed rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; align-items: center; justify-content: center; touch-action: none;">
            <span style="font-size: 0.68rem; color: var(--text-muted); writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 2px;" data-i18n="scrollStrip">SCROLL</span>
          </div>
        </div>

        <!-- MOUSE BUTTONS -->
        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
          <button class="btn btn-outline" id="btnMouseLeft" onclick="sendMouseClick('left')" style="flex: 1; padding: 12px 6px; font-weight: 600; font-size: 0.82rem;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 5px; vertical-align: text-bottom;"><path d="M12 2a5 5 0 0 0-5 5v10a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5z"/><line x1="12" y1="2" x2="12" y2="8"/></svg>
            <span data-i18n="btnLeftClick">Left Click</span>
          </button>
          <button class="btn btn-outline" id="btnMouseMiddle" onclick="sendMouseClick('middle')" style="flex: 0 0 46px; padding: 12px 0;" title="Middle Click">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto;"><circle cx="12" cy="7" r="1.5"/><rect x="5" y="2" width="14" height="20" rx="7"/></svg>
          </button>
          <button class="btn btn-outline" id="btnMouseRight" onclick="sendMouseClick('right')" style="flex: 1; padding: 12px 6px; font-weight: 600; font-size: 0.82rem;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 5px; vertical-align: text-bottom;"><path d="M12 2a5 5 0 0 0-5 5v10a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5z"/><line x1="12" y1="2" x2="12" y2="8"/></svg>
            <span data-i18n="btnRightClick">Right Click</span>
          </button>
        </div>

        <!-- DRAG LOCK & DOUBLE CLICK ROW -->
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <button class="btn btn-outline" id="btnDragLock" onclick="toggleDragLock()" style="flex: 1; padding: 10px; font-size: 0.8rem; font-weight: 600;">
            <span id="dragLockIcon">🔓</span> <span id="dragLockText" data-i18n="dragLock">Drag Lock (Hold Down)</span>
          </button>
          <button class="btn btn-outline" onclick="sendMouseDoubleClick()" style="flex: 1; padding: 10px; font-size: 0.8rem; font-weight: 600;" data-i18n="doubleClick">
            Double Click
          </button>
        </div>

        <!-- SENSITIVITY SLIDER -->
        <div style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(255, 255, 255, 0.03); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.06);">
          <span style="font-size: 0.75rem; color: var(--text-muted); min-width: 70px;" data-i18n="sensitivity">Sensitivity:</span>
          <input type="range" id="sliderSensitivity" min="0.4" max="2.5" step="0.1" value="1.2" oninput="changeTrackpadSensitivity(this.value)" style="flex: 1; accent-color: var(--accent-primary);">
        </div>
      </div>
    </div>

    <!-- CARD: REMOTE KEYBOARD & KEYSTROKES -->
    <div class="card is-collapsed" id="cardTeclado">
      <div class="card-header card-header-clickable" onclick="toggleCardCollapse('cardTeclado', event)">
        <div class="card-title-group">
          <h2 data-i18n="keyboardTitle">Remote Keyboard & Keystrokes</h2>
          <p data-i18n="keyboardDesc">Type phone text at PC cursor and send computer keys</p>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="collapse-chevron" title="Colapsar / Expandir">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
      </div>

      <div class="card-collapsible-body">
        <!-- TEXT INPUT BAR -->
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="text" id="inputRemoteText" placeholder="Type or dictate text to send to PC..." data-i18n="typePlaceholder" onkeydown="handleRemoteTextKeyDown(event)" style="flex: 1; padding: 11px 14px; font-size: 0.88rem; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; color: #fff; outline: none;">
          <button class="btn btn-primary" onclick="sendRemoteText()" style="padding: 11px 16px; font-weight: 600;" data-i18n="btnSendText">
            Send
          </button>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; padding: 0 4px;">
          <label style="font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="chkSendOnEnter" checked style="accent-color: var(--accent-primary);">
            <span data-i18n="sendOnEnter">Send on Enter</span>
          </label>
          <label style="font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="chkClearOnSend" checked style="accent-color: var(--accent-primary);">
            <span data-i18n="clearOnSend">Clear after send</span>
          </label>
        </div>

        <!-- CUSTOM COMBINATIONS BUILDER -->
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 12px; margin-bottom: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; flex-wrap: wrap; gap: 6px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 0.78rem; font-weight: 600; color: var(--text);" data-i18n="customComboTitle">Custom Key Combinations</span>
              <span id="modifierTimerBadge" style="display: none; font-size: 0.68rem; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); align-items: center; gap: 4px;">⏱️ 8s</span>
            </div>
            <button type="button" class="btn btn-outline btn-sm" onclick="resetStuckKeys()" style="font-size: 0.7rem; padding: 3px 8px; color: #f59e0b; border-color: rgba(245, 158, 11, 0.35);" title="Soltar Ctrl, Alt, Shift si quedaron presionadas" data-i18n="btnUnstickKeys">🔓 Unstick Keys</button>
          </div>

          <!-- MODIFIERS SELECTOR -->
          <div style="display: flex; gap: 6px; margin-bottom: 10px; margin-top: 8px;">
            <button type="button" class="btn btn-outline btn-sm combo-mod-btn" id="modCtrl" onclick="toggleModifier('ctrl')" style="flex: 1; min-width: 50px; font-weight: 600;">Ctrl</button>
            <button type="button" class="btn btn-outline btn-sm combo-mod-btn" id="modAlt" onclick="toggleModifier('alt')" style="flex: 1; min-width: 50px; font-weight: 600;">Alt</button>
            <button type="button" class="btn btn-outline btn-sm combo-mod-btn" id="modShift" onclick="toggleModifier('shift')" style="flex: 1; min-width: 50px; font-weight: 600;">Shift</button>
            <button type="button" class="btn btn-outline btn-sm combo-mod-btn" id="modWin" onclick="toggleModifier('win')" style="flex: 1; min-width: 50px; font-weight: 600;">Win</button>
          </div>

          <!-- KEY INPUT + SEND -->
          <div style="display: flex; gap: 8px; margin-bottom: 8px;">
            <input type="text" id="inputCustomKey" placeholder="Key (e.g. Esc, Tab, F4, D, W, Enter)..." data-i18n="comboKeyPlaceholder" onkeydown="if(event.key==='Enter') sendCustomCombination()" style="flex: 1; padding: 10px 12px; font-size: 0.84rem; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; color: #fff; outline: none;">
            <button class="btn btn-primary btn-sm" onclick="sendCustomCombination()" style="padding: 10px 14px; font-weight: 600; font-size: 0.82rem;" data-i18n="btnSendCombo">
              🚀 Send Combo
            </button>
          </div>

          <!-- QUICK CHIPS -->
          <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center;">
            <span style="font-size: 0.7rem; color: var(--text-muted); margin-right: 4px;" data-i18n="comboPresets">Suggestions:</span>
            <button type="button" class="chip-btn" onclick="setCustomKey('Esc')">Esc</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('Tab')">Tab</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('Enter')">Enter</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('F4')">F4</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('D')">D</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('R')">R</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('E')">E</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('W')">W</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('T')">T</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('L')">L</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('V')">V</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('Delete')">Del</button>
            <button type="button" class="chip-btn" onclick="setCustomKey('Space')">Space</button>
          </div>

          <!-- POPULAR PRESETS -->
          <div style="border-top: 1px dashed rgba(255, 255, 255, 0.08); margin-top: 10px; padding-top: 8px; display: flex; gap: 5px; flex-wrap: wrap;">
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('ctrl+shift+esc')" style="font-size: 0.72rem; padding: 5px 8px;">Ctrl+Shift+Esc</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('alt+f4')" style="font-size: 0.72rem; padding: 5px 8px;">Alt+F4</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('win+d')" style="font-size: 0.72rem; padding: 5px 8px;">Win+D</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('win+r')" style="font-size: 0.72rem; padding: 5px 8px;">Win+R</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('win+e')" style="font-size: 0.72rem; padding: 5px 8px;">Win+E</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('win+l')" style="font-size: 0.72rem; padding: 5px 8px;">Win+L</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('win+v')" style="font-size: 0.72rem; padding: 5px 8px;">Win+V</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('ctrl+w')" style="font-size: 0.72rem; padding: 5px 8px;">Ctrl+W</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('ctrl+t')" style="font-size: 0.72rem; padding: 5px 8px;">Ctrl+T</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="sendKey('ctrl+r')" style="font-size: 0.72rem; padding: 5px 8px;">Ctrl+R</button>
          </div>
        </div>
        <!-- COMMON COMPUTER KEYS -->
        <div style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="specialKeys">
          Special Computer Keys
        </div>

        <!-- ROW 1: CORE KEYS -->
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 6px;">
          <button class="btn btn-outline btn-sm" onclick="sendKey('Escape')">Esc</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('Tab')">Tab</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('Win')">⊞ Win</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('Backspace')" title="Backspace">⌫ Del</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('Enter')" style="font-weight: 700; color: var(--accent-primary);">↵ Enter</button>
        </div>

        <!-- ROW 2: SHORTCUTS -->
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 6px;">
          <button class="btn btn-outline btn-sm" onclick="sendKey('ctrl+c')">Ctrl+C</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('ctrl+v')">Ctrl+V</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('ctrl+z')">Ctrl+Z</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('ctrl+a')">Ctrl+A</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('alt+tab')">Alt+Tab</button>
        </div>

        <!-- ROW 3: NAVIGATION & EDIT -->
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 8px;">
          <button class="btn btn-outline btn-sm" onclick="sendKey('Delete')">Supr</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('Home')">Home</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('End')">End</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('PageUp')">PgUp</button>
          <button class="btn btn-outline btn-sm" onclick="sendKey('PageDown')">PgDn</button>
        </div>

        <!-- ROW 4: ARROWS -->
        <div style="display: flex; justify-content: center; gap: 6px; margin-bottom: 10px;">
          <button class="btn btn-outline btn-sm" onclick="sendKey('ArrowLeft')" style="width: 52px; font-size: 1rem;">◄</button>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <button class="btn btn-outline btn-sm" onclick="sendKey('ArrowUp')" style="width: 52px; font-size: 1rem;">▲</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('ArrowDown')" style="width: 52px; font-size: 1rem;">▼</button>
          </div>
          <button class="btn btn-outline btn-sm" onclick="sendKey('ArrowRight')" style="width: 52px; font-size: 1rem;">►</button>
        </div>

        <!-- EXPANDABLE F1-F12 SECTION -->
        <details style="background: rgba(255, 255, 255, 0.02); border-radius: 8px; padding: 6px 10px; border: 1px solid rgba(255, 255, 255, 0.05);">
          <summary style="font-size: 0.72rem; color: var(--text-muted); cursor: pointer; user-select: none;" data-i18n="fnKeysSummary">Function Keys (F1 - F12)</summary>
          <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; margin-top: 8px;">
            <button class="btn btn-outline btn-sm" onclick="sendKey('F1')">F1</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F2')">F2</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F3')">F3</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F4')">F4</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F5')">F5</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F6')">F6</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F7')">F7</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F8')">F8</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F9')">F9</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F10')">F10</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F11')">F11</button>
            <button class="btn btn-outline btn-sm" onclick="sendKey('F12')">F12</button>
          </div>
        </details>
      </div>
    </div>

    <!-- CARD 2: ACCIONES DE SISTEMA -->
    <div class="card" id="cardSistema">
      <div class="card-header">
        <div class="card-title-group">
          <h2 data-i18n="systemCardTitle">System & Diagnostics</h2>
          <p data-i18n="systemCardDesc">ScreenGuard, clipboard, screenshots, and native tools</p>
        </div>
      </div>

      <!-- SUB 2.A: EMULADOR -->
      <div class="sub-section" id="sub_emulador" data-sub-title="Emulador Android">
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="subEmulator">Android Emulator</div>
        </div>
        <div class="form-group" style="margin-bottom: 10px; margin-top: 6px;">
          <p style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
            <span data-i18n="emulatorDesc">Launch or stop the Android emulator configured in .env from your phone.</span>
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
      </div>

      <!-- SUB 2.B: CONTROL DE PANTALLA -->
      <div class="sub-section" id="sub_pantalla" data-sub-title="Control de Pantalla">
        <div class="divider"></div>
        <div class="sub-section-header" style="display: flex; align-items: center; justify-content: space-between;">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="displayControlSub">Display Control (Physical PC)</div>
          <span class="status-badge" id="screenGuardBadge" style="font-size: 0.72rem; padding: 2px 8px;">
            <span class="status-dot"></span> <span id="screenGuardBadgeText" data-i18n="screenGuardInactiveBadge">Guard Inactive</span>
          </span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px; width: 100%;">
          <div style="display: flex; gap: 8px; width: 100%;">
            <button class="btn" id="btnGuardiaToggle" style="flex: 1.2; margin-top: 0; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.4); color: rgb(216, 180, 254); display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="toggleGuardia()" title="Apaga la pantalla física y la mantiene apagada ante notificaciones o ScreenConnect. Despierta con teclado/mouse físico o tocando este botón.">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              <span id="btnGuardiaToggleText" data-i18n="btnGuardToggleOn">Turn Off (Guard)</span>
            </button>
            <button class="btn btn-success" style="flex: 1; margin-top: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="controlarTeclado('encender-pantalla')" title="Enciende la pantalla y desactiva el guardián">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
              Encender (Ctrl)
            </button>
          </div>
          <div style="display: flex; gap: 8px; width: 100%;">
            <button class="btn btn-danger" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.25); color: rgb(248, 113, 113); display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 0.78rem; padding: 7px 10px;" onclick="controlarTeclado('apagar-pantalla')" title="Apagado tradicional mediante combinación Alt+X">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>
              Apagar Tradicional (Alt+X)
            </button>
          </div>
        </div>
      </div>

      <!-- SUB 2.C: PORTAPAPELES -->
      <div class="sub-section" id="sub_portapapeles" data-sub-title="Portapapeles de la PC">
        <div class="divider"></div>
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="clipboardSub">PC Clipboard</div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 5px;">
          <input type="text" id="inputPortapapeles" placeholder="Text to send to Windows clipboard..." data-i18n="clipPlaceholder" style="flex: 2; padding: 10px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 0;">
          <button class="btn" onclick="enviarPortapapeles()" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.75rem;">
            Copiar a PC
          </button>
          <button class="btn" onclick="obtenerPortapapeles()" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.75rem;">
            Leer de PC
          </button>
        </div>
      </div>

      <!-- SUB 2.D: CAPTURA & LATENCIA -->
      <div class="sub-section" id="sub_captura" data-sub-title="Captura de Pantalla & Latencia">
        <div class="divider"></div>
        <div class="sub-section-header">
          <div class="card-section-title" style="margin-bottom: 0;" data-i18n="screenshotSub">Screenshot & Latency</div>
        </div>
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
    </div>

    <!-- CARD 3: REINICIAR GATEWAY -->
    <div class="card" id="cardReiniciar" style="margin-top: 10px; border-color: rgba(239, 68, 68, 0.15);">
      <div class="card-header" style="margin-bottom: 0; display: flex; align-items: center; justify-content: space-between;">
        <div class="card-title-group" style="flex: 1;">
          <h2 data-i18n="restartCardTitle">Gateway Server</h2>
          <p data-i18n="restartCardDesc">Restart gateway and reconnect tunnel</p>
        </div>
        <button class="btn btn-danger" onclick="confirmarReinicio()" style="padding: 10px 16px; font-size: 0.85rem; flex: 0 0 auto; width: auto; margin-top: 0; display: inline-flex; align-items: center; gap: 4px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Reiniciar
        </button>
      </div>
    </div>

    <!-- CARD 5: AUDIO, MULTIMEDIA, BRILLO & VOZ -->
    <div class="card is-collapsed" id="cardMultimedia" style="margin-top: 10px;">
      <div class="card-header card-header-clickable" onclick="toggleCardCollapse('cardMultimedia', event)">
        <div class="card-title-group">
          <h2 data-i18n="mediaCardTitle">Media & Audio Controls</h2>
          <p data-i18n="mediaCardDesc">Audio, system brightness, and voice reader (TTS)</p>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="collapse-chevron" title="Colapsar / Expandir">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
      </div>
      
      <div class="card-collapsible-body">
        <!-- SUB 5.A: AUDIO -->
        <div class="sub-section" id="sub_media_audio" data-sub-title="Audio y Reproducción">
          <div class="sub-section-header">
            <div class="card-section-title" style="margin-bottom: 0;" data-i18n="audioSub">Audio & Playback Control</div>
            <div id="audioStatusText" style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500; letter-spacing: 0.3px; margin-right: 8px;">Volume: --% | --</div>
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
        </div>

        <!-- SUB 5.B: BRILLO -->
        <div class="sub-section" id="sub_media_brillo" data-sub-title="Brillo de Pantalla">
          <div style="border-top: 1px dashed rgba(255,255,255,0.15); margin: 15px 0 10px 0;"></div>
          <div class="sub-section-header">
            <div class="card-section-title" style="margin-bottom: 0;" data-i18n="brightnessSub">Display Brightness</div>
          </div>
          <div class="form-group" style="margin-bottom: 5px; margin-top: 8px;">
            <div class="form-label-row">
              <span data-i18n="brightnessLevel">Brightness Level</span>
              <span id="brilloVal">--%</span>
            </div>
            <input type="range" class="slider" id="brilloSlider" min="0" max="100" step="1" value="50" oninput="updateBrilloLabel(this.value)" onchange="cambiarBrillo(this.value)">
          </div>
        </div>

        <!-- SUB 5.C: TTS -->
        <div class="sub-section" id="sub_media_tts" data-sub-title="Lector de Voz (TTS)">
          <div class="divider"></div>
          <div class="sub-section-header">
            <div class="card-section-title" style="margin-bottom: 0;" data-i18n="ttsSub">Remote Voice Reader (TTS)</div>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <input type="text" id="inputTTS" placeholder="Text to speak aloud on PC..." data-i18n="ttsPlaceholder" style="flex: 2; padding: 10px 12px; font-size: 0.85rem; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 12px; color: var(--text); outline: none; margin-top: 0;" onkeydown="checkTTSEnter(event)">
            <button class="btn" onclick="enviarTTS()" style="flex: 1; margin-top: 0; padding: 10px; font-size: 0.75rem;">
              Hablar
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- CARD 6: ENERGÍA Y SESIÓN DE PC -->
    <div class="card" id="cardEnergia" style="margin-top: 10px; border-color: rgba(239, 68, 68, 0.15);">
      <div class="card-header" style="margin-bottom: 15px;">
        <div class="card-title-group">
          <h2 data-i18n="powerCardTitle">Power & Brightness</h2>
          <p data-i18n="powerCardDesc">Lock or sleep the computer</p>
        </div>
      </div>
      <div style="display: flex; gap: 8px; width: 100%;">
        <button class="btn btn-danger" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68); display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="controlarEnergia('bloquear')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          Bloquear PC
        </button>
        <button class="btn btn-danger" style="flex: 1; margin-top: 0; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: rgb(239, 68, 68); display: inline-flex; align-items: center; justify-content: center; gap: 6px;" onclick="controlarEnergia('suspender')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
          Suspender PC
        </button>
      </div>
    </div>

    <!-- Barra de info de túnel ngrok -->
    <div class="tunnel-bar" id="tunnelBar" style="display: none;">
      <span class="badge">Remoto</span>
      <span>Túnel seguro activo: <a id="tunnelLink" href="#" target="_blank">Cargando...</a></span>
    </div>
  <!-- FULLSCREEN TRACKPAD OVERLAY -->
  <div id="trackpadFullscreenOverlay" style="display: none; position: fixed; inset: 0; width: 100vw; height: 100vh; background: #0b0f19; z-index: 999999; flex-direction: column; touch-action: none; user-select: none;">
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(15, 23, 42, 0.95); border-bottom: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(12px);">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-weight: 700; font-size: 0.92rem; color: #fff;" data-i18n="trackpadTitle">Virtual Trackpad & Mouse</span>
        <span id="fsSpeedBadge" style="font-size: 0.72rem; padding: 2px 7px; background: rgba(99, 102, 241, 0.25); color: #818cf8; border-radius: 6px; font-weight: 600;">1.2x</span>
      </div>
      <button class="btn btn-sm btn-danger" onclick="exitTrackpadFullscreen()" style="padding: 7px 14px; font-weight: 600; font-size: 0.8rem; margin: 0;" data-i18n="exitFullscreen">
        ✖ Exit Fullscreen
      </button>
    </div>
    <!-- FULLSCREEN REMOTE PROMPT & ACTION BAR (Above Mousepad) -->
    <div style="padding: 8px 12px; background: rgba(15, 23, 42, 0.95); border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; gap: 6px; z-index: 10;">
      <div style="display: flex; gap: 6px; align-items: center;">
        <textarea id="fsPromptInput" rows="1" placeholder="Type prompt for AI / PC cursor..." data-i18n="fsPromptPlaceholder" oninput="autoGrowFsTextarea(this)" style="flex: 1; padding: 8px 10px; font-size: 0.84rem; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; color: #fff; resize: none; min-height: 38px; max-height: 90px; outline: none; font-family: inherit; line-height: 1.35; touch-action: manipulation; user-select: text; -webkit-user-select: text;"></textarea>
        <button type="button" class="btn btn-primary" onclick="sendFullscreenPrompt()" style="padding: 8px 14px; font-weight: 700; font-size: 0.82rem; min-height: 38px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;" data-i18n="btnSendPrompt">
          🚀 Send
        </button>
      </div>
      <div style="display: flex; gap: 6px; align-items: center;">
        <button type="button" class="btn btn-outline" id="fsBtnBackspace" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 600; color: #f87171; border-color: rgba(239, 68, 68, 0.35); touch-action: none; user-select: none; -webkit-user-select: none;" title="Tap to delete character, hold down to delete words and entire lines">
          ⌫ <span data-i18n="fsBtnDelete">Delete (Hold: Lines)</span>
        </button>
        <button type="button" class="btn btn-outline" onclick="sendKey('Enter')" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 700; color: #34d399; border-color: rgba(52, 211, 153, 0.35);" title="Send Enter to PC cursor">
          ↵ <span data-i18n="fsBtnEnter">Enter</span>
        </button>
        <button type="button" class="btn btn-outline" onclick="sendKey('shift+enter')" style="flex: 0.85; padding: 8px 6px; font-size: 0.74rem; font-weight: 600; color: #818cf8; border-color: rgba(129, 140, 248, 0.35);" title="Shift+Enter (New line in AI chats)">
          ⇧↵ <span data-i18n="fsBtnShiftEnter">New Line</span>
        </button>
        <button type="button" class="btn btn-outline" onclick="clearFsPrompt()" style="padding: 8px 11px; font-size: 0.74rem; color: var(--text-muted);" title="Clear text">
          ✕
        </button>
      </div>
    </div>
    <div style="position: relative; flex: 1; width: 100%; height: 100%; overflow: hidden;" id="fsTouchpadSurface">
      <div style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; opacity: 0.25;">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <span style="font-size: 0.88rem; font-weight: 600; text-align: center; max-width: 80%; margin-top: 10px;" data-i18n="touchpadHint">Slide 1 finger to move • Tap for Left Click • Double-tap for 2x • 2 fingers for Right Click</span>
      </div>
      <div id="fsTouchpadScrollStrip" style="position: absolute; right: 0; top: 0; bottom: 0; width: 56px; background: rgba(255, 255, 255, 0.04); border-left: 1px dashed rgba(255, 255, 255, 0.12); display: flex; flex-direction: column; align-items: center; justify-content: center; touch-action: none;">
        <span style="font-size: 0.72rem; color: var(--text-muted); writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 3px;" data-i18n="scrollStrip">SCROLL</span>
      </div>
    </div>
    <div style="padding: 10px 12px; background: rgba(15, 23, 42, 0.95); border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; gap: 6px;">
      <button class="btn btn-outline" onclick="sendMouseClick('left')" style="flex: 1; padding: 12px 4px; font-weight: 700; font-size: 0.82rem;" data-i18n="btnLeftClick">
        Left Click
      </button>
      <button class="btn btn-outline" onclick="sendMouseDoubleClick()" style="flex: 0.9; padding: 12px 4px; font-weight: 700; font-size: 0.82rem;" data-i18n="doubleClick">
        Double Click
      </button>
      <button class="btn btn-outline" id="fsBtnDragLock" onclick="toggleDragLock()" style="flex: 1; padding: 12px 4px; font-weight: 700; font-size: 0.8rem;">
        <span id="fsDragLockIcon">🔓</span> <span id="fsDragLockText" data-i18n="dragLock">Drag Lock</span>
      </button>
      <button class="btn btn-outline" onclick="sendMouseClick('right')" style="flex: 1; padding: 12px 4px; font-weight: 700; font-size: 0.82rem;" data-i18n="btnRightClick">
        Right Click
      </button>
    </div>
  </div>

  </main>

  <!-- Modal Pausa Temporal -->
  <div class="modal-overlay" id="modalPausaTemporal" style="display: none;" onclick="cerrarModalPausaTemporalSiBackground(event)">
    <div class="modal-card">
      <div class="modal-header">
        <h3>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          Pausa Temporal Programada
        </h3>
        <button class="modal-close-btn" onclick="cerrarModalPausaTemporal()">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 15px; line-height: 1.4;">
          Ingresa la cantidad de minutos para pausar temporalmente la actividad del navegador. Al terminar el tiempo, la actividad se reanudará automáticamente.
        </p>
        <div class="form-group">
          <label style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">Minutos de Pausa</label>
          <input type="number" id="pausaTemporalMinsInput" class="number-input" value="25" min="1" max="480" step="1" style="font-size: 1.15rem; font-weight: 600; text-align: center; margin-top: 6px;" onkeydown="if(event.key === 'Enter') confirmarPausaTemporal()">
        </div>
        
        <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-bottom: 15px;">
          <button class="btn-preset" onclick="setPresetPausa(10)">10m</button>
          <button class="btn-preset" onclick="setPresetPausa(15)">15m</button>
          <button class="btn-preset" onclick="setPresetPausa(20)">20m</button>
          <button class="btn-preset" onclick="setPresetPausa(25)">25m</button>
          <button class="btn-preset" onclick="setPresetPausa(30)">30m</button>
          <button class="btn-preset" onclick="setPresetPausa(40)">40m</button>
        </div>

        <details style="margin-bottom: 15px; font-size: 0.75rem; color: var(--text-muted);" id="detailsPauseIntervals">
          <summary style="cursor: pointer; user-select: none; font-weight: 500; opacity: 0.85; margin-bottom: 8px;">⚙️ Configurar intervalos de pausa programada (Hasta 4)</summary>
          <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 10px; border: 1px solid var(--card-border);">
            <div id="pauseIntervalsList" style="display: flex; flex-direction: column; gap: 8px;">
              <!-- Filas generadas dinámicamente -->
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px; gap: 8px;">
              <button type="button" id="btnAddPauseInterval" class="btn btn-sm btn-outline" onclick="agregarFilaIntervaloPausa()" style="font-size: 0.72rem; padding: 5px 8px; display: inline-flex; align-items: center; gap: 4px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                + Intervalo
              </button>
              <button type="button" class="btn btn-sm btn-primary" onclick="guardarIntervalosPausa()" style="font-size: 0.72rem; padding: 5px 12px; background: #f59e0b; border-color: #f59e0b; color: #fff;">
                Guardar Horarios
              </button>
            </div>
          </div>
        </details>
      </div>
      <div class="modal-footer" style="display: flex; gap: 10px;">
        <button class="btn" onclick="cerrarModalPausaTemporal()" style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border);" data-i18n="btnCancel">Cancel</button>
        <button class="btn" onclick="confirmarPausaTemporal()" style="flex: 1; background: #f59e0b; border-color: #f59e0b; color: #fff; font-weight: 700; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.4);" data-i18n="btnConfirmPause">Confirm Pause</button>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    // Interceptor global para incluir siempre la cabecera 'ngrok-skip-browser-warning' en las peticiones fetch
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
      options = options || {};
      options.headers = options.headers || {};
      if (options.headers instanceof Headers) {
        options.headers.set('ngrok-skip-browser-warning', 'true');
      } else if (Array.isArray(options.headers)) {
        options.headers.push(['ngrok-skip-browser-warning', 'true']);
      } else {
        options.headers['ngrok-skip-browser-warning'] = 'true';
      }
      return originalFetch(url, options);
    };

    let currentBrowserInterval = 4.0;

    document.addEventListener('DOMContentLoaded', () => {
      setLanguage(currentLang);
      initTrackpad();
      initDashboardCustomizer();
      scheduledPoll();
      probarPing();
      setInterval(probarPing, 20000);
      obtenerBrillo();
    });

    function updateBrilloLabel(val) {
      document.getElementById('brilloVal').innerText = val + '%';
    }


    async function obtenerBrillo() {
      try {
        const response = await fetch('/system/brightness');
        const data = await response.json();
        if (response.ok && data.brightness !== null) {
          if (document.activeElement !== document.getElementById('brilloSlider')) {
            document.getElementById('brilloSlider').value = data.brightness;
            updateBrilloLabel(data.brightness);
          }
        }
      } catch (error) {
        console.error('Error al obtener brillo:', error);
      }
    }

    async function cambiarBrillo(val) {
      updateBrilloLabel(val);
      try {
        const response = await fetch('/system/brightness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brightness: Number(val) })
        });
        const data = await response.json();
        if (response.ok) {
          showToast('Brillo ajustado al ' + val + '%.', 'success');
        } else {
          showToast(data.message || 'Error al ajustar brillo', 'error');
        }
      } catch (error) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    function logout() {
      document.cookie = "api_key=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC; Secure; SameSite=Lax";
      localStorage.removeItem('X-API-KEY');
      sessionStorage.setItem('auto_login_failed', 'true');
      window.location.href = '/';
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

      try {
        const response = await fetch('/system/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: texto })
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
        const response = await fetch('/system/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: accion })
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
      const labelEl = document.getElementById('browserIntervalVal');
      if (labelEl) {
        labelEl.innerText = Math.round(parseFloat(val)) + ' minutos';
      }
    }

    function dismissToast(el) {
      if (!el || !el.parentNode || el._isDismissing) return;
      el._isDismissing = true;
      if (el._timer) clearTimeout(el._timer);
      el.style.animation = 'slideOutUp 0.15s ease forwards';
      setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 150);
    }

    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      if (!container) return;

      // Si ya hay un toast mostrando exactamente el mismo mensaje, no duplicar: reiniciar temporizador
      const existing = Array.from(container.children).find(t => t._toastMsg === message && !t._isDismissing);
      if (existing) {
        if (existing._timer) clearTimeout(existing._timer);
        const duration = type === 'error' ? 3500 : (type === 'warning' ? 3000 : 2200);
        existing._timer = setTimeout(() => dismissToast(existing), duration);
        return;
      }

      // Limitar a máximo 1 notificación visible a la vez: eliminar toasts previos de forma síncrona sin bucles
      Array.from(container.children).forEach(child => {
        if (child._timer) clearTimeout(child._timer);
        child.remove();
      });

      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast._toastMsg = message;
      
      let icon = '';
      if (type === 'success') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
      } else if (type === 'error') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      } else if (type === 'warning') {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
      } else {
        icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
      }

      toast.innerHTML = icon + ' <span style="flex: 1; word-break: break-word;">' + message + '</span>';
      
      toast.onclick = () => dismissToast(toast);

      // Descartar por swipe hacia arriba o lateral
      let startX = 0, startY = 0;
      let isSwiping = false;

      toast.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        toast.style.transition = 'none';
        isSwiping = true;
      }, { passive: true });

      toast.addEventListener('touchmove', (e) => {
        if (!isSwiping) return;
        const diffX = e.touches[0].clientX - startX;
        const diffY = e.touches[0].clientY - startY;
        if (diffY < 0) {
          toast.style.transform = 'translateY(' + diffY + 'px)';
          toast.style.opacity = Math.max(0, 1 - Math.abs(diffY) / 100);
        } else if (Math.abs(diffX) > 20) {
          toast.style.transform = 'translateX(' + diffX + 'px)';
          toast.style.opacity = Math.max(0, 1 - Math.abs(diffX) / 200);
        }
      }, { passive: true });

      toast.addEventListener('touchend', (e) => {
        if (!isSwiping) return;
        isSwiping = false;
        const endY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : startY;
        const endX = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : startX;
        const diffY = endY - startY;
        const diffX = endX - startX;
        if (diffY < -25 || Math.abs(diffX) > 60) {
          dismissToast(toast);
        } else {
          toast.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
          toast.style.transform = '';
          toast.style.opacity = '1';
        }
      }, { passive: true });

      container.appendChild(toast);
      
      const duration = type === 'error' ? 3500 : (type === 'warning' ? 3000 : 2200);
      toast._timer = setTimeout(() => dismissToast(toast), duration);
    }

    
    let isPollingGateway = false;
    async function scheduledPoll() {
      if (isPollingGateway) return;
      isPollingGateway = true;
      try {
        await pollGatewayStatus();
      } catch (e) {
        // Ignore error, watchdog prevents tab hang
      } finally {
        isPollingGateway = false;
        setTimeout(scheduledPoll, 5000);
      }
    }

    async function pollGatewayStatus() {
      try {
        const response = await safeFetch('/gateway/status', {}, 3500);
        
        if (response.status === 403) {
          logout();
          return;
        }

        const data = await response.json();
        window.lastStatusData = data;
        
        // Sincronizar UI de Navegador Web
        const browserBadge = document.getElementById('browserBadge');
        const browserBadgeText = document.getElementById('browserBadgeText');
        const btnBrowserOpen = document.getElementById('btnBrowserOpen');
        const btnBrowserClose = document.getElementById('btnBrowserClose');

        const testMouseBtn = document.getElementById('btnTestMouse');
        const testTipeoBtn = document.getElementById('btnTestTipeo');
        const testShiftBtn = document.getElementById('btnTestShift');

        const isEs = currentLang === 'es';
        if (data.browserAbierto) {
          browserBadge.className = 'status-badge active';
          browserBadgeText.innerText = isEs ? 'Navegador: Abierto' : 'Browser: Open';
          btnBrowserOpen.className = 'btn btn-primary btn-disabled';
          btnBrowserClose.className = 'btn btn-danger';
          
          document.getElementById('btnBrowserMinimize').classList.remove('btn-disabled');
          document.getElementById('btnBrowserRestore').classList.remove('btn-disabled');
          
          testMouseBtn.classList.remove('btn-disabled');
          testTipeoBtn.classList.remove('btn-disabled');
          testShiftBtn.classList.remove('btn-disabled');
        } else {
          browserBadge.className = 'status-badge';
          browserBadgeText.innerText = isEs ? 'Navegador: Cerrado' : 'Browser: Closed';
          btnBrowserOpen.className = 'btn btn-primary';
          btnBrowserClose.className = 'btn btn-disabled';

          document.getElementById('btnBrowserMinimize').classList.add('btn-disabled');
          document.getElementById('btnBrowserRestore').classList.add('btn-disabled');

          testMouseBtn.classList.add('btn-disabled');
          testTipeoBtn.classList.add('btn-disabled');
          testShiftBtn.classList.add('btn-disabled');
        }

        // Ensure the interval input is always enabled for hot reconfiguration
        const intervalInput = document.getElementById('browserIntervalInput');
        intervalInput.classList.remove('btn-disabled');
        intervalInput.disabled = false;

        // Sincronizar UI de Sesión Activa
        const presenciaBadge = document.getElementById('presenciaBadge');
        const presenciaBadgeText = document.getElementById('presenciaBadgeText');
        const cardBrowser = document.getElementById('cardBrowser');

        const btnPlay = document.getElementById('btnPresenciaPlay');
        const btnPause = document.getElementById('btnPresenciaPause');
        const btnPausaTemp = document.getElementById('btnPresenciaPausaTemporal');
        const pausaBanner = document.getElementById('pausaTemporalStatusBanner');
        const pausaCountdownText = document.getElementById('pausaTemporalCountdownText');

        if (data.browserPausaTemporalRemainingMs && data.browserPausaTemporalRemainingMs > 0) {
          const totalSecs = Math.ceil(data.browserPausaTemporalRemainingMs / 1000);
          const mins = Math.floor(totalSecs / 60);
          const secs = totalSecs % 60;
          const formattedSecs = String(secs).padStart(2, '0');
          const timeStr = mins + 'm ' + formattedSecs + 's';

          presenciaBadge.className = 'status-badge warning';
          presenciaBadgeText.innerText = (isEs ? 'Pausa Temp: ' : 'Temp Pause: ') + mins + 'm';
          cardBrowser.classList.add('active-state');

          if (pausaBanner) {
            pausaBanner.style.display = 'flex';
            if (pausaCountdownText) pausaCountdownText.innerText = timeStr;
          }

          // Si hay pausa temporal, el botón Iniciar (Play) debe estar disponible para reanudar la simulación e interrumpir la pausa
          btnPlay.classList.remove('btn-disabled');
          btnPause.classList.remove('btn-disabled');
          if (btnPausaTemp) btnPausaTemp.classList.remove('btn-disabled');
        } else {
          if (pausaBanner) pausaBanner.style.display = 'none';

          if (data.browserPresenciaActiva) {
            presenciaBadge.className = 'status-badge active';
            presenciaBadgeText.innerText = isEs ? 'Mantener Activo: On' : 'Keepalive: On';
            cardBrowser.classList.add('active-state');
            btnPlay.classList.add('btn-disabled');
            btnPause.classList.remove('btn-disabled');
            if (btnPausaTemp) btnPausaTemp.classList.remove('btn-disabled');
          } else {
            presenciaBadge.className = 'status-badge';
            presenciaBadgeText.innerText = isEs ? 'Mantener Activo: Off' : 'Keepalive: Off';
            if (!data.browserAbierto) {
              cardBrowser.classList.remove('active-state');
            }
            btnPlay.classList.remove('btn-disabled');
            btnPause.classList.add('btn-disabled');
            if (btnPausaTemp) btnPausaTemp.classList.remove('btn-disabled');
          }
        }

        if (document.activeElement !== document.getElementById('browserIntervalInput')) {
          const mins = Math.round(data.browserIntervalMs / 60000);
          document.getElementById('browserIntervalInput').value = mins;
          updateBrowserSliderLabel(mins);
        }

        // Sincronizar campos de planificación si no están en foco
        if (document.activeElement !== document.getElementById('browserStartHour')) {
          document.getElementById('browserStartHour').value = data.browserSimulacionStartHour || '09:00';
        }
        if (document.activeElement !== document.getElementById('browserEndHour')) {
          document.getElementById('browserEndHour').value = data.browserSimulacionEndHour || '18:00';
        }
        if (document.activeElement !== document.getElementById('browserCloseHour')) {
          document.getElementById('browserCloseHour').value = data.browserCloseHour || '18:03';
        }
        if (document.activeElement !== document.getElementById('browserCloseEnabled')) {
          document.getElementById('browserCloseEnabled').checked = !!data.browserCloseEnabled;
        }
        if (document.activeElement !== document.getElementById('browserFlexCloseDate')) {
          document.getElementById('browserFlexCloseDate').value = data.browserFlexCloseDate || '';
        }
        if (document.activeElement !== document.getElementById('browserFlexCloseHour')) {
          document.getElementById('browserFlexCloseHour').value = data.browserFlexCloseHour || '';
        }
        if (document.activeElement !== document.getElementById('browserFlexCloseEnabled')) {
          document.getElementById('browserFlexCloseEnabled').checked = !!data.browserFlexCloseEnabled;
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
          let statusStr = (isEs ? 'Volumen: ' : 'Volume: ') + vol + '%';
          if (muted) {
            statusStr += isEs ? ' (Silenciado)' : ' (Muted)';
          }
          statusStr += ' | ' + (playing ? (isEs ? '▶ Reproduciendo' : '▶ Playing') : (isEs ? '⏸ Pausado' : '⏸ Paused'));
          audioTextEl.innerText = statusStr;
        }

        // Actualizar label de última actividad
        const lastActEl = document.getElementById('lastActivityLabel');
        if (lastActEl && data.lastActivityFormatted) {
          if (data.lastActivitySecondsAgo !== null) {
            const agoStr = isEs ? ('Hace ' + data.lastActivityFormatted) : (data.lastActivityFormatted + ' ago');
            lastActEl.innerText = (isEs ? 'Última: ' : 'Last: ') + data.lastActivityTimeStr + ' (' + agoStr + ')';
          } else {
            lastActEl.innerText = isEs ? 'Última: Sin actividad' : 'Last: No activity';
          }
        }

        // Actualizar estado de Guardián de Pantalla
        const screenGuardBadge = document.getElementById('screenGuardBadge');
        const screenGuardBadgeText = document.getElementById('screenGuardBadgeText');
        const btnGuardiaToggle = document.getElementById('btnGuardiaToggle');
        const btnGuardiaToggleText = document.getElementById('btnGuardiaToggleText');
        if (data.screenGuardActive) {
          if (screenGuardBadge) screenGuardBadge.className = 'status-badge active';
          if (screenGuardBadgeText) screenGuardBadgeText.innerText = isEs ? 'Guardián Activo' : 'Guard Active';
          if (btnGuardiaToggle) {
            btnGuardiaToggle.style.background = 'rgba(16, 185, 129, 0.2)';
            btnGuardiaToggle.style.borderColor = '#10b981';
            btnGuardiaToggle.style.color = '#10b981';
          }
          if (btnGuardiaToggleText) btnGuardiaToggleText.innerText = isEs ? 'Desactivar Guardián (Encender)' : 'Disable Guard (Turn On)';
        } else {
          if (screenGuardBadge) screenGuardBadge.className = 'status-badge';
          if (screenGuardBadgeText) screenGuardBadgeText.innerText = isEs ? 'Guardián Inactivo' : 'Guard Inactive';
          if (btnGuardiaToggle) {
            btnGuardiaToggle.style.background = 'rgba(168, 85, 247, 0.15)';
            btnGuardiaToggle.style.borderColor = 'rgba(168, 85, 247, 0.4)';
            btnGuardiaToggle.style.color = 'rgb(216, 180, 254)';
          }
          if (btnGuardiaToggleText) btnGuardiaToggleText.innerText = isEs ? 'Apagar (Guardián)' : 'Turn Off (Guard)';
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
      const browserCloseHour = document.getElementById('browserCloseHour').value;
      const browserCloseEnabled = document.getElementById('browserCloseEnabled').checked;
      const flexCloseDate = document.getElementById('browserFlexCloseDate').value;
      const flexCloseHour = document.getElementById('browserFlexCloseHour').value;
      const flexCloseEnabled = document.getElementById('browserFlexCloseEnabled').checked;

      const checkedDays = [];
      const checkboxes = document.querySelectorAll('.day-checkbox');
      checkboxes.forEach(cb => {
        if (cb.checked) {
          checkedDays.push(Number(cb.value));
        }
      });

      drawDayLabels();

      try {
        const response = await fetch('/browser/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startHour,
            endHour,
            days: checkedDays,
            browserCloseHour,
            browserCloseEnabled,
            flexCloseDate,
            flexCloseHour,
            flexCloseEnabled
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
      try {
        const response = await fetch('/browser/window', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: accion })
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

    function calcularDefaultMinsSegunIntervalos(intervals) {
      if (!Array.isArray(intervals) || intervals.length === 0) return 25;
      const now = new Date();
      const curMinutes = now.getHours() * 60 + now.getMinutes();

      for (let i = 0; i < intervals.length; i++) {
        const item = intervals[i];
        if (!item || !item.start || !item.end) continue;
        const [sH, sM] = item.start.split(':').map(Number);
        const [eH, eM] = item.end.split(':').map(Number);
        const startMin = sH * 60 + sM;
        const endMin = eH * 60 + eM;

        if (startMin <= endMin) {
          if (curMinutes >= startMin && curMinutes <= endMin) {
            return Number(item.mins) || 20;
          }
        } else {
          if (curMinutes >= startMin || curMinutes <= endMin) {
            return Number(item.mins) || 20;
          }
        }
      }
      return Number(intervals[0].mins) || 25;
    }

    function renderizarIntervalosPausa(intervals) {
      const container = document.getElementById('pauseIntervalsList');
      if (!container) return;
      container.innerHTML = '';

      const list = Array.isArray(intervals) && intervals.length > 0 ? intervals : [
        { start: '00:00', end: '15:15', mins: 25 },
        { start: '15:15', end: '23:59', mins: 15 }
      ];

      list.slice(0, 4).forEach(function(item) {
        agregarFilaDOMIntervaloPausa(item.start || '00:00', item.end || '23:59', item.mins || 20);
      });
      actualizarBotonAgregarIntervalo();
    }

    function agregarFilaDOMIntervaloPausa(startVal, endVal, minsVal) {
      const container = document.getElementById('pauseIntervalsList');
      if (!container) return;

      const row = document.createElement('div');
      row.className = 'pause-interval-row';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      row.style.background = 'rgba(0,0,0,0.25)';
      row.style.padding = '6px 8px';
      row.style.borderRadius = '8px';
      row.style.border = '1px solid rgba(255,255,255,0.06)';

      const lblDe = document.createElement('span');
      lblDe.style.fontSize = '0.7rem';
      lblDe.style.color = 'var(--text-muted)';
      lblDe.textContent = 'De';

      const inStart = document.createElement('input');
      inStart.type = 'time';
      inStart.className = 'pause-interval-start';
      inStart.value = startVal;
      inStart.style.background = 'rgba(255,255,255,0.05)';
      inStart.style.border = '1px solid var(--card-border)';
      inStart.style.color = '#fff';
      inStart.style.borderRadius = '6px';
      inStart.style.padding = '3px 4px';
      inStart.style.fontSize = '0.75rem';
      inStart.style.width = '75px';
      inStart.style.textAlign = 'center';

      const lblA = document.createElement('span');
      lblA.style.fontSize = '0.7rem';
      lblA.style.color = 'var(--text-muted)';
      lblA.textContent = 'a';

      const inEnd = document.createElement('input');
      inEnd.type = 'time';
      inEnd.className = 'pause-interval-end';
      inEnd.value = endVal;
      inEnd.style.background = 'rgba(255,255,255,0.05)';
      inEnd.style.border = '1px solid var(--card-border)';
      inEnd.style.color = '#fff';
      inEnd.style.borderRadius = '6px';
      inEnd.style.padding = '3px 4px';
      inEnd.style.fontSize = '0.75rem';
      inEnd.style.width = '75px';
      inEnd.style.textAlign = 'center';

      const lblDef = document.createElement('span');
      lblDef.style.fontSize = '0.7rem';
      lblDef.style.color = 'var(--text-muted)';
      lblDef.textContent = 'Default:';

      const inMins = document.createElement('input');
      inMins.type = 'number';
      inMins.className = 'pause-interval-mins';
      inMins.min = '1';
      inMins.max = '480';
      inMins.value = minsVal;
      inMins.style.background = 'rgba(255,255,255,0.05)';
      inMins.style.border = '1px solid var(--card-border)';
      inMins.style.color = '#fff';
      inMins.style.borderRadius = '6px';
      inMins.style.padding = '3px 4px';
      inMins.style.fontSize = '0.75rem';
      inMins.style.width = '48px';
      inMins.style.textAlign = 'center';

      const lblM = document.createElement('span');
      lblM.style.fontSize = '0.7rem';
      lblM.style.color = 'var(--text-muted)';
      lblM.textContent = 'm';

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn-del-interval';
      btnDel.title = 'Eliminar intervalo';
      btnDel.style.background = 'transparent';
      btnDel.style.border = 'none';
      btnDel.style.color = '#ef4444';
      btnDel.style.cursor = 'pointer';
      btnDel.style.padding = '2px';
      btnDel.style.marginLeft = 'auto';
      btnDel.style.display = 'flex';
      btnDel.style.alignItems = 'center';
      btnDel.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      btnDel.onclick = function() {
        row.remove();
        actualizarBotonAgregarIntervalo();
      };

      row.appendChild(lblDe);
      row.appendChild(inStart);
      row.appendChild(lblA);
      row.appendChild(inEnd);
      row.appendChild(lblDef);
      row.appendChild(inMins);
      row.appendChild(lblM);
      row.appendChild(btnDel);

      container.appendChild(row);
    }

    function actualizarBotonAgregarIntervalo() {
      const rows = document.querySelectorAll('.pause-interval-row');
      const btnAdd = document.getElementById('btnAddPauseInterval');
      if (btnAdd) {
        btnAdd.style.display = rows.length >= 4 ? 'none' : 'inline-flex';
      }
      rows.forEach(function(row) {
        const delBtn = row.querySelector('.btn-del-interval');
        if (delBtn) {
          delBtn.style.display = rows.length <= 1 ? 'none' : 'flex';
        }
      });
    }

    function agregarFilaIntervaloPausa() {
      const rows = document.querySelectorAll('.pause-interval-row');
      if (rows.length >= 4) {
        showToast('Máximo 4 intervalos permitidos.', 'warning');
        return;
      }
      let newStart = '18:00';
      if (rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        const lastEnd = lastRow.querySelector('.pause-interval-end').value;
        if (lastEnd) newStart = lastEnd;
      }
      agregarFilaDOMIntervaloPausa(newStart, '23:59', 20);
      actualizarBotonAgregarIntervalo();
    }

    async function guardarIntervalosPausa() {
      const rows = document.querySelectorAll('.pause-interval-row');
      const intervals = [];
      rows.forEach(function(row) {
        const start = row.querySelector('.pause-interval-start').value || '00:00';
        const end = row.querySelector('.pause-interval-end').value || '23:59';
        const mins = parseInt(row.querySelector('.pause-interval-mins').value) || 20;
        intervals.push({ start: start, end: end, mins: mins });
      });

      if (intervals.length === 0) {
        showToast('Debe haber al menos 1 intervalo configurado.', 'warning');
        return;
      }

      try {
        const response = await fetch('/browser/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mealPauseIntervals: intervals })
        });
        const data = await response.json();
        if (response.ok) {
          showToast('Intervalos de pausa actualizados con éxito.', 'success');
          if (window.lastStatusData) {
            window.lastStatusData.mealPauseIntervals = intervals;
          }
          const defaultMins = calcularDefaultMinsSegunIntervalos(intervals);
          document.getElementById('pausaTemporalMinsInput').value = defaultMins;
          setPresetPausa(defaultMins);
        } else {
          showToast(data.message || 'Error al actualizar intervalos', 'error');
        }
      } catch (error) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    function abrirModalPausaTemporal() {
      const intervals = (window.lastStatusData && window.lastStatusData.mealPauseIntervals) || [
        { start: '00:00', end: '15:15', mins: 25 },
        { start: '15:15', end: '23:59', mins: 15 }
      ];
      renderizarIntervalosPausa(intervals);
      const defaultMins = calcularDefaultMinsSegunIntervalos(intervals);
      document.getElementById('pausaTemporalMinsInput').value = defaultMins;
      setPresetPausa(defaultMins);
      document.getElementById('modalPausaTemporal').style.display = 'flex';
      setTimeout(() => {
        const input = document.getElementById('pausaTemporalMinsInput');
        if (input) {
          input.focus();
          input.select();
        }
      }, 50);
    }

    function cerrarModalPausaTemporal() {
      const modal = document.getElementById('modalPausaTemporal');
      if (modal) modal.style.display = 'none';
    }

    function cerrarModalPausaTemporalSiBackground(e) {
      if (e.target && e.target.id === 'modalPausaTemporal') {
        cerrarModalPausaTemporal();
      }
    }

    function setPresetPausa(mins) {
      document.getElementById('pausaTemporalMinsInput').value = mins;
      const buttons = document.querySelectorAll('.btn-preset');
      buttons.forEach(btn => {
        if (btn.innerText === mins + 'm') {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }

    async function confirmarPausaTemporal() {
      const inputEl = document.getElementById('pausaTemporalMinsInput');
      let mins = parseInt(inputEl.value);
      if (isNaN(mins) || mins < 1) mins = 20;
      if (mins > 480) mins = 480;

      cerrarModalPausaTemporal();

      try {
        const response = await fetch('/browser/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'pausa_temporal', durationMins: mins })
        });
        const data = await response.json();
        if (response.ok) {
          showToast(data.message, 'success');
          pollGatewayStatus();
        } else {
          showToast(data.message || 'Error al activar pausa temporal', 'error');
        }
      } catch (error) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    async function controlPresencia(accion) {
      let mins = parseInt(document.getElementById('browserIntervalInput').value);
      if (isNaN(mins) || mins < 1) {
        mins = 1;
      } else if (mins > 9999) {
        mins = 9999;
      }
      document.getElementById('browserIntervalInput').value = mins;
      updateBrowserSliderLabel(mins);
      const ms = mins * 60000;
      try {
        const response = await fetch('/browser/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: accion, intervalMs: ms })
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

    async function cambiarIntervaloEnCaliente(val) {
      let mins = parseInt(val);
      if (isNaN(mins) || mins < 1) {
        mins = 1;
      } else if (mins > 9999) {
        mins = 9999;
      }
      document.getElementById('browserIntervalInput').value = mins;
      updateBrowserSliderLabel(mins);
      const ms = mins * 60000;
      
      const btnPause = document.getElementById('btnPresenciaPause');
      const estaActiva = !btnPause.classList.contains('btn-disabled');

      try {
        const response = await fetch('/browser/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            action: estaActiva ? 'iniciar' : 'pausar', 
            intervalMs: ms 
          })
        });
        const data = await response.json();
        if (response.ok) {
          showToast(estaActiva ? 'Intervalo reconfigurado en caliente a ' + mins + ' minutos.' : 'Intervalo guardado: ' + mins + ' minutos.', 'success');
          pollGatewayStatus();
        } else {
          showToast(data.message || 'Error al guardar intervalo', 'error');
        }
      } catch (error) {
        showToast('Error de conexión con el servidor', 'error');
      }
    }

    async function enviarAccionPrueba(accion) {
      try {
        const response = await fetch('/browser/simulate-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: accion })
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

      try {
        const response = await fetch('/system/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ program: programa })
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

      try {
        const response = await fetch('/system/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ program: programa })
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
      try {
        const response = await fetch('/system/keyboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: accion })
        });
        const data = await response.json();
        showToast(data.message, response.ok ? 'success' : 'error');
        if (response.ok) {
          setTimeout(pollGatewayStatus, 300);
        }
      } catch (error) {
        showToast('Error al conectar con la PC', 'error');
      }
    }

    function toggleGuardia() {
      if (window.lastStatusData && window.lastStatusData.screenGuardActive) {
        controlarTeclado('encender-pantalla');
      } else {
        controlarTeclado('apagar-guardia');
      }
    }

    async function controlarEnergia(accion) {
      const confirmMsg = accion === 'bloquear' 
        ? '¿Estás seguro de que deseas bloquear la PC?' 
        : '¿Estás seguro de que deseas suspender la PC?';
      
      if (!confirm(confirmMsg)) {
        return;
      }

      try {
        const response = await fetch('/system/power', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: accion })
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
      try {
        const response = await fetch('/system/clipboard', {
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
      try {
        const response = await fetch('/system/clipboard');
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
      const preview = document.getElementById('screenshotPreview');
      preview.onload = () => {
        showToast('Captura de pantalla actualizada.', 'success');
      };
      preview.src = '/system/screenshot?t=' + Date.now();
      preview.style.display = 'block';
    }

    async function probarPing() {
      try {
        const response = await fetch('/system/ping');
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

    // === GESTIÓN DE PERSONALIZACIÓN, ORDEN Y VISIBILIDAD DE SECCIONES ===
    const DEFAULT_CARD_ORDER = ['cardBrowser', 'cardMousePad', 'cardTeclado', 'cardSistema', 'cardReiniciar', 'cardMultimedia', 'cardEnergia'];
    const CARD_TITLES = {
      'cardBrowser': 'Navegador Activo',
      'cardMousePad': 'Trackpad & Mouse',
      'cardTeclado': 'Teclado Remoto',
      'cardSistema': 'Acciones de Sistema',
      'cardReiniciar': 'Reiniciar Servidor',
      'cardMultimedia': 'Controles Multimedia, Brillo & Voz',
      'cardEnergia': 'Energía y Sesión de PC'
    };

    let isEditModeActive = false;
    let draggedCard = null;
    let touchActiveCard = null;

    function getDashboardConfig() {
      let cfg = null;
      try {
        const saved = localStorage.getItem('gateway_dashboard_custom_v1');
        if (saved) cfg = JSON.parse(saved);
      } catch (e) {}
      if (!cfg || !Array.isArray(cfg.order)) {
        return {
          order: [...DEFAULT_CARD_ORDER],
          hidden: {},
          subHidden: {}
        };
      }
      DEFAULT_CARD_ORDER.forEach(id => {
        if (!cfg.order.includes(id)) {
          cfg.order.push(id);
        }
      });
      return cfg;
    }

    function saveDashboardConfig(config) {
      try {
        localStorage.setItem('gateway_dashboard_custom_v1', JSON.stringify(config));
      } catch (e) {}
    }

    function initDashboardCustomizer() {
      const config = getDashboardConfig();
      const mainEl = document.querySelector('main');
      const tunnelBar = document.getElementById('tunnelBar');

      // Añadir la barra de edición a cada tarjeta principal
      DEFAULT_CARD_ORDER.forEach(function(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;

        // Evitar duplicar la barra de edición
        if (!card.querySelector('.card-edit-bar')) {
          const editBar = document.createElement('div');
          editBar.className = 'card-edit-bar';

          const editLeft = document.createElement('div');
          editLeft.className = 'card-edit-left';

          const dragHandle = document.createElement('div');
          dragHandle.className = 'card-drag-handle';
          dragHandle.title = 'Arrastrar para mover';
          dragHandle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg><span>Mover</span>';

          const arrowsDiv = document.createElement('div');
          arrowsDiv.className = 'card-edit-arrows';

          const btnUp = document.createElement('button');
          btnUp.className = 'btn-arrow';
          btnUp.title = 'Mover arriba';
          btnUp.textContent = '▲';
          btnUp.onclick = function() { moveCard(cardId, 'up'); };

          const btnDown = document.createElement('button');
          btnDown.className = 'btn-arrow';
          btnDown.title = 'Mover abajo';
          btnDown.textContent = '▼';
          btnDown.onclick = function() { moveCard(cardId, 'down'); };

          arrowsDiv.appendChild(btnUp);
          arrowsDiv.appendChild(btnDown);
          editLeft.appendChild(dragHandle);
          editLeft.appendChild(arrowsDiv);

          const btnVis = document.createElement('button');
          btnVis.className = 'btn-toggle-vis is-visible';
          btnVis.id = 'btnVis_' + cardId;
          btnVis.title = 'Ocultar o mostrar';
          btnVis.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Visible</span>';
          btnVis.onclick = function() { toggleCardVisibility(cardId); };

          editBar.appendChild(editLeft);
          editBar.appendChild(btnVis);

          card.insertBefore(editBar, card.firstChild);
        }

        // Configurar atributos drag & drop para desktop
        card.setAttribute('draggable', 'false');

        const handle = card.querySelector('.card-drag-handle');
        if (handle) {
          handle.addEventListener('mousedown', function() {
            card.setAttribute('draggable', 'true');
          });
          handle.addEventListener('mouseup', function() {
            card.setAttribute('draggable', 'false');
          });

          // Soporte Touch para móviles
          handle.addEventListener('touchstart', function(e) { handleTouchStart(e, card); }, { passive: false });
          handle.addEventListener('touchmove', function(e) { handleTouchMove(e, card); }, { passive: false });
          handle.addEventListener('touchend', function(e) { handleTouchEnd(e, card); });
        }

        // Listeners Desktop Drag & Drop
        card.addEventListener('dragstart', function(e) { handleDragStart(e, card); });
        card.addEventListener('dragover', function(e) { handleDragOver(e, card); });
        card.addEventListener('dragend', function(e) { handleDragEnd(e, card); });
      });

      // Añadir botón de visibilidad a cada sub-sección
      const allSubSections = document.querySelectorAll('.sub-section');
      allSubSections.forEach(function(subEl) {
        const subId = subEl.id;
        if (!subId) return;

        const headerEl = subEl.querySelector('.sub-section-header');
        if (headerEl && !headerEl.querySelector('.btn-sub-vis')) {
          const btnSubVis = document.createElement('button');
          btnSubVis.className = 'btn-sub-vis is-visible';
          btnSubVis.id = 'btnSubVis_' + subId;
          btnSubVis.title = 'Ocultar o mostrar este bloque';
          btnSubVis.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Visible</span>';
          btnSubVis.onclick = function(e) {
            e.stopPropagation();
            toggleSubSectionVisibility(subId);
          };
          headerEl.appendChild(btnSubVis);
        }

        // Aplicar estado guardado de sub-secciones
        const subHiddenMap = config.subHidden || {};
        const isSubHidden = !!subHiddenMap[subId];
        if (isSubHidden) {
          subEl.classList.add('is-hidden-sub');
        } else {
          subEl.classList.remove('is-hidden-sub');
        }
        updateSubVisibilityBtnUI(subId, !isSubHidden);
      });

      // Aplicar orden guardado
      const order = Array.isArray(config.order) ? config.order : DEFAULT_CARD_ORDER;
      order.forEach(function(cardId) {
        const card = document.getElementById(cardId);
        if (card && mainEl) {
          if (tunnelBar) {
            mainEl.insertBefore(card, tunnelBar);
          } else {
            mainEl.appendChild(card);
          }
        }
      });

      // Aplicar visibilidad guardada
      const hiddenMap = config.hidden || {};
      DEFAULT_CARD_ORDER.forEach(function(cardId) {
        const card = document.getElementById(cardId);
        const isHidden = !!hiddenMap[cardId];
        if (card) {
          if (isHidden) {
            card.classList.add('is-hidden-card');
          } else {
            card.classList.remove('is-hidden-card');
          }
          updateVisibilityBtnUI(cardId, !isHidden);
        }
      });
    }

    function toggleEditMode() {
      isEditModeActive = !isEditModeActive;
      document.body.classList.toggle('is-edit-mode', isEditModeActive);
      
      const banner = document.getElementById('editModeBanner');
      if (banner) banner.classList.toggle('active', isEditModeActive);

      const btnToggle = document.getElementById('btnToggleEditMode');
      if (btnToggle) btnToggle.classList.toggle('active', isEditModeActive);

      if (isEditModeActive) {
        showToast('Modo edición activado. Arrastra las tarjetas u oculta bloques específicos.', 'info');
      } else {
        saveCurrentDOMState();
        showToast('Cambios guardados correctamente.', 'success');
      }
    }

    function updateVisibilityBtnUI(cardId, isVisible) {
      const btn = document.getElementById('btnVis_' + cardId);
      if (!btn) return;
      if (isVisible) {
        btn.className = 'btn-toggle-vis is-visible';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Visible</span>';
      } else {
        btn.className = 'btn-toggle-vis is-hidden';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg><span>Oculto</span>';
      }
    }

    function updateSubVisibilityBtnUI(subId, isVisible) {
      const btn = document.getElementById('btnSubVis_' + subId);
      if (!btn) return;
      if (isVisible) {
        btn.className = 'btn-sub-vis is-visible';
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Visible</span>';
      } else {
        btn.className = 'btn-sub-vis is-hidden';
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg><span>Oculto</span>';
      }
    }

    function toggleCardVisibility(cardId) {
      const card = document.getElementById(cardId);
      if (!card) return;
      const willBeHidden = !card.classList.contains('is-hidden-card');
      if (willBeHidden) {
        card.classList.add('is-hidden-card');
      } else {
        card.classList.remove('is-hidden-card');
      }
      updateVisibilityBtnUI(cardId, !willBeHidden);
      saveCurrentDOMState();
      showToast((CARD_TITLES[cardId] || 'Sección') + ': ' + (willBeHidden ? 'Ocultada' : 'Visible'), 'info');
    }

    function toggleSubSectionVisibility(subId) {
      const subEl = document.getElementById(subId);
      if (!subEl) return;
      const willBeHidden = !subEl.classList.contains('is-hidden-sub');
      if (willBeHidden) {
        subEl.classList.add('is-hidden-sub');
      } else {
        subEl.classList.remove('is-hidden-sub');
      }
      updateSubVisibilityBtnUI(subId, !willBeHidden);
      saveCurrentDOMState();
      const title = subEl.getAttribute('data-sub-title') || 'Bloque';
      showToast(title + ': ' + (willBeHidden ? 'Ocultado' : 'Visible'), 'info');
    }

    function moveCard(cardId, direction) {
      const card = document.getElementById(cardId);
      if (!card) return;
      const mainEl = document.querySelector('main');
      const cards = Array.from(mainEl.querySelectorAll('.card'));
      const currentIndex = cards.indexOf(card);

      if (direction === 'up' && currentIndex > 0) {
        mainEl.insertBefore(card, cards[currentIndex - 1]);
        saveCurrentDOMState();
      } else if (direction === 'down' && currentIndex < cards.length - 1) {
        mainEl.insertBefore(cards[currentIndex + 1], card);
        saveCurrentDOMState();
      }
    }

    function saveCurrentDOMState() {
      const mainEl = document.querySelector('main');
      const cards = Array.from(mainEl.querySelectorAll('.card'));
      const order = [];
      const hidden = {};
      const subHidden = {};

      cards.forEach(function(card) {
        const id = card.id;
        if (id) {
          order.push(id);
          hidden[id] = card.classList.contains('is-hidden-card');
        }
      });

      document.querySelectorAll('.sub-section').forEach(function(subEl) {
        if (subEl.id) {
          subHidden[subEl.id] = subEl.classList.contains('is-hidden-sub');
        }
      });

      saveDashboardConfig({ order: order, hidden: hidden, subHidden: subHidden });
    }

    function resetDashboardLayout() {
      const mainEl = document.querySelector('main');
      const tunnelBar = document.getElementById('tunnelBar');

      DEFAULT_CARD_ORDER.forEach(function(cardId) {
        const card = document.getElementById(cardId);
        if (card) {
          card.classList.remove('is-hidden-card');
          updateVisibilityBtnUI(cardId, true);
          if (tunnelBar) {
            mainEl.insertBefore(card, tunnelBar);
          } else {
            mainEl.appendChild(card);
          }
        }
      });

      document.querySelectorAll('.sub-section').forEach(function(subEl) {
        subEl.classList.remove('is-hidden-sub');
        if (subEl.id) updateSubVisibilityBtnUI(subEl.id, true);
      });

      saveDashboardConfig({
        order: [...DEFAULT_CARD_ORDER],
        hidden: {},
        subHidden: {}
      });

      showToast('Secciones y orden restablecidos por defecto.', 'success');
    }

    // Drag & Drop Desktop
    function handleDragStart(e, card) {
      if (!isEditModeActive) {
        e.preventDefault();
        return;
      }
      draggedCard = card;
      card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.id);
    }

    function handleDragOver(e, targetCard) {
      if (!isEditModeActive || !draggedCard || draggedCard === targetCard) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const mainEl = document.querySelector('main');
      const rect = targetCard.getBoundingClientRect();
      const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
      mainEl.insertBefore(draggedCard, next ? targetCard.nextSibling : targetCard);
    }

    function handleDragEnd(e, card) {
      if (card) card.classList.remove('is-dragging');
      card.setAttribute('draggable', 'false');
      draggedCard = null;
      saveCurrentDOMState();
    }

    // Touch Drag para Móviles
    function handleCardTouchStart(e, card) {
      if (!isEditModeActive) return;
      touchActiveCard = card;
      card.classList.add('is-dragging');
      if (navigator.vibrate) navigator.vibrate(20);
    }

    function handleCardTouchMove(e, card) {
      if (!isEditModeActive || !touchActiveCard) return;
      e.preventDefault();
      const touchY = e.touches[0].clientY;
      const touchX = e.touches[0].clientX;
      const elemBelow = document.elementFromPoint(touchX, touchY);
      if (!elemBelow) return;

      const targetCard = elemBelow.closest('.card');
      if (targetCard && targetCard !== touchActiveCard) {
        const mainEl = document.querySelector('main');
        const rect = targetCard.getBoundingClientRect();
        const next = (touchY - rect.top) / (rect.bottom - rect.top) > 0.5;
        mainEl.insertBefore(touchActiveCard, next ? targetCard.nextSibling : targetCard);
      }
    }

    function handleCardTouchEnd(e, card) {
      if (!isEditModeActive || !touchActiveCard) return;
      touchActiveCard.classList.remove('is-dragging');
      touchActiveCard = null;
      saveCurrentDOMState();
    }

    // === GESTIÓN DE MODO AVANZADO (DESBLOQUEO SECRETO DE HERRAMIENTAS WEB) ===
    function isWebToolsUnlocked() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('tools') === '1' || urlParams.get('web') === '1') {
          localStorage.setItem('gw_web_tools_unlocked', '1');
          return true;
        }
        return localStorage.getItem('gw_web_tools_unlocked') === '1';
      } catch (e) {
        return false;
      }
    }

    function applyWebToolsVisibility() {
      const card = document.getElementById('cardBrowser');
      if (!card) return;
      if (isWebToolsUnlocked()) {
        card.classList.remove('secret-hidden');
      } else {
        card.classList.add('secret-hidden');
      }
    }

    let headerClickCount = 0;
    let headerClickTimer = null;
    function handleSecretHeaderClick() {
      headerClickCount++;
      if (headerClickTimer) clearTimeout(headerClickTimer);
      headerClickTimer = setTimeout(() => { headerClickCount = 0; }, 2500);
      if (headerClickCount >= 5) {
        headerClickCount = 0;
        const wasUnlocked = isWebToolsUnlocked();
        if (wasUnlocked) {
          localStorage.removeItem('gw_web_tools_unlocked');
          showToast('Modo estándar activo.', 'info');
        } else {
          localStorage.setItem('gw_web_tools_unlocked', '1');
          showToast('Herramientas web activadas.', 'success');
        }
        applyWebToolsVisibility();
      }
    }

    window.addEventListener('keydown', function(e) {
      if ((e.ctrlKey && e.shiftKey && (e.key === 'U' || e.key === 'u')) ||
          (e.ctrlKey && e.altKey && (e.key === 'A' || e.key === 'a'))) {
        e.preventDefault();
        const wasUnlocked = isWebToolsUnlocked();
        if (wasUnlocked) {
          localStorage.removeItem('gw_web_tools_unlocked');
          showToast('Modo estándar activo.', 'info');
        } else {
          localStorage.setItem('gw_web_tools_unlocked', '1');
          showToast('Herramientas web activadas.', 'success');
        }
        applyWebToolsVisibility();
      }
    });

    document.addEventListener('DOMContentLoaded', applyWebToolsVisibility);
    setTimeout(applyWebToolsVisibility, 100);

    // ==========================================
    // INTERNATIONALIZATION (I18N) SYSTEM
    // ==========================================
        // ==========================================
    // INTERNATIONALIZATION (I18N) SYSTEM
    // ==========================================
    const I18N = {
      en: {
        appTitle: "Gateway Control Center",
        appDesc: "API Gateway & Automation Server",
        installApp: "Install App",
        editModeBanner: "Edit Mode: Drag ⠿ to reorder or use 👁️ to hide/show.",
        btnReset: "Reset",
        btnDone: "Done",
        trackpadTitle: "Virtual Trackpad & Mouse",
        trackpadDesc: "Touchpad navigation, gestures, drag lock, and clicking",
        trackpadSpeed: "Speed:",
        btnFullscreen: "⛶ Fullscreen",
        exitFullscreen: "✖ Exit Fullscreen",
        touchpadHint: "Slide 1 finger to move • Tap for Left Click • Double-tap for 2x • 2 fingers for Right Click",
        scrollStrip: "SCROLL",
        btnLeftClick: "Left Click",
        btnRightClick: "Right Click",
        doubleClick: "Double Click",
        dragLock: "Drag Lock (Hold Down)",
        dragActive: "Drag Active (Click to Release)",
        sensitivity: "Sensitivity:",
        keyboardTitle: "Remote Keyboard & Keystrokes",
        keyboardDesc: "Type phone text at PC cursor and send computer keys",
        typePlaceholder: "Type or dictate text to send to PC...",
        btnSendText: "Send",
        sendOnEnter: "Send on Enter",
        clearOnSend: "Clear after send",
        specialKeys: "Special Computer Keys",
        fnKeysSummary: "Function Keys (F1 - F12)",
        customComboTitle: "Custom Key Combinations",
        customComboDesc: "Combine modifiers with any key",
        comboKeyPlaceholder: "Key (e.g. Esc, Tab, F4, D, W, Enter)...",
        btnSendCombo: "🚀 Send Combo",
        btnUnstickKeys: "🔓 Unstick Keys",
        comboPresets: "Suggestions:",
        browserCardTitle: "Active Browser Keepalive",
        browserCardDesc: "Persistent session and display sleep prevention",
        browserOpenBadge: "Browser: Open",
        browserClosedBadge: "Browser: Closed",
        keepaliveOnBadge: "Keepalive: On",
        keepaliveOffBadge: "Keepalive: Off",
        subBrowserWindow: "Browser Window",
        btnBrowserOpen: "Open Window",
        btnCloseWindow: "Close Window",
        btnMinimize: "Minimize",
        btnRestore: "Restore/View",
        subKeepalive: "Keep Active Session",
        activityIntervalLabel: "Activity Interval (minutes)",
        btnStart: "Start",
        btnTempPause: "Temp Pause",
        btnPause: "Pause",
        tempPauseActiveText: "Scheduled temporary pause:",
        btnResumeNow: "Resume Now",
        subSchedule: "Scheduled Hours",
        lblStartHour: "Start Activity",
        lblEndHour: "End Activity",
        lblAllowedDays: "Allowed Days",
        subAutoClose: "Browser Auto-Close",
        lblCloseHour: "Close Hour",
        lblAutoClose: "Auto-Close",
        subFlexClose: "Flex Close",
        lblDate: "Date",
        subInputTests: "Input Tests (Instant Actions)",
        btnMoveCursor: "Move Cursor",
        btnTestFocus: "Test Focus",
        btnPressShift: "Press Shift",
        systemCardTitle: "System & Diagnostics",
        systemCardDesc: "ScreenGuard, clipboard, screenshots, and native tools",
        subEmulator: "Android Emulator",
        emulatorDesc: "Launch or stop the Android emulator configured in .env from your phone.",
        btnStartEmulator: "Launch",
        btnCloseEmulator: "Close",
        displayControlSub: "Display Control (Physical PC)",
        screenGuardActiveBadge: "Guard Active",
        screenGuardInactiveBadge: "Guard Inactive",
        btnGuardToggleOff: "Disable Guard (Turn On)",
        btnGuardToggleOn: "Turn Off (Guard)",
        btnTurnOnCtrl: "Turn On (Ctrl)",
        btnTurnOffAltX: "Traditional Off (Alt+X)",
        clipboardSub: "PC Clipboard",
        clipPlaceholder: "Text to send to Windows clipboard...",
        btnCopyToPC: "Copy to PC",
        btnReadFromPC: "Read from PC",
        screenshotSub: "Screenshot & Latency",
        btnCaptureScreen: "Capture Screen",
        mediaCardTitle: "Media & Audio Controls",
        mediaCardDesc: "Audio, system brightness, and voice reader (TTS)",
        audioSub: "Audio & Playback Control",
        brightnessSub: "Display Brightness",
        brightnessLevel: "Brightness Level",
        ttsSub: "Remote Voice Reader (TTS)",
        ttsPlaceholder: "Text to speak aloud on PC...",
        btnSpeak: "Speak",
        powerCardTitle: "Power & Session",
        powerCardDesc: "Lock or sleep the computer",
        btnLockPC: "Lock PC",
        btnSleepPC: "Sleep PC",
        restartCardTitle: "Gateway Server",
        restartCardDesc: "Restart gateway and reconnect tunnel",
        btnRestartServer: "Restart",
        fsPromptPlaceholder: "Type prompt for AI / PC cursor...",
        btnSendPrompt: "🚀 Send",
        fsBtnDelete: "Delete (Hold: Lines)",
        fsBtnEnter: "Enter",
        fsBtnShiftEnter: "New Line"
      },
      es: {
        appTitle: "Centro de Control Gateway",
        appDesc: "API Gateway y Servidor de Automatización",
        installApp: "Instalar App",
        editModeBanner: "Modo Edición: Arrastra ⠿ para reordenar o usa 👁️ para ocultar/mostrar.",
        btnReset: "Restablecer",
        btnDone: "Listo",
        trackpadTitle: "Trackpad y Mouse Virtual",
        trackpadDesc: "Navegación táctil, gestos, arrastre y clics",
        trackpadSpeed: "Velocidad:",
        btnFullscreen: "⛶ Pantalla Completa",
        exitFullscreen: "✖ Salir de Pantalla Completa",
        touchpadHint: "Desliza 1 dedo para mover • Tap para Clic Izq • Doble tap para 2x • 2 dedos para Clic Der",
        scrollStrip: "RUEDA",
        btnLeftClick: "Clic Izquierdo",
        btnRightClick: "Clic Derecho",
        doubleClick: "Doble Clic",
        dragLock: "Bloquear Arrastre (Mantener)",
        dragActive: "Arrastre Activo (Clic para Soltar)",
        sensitivity: "Sensibilidad:",
        keyboardTitle: "Teclado Remoto & Pulsaciones",
        keyboardDesc: "Escribe desde el móvil en el cursor de la PC y envía teclas",
        typePlaceholder: "Escribe o dicta texto para enviar a la PC...",
        btnSendText: "Enviar",
        sendOnEnter: "Enviar al pulsar Enter",
        clearOnSend: "Borrar al enviar",
        specialKeys: "Teclas Especiales de PC",
        fnKeysSummary: "Teclas de Función (F1 - F12)",
        customComboTitle: "Combinaciones de Teclas Personalizadas",
        customComboDesc: "Combina modificadores con cualquier tecla",
        comboKeyPlaceholder: "Tecla (ej: Esc, Tab, F4, D, W, Enter)...",
        btnSendCombo: "🚀 Enviar Combinación",
        btnUnstickKeys: "🔓 Soltar Teclas",
        comboPresets: "Sugerencias:",
        browserCardTitle: "Navegador Activo",
        browserCardDesc: "Sesión persistente y prevención de inactividad de pantalla",
        browserOpenBadge: "Navegador: Abierto",
        browserClosedBadge: "Navegador: Cerrado",
        keepaliveOnBadge: "Mantener Activo: On",
        keepaliveOffBadge: "Mantener Activo: Off",
        subBrowserWindow: "Ventana del Navegador",
        btnBrowserOpen: "Abrir Ventana",
        btnCloseWindow: "Cerrar Ventana",
        btnMinimize: "Minimizar",
        btnRestore: "Restaurar/Ver",
        subKeepalive: "Mantener Sesión Activa",
        activityIntervalLabel: "Intervalo de Actividad (minutos)",
        btnStart: "Iniciar",
        btnTempPause: "Pausa Temp",
        btnPause: "Pausar",
        tempPauseActiveText: "Pausa temporal programada:",
        btnResumeNow: "Reanudar Ya",
        subSchedule: "Programación Horaria",
        lblStartHour: "Inicio Actividad",
        lblEndHour: "Fin Actividad",
        lblAllowedDays: "Días Permitidos",
        subAutoClose: "Auto-Cierre del Navegador",
        lblCloseHour: "Hora de Cierre",
        lblAutoClose: "Auto-Cierre",
        subFlexClose: "Cierre Flex",
        lblDate: "Fecha",
        subInputTests: "Pruebas de Entrada (Acciones al Instante)",
        btnMoveCursor: "Mover Cursor",
        btnTestFocus: "Probar Enfoque",
        btnPressShift: "Presionar Shift",
        systemCardTitle: "Sistema & Diagnóstico",
        systemCardDesc: "ScreenGuard y utilidades nativas de Windows",
        subEmulator: "Emulador Android",
        emulatorDesc: "Permite iniciar o cerrar el emulador configurado en .env desde tu celular.",
        btnStartEmulator: "Iniciar",
        btnCloseEmulator: "Cerrar",
        displayControlSub: "Control de Pantalla (PC Físico)",
        screenGuardActiveBadge: "Guardián Activo",
        screenGuardInactiveBadge: "Guardián Inactivo",
        btnGuardToggleOff: "Desactivar Guardián (Encender)",
        btnGuardToggleOn: "Apagar (Guardián)",
        btnTurnOnCtrl: "Encender (Ctrl)",
        btnTurnOffAltX: "Apagar Tradicional (Alt+X)",
        clipboardSub: "Portapapeles de la PC",
        clipPlaceholder: "Texto a enviar al portapapeles de Windows...",
        btnCopyToPC: "Copiar a PC",
        btnReadFromPC: "Leer de PC",
        screenshotSub: "Captura de Pantalla & Latencia",
        btnCaptureScreen: "Capturar Pantalla",
        mediaCardTitle: "Controles Multimedia & Audio",
        mediaCardDesc: "Audio, brillo del sistema y lector de voz (TTS)",
        audioSub: "Control de Audio y Reproducción",
        brightnessSub: "Brillo de Pantalla",
        brightnessLevel: "Nivel de Brillo",
        ttsSub: "Lector de Voz Remoto (TTS)",
        ttsPlaceholder: "Texto para hablar en voz alta en PC...",
        btnSpeak: "Hablar",
        powerCardTitle: "Energía & Pantalla",
        powerCardDesc: "Brillo del monitor y suspensión de la PC",
        btnLockPC: "Bloquear PC",
        btnSleepPC: "Suspender PC",
        restartCardTitle: "Gateway Server",
        restartCardDesc: "Reinicio seguro del proceso desacoplado",
        btnRestartServer: "Reiniciar",
        fsPromptPlaceholder: "Escribe prompt para IA / cursor de PC...",
        btnSendPrompt: "🚀 Enviar",
        fsBtnDelete: "Borrar (Mantener: Líneas)",
        fsBtnEnter: "Enter",
        fsBtnShiftEnter: "Salto Línea"
      }
    };

    let currentLang = localStorage.getItem('dashboard_lang') || 'en';

    function setLanguage(lang) {
      currentLang = lang || 'en';
      localStorage.setItem('dashboard_lang', currentLang);
      const dict = I18N[currentLang] || I18N.en;

      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = dict[key];
          } else {
            el.innerText = dict[key];
          }
        }
      });

      const btn = document.getElementById('btnLangToggle');
      if (btn) btn.innerText = currentLang === 'en' ? '🌐 EN' : '🌐 ES';

      if (isEditModeActive) {
        document.querySelectorAll('.card-edit-title').forEach(span => {
          const card = span.closest('.card');
          if (card && CARD_TITLES[card.id]) {
            const titles = CARD_TITLES[card.id];
            span.textContent = (titles && (titles[currentLang] || titles.en)) || card.id;
          }
        });
      }
    }

    function toggleLanguage() {
      setLanguage(currentLang === 'en' ? 'es' : 'en');
      if (window.lastStatusData) pollGatewayStatus();
    }

    // ==========================================
        // ==========================================
    // VIRTUAL TRACKPAD & MOUSE LOGIC (ROBUST ANTI-FREEZE ENGINE)
    // ==========================================
    let trackpadSensitivity = parseFloat(localStorage.getItem('trackpad_sensitivity') || '1.2');
    let isDragLocked = false;
    let padTouchStartX = 0, padTouchStartY = 0;
    let lastPadTouchX = 0, lastPadTouchY = 0;
    let padGestureStartTime = 0;
    let maxPadTouches = 0;
    let isTwoFingerGesture = false;
    let totalPadMovement = 0;
    let lastSingleTapTime = 0;
    let singleTapTimeout = null;

    let moveAccumDx = 0;
    let moveAccumDy = 0;
    let isMouseSending = false;

    // Anti-Freeze safeFetch helper with AbortController timeout
    async function safeFetch(url, options = {}, timeoutMs = 4000) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    }

    function initTrackpad() {
      const surface = document.getElementById('touchpadSurface');
      const scrollStrip = document.getElementById('touchpadScrollStrip');
      const fsSurface = document.getElementById('fsTouchpadSurface');
      const fsScrollStrip = document.getElementById('fsTouchpadScrollStrip');
      const slider = document.getElementById('sliderSensitivity');
      const label = document.getElementById('trackpadSpeedLabel');

      if (slider) slider.value = trackpadSensitivity;
      if (label) label.innerText = trackpadSensitivity.toFixed(1) + 'x';

      [surface, fsSurface].forEach(surf => {
        if (surf) {
          surf.addEventListener('touchstart', handlePadTouchStart, { passive: false });
          surf.addEventListener('touchmove', handlePadTouchMove, { passive: false });
          surf.addEventListener('touchend', handlePadTouchEnd, { passive: false });
          surf.addEventListener('touchcancel', handlePadTouchEnd, { passive: false });
          surf.addEventListener('click', (e) => {
            if (e.pointerType === 'mouse' || (!('ontouchstart' in window) && e.detail === 1)) {
              sendMouseClick('left');
            }
          });
        }
      });

      [scrollStrip, fsScrollStrip].forEach(strip => {
        if (strip) {
          let scrollStartY = 0;
          strip.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            if (e.touches.length > 0) scrollStartY = e.touches[0].clientY;
          }, { passive: true });

          strip.addEventListener('touchmove', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (e.touches.length > 0) {
              const curY = e.touches[0].clientY;
              const deltaY = scrollStartY - curY;
              if (Math.abs(deltaY) > 6) {
                sendMouseScroll(Math.round(deltaY * 5));
                scrollStartY = curY;
              }
            }
          }, { passive: false });
        }
      });
      initContinuousBackspace();
    }

    function changeTrackpadSensitivity(val) {
      trackpadSensitivity = parseFloat(val) || 1.2;
      localStorage.setItem('trackpad_sensitivity', trackpadSensitivity);
      const label = document.getElementById('trackpadSpeedLabel');
      if (label) label.innerText = trackpadSensitivity.toFixed(1) + 'x';
      const fsBadge = document.getElementById('fsSpeedBadge');
      if (fsBadge) fsBadge.innerText = trackpadSensitivity.toFixed(1) + 'x';
    }

    function autoGrowFsTextarea(el) {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(Math.max(el.scrollHeight, 38), 120) + 'px';
    }

    function clearFsPrompt() {
      const input = document.getElementById('fsPromptInput');
      if (input) {
        input.value = '';
        input.style.height = '38px';
        input.focus();
      }
    }

    async function sendFullscreenPrompt() {
      const input = document.getElementById('fsPromptInput');
      if (!input) return;
      const text = input.value;
      if (!text || !text.trim()) {
        showToast(currentLang === 'es' ? 'Escribe algo primero' : 'Type something first', 'warning');
        return;
      }
      try {
        const res = await safeFetch('/system/keyboard/type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, paste: true })
        }, 3500);
        const data = await res.json();
        if (res.ok && data.status === 'ok') {
          showToast(currentLang === 'es' ? 'Prompt enviado 🚀' : 'Prompt sent 🚀', 'success');
          input.value = '';
          input.style.height = '38px';
        } else {
          showToast(data.message || 'Error', 'error');
        }
      } catch (err) {
        showToast(currentLang === 'es' ? 'Error al enviar prompt' : 'Failed to send prompt', 'error');
      }
    }

    function initContinuousBackspace() {
      const btn = document.getElementById('fsBtnBackspace');
      if (!btn) return;

      let timer = null;
      let interval = null;
      let isHolding = false;
      let holdStartTime = 0;
      let lineDeleteCount = 0;
      let defaultLabel = '';

      function sendDelete(key) {
        safeFetch('/system/keyboard/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        }, 1200).catch(() => {});
      }

      function startPress(e) {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        if (isHolding) return;
        isHolding = true;
        holdStartTime = Date.now();
        lineDeleteCount = 0;
        defaultLabel = btn.innerHTML;

        btn.style.background = 'rgba(239, 68, 68, 0.3)';
        btn.style.borderColor = '#ef4444';

        // 1. Immediate single backspace
        sendDelete('backspace');

        // 2. Schedule continuous deletion
        timer = setTimeout(() => {
          interval = setInterval(() => {
            if (!isHolding) return;
            const elapsed = Date.now() - holdStartTime;
            if (elapsed > 1100) {
              lineDeleteCount++;
              sendDelete('delline');
              const label = currentLang === 'es' ? 'Líneas' : 'Lines';
              btn.innerHTML = '⌫ ' + label + ' (x' + lineDeleteCount + ')';
            } else if (elapsed > 350) {
              sendDelete('ctrl+backspace');
              const label = currentLang === 'es' ? 'Palabras...' : 'Words...';
              btn.innerHTML = '⌫ ' + label;
            } else {
              sendDelete('backspace');
            }
          }, 140);
        }, 320);
      }

      function endPress(e) {
        if (!isHolding) return;
        isHolding = false;
        if (timer) { clearTimeout(timer); timer = null; }
        if (interval) { clearInterval(interval); interval = null; }

        btn.style.background = '';
        btn.style.borderColor = '';
        if (defaultLabel) {
          btn.innerHTML = defaultLabel;
        }

        // Auto-release any stuck modifiers
        safeFetch('/system/keyboard/reset', { method: 'POST' }, 1200).catch(() => {});
      }

      btn.addEventListener('pointerdown', startPress, { passive: false });
      btn.addEventListener('pointerup', endPress, { passive: false });
      btn.addEventListener('pointercancel', endPress, { passive: false });
      btn.addEventListener('pointerleave', endPress, { passive: false });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function toggleCardCollapse(cardId, e) {
      if (typeof isEditModeActive !== 'undefined' && isEditModeActive) return;
      if (e && e.target && e.target.closest('button, input, select, a, .card-edit-bar')) {
        return;
      }
      const card = document.getElementById(cardId);
      if (!card) return;
      card.classList.toggle('is-collapsed');
    }

    function enterTrackpadFullscreen() {
      const overlay = document.getElementById('trackpadFullscreenOverlay');
      if (overlay) {
        overlay.style.display = 'flex';
        const fsBadge = document.getElementById('fsSpeedBadge');
        if (fsBadge) fsBadge.innerText = trackpadSensitivity.toFixed(1) + 'x';

        // Mobile back button / swipe gesture integration
        try {
          if (!history.state || !history.state.isFullscreenTrackpad) {
            history.pushState({ isFullscreenTrackpad: true }, '');
          }
        } catch (e) {}

        const docEl = document.documentElement;
        if (docEl.requestFullscreen) docEl.requestFullscreen().catch(() => {});
        else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen().catch(() => {});
      }
    }

    function exitTrackpadFullscreen(fromPopstate = false) {
      const overlay = document.getElementById('trackpadFullscreenOverlay');
      if (overlay) {
        overlay.style.display = 'none';
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
          document.webkitExitFullscreen().catch(() => {});
        }

        if (!fromPopstate && history.state && history.state.isFullscreenTrackpad) {
          try {
            history.back();
          } catch (e) {}
        }
      }
    }

    window.addEventListener('popstate', () => {
      const overlay = document.getElementById('trackpadFullscreenOverlay');
      if (overlay && overlay.style.display !== 'none') {
        exitTrackpadFullscreen(true);
      }
    });

    function handlePadTouchStart(e) {
      e.preventDefault();
      if (e.touches.length > maxPadTouches) {
        maxPadTouches = e.touches.length;
      }
      if (e.touches.length === 2) {
        isTwoFingerGesture = true;
      }

      if (e.touches.length === 1) {
        padTouchStartX = e.touches[0].clientX;
        padTouchStartY = e.touches[0].clientY;
        lastPadTouchX = padTouchStartX;
        lastPadTouchY = padTouchStartY;
        padGestureStartTime = Date.now();
        totalPadMovement = 0;
      } else if (e.touches.length === 2) {
        padTouchStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        padTouchStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        lastPadTouchX = padTouchStartX;
        lastPadTouchY = padTouchStartY;
        padGestureStartTime = Date.now();
      }
    }

    function handlePadTouchMove(e) {
      e.preventDefault();
      if (e.touches.length > maxPadTouches) {
        maxPadTouches = e.touches.length;
      }

      if (e.touches.length === 1 && !isTwoFingerGesture) {
        const curX = e.touches[0].clientX;
        const curY = e.touches[0].clientY;
        const dx = (curX - lastPadTouchX) * trackpadSensitivity;
        const dy = (curY - lastPadTouchY) * trackpadSensitivity;
        totalPadMovement += Math.abs(curX - lastPadTouchX) + Math.abs(curY - lastPadTouchY);
        lastPadTouchX = curX;
        lastPadTouchY = curY;

        moveAccumDx += dx;
        moveAccumDy += dy;
        requestFlushMouseMove();
      } else if (e.touches.length === 2) {
        isTwoFingerGesture = true;
        const curY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const deltaY = lastPadTouchY - curY;
        totalPadMovement += Math.abs(deltaY);
        lastPadTouchY = curY;

        if (Math.abs(deltaY) > 5) {
          sendMouseScroll(Math.round(deltaY * 5));
        }
      }
    }

    function requestFlushMouseMove() {
      if (isMouseSending) return;

      const sendX = Math.trunc(moveAccumDx);
      const sendY = Math.trunc(moveAccumDy);
      if (sendX === 0 && sendY === 0) return;

      moveAccumDx -= sendX;
      moveAccumDy -= sendY;

      isMouseSending = true;
      safeFetch('/system/mouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'move', dx: sendX, dy: sendY })
      }, 1000).catch(() => {}).finally(() => {
        isMouseSending = false;
        if (Math.trunc(moveAccumDx) !== 0 || Math.trunc(moveAccumDy) !== 0) {
          requestFlushMouseMove();
        }
      });
    }

    function handlePadTouchEnd(e) {
      e.preventDefault();
      if (e.touches.length > 0) return;

      const elapsed = Date.now() - padGestureStartTime;
      requestFlushMouseMove();

      if (isTwoFingerGesture) {
        // Two-finger tap: RIGHT CLICK (generous threshold for mobile digitizers)
        if (elapsed < 500 && totalPadMovement < 60) {
          if (singleTapTimeout) { clearTimeout(singleTapTimeout); singleTapTimeout = null; }
          sendMouseClick('right');
          showToast(currentLang === 'es' ? 'Clic Derecho (2 dedos)' : 'Right Click (2 fingers)', 'info');
          if (navigator.vibrate) navigator.vibrate(40);
        }
      } else if (maxPadTouches === 1) {
        // Single finger tap
        if (elapsed < 420 && totalPadMovement < 35) {
          const now = Date.now();
          if (now - lastSingleTapTime < 320) {
            // Double tap -> DOUBLE CLICK
            if (singleTapTimeout) { clearTimeout(singleTapTimeout); singleTapTimeout = null; }
            lastSingleTapTime = 0;
            sendMouseDoubleClick();
            showToast(currentLang === 'es' ? 'Doble Clic' : 'Double Click', 'info');
            if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
          } else {
            lastSingleTapTime = now;
            singleTapTimeout = setTimeout(() => {
              singleTapTimeout = null;
              sendMouseClick('left');
              if (navigator.vibrate) navigator.vibrate(30);
            }, 200);
          }
        }
      }

      maxPadTouches = 0;
      isTwoFingerGesture = false;
      totalPadMovement = 0;
    }

    async function sendMouseClick(button) {
      try {
        await safeFetch('/system/mouse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'click', button })
        }, 2000);
      } catch (e) {}
    }

    async function sendMouseDoubleClick() {
      try {
        await safeFetch('/system/mouse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'double-click', button: 'left' })
        }, 2000);
      } catch (e) {}
    }

    async function sendMouseScroll(deltaY) {
      try {
        await safeFetch('/system/mouse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'scroll', deltaY })
        }, 1500);
      } catch (e) {}
    }

    async function toggleDragLock() {
      isDragLocked = !isDragLocked;
      const action = isDragLocked ? 'down' : 'up';
      try {
        await safeFetch('/system/mouse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, button: 'left' })
        }, 2000);

        const dict = I18N[currentLang] || I18N.en;
        const icon = isDragLocked ? '🔒' : '🔓';
        const txt = isDragLocked ? dict.dragActive : dict.dragLock;

        const iconEl = document.getElementById('dragLockIcon');
        const textEl = document.getElementById('dragLockText');
        const btn = document.getElementById('btnDragLock');
        if (iconEl) iconEl.innerText = icon;
        if (textEl) textEl.innerText = txt;
        if (btn) {
          btn.style.background = isDragLocked ? 'rgba(239, 68, 68, 0.2)' : '';
          btn.style.borderColor = isDragLocked ? 'var(--danger)' : '';
          btn.style.color = isDragLocked ? '#f87171' : '';
        }

        const fsIconEl = document.getElementById('fsDragLockIcon');
        const fsTextEl = document.getElementById('fsDragLockText');
        const fsBtn = document.getElementById('fsBtnDragLock');
        if (fsIconEl) fsIconEl.innerText = icon;
        if (fsTextEl) fsTextEl.innerText = txt;
        if (fsBtn) {
          fsBtn.style.background = isDragLocked ? 'rgba(239, 68, 68, 0.25)' : '';
          fsBtn.style.borderColor = isDragLocked ? 'var(--danger)' : '';
          fsBtn.style.color = isDragLocked ? '#f87171' : '';
        }
      } catch (e) {}
    }

    // ==========================================
    // REMOTE KEYBOARD & CUSTOM COMBINATIONS LOGIC
    // ==========================================
    const activeModifiers = new Set();
    let modifierAutoClearTimer = null;
    let modifierCountdownInterval = null;
    let modifierSecondsLeft = 0;

    function resetActiveModifiers() {
      if (modifierAutoClearTimer) { clearTimeout(modifierAutoClearTimer); modifierAutoClearTimer = null; }
      if (modifierCountdownInterval) { clearInterval(modifierCountdownInterval); modifierCountdownInterval = null; }
      activeModifiers.clear();
      ['modCtrl', 'modAlt', 'modShift', 'modWin'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.style.background = '';
          btn.style.borderColor = '';
          btn.style.color = '';
        }
      });
      const timerEl = document.getElementById('modifierTimerBadge');
      if (timerEl) timerEl.style.display = 'none';
    }

    function startModifierTimer() {
      if (modifierAutoClearTimer) clearTimeout(modifierAutoClearTimer);
      if (modifierCountdownInterval) clearInterval(modifierCountdownInterval);

      if (activeModifiers.size === 0) {
        const timerEl = document.getElementById('modifierTimerBadge');
        if (timerEl) timerEl.style.display = 'none';
        return;
      }

      modifierSecondsLeft = 8;
      const timerEl = document.getElementById('modifierTimerBadge');
      if (timerEl) {
        timerEl.style.display = 'inline-flex';
        timerEl.innerText = '⏱️ ' + modifierSecondsLeft + 's';
      }

      modifierCountdownInterval = setInterval(() => {
        modifierSecondsLeft--;
        if (modifierSecondsLeft <= 0) {
          clearInterval(modifierCountdownInterval);
          modifierCountdownInterval = null;
        } else if (timerEl) {
          timerEl.innerText = '⏱️ ' + modifierSecondsLeft + 's';
        }
      }, 1000);

      modifierAutoClearTimer = setTimeout(() => {
        resetActiveModifiers();
        showToast(currentLang === 'es' ? 'Modificadores desactivados por inactividad' : 'Modifiers cleared by timer', 'info');
      }, 8000);
    }

    function toggleModifier(mod) {
      const idMap = { ctrl: 'modCtrl', alt: 'modAlt', shift: 'modShift', win: 'modWin' };
      const btn = document.getElementById(idMap[mod]);
      if (activeModifiers.has(mod)) {
        activeModifiers.delete(mod);
        if (btn) {
          btn.style.background = '';
          btn.style.borderColor = '';
          btn.style.color = '';
        }
      } else {
        activeModifiers.add(mod);
        if (btn) {
          btn.style.background = 'rgba(99, 102, 241, 0.25)';
          btn.style.borderColor = 'var(--accent-primary)';
          btn.style.color = '#818cf8';
        }
      }
      startModifierTimer();
    }

    function setCustomKey(key) {
      const input = document.getElementById('inputCustomKey');
      if (input) {
        input.value = key;
        input.focus();
      }
    }

    function sendCustomCombination() {
      const input = document.getElementById('inputCustomKey');
      const key = input ? input.value.trim() : '';
      const mods = Array.from(activeModifiers);

      if (mods.length === 0 && !key) {
        showToast(currentLang === 'es' ? 'Selecciona un modificador o escribe una tecla' : 'Select a modifier or enter a key', 'warning');
        return;
      }

      const parts = [...mods];
      if (key) parts.push(key);
      const combo = parts.join('+');
      sendKey(combo);

      // Auto-clear active modifiers and timer once combo is sent!
      resetActiveModifiers();
    }

    async function resetStuckKeys() {
      resetActiveModifiers();
      try {
        await safeFetch('/system/keyboard/reset', { method: 'POST' }, 2000);
        showToast(currentLang === 'es' ? 'Teclas liberadas (Reset OK)' : 'Keys released (Reset OK)', 'success');
        if (navigator.vibrate) navigator.vibrate(30);
      } catch (e) {
        showToast(currentLang === 'es' ? 'Error al liberar teclas' : 'Failed to reset keys', 'error');
      }
    }

    async function sendRemoteText() {
      const input = document.getElementById('inputRemoteText');
      if (!input) return;
      const text = input.value;
      if (!text) return;

      try {
        const res = await safeFetch('/system/keyboard/type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        }, 3000);

        if (res.ok) {
          showToast((currentLang === 'es' ? 'Texto enviado: ' : 'Text typed: ') + (text.length > 25 ? text.substring(0, 25) + '...' : text), 'success');
          const chkClear = document.getElementById('chkClearOnSend');
          if (chkClear && chkClear.checked) {
            input.value = '';
          }
        }
      } catch (e) {
        showToast(currentLang === 'es' ? 'Error al enviar texto' : 'Failed to send text', 'error');
      }
    }

    function handleRemoteTextKeyDown(e) {
      if (e.key === 'Enter') {
        const chkSend = document.getElementById('chkSendOnEnter');
        if (chkSend && chkSend.checked) {
          e.preventDefault();
          sendRemoteText();
        }
      }
    }

    async function sendKey(key) {
      try {
        const res = await safeFetch('/system/keyboard/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        }, 3000);
        if (res.ok) {
          showToast(key.toUpperCase(), 'info');
        }
      } catch (e) {
        showToast((currentLang === 'es' ? 'Error al presionar: ' : 'Failed key: ') + key, 'error');
      }
    }

    // === PWA & SERVICE WORKER INSTALLATION ===
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const btnInstall = document.getElementById('btnInstallPwa');
      if (btnInstall) {
        btnInstall.style.display = 'inline-flex';
      }
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      const btnInstall = document.getElementById('btnInstallPwa');
      if (btnInstall) btnInstall.style.display = 'none';
      showToast(currentLang === 'es' ? 'App instalada con éxito' : 'App installed successfully', 'success');
    });

    function triggerPwaInstall() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((choiceResult) => {
          if (choiceResult && choiceResult.outcome === 'accepted') {
            console.log('PWA installation accepted');
          }
          deferredInstallPrompt = null;
          const btnInstall = document.getElementById('btnInstallPwa');
          if (btnInstall) btnInstall.style.display = 'none';
        });
      } else {
        showToast(currentLang === 'es' ? 'Usa el menú de Brave (...) y toca "Instalar aplicación" o "Agregar a inicio"' : 'Use Brave menu (...) and tap "Install app" or "Add to Home screen"', 'info');
      }
    }

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
          .then((reg) => console.log('Gateway PWA ServiceWorker registered with scope:', reg.scope))
          .catch((err) => console.error('Gateway PWA ServiceWorker registration failed:', err));
      });
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

// Ruta principal GET /`;

app.get('/', (req, res) => {
  let cookieKey = getApiKeyFromCookie(req.headers.cookie);
  const queryKey = req.query.key || req.query.api_key;

  const cookies = ['ngrok-skip-browser-warning=true; Path=/; Max-Age=31536000; SameSite=Lax; Secure'];

  if (queryKey === API_KEY) {
    cookies.push(`api_key=${encodeURIComponent(queryKey)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    cookieKey = queryKey;
  }

  res.setHeader('Set-Cookie', cookies);

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
  if (browserCloseEnabled && browserCloseHour) {
    const [closeHH, closeMM] = browserCloseHour.split(':').map(Number);
    const nowTotalMins = now.getHours() * 60 + now.getMinutes();
    const closeTotalMins = closeHH * 60 + closeMM;
    const minuteKey = `${HH}:${mm}`;

    if (nowTotalMins >= closeTotalMins && lastAutoCierreMinute !== minuteKey) {
      // Solo actuar si estamos dentro del mismo minuto o lo pasamos (y no se actuo hoy ya)
      const diffMins = nowTotalMins - closeTotalMins;
      if (diffMins <= 1) { // hasta 1 minuto de gracia
        lastAutoCierreMinute = minuteKey;
        if (browserContext || browserAbierto) {
          log(`Cron Horario: Auto-cierre del navegador programado a las ${browserCloseHour} (ahora ${currentTimeString}).`);
          await cleanupBrowserSession();
        }
        exec('taskkill /f /im emulator.exe & taskkill /f /im qemu-system-x86_64.exe', (error) => {});
      }
    } else if (nowTotalMins < closeTotalMins) {
      lastAutoCierreMinute = null; // resetear para el proximo dia
    }
  }

  // 1.B. Auto-cierre Flex por fecha y hora específica
  if (browserFlexCloseEnabled && browserFlexCloseDate && browserFlexCloseHour) {
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const todayDateString = `${YYYY}-${MM}-${DD}`;
    const minuteKey = `${todayDateString} ${HH}:${mm}`;

    if (todayDateString === browserFlexCloseDate && currentTimeString >= browserFlexCloseHour && lastFlexCierreMinute !== minuteKey) {
      const [closeHH, closeMM] = browserFlexCloseHour.split(':').map(Number);
      const nowTotalMins = now.getHours() * 60 + now.getMinutes();
      const closeTotalMins = closeHH * 60 + closeMM;
      const diffMins = nowTotalMins - closeTotalMins;

      if (diffMins <= 1) {
        lastFlexCierreMinute = minuteKey;
        browserFlexCloseEnabled = false;
        saveSimulationState();

        if (browserContext || browserAbierto) {
          log(`Cron Horario: Cierre Flex del navegador ejecutado para la fecha ${browserFlexCloseDate} a las ${browserFlexCloseHour} (ahora ${currentTimeString}).`);
          await cleanupBrowserSession();
        }
        exec('taskkill /f /im emulator.exe & taskkill /f /im qemu-system-x86_64.exe', (error) => {});
      }
    }
  }

  // 2. Auto-cierre/pausa por estar fuera del horario general de la simulacion
  if (browserPresenciaActiva) {
    if (!isSimulationInSchedule()) {
      // Si estamos fuera de horario, asegurar que el navegador y el emulador esten cerrados
      if (browserContext || browserAbierto) {
        log('Cron Horario: Cerrando navegador web por estar fuera de horario programado.');
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
          authtoken: token,
          request_header_add: ['ngrok-skip-browser-warning: true']
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
