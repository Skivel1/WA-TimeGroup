// SkiBot — versión consolidada y optimizada para Docker
'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { DateTime } = require('luxon');
const { parsePhoneNumber } = require('libphonenumber-js');

// ================== Config (variables de entorno) ==================
const BOT_NAME = process.env.BOT_NAME || 'Skibot';
const DATA_DIR = process.env.DATA_DIR || '.';
const SESSION_PATH = path.join(DATA_DIR, '.wwebjs_auth');
const CACHE_PATH = path.join(DATA_DIR, '.wwebjs_cache');
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/skibot-heartbeat';
const LOG_MESSAGES = process.env.LOG_MESSAGES === 'true'; // loguear T// Reemplaza esto con tu número de WhatsApp registrado (con código de país sin el signo +)
const MY_NUMBER = '52181XXXXXXXX@c.us'; // O el formato de tu ID de WhatsApp (ej. 521... o 52...)

async function canRunAdminCmd(msg) {
  // 1. Si el mensaje viene de tu número personal, autorizar de inmediato
  const senderId = msg.author || msg.from;
  if (senderId === MY_NUMBER || senderId.includes('528121581206')) {
    return true;
  }

  // 2. Validación estándar de administradores en el grupo
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return false;

    const authorId = msg.author || msg.from;
    const participant = chat.participants.find(p => p.id._serialized === authorId);

    return participant && (participant.isAdmin || participant.isSuperAdmin);
  } catch (error) {
    console.error("Error al consultar administradores del chat:", error.message);
    return false;
  }
}ODOS los mensajes (debug)
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3000);
const WATCHDOG_MS = 5 * 60 * 1000;

const botStartTime = new Date();

// Número del owner: últimos 10 dígitos SIN +52 ni prefijos
const OWNER_NUMBER_BASE10 = toBase10(process.env.OWNER_NUMBER || '');
if (!OWNER_NUMBER_BASE10) {
  console.warn('⚠️ OWNER_NUMBER no está definido: nadie tendrá permisos de owner.');
}

const countryTimezoneMap = {
  MX: { zone: 'America/Mexico_City', flag: '🇲🇽' },
  AR: { zone: 'America/Argentina/Buenos_Aires', flag: '🇦🇷' },
  CO: { zone: 'America/Bogota', flag: '🇨🇴' },
  BR: { zone: 'America/Sao_Paulo', flag: '🇧🇷' },
  US: { zone: 'America/New_York', flag: '🇺🇸' },
  VE: { zone: 'America/Caracas', flag: '🇻🇪' },
  BO: { zone: 'America/La_Paz', flag: '🇧🇴' },
  CL: { zone: 'America/Santiago', flag: '🇨🇱' },
  PE: { zone: 'America/Lima', flag: '🇵🇪' },
};

// ================== Estado en memoria (con limpieza) ==================
// DM id -> { step, evento, fecha, hora, groups:[{id,name}], ts }
const encuestaState = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

const lastWelcomeAt = new Map(); // `${chatId}::${participantId}` -> ms
const MIN_INTERVAL_MS = 1500;

const cooldowns = new Map(); // `${sender}::${cmd}` -> ms

// ================== Sesión: limpiar locks de Chromium ==================
// Tras un cierre sucio (docker kill / corte de luz) quedan estos archivos y
// Chromium se niega a abrir el perfil ("browser is already running").
function cleanSingletonLocks() {
  const dir = path.join(SESSION_PATH, 'session');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) { /* noop */ }
  }
}
fs.mkdirSync(SESSION_PATH, { recursive: true });
cleanSingletonLocks();

// ================== Cliente ==================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
  webVersionCache: { type: 'local', path: CACHE_PATH + '/' },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--mute-audio',
    ],
  },
});

// ================== Heartbeat (para el HEALTHCHECK de Docker) ==================
function beat() {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (_) { /* noop */ }
}

// ================== QR, Ready, ciclo de vida ==================
client.on('qr', qr => {
  beat(); // esperando QR no cuenta como "unhealthy"
  qrcode.generate(qr, { small: true });
  console.log('🔄 Escanea el código QR con tu WhatsApp');
});

let watchdogTimer = null;
client.on('ready', () => {
  console.log('✅ Bot listo para funcionar');
  beat();
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
      ]);
      if (state !== 'CONNECTED') throw new Error(`estado ${state}`);
      beat();
    } catch (e) {
      console.error('🐕 Watchdog: el cliente no responde →', e.message);
      shutdown(1); // Docker (restart: unless-stopped) lo levanta de nuevo
    }
  }, WATCHDOG_MS);
});

