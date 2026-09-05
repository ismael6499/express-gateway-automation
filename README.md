# Local API Gateway & Automation Server

Este proyecto es un servidor unificado desarrollado en Express.js que actúa como un API Gateway local seguro. Proporciona automatización web para Browser Session y simulación de control de climatización.

## Requisitos Previos

- [Node.js](https://nodejs.org/) (versión 18 o superior recomendada)
- Instalar dependencias del proyecto y de Playwright:

```bash
npm install
npx playwright install chromium
```

## Configuración

Copia o renombra el archivo `.env.example` (o crea un archivo `.env`) en la raíz del proyecto y ajusta las siguientes variables:

```env
PORT=3000
API_KEY=tu-clave-api-segura
```

## Ejecución

Para iniciar el servidor local en modo desarrollo/producción:

```bash
npm start
```

El servidor estará escuchando por defecto en `http://localhost:3000`.

## Endpoints y Ejemplos de Uso

Todas las solicitudes entrantes requieren el encabezado de autenticación `X-API-KEY`.

### 1. Control de Presencia en Browser: `POST /browser/status`

Controla la sesión del navegador para mantener activo el estado de Browser.

- **Activar**: Inicia un navegador Chromium persistente (visible) que guarda la sesión en `./browser_user_data`, navega a Browser y simula actividad cada 4 minutos haciendo clic en `#search-input-selector`.

  ```bash
  curl -X POST http://localhost:3000/browser/status \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api-segura" \
    -d '{"estado": "activo"}'
  ```

- **Desactivar**: Cierra el navegador y destruye el intervalo de actividad para evitar fugas de memoria.

  ```bash
  curl -X POST http://localhost:3000/browser/status \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api-segura" \
    -d '{"estado": "inactivo"}'
  ```

### 2. Control de Climatización: `POST /aire/encender`

Enciende el dispositivo 'Agustin Air Conditioner' con el modo especificado. La velocidad del flujo de aire se fuerza obligatoriamente en `alta`.

- **Mapeo de modos**:
  - Sin modo especificado -> `cooling`
  - `ventilador` o `fan` -> `fan-only`
  - `seco` o `dry` -> `dry`

  ```bash
  curl -X POST http://localhost:3000/aire/encender \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api-segura" \
    -d '{"modo": "ventilador"}'
  ```

### 3. Ciclo Crítico de Reinicio: `POST /aire/reiniciar`

Ejecuta el ciclo de reinicio de 20 segundos para 'Agustin Air Conditioner'. Envia señal de encendido inmediatamente, espera exactamente 20 segundos y envia la señal de apagado.

```bash
curl -X POST http://localhost:3000/aire/reiniciar \
  -H "X-API-KEY: tu-clave-api-segura"
```

### 4. Control de Pantalla y Guardián Inteligente: `POST /sistema/teclado`

Permite apagar la pantalla física protegiéndola contra despertares espurios provocados por notificaciones de Windows o sesiones de escritorio remoto (ScreenConnect).

- **Activar Guardián (Apagar y Proteger)**:
  ```bash
  curl -X POST http://localhost:3000/sistema/teclado \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api-segura" \
    -d '{"accion": "apagar-guardia"}'
  ```

- **Encender Pantalla / Desactivar Guardián**:
  ```bash
  curl -X POST http://localhost:3000/sistema/teclado \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api-segura" \
    -d '{"accion": "encender-pantalla"}'
  ```

- **Consultar Estado del Guardián**:
  ```bash
  curl -X POST http://localhost:3000/sistema/teclado \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: tu-clave-api-segura" \
    -d '{"accion": "estado-guardia"}'
  ```

