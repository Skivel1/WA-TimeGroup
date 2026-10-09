# SkiBot (Docker)

Bot de WhatsApp (whatsapp-web.js + Chromium del sistema) listo para correr en Docker / Portainer.

## Contenido
- `index.js` — bot consolidado (reemplaza SkiBot2.js; `handlers/`, `commands/`, `utils/`, `Skibot1.js`, `Skibot3.js` y `eventos.json` ya no se usan)
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`

## Variables de entorno
| Variable | Descripción |
|---|---|
| `OWNER_NUMBER` | Tu número a 10 dígitos, sin +52 (obligatoria) |
| `ADMIN_NUMBERS` | Opcional: admins fijos (10 dígitos, separados por coma) que pueden usar `!skibot` y `!encuesta roles` aunque WhatsApp Web falle al listar admins |
| `OWNER_IDS` | Opcional: tus IDs exactos (los ves con `!id`), p. ej. `123456789012345@lid`. Te dan permisos de owner sin consultar a WhatsApp Web |
| `ADMIN_IDS` | Opcional: igual que `OWNER_IDS` pero solo para comandos de admin. Acepta IDs exactos (`123456789012345@lid`) **o teléfonos** (`528123456789`), separados por coma, espacio o `;` |
| `PUBLIC_COMMANDS` | `false` (default): solo la lista usa comandos; el resto se ignora sin responder. `true`: `!comandos`, `!link gremio`, `!discord gremio`, `!iniciales gremio`, `Consultar hora` y `!id` quedan abiertos a todos (`!skibot`, `!encuesta` y `!encuesta roles` siguen solo para la lista) |
| `ALLOW_GROUP_ADMINS` | `true` (default): además de la lista, los **administradores del grupo** de WhatsApp pueden usar los comandos (se detectan por ID y por teléfono, con caché de 60 s). `false`: solo la lista |
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

## Solución de problemas
- `Error ... r: r ... getChatById`: WhatsApp Web rechazó la consulta del chat (suele pasar justo tras vincular, mientras sincroniza). El bot reintenta 3 veces y responde con un aviso; si persiste, define `ADMIN_NUMBERS`.
- `browser is already running`: el bot limpia los locks solo al arrancar; si pasa, reinicia el contenedor.

## Consultar hora
- `Consultar hora 21:39` (con o sin `!`): toma 21:39 como la hora **local de quien escribe** (según el país de su número), la muestra primero y luego la convierte para **todos los países** de los miembros del grupo, agrupando por zona.
- `Consultar hora 21:39 🇦🇷` (o `AR`): usa la hora de esa bandera como base.
- Los números ocultos tras un ID `@lid` se resuelven por lotes y se guardan en caché.
- Países con varias zonas (EE. UU., Brasil, México, Canadá, Rusia, Australia…) usan su **zona principal**: el número de teléfono no indica en cuál vive cada persona.

## Si el bot ignora a alguien que ya agregaste
1. Mira el log al arrancar: la línea `⚙️ Config →` muestra qué listas recibió el contenedor. Si salen vacías, las variables **no están llegando**.
2. En Portainer, las variables del stack solo llegan al contenedor si el compose las referencia (`- ADMIN_IDS=${ADMIN_IDS:-}`). Usa el `docker-compose.yml` de este proyecto.
3. Tras cambiar variables hay que **recrear el contenedor** (Update the stack).
4. El log del mensaje ignorado muestra la línea `💡 Para autorizarlo agrega a ADMIN_IDS exactamente: ...`.

## Si WhatsApp Web falla al leer grupos (error `r`)
Algunas versiones de WhatsApp Web rompen `getChat`/`getChats` en grupos. El bot lee los miembros y admins **directamente** de WhatsApp Web (sin esos pasos) y usa `getChat` solo como plan B. Si aun así falla, el log dice qué paso falló, por ejemplo:
`⚠️ Lectura directa del grupo sin miembros: ... | toPn: ...`. Mándame esa línea.

Notas sobre IDs `@lid`:
- Para un ID `@lid`, `Contact.number` **no es el teléfono** (es el propio ID). El bot obtiene el teléfono de la lista de miembros del grupo.
- Lo más fiable para ti: `OWNER_IDS=<tu ID @lid>`. Lo ves en el log: `📩 ... | ID: xxxx@lid`.

## Error "pull access denied for skibot" al redesplegar en Portainer
Ocurre cuando Portainer hace `compose pull` de una imagen que solo existe en tu servidor. El `docker-compose.yml` ya incluye `pull_policy: build` (no intenta bajarla; la construye en cada despliegue). Si aun así lo ves:
1. Al hacer *Pull and redeploy*, **desactiva "Re-pull image"**.
2. Si tu Portainer gestiona un entorno remoto (agente/Edge), los `build` pueden fallar (limitación conocida de Portainer). En ese caso construye la imagen en el servidor (`docker build -t skibot:latest .`) y usa en el stack solo:
```yaml
services:
  skibot:
    image: skibot:latest
    pull_policy: never      # usa solo la imagen local, nunca Docker Hub
    # ...resto igual (environment, volumes, etc.), sin la línea "build"
```

## El bot pidió QR de nuevo / dejó de responder
- Log `🔌 Desconectado de WhatsApp: LOGOUT`: **WhatsApp cerró la sesión del dispositivo** y la librería borra la sesión (por eso pide QR). Lo más común: **dos instancias usando la misma sesión** (otro contenedor, el bot de Windows aún corriendo, o una carpeta `.wwebjs_auth` copiada) o el dispositivo eliminado desde el teléfono (Ajustes → Dispositivos vinculados). Cada instancia debe tener **su propio QR**.
- Al detener el contenedor usa **Stop** (envía SIGTERM y deja cerrar Chromium bien), no **Kill**: matar Chromium a la fuerza puede dañar el perfil.
- Si el contenedor muere solo, revisa si fue por memoria: `docker inspect skibot --format '{{.State.OOMKilled}}'`. Si da `true`, sube `memory` en el compose (p. ej. `1536M`).
- `RESTART_EVERY_HOURS=24` hace un reinicio limpio programado (la sesión se conserva).

## Comandos y quién puede usarlos
| Comando | Quién |
|---|---|
| `!skibot`, `!encuesta roles` | owner, admins de la lista (`ADMIN_IDS`/`ADMIN_NUMBERS`) y, si `ALLOW_GROUP_ADMINS=true` (default), admins del grupo de WhatsApp |
| `!encuesta` (por mensaje directo) | **solo el owner** |
| `!iniciales gremio`, `!link gremio`, `!discord gremio`, `Consultar hora …`, `!comandos`, `!id` | los mismos que administración; **todos** si `PUBLIC_COMMANDS=true` |
| `!me mide`, `!rol` (`!linea`), `!campeon` (`!champ`), `!tilt`, `!excusa`, `!duo` | **todos** (públicos, sin control de acceso) |

- Quien no tiene permiso para un comando es ignorado en silencio y la consola lo registra (`⛔ IGNORADO`).
- Los comandos de diversión también se registran en consola con el ID de quien los usa (`🎮 [público] …`).
- `!duo` solo funciona en grupos. `!comandos` muestra la lista actualizada según tu configuración.
- Si `getContact` falla, los comandos de diversión responden igual, sin mencionar.