client.on('disconnected', reason => {
  console.error('🔌 Desconectado de WhatsApp:', reason);
  shutdown(1);
});
client.on('auth_failure', m => {
  console.error('🔐 Fallo de autenticación:', m);
  shutdown(1);
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n👋 Cerrando el bot limpiamente...');
  try {
    await Promise.race([
      client.destroy(),
      new Promise(res => setTimeout(res, 10000)),
    ]);
  } catch (err) {
    console.error('❌ Error al cerrar el cliente:', err.message);
  }
  process.exit(code);
}
// Docker envía SIGTERM; Ctrl+C envía SIGINT
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', e => console.error('⚠️ Promesa rechazada sin manejar:', e));
process.on('uncaughtException', e => {
  console.error('💥 Excepción no capturada:', e);
  shutdown(1);
});

// ================== Limpieza periódica de memoria ==================
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of encuestaState) if (now - v.ts > STATE_TTL_MS) encuestaState.delete(k);
  for (const [k, t] of lastWelcomeAt) if (now - t > 60 * 60 * 1000) lastWelcomeAt.delete(k);
  for (const [k, t] of cooldowns) if (now - t > 60 * 1000) cooldowns.delete(k);
}, 5 * 60 * 1000).unref();

// ================== Helpers ==================
function formatUptime(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hr = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return (days ? `${days}d ` : '') +
    String(hr).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function toBase10(numStr) {
  if (!numStr) return '';
  const digits = String(numStr).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Acepta: "521234567890@c.us", { user: "521234567890" }, "521234567890"
function extractUserBase10(anyId) {
  if (!anyId) return '';
  if (typeof anyId === 'object') {
    if (anyId.user) return toBase10(anyId.user);
    if (anyId._serialized) return toBase10(anyId._serialized.split('@')[0]);
  }
  return toBase10(String(anyId).split('@')[0]);
}

function isAdminFlag(p) {
  if (!p) return false;
  return Boolean(
    p.isAdmin === true ||
    p.isSuperAdmin === true ||
    p.admin === 'admin' ||
    p.admin === 'superadmin' ||
    (p.role && (p.role === 'admin' || p.role === 'superadmin'))
  );
}

async function ensureParticipants(chat) {
  if (Array.isArray(chat.participants) && chat.participants.length) return chat.participants;
  if (typeof chat.fetchParticipants === 'function') {
    try {
      const parts = await chat.fetchParticipants();
      if (Array.isArray(parts) && parts.length) return parts;
    } catch (_) { /* noop */ }
  }
  return chat.participants || [];
}

// ¿El remitente es admin del grupo? (coincidencia EXACTA por últimos 10 dígitos)
async function isSenderAdminInGroup(chat, msg) {
  if (!chat.isGroup) return false;

  const contact = await msg.getContact().catch(() => null);
  const senderBases = [contact?.number, contact?.id?._serialized, contact?.id?.user, msg.author]
    .filter(Boolean)
    .map(extractUserBase10)
    .filter(x => x.length >= 7);
  if (!senderBases.length) return false;

  const parts = await ensureParticipants(chat);
  const adminSet = new Set(
    parts.filter(isAdminFlag).map(p => extractUserBase10(p?.id)).filter(x => x.length >= 7)
  );

  if (typeof chat.getAdmins === 'function') {
    try {
      const admins = await chat.getAdmins();
      for (const a of (Array.isArray(admins) ? admins : [])) {
        const base = extractUserBase10(a?.number || a?.id?._serialized || a?.id || a);
        if (base && base.length >= 7) adminSet.add(base);
      }
    } catch (_) { /* noop */ }
  }

  return senderBases.some(b => adminSet.has(b));
}

// ¿Es el owner? Chequeo barato primero; solo si el id es @lid consulta el contacto.
async function isOwner(msg) {
  if (!OWNER_NUMBER_BASE10) return false;
  const candidates = [msg.author, msg.from].filter(Boolean);
  if (candidates.some(c => extractUserBase10(c) === OWNER_NUMBER_BASE10)) return true;
  if (candidates.some(c => String(c).endsWith('@lid'))) {
    const contact = await msg.getContact().catch(() => null);
    if (contact?.number && toBase10(contact.number) === OWNER_NUMBER_BASE10) return true;
  }
  return false;
}

async function canRunAdminCmd(msg) {
  try {
    const chat = await msg.getChat(); // O client.getChatById(...)
    if (!chat.isGroup) return false;
    
    // Tu lógica actual de verificación de admin...
  } catch (error) {
    console.error("Error obteniendo el chat:", error.message);
    return false; // Si falla la consulta del chat, deniega temporalmente el comando sin romper el bot
  }
}

// Matching de comandos (case/acentos/espacios)
function normCmd(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
function isCmd(body, aliases) {
  const m = normCmd(body);
  return aliases.some(a => normCmd(a) === m);
}
function startsWithCmd(body, aliases) {
  const m = normCmd(body);
  return aliases.some(a => m.startsWith(normCmd(a)));
}

// Filtro barato: ¿el texto SIQUIERA parece un comando?
const COMMAND_START = /^(!|consultar hora)/;

// Anti-spam por remitente+comando
function onCooldown(msg, cmd) {
  const key = `${msg.author || msg.from}::${cmd}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < COOLDOWN_MS) return true;
  cooldowns.set(key, now);
  return false;
}

function senderLabel(msg) {
  return msg._data?.notifyName || extractUserBase10(msg.author || msg.from) || 'Usuario';
}

// ================== Handler de mensajes ==================
client.on('message', async msg => {
  try {
    // 1) Filtros baratos: sin llamadas al navegador
    if (msg.fromMe || msg.from === 'status@broadcast') return;
    if (typeof msg.body !== 'string' || !msg.body) return;

    const rawBody = msg.body;
    const isGroupMsg = msg.from.endsWith('@g.us');
    const inFlow = !isGroupMsg && encuestaState.has(msg.from);

    if (LOG_MESSAGES) console.log(`📥 [${new Date().toLocaleString()}] ${senderLabel(msg)}: "${rawBody}"`);

    // El 95% de los mensajes de grupo termina aquí
    if (!inFlow && !COMMAND_START.test(normCmd(rawBody))) return;

    const who = senderLabel(msg);

    // ============ DM: !encuesta (SOLO OWNER) ============
    if (!isGroupMsg && isCmd(rawBody, ['!encuesta'])) {
      if (!(await isOwner(msg))) return;
      encuestaState.set(msg.from, { step: 'askType', ts: Date.now() });
      return msg.reply('📋 ¿Qué tipo de encuesta quieres crear? (p.e. *Scrim*)\n\n_Escribe *cancelar* para salir._');
    }

    // ============ DM: flujo de creación de encuesta ============
    if (inFlow) {
      const state = encuestaState.get(msg.from);
      const text = rawBody.trim();
      state.ts = Date.now();

      if (normCmd(text) === 'cancelar') {
        encuestaState.delete(msg.from);
        return msg.reply('🚫 Encuesta cancelada.');
      }

      switch (state.step) {
        case 'askType':
          state.evento = text;
          state.step = 'askDate';
          return msg.reply(`🗓️ Entendido, Evento: *${text}*. Ahora, ¿qué fecha tendrá? (dd/mm/yyyy)`);

        case 'askDate':
          if (!/^\d{2}\/\d{2}\/\d{4}$/.test(text) || !DateTime.fromFormat(text, 'dd/MM/yyyy').isValid)
            return msg.reply('⛔ Fecha inválida. Usa dd/mm/yyyy, ej. 18/07/2025');
          state.fecha = text;
          state.step = 'askTime';
          return msg.reply('⏰ Excelente. ¿A qué hora? (formato 24h, ej. 20:00)');

        case 'askTime': {
          if (!/^\d{2}:\d{2}$/.test(text) || !DateTime.fromFormat(text, 'HH:mm').isValid)
            return msg.reply('⛔ Hora inválida. Usa HH:MM en 24h, ej. 20:00');
          state.hora = text;
          const allChats = await client.getChats();
          // Guardamos solo id + nombre (no objetos Chat completos)
          state.groups = allChats.filter(c => c.isGroup).map(c => ({ id: c.id._serialized, name: c.name }));
          if (!state.groups.length) {
            encuestaState.delete(msg.from);
            return msg.reply('⚠️ No estoy en ningún grupo para enviar la encuesta.');
          }
          state.step = 'askGroup';
          let lista = '📨 ¿A qué grupo deseas enviar esta encuesta?\n\n';
          state.groups.forEach((g, i) => { lista += `\`${i + 1}\` • ${g.name}\n`; });
          return msg.reply(lista);
        }

        case 'askGroup': {
          const idx = parseInt(text, 10) - 1;
          const target = (!isNaN(idx) && state.groups[idx])
            ? state.groups[idx]
            : state.groups.find(g => normCmd(g.name) === normCmd(text));
          if (!target) return msg.reply('⛔ No encontré ese grupo. Responde con número o nombre exacto.');

          const targetChat = await client.getChatById(target.id);

          // Resumen de horarios locales (según prefijo telefónico de los miembros)
          const baseTime = DateTime.fromFormat(
            `${state.fecha} ${state.hora}`, 'dd/MM/yyyy HH:mm', { zone: 'America/Mexico_City' }
          );
          const zonasVistas = new Set();
          let tzSummary = '🕒 Horarios locales:\n';
          for (const p of await ensureParticipants(targetChat)) {
            try {
              const country = parsePhoneNumber(`+${p.id.user}`).country;
              if (country && countryTimezoneMap[country]) {
                const { zone, flag } = countryTimezoneMap[country];
                if (!zonasVistas.has(zone)) {
                  zonasVistas.add(zone);
                  tzSummary += `${flag} ${baseTime.setZone(zone).toFormat('HH:mm')}\n`;
                }
              }
            } catch (_) { /* número inválido */ }
          }

          const pollText =
            `🎯 Evento: ${state.evento}\n` +
            `🗓️ Día: ${state.fecha}\n` +
            `⏰ Hora: ${state.hora}\n` +
            `${tzSummary}\n` +
            `📝 *Detalles del Evento:*\n` +
            `5 VS 5 entre miembros del guild.\n` +
            `Si vas a participar y surge algún inconveniente, avisa con tiempo.\n` +
            `Se pide compromiso de asistencia.`;

          try {
            if (typeof Poll === 'function') {
              const poll = new Poll(pollText, ['✅ Participo', '❌ No participo'], { allowMultipleAnswers: false });
              await client.sendMessage(target.id, poll);
              await msg.reply(`✅ ¡Encuesta enviada a *${target.name}*!`);
            } else {
              await client.sendMessage(target.id, pollText + '\n\nResponde con ✅ o ❌ según tu disponibilidad.');
              await msg.reply(`✅ Mensaje enviado a *${target.name}* (Poll no soportado en esta versión).`);
            }
          } catch (err) {
            console.error('Error enviando encuesta:', err);
            await msg.reply('❌ No pude enviar la encuesta.');
          }
          encuestaState.delete(msg.from);
          return;
        }
      }
      return;
    }

    // ============ !skibot (admins/owner) ============
    if (isCmd(rawBody, ['!skibot'])) {
      if (!(await canRunAdminCmd(msg, isGroupMsg))) return;
      const now = new Date();
      const horaLocal = now.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
      await msg.reply(
        `🤖 *${BOT_NAME} está en línea* ✅\n\n` +
        `🕒 *Hora local (CDMX)*: ${horaLocal}\n` +
        `⏱️ *Tiempo activo*: ${formatUptime(now - botStartTime)}\n\n` +
        `Escribe *!comandos* para ver lo que puedo hacer.`
      );
      console.log(`✅ !skibot → ${who}`);
      return;
    }

    // ============ !encuesta roles (admins/owner) ============
    if (isCmd(rawBody, ['!encuesta roles'])) {
      if (!(await canRunAdminCmd(msg, isGroupMsg))) return;
      const chat = await msg.getChat();
      const title = '🎮 *¿Qué línea juegas más frecuentemente?*';
      const options = [
        '🗡️ Top – El reino del 1v1 eterno.',
        '🐊 Jungla – Nadie te quiere hasta que no gankees.',
        '🧙‍♂️ Mid – Duelo de magos y asesinos.',
        '🏹 ADC – Mucho daño, poca vida, pero glamoroso.',
        '🛡️ Soporte – Guardas a todos, incluso al feed.',
      ];
      try {
        if (typeof Poll === 'function') {
          await chat.sendMessage(new Poll(title, options, { allowMultipleAnswers: true }));
        } else {
          await chat.sendMessage(title + '\n\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n'));
        }
        console.log(`📊 Encuesta de roles enviada por ${who}`);
      } catch (err) {
        console.error('❌ Error al enviar encuesta de roles:', err);
      }
      return;
    }

    // ============ !comandos ============
    if (isCmd(rawBody, ['!comandos', '!cmd', '!comando'])) {
      if (onCooldown(msg, 'help')) return;
      await msg.reply(`
📜 *Lista de Comandos disponibles* ⚙️

1. *Iniciales del Gremio* ⚔️
   ➤ Comando: \`!iniciales gremio\`

2. *Enlace para unirse al Gremio* 🛡️
   ➤ Comando: \`!link gremio\`

3. *Servidor de Discord del Gremio* 💬
   ➤ Comando: \`!discord gremio\`

4. *Conversión Horaria para el Grupo* 🕒
   ➤ Comando: \`Consultar hora HH:MM 🇲🇽\`
   ➤ Ejemplo: \`Consultar hora 15:30 🇦🇷\`

5. *Encuesta de Roles (solo admins)* 📊
   ➤ Comando: \`!encuesta roles\`

ℹ️ Puedes escribir *!comandos*, *!cmd* o *!comando* para ver esta lista.`);
      return;
    }

    // ============ Comandos del gremio ============
    if (isCmd(rawBody, ['!iniciales gremio', '!iniciales del gremio'])) {
      if (onCooldown(msg, 'iniciales')) return;
      await msg.reply('⚔️ Estas son las iniciales del gremio, colócalas en tu nick de invocador para infundir miedo a tus enemigos: *WG 忠* 💥');
      return;
    }
    if (isCmd(rawBody, ['!link gremio', '!enlace gremio'])) {
      if (onCooldown(msg, 'link')) return;
      await msg.reply('🛡️ Únete al mejor gremio de Wild Rift: https://playwildrift.page.link/rowdeeplink?type=2&params=806285341537834098 🌐🔥');
      return;
    }
    if (isCmd(rawBody, ['!discord gremio', '!discord del gremio'])) {
      if (onCooldown(msg, 'discord')) return;
      await msg.reply('💬 Enlace del Discord del gremio: https://discord.gg/M4aAtt8a7T 🎧🛡️');
      return;
    }

    // ============ Consultar hora (con bandera) ============
    if (startsWithCmd(rawBody, ['consultar hora'])) {
      if (onCooldown(msg, 'hora')) return;

      const clean = rawBody.replace(/\u200B/g, '');
      const m = clean.match(/consultar hora\s+(\d{1,2}):(\d{2})\s*(.+)?/i);
      if (!m) {
        return msg.reply('⛔ Usa el formato: *Consultar hora 20:00 🇲🇽*\nEjemplos:\n• *Consultar hora 20:00 🇲🇽*\n• *Consultar hora 20:00 🇦🇷*\n• *Consultar hora 20:00 🇺🇸*');
      }

      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const flagInput = m[3] ? m[3].trim() : '🇲🇽';

      if (hour > 23 || minute > 59) {
        return msg.reply('⛔ Hora inválida. Usa formato 24h como *20:00* 🕒');
      }

      let targetCountry = null;
      let targetZone = 'America/Mexico_City';
      let targetFlag = '🇲🇽';

      for (const [code, data] of Object.entries(countryTimezoneMap)) {
        if (data.flag === flagInput) {
          targetCountry = code; targetZone = data.zone; targetFlag = data.flag;
          break;
        }
      }
      if (!targetCountry && flagInput.length === 2) {
        const code = flagInput.toUpperCase();
        if (countryTimezoneMap[code]) {
          targetCountry = code;
          targetZone = countryTimezoneMap[code].zone;
          targetFlag = countryTimezoneMap[code].flag;
        }
      }
      if (!targetCountry) {
        let banderas = '🚩 *Banderas disponibles:*\n';
        for (const [code, data] of Object.entries(countryTimezoneMap)) {
          banderas += `• ${data.flag} ${code} (${data.zone.split('/').pop().replace(/_/g, ' ')})\n`;
        }
        return msg.reply(`⛔ Bandera no reconocida: "${flagInput}"\n\n${banderas}\nEjemplo: *Consultar hora 20:00 🇲🇽*`);
      }

      const baseTime = DateTime.fromObject({ hour, minute }, { zone: targetZone });
      let response = `🕓 *Hora base: ${baseTime.toFormat('HH:mm')} (${targetZone.split('/').pop().replace(/_/g, ' ')})* ${targetFlag}\n\n`;

      const paisesYaIncluidos = new Set([targetCountry]);
      let conversiones = 0;

      // Solo en grupos hay participantes que consultar
      const participants = isGroupMsg ? await ensureParticipants(await msg.getChat()) : [];
      for (const participant of participants) {
        const rawNumber = participant.id?.user || participant.number || '';
        if (!rawNumber) continue;
        try {
          const iso = parsePhoneNumber(`+${rawNumber}`).country;
          if (!iso || paisesYaIncluidos.has(iso) || !countryTimezoneMap[iso]) continue;
          paisesYaIncluidos.add(iso);
          conversiones++;

          const tz = countryTimezoneMap[iso];
          const local = baseTime.setZone(tz.zone);
          let cambioDia = '';
          if (local.day > baseTime.day) cambioDia = ' (día siguiente)';
          if (local.day < baseTime.day) cambioDia = ' (día anterior)';
          response += `${tz.flag} ${iso}: ${local.toFormat('HH:mm')} (${tz.zone.split('/').pop().replace(/_/g, ' ')})${cambioDia}\n`;
        } catch (_) { /* número inválido */ }
      }

      if (!conversiones) response += 'ℹ️ No se detectaron participantes de otros países en el grupo.';

      response += '\n\n🚩 *Banderas disponibles:* ';
      Object.values(countryTimezoneMap).forEach((d, i) => {
        if (i % 5 === 0 && i > 0) response += '\n';
        response += `${d.flag} `;
      });

      return msg.reply(response);
    }
  } catch (err) {
    console.error('❌ Error general en message handler:', err);
  }
});

