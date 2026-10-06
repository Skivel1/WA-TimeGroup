# SkiBot (Docker)

Bot de WhatsApp (whatsapp-web.js + Chromium del sistema) listo para correr en Docker / Portainer.

## Contenido
- `index.js` — bot consolidado (reemplaza SkiBot2.js; `handlers/`, `commands/`, `utils/`, `Skibot1.js`, `Skibot3.js` y `eventos.json` ya no se usan)
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`

## Variables de entorno
| Variable | Descripción |
|---|---|
| `OWNER_NUMBER` | Tu número a 10 dígitos, sin +52 (obligatoria) |
| `BOT_NAME` | Nombre mostrado en `!skibot` (default `Skibot`) |
| `TZ` | Zona horaria del contenedor (default `America/Mexico_City`) |
| `LOG_MESSAGES` | `true` para loguear TODOS los mensajes (solo debug) |

## Desplegar

### Opción A: Portainer con Git (recomendada)
1. Sube esta carpeta a un repo privado (el `.gitignore` ya excluye sesión y `.env`).
2. Portainer → Stacks → Add stack → Repository → apunta al repo (compose path `docker-compose.yml`).
3. En *Environment variables* define `OWNER_NUMBER`. Deploy.

### Opción B: construir en el servidor
```bash
scp -r skibot-docker/ usuario@servidor:~/skibot && ssh usuario@servidor
cd ~/skibot && cp .env.example .env && nano .env
docker compose up -d --build
```
Si luego quieres administrarlo en Portainer, el contenedor aparece solo en *Containers*.

## Primer arranque (QR)
```bash
docker logs -f skibot
```
Escanea el QR desde WhatsApp → Dispositivos vinculados. La sesión queda en el volumen `skibot_data`, así que no se repite al reiniciar.

### Reusar tu sesión de Windows (opcional, evita escanear)
Con el contenedor detenido, copia tu carpeta `.wwebjs_auth` al volumen:
```bash
docker compose up --no-start
docker cp ./.wwebjs_auth skibot:/app/data/
docker run --rm -v skibot_data:/d alpine chown -R 1000:1000 /d
docker compose up -d
```
(No siempre funciona entre sistemas; si falla, borra la carpeta del volumen y escanea el QR.)

## Qué cambió respecto a SkiBot2.js
- Los mensajes que no son comandos se descartan **sin** llamar al navegador (antes: `getChat`, `getContact` y verificación de admin en cada mensaje).
- `!encuesta` por DM ahora es **solo owner** (antes cualquiera podía hacer que el bot enviara encuestas a todos los grupos). También acepta `cancelar` y valida fecha/hora reales.
- Admin se calcula solo en `!skibot` y `!encuesta roles`; coincidencia exacta por últimos 10 dígitos (se quitó el match por sufijo de 8 dígitos).
- Cierre limpio con `SIGTERM`, limpieza de `SingletonLock`, salida automática en `disconnected`/`auth_failure`, watchdog cada 5 min y `HEALTHCHECK`.
- Estado de encuestas con TTL de 10 min, guardando solo id y nombre del grupo; mapas con limpieza periódica.
- Cooldown de 3 s por usuario y comando en comandos públicos.
- Logs mínimos (solo comandos) + rotación de logs en el compose.
- Número del owner por variable de entorno, no en el código.

## Notas
- Si cambias el límite de RAM (1 GB), no bajes de ~700 MB: Chromium + WhatsApp Web lo necesitan.
- Para actualizar: `docker compose up -d --build` (la sesión persiste).
- El bot es no oficial (whatsapp-web.js); evita envíos masivos desde este número.
