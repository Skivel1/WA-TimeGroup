FROM node:20-bookworm-slim

# Chromium del sistema + fuentes (sin fuente de emojis, los emojis salen rotos)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    TZ=America/Mexico_City \
    DATA_DIR=/app/data

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./

# Carpeta de datos (sesión de WhatsApp) con permisos para el usuario no-root
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# Sano = el bot escribió su heartbeat en los últimos 10 min
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
  CMD node -e "const s=require('fs').statSync('/tmp/skibot-heartbeat');process.exit(Date.now()-s.mtimeMs<600000?0:1)"

CMD ["node", "index.js"]