// ================== Bienvenida automática (reingresos OK) ==================
const welcomeKey = (chatId, participantId) => `${chatId}::${participantId}`;

function collectIds(notification) {
  return (notification.recipientIds && notification.recipientIds.length ? notification.recipientIds : [])
    .concat(notification?.participants || [])
    .concat(notification.id && notification.id.participant ? [notification.id.participant] : [])
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

async function handleWelcome(notification) {
  try {
    const chat = await notification.getChat();
    const chatKey = chat.id?._serialized || String(chat.id);
    const joinedIds = collectIds(notification);
    if (!joinedIds.length) return;

    for (const participantId of joinedIds) {
      const key = welcomeKey(chatKey, participantId);
      const now = Date.now();
      if (now - (lastWelcomeAt.get(key) || 0) < MIN_INTERVAL_MS) continue;
      lastWelcomeAt.set(key, now); // marcar ANTES de await evita dobles por carrera

      let contact = null;
      try {
        contact = await client.getContactById(participantId);
      } catch (_) {
        const user = String(participantId).split('@')[0] || '';
        if (/^\d+$/.test(user)) {
          try { contact = await client.getContactById(`${user}@c.us`); } catch (_) { /* noop */ }
        }
      }

      const tag = contact ? `@${contact.id.user}` : `@${String(participantId).split('@')[0]}`;
      const bienvenida =
        `🎉 *¡Bienvenid@* ${tag} *a esta pequeña familia!* 🫂✨\n\n` +
        `🎮 Déjanos tu *nick* y las *líneas que juegas* 🧙‍♂️🏹🛡️\n\n` +
        `💳 Por si las dudas, también deja tu número de tarjeta de crédito, CVV y órganos sanos, por favor 😌🫀🫁😂\n\n` +
        `¡Disfruta tu estadía en *Warrior Guardian*! 🔥`;

      await chat.sendMessage(bienvenida, { mentions: contact ? [contact] : [] });
      console.log(`✅ Bienvenida enviada a ${contact?.pushname || contact?.number || participantId}`);
    }
  } catch (error) {
    console.error('❌ Error en handleWelcome:', error);
  }
}

// Si alguien sale, limpiamos su marca para que un reingreso inmediato VUELVA a saludar.
async function handleLeave(notification) {
  try {
    const chat = await notification.getChat();
    const chatKey = chat.id?._serialized || String(chat.id);
    for (const participantId of collectIds(notification)) {
      lastWelcomeAt.delete(welcomeKey(chatKey, participantId));
    }
  } catch (e) {
    console.log('ℹ️ handleLeave error/noop:', e?.message || e);
  }
}

client.on('group_join', handleWelcome);
client.on('group_leave', handleLeave);

// Fallback para forks/Comunidades que usan group_update
client.on('group_update', async notification => {
  try {
    const t = (notification?.type || '').toString().toLowerCase();
    if (['add', 'invite', 'link_join', 'participant_added', 'participants_added'].includes(t)) {
      await handleWelcome(notification);
    }
    if (['remove', 'participant_removed', 'participants_removed', 'left'].includes(t)) {
      await handleLeave(notification);
    }
  } catch (_) { /* noop */ }
});

// ================== Init ==================
console.log(`🚀 Iniciando ${BOT_NAME}...`);
client.initialize().catch(err => {
  console.error('❌ Error al inicializar el cliente:', err);
  shutdown(1);
});
