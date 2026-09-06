# Local API Gateway & Workspace Automation Server

Servidor unificado en Express.js diseñado como un **API Gateway local** seguro para la automatización de tareas en el entorno de trabajo, administración remota de energía y periféricos, y control de dispositivos domésticos.

## Características Principales

- **ScreenGuard Inteligente (Gestión de Pantalla)**:
  - Bloqueo y apagado de monitores físicos mediante un helper nativo Win32 en C#.
  - Protección activa contra notificaciones toast de Windows o eventos del sistema que enciendan la pantalla de manera accidental.
  - Soporte de baja luminosidad para Escritorio Remoto (Google Remote Desktop / ScreenConnect): reduce el brillo del monitor al 0% vía WMI para mantener el espacio en penumbra y re-apaga el monitor físico tras 12 segundos de inactividad remota.
  - Despertar inmediato por interacción con hardware físico (pulsación de tecla real o movimiento deliberado de mouse).
- **Controles Multimedia y Audio**:
  - Ajuste de volumen y silenciamiento a través de helper nativo COM/CoreAudio.
  - Control de reproducción multimedia (Play/Pausa, Siguiente, Anterior).
  - Reproductor de Texto a Voz (TTS) local con síntesis de voz nativa del sistema.
  - Control de brillo de monitor por hardware vía WMI (`WmiMonitorBrightnessMethods`).
- **Portapapeles y Captura Remota**:
  - Lectura y escritura remota en el portapapeles de Windows con soporte UTF-8 completo.
  - Capturas de pantalla instantáneas multimonitor con corrección de DPI para monitoreo visual de tareas.
- **Automatización de Dispositivos**:
  - Integración para control de climatización y ciclos de reinicio de aire acondicionado.
  - Ejecución y control de aplicaciones y emuladores.
- **Acceso Remoto Seguro**:
  - Panel web responsivo con diseño Glassmorphism optimizado para dispositivos móviles y escritorio.
  - Autenticación por cookie segura Set-Cookie del lado del servidor o cabecera `X-API-KEY`.
  - Integración nativa con túneles seguros ngrok y dominio estático.

---

## Requisitos Previos

- [Node.js](https://nodejs.org/) (versión 18 o superior recomendada).
- [Git](https://git-scm.com/).
- Instalar dependencias del proyecto:

```bash
npm install
```

---

## Configuración

1. Copia el archivo de plantilla `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Modifica los valores en `.env` según tu entorno:
   ```env
   PORT=3000
   API_KEY=tu-clave-api-segura
   NGROK_AUTHTOKEN=tu-token-de-ngrok
   NGROK_DOMAIN=tu-subdominio-estatico.ngrok-free.dev
   ```

---

## Ejecución

Para iniciar el servidor:

```bash
npm start
```

El servidor estará escuchando de forma predeterminada en `http://localhost:3000`.

---

## Endpoints Principales

Todas las peticiones API requieren autenticación mediante la cabecera `X-API-KEY` o mediante la sesión iniciada en la interfaz web.

### 1. Control de Pantalla y Guardián Inteligente: `POST /sistema/teclado`

- **Activar Guardián (Apagar y Proteger)**:
  ```bash
  curl -X POST http://localhost:3000/sistema/teclado \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api" \
    -d '{"accion": "apagar-guardia"}'
  ```
- **Encender Pantalla / Desactivar Guardián**:
  ```bash
  curl -X POST http://localhost:3000/sistema/teclado \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api" \
    -d '{"accion": "encender-pantalla"}'
  ```

### 2. Controles de Sistema y Portapapeles

- **Leer Portapapeles**: `GET /sistema/portapapeles`
- **Escribir en Portapapeles**:
  ```bash
  curl -X POST http://localhost:3000/sistema/portapapeles \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api" \
    -d '{"text": "Texto a enviar"}'
  ```
- **Captura de Pantalla**: `GET /sistema/screenshot`

### 3. Audio, Brillo y Multimedia

- **Control de Reproducción**: `POST /sistema/media` con `{"accion": "playpause"}` (o `next`, `prev`, `togglemute`).
- **Ajustar Brillo de Monitor**: `POST /sistema/brillo` con `{"brillo": 50}` (0 a 100%).
- **Texto a Voz (TTS)**: `POST /sistema/tts` con `{"texto": "Hola mundo"}`.

### 4. Climatización: `POST /aire/encender` y `POST /aire/reiniciar`

- Control y ciclos de reinicio para unidades de aire acondicionado compatibles.

---

## Licencia

Distribuido bajo la Licencia MIT.
