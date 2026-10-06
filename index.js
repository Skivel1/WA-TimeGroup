// SkiBot — versión consolidada y optimizada para Docker
'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { DateTime } = require('luxon');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// ================== Config (variables de entorno) ==================
const BOT_NAME = process.env.BOT_NAME || 'Skibot';
const DATA_DIR = process.env.DATA_DIR || '.';
const SESSION_PATH = path.join(DATA_DIR, '.wwebjs_auth');
const CACHE_PATH = path.join(DATA_DIR, '.wwebjs_cache');
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/skibot-heartbeat';
const LOG_MESSAGES = process.env.LOG_MESSAGES === 'true'; // loguear TODOS los mensajes (debug)
// Por defecto SOLO la lista (owner/admins) puede usar comandos; el resto se ignora en silencio.
const PUBLIC_COMMANDS = process.env.PUBLIC_COMMANDS === 'true';       // true = !comandos, !link gremio, etc. abiertos a todos
const ALLOW_GROUP_ADMINS = process.env.ALLOW_GROUP_ADMINS === 'true'; // true = también admins del grupo según WhatsApp
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3000);
const WATCHDOG_MS = 5 * 60 * 1000;

const botStartTime = new Date();

// Número del owner: últimos 10 dígitos SIN +52 ni prefijos
const OWNER_NUMBER_BASE10 = toBase10(process.env.OWNER_NUMBER || '');
// Admins fijos opcionales (no dependen de WhatsApp Web): ADMIN_NUMBERS=8111111111,8222222222
const ADMIN_NUMBERS = new Set(
  (process.env.ADMIN_NUMBERS || '').split(',').map(toBase10).filter(x => x.length >= 7)
);
// IDs exactos (útiles cuando WhatsApp te identifica como xxxx@lid en grupos).
// Obtén el tuyo escribiendo !id en el grupo. Separados por coma.
const parseIds = v => new Set((v || '').split(',').map(x => x.trim()).filter(Boolean));
const OWNER_IDS = parseIds(process.env.OWNER_IDS);
const ADMIN_IDS = parseIds(process.env.ADMIN_IDS);
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

const phoneCache = new Map(); // id serializado -> dígitos del teléfono real

// Respaldo cuando WhatsApp Web no deja leer los miembros del grupo:
// recordamos a quienes escriben / entran. chatId -> Set(ids)
const groupSeen = new Map();
const GROUP_SEEN_MAX = 1024;
function rememberMember(chatId, id) {
  if (!chatId || !id) return;
  let set = groupSeen.get(chatId);
  if (!set) { set = new Set(); groupSeen.set(chatId, set); }
  if (set.size < GROUP_SEEN_MAX) set.add(String(id));
}

// ================== Sesión: limpiar locks de Chromium ==================
// Tras un cierre sucio (docker kill / corte de luz) quedan estos archivos y
// Chromium se niega a abrir el perfil ("browser is already running").
function cleanSingletonLocks() {
  const dir = path.join(SESSION_PATH, 'session');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) { /* noop */ }
  }
  // Carpetas temporales donde Chromium deja su socket de instancia
  try {
    for (const name of fs.readdirSync('/tmp')) {
      if (name.startsWith('.org.chromium.') || name.startsWith('.com.google.Chrome.')) {
        fs.rmSync(path.join('/tmp', name), { recursive: true, force: true });
      }
    }
  } catch (_) { /* noop */ }
}

// Al arrancar, cualquier Chromium vivo en ESTE contenedor es huérfano (el nuestro
// aún no se lanzó): lo matamos para que no bloquee el perfil.
function killStaleChromium() {
  if (process.platform !== 'linux') return;
  let killed = 0;
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid || pid === process.ppid || pid === 1) continue;
      try {
        const exe = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || '';
        if (/chrom(e|ium)/i.test(exe)) { process.kill(pid, 'SIGKILL'); killed++; }
      } catch (_) { /* proceso ya terminó */ }
    }
  } catch (_) { /* noop */ }
  if (killed) console.log(`🧹 Chromium huérfano eliminado (${killed} procesos)`);
}

function prepareProfile() {
  killStaleChromium();
  cleanSingletonLocks();
}
fs.mkdirSync(SESSION_PATH, { recursive: true });
prepareProfile();

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
client.on('ready', async () => {
  console.log('✅ Bot listo para funcionar');
  beat();
  try {
    const webVer = await client.getWWebVersion();
    let libVer = '?';
    try { libVer = require('whatsapp-web.js/package.json').version; } catch (_) { /* noop */ }
    console.log(`ℹ️ whatsapp-web.js ${libVer} | WhatsApp Web ${webVer}`);
  } catch (_) { /* noop */ }
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

// ---- Resolver número real (maneja @c.us y @lid) ----
// En grupos WhatsApp puede identificar a los miembros como xxxx@lid; en ese caso
// id.user NO es el teléfono, hay que pedir el contacto para obtener el número real.
async function resolvePhoneDigits(id, hintPn = null) {
  const serialized = typeof id === 'string' ? id : id?._serialized;
  if (!serialized) return '';
  if (phoneCache.has(serialized)) return phoneCache.get(serialized);

  const onlyDigits = v => String(v || '').split('@')[0].replace(/\D/g, '');
  let digits = '';

  if (hintPn && onlyDigits(hintPn)) {
    // El Store ya nos dio el número real junto al participante
    digits = onlyDigits(hintPn);
  } else if (serialized.endsWith('@c.us')) {
    digits = onlyDigits(serialized);
  } else if (serialized.endsWith('@lid')) {
    // 1) API de whatsapp-web.js (versiones recientes): LID -> número real
    if (typeof client.getContactLidAndPhone === 'function') {
      try {
        const r = await client.getContactLidAndPhone([serialized]);
        const pn = Array.isArray(r) ? r[0]?.pn : null;
        if (pn) digits = onlyDigits(pn);
      } catch (_) { /* noop */ }
    }
    // 2) Fallback: Store interno de WhatsApp Web
    if (!digits && client.pupPage) {
      try {
        const pn = await client.pupPage.evaluate(lid => {
          const wid = window.Store.WidFactory.createWid(lid);
          const p = window.Store.LidUtils?.getPhoneNumber?.(wid);
          return p ? p._serialized || String(p) : null;
        }, serialized);
        if (pn) digits = onlyDigits(pn);
      } catch (_) { /* noop */ }
    }
    // 3) Último recurso: el contacto, SOLO si trae un número distinto del LID
    if (!digits) {
      const contact = await client.getContactById(serialized).catch(() => null);
      if (contact?.id?.server === 'c.us') digits = onlyDigits(contact.id.user);
      else if (contact?.number && onlyDigits(contact.number) !== onlyDigits(serialized)) {
        digits = onlyDigits(contact.number);
      }
    }
  } else {
    digits = onlyDigits(serialized);
  }

  if (digits) phoneCache.set(serialized, digits); // no cacheamos fallos
  return digits;
}

// Miembros de un grupo SIN usar getChat() (que WhatsApp Web rechaza a veces).
// Devuelve [{ id: '...@lid|@c.us', pn: '5218...@c.us' | null }]
async function getGroupMembers(chatId) {
  // 1) Directo del Store de WhatsApp Web
  if (client.pupPage) {
    try {
      const list = await client.pupPage.evaluate(async id => {
        if (!window.Store || !window.Store.WidFactory) return null; // Store no inyectado
        const wid = window.Store.WidFactory.createWid(id);
        let meta = window.Store.GroupMetadata?.get?.(wid) || window.Store.Chat?.get?.(wid)?.groupMetadata;
        if (!meta && window.Store.GroupMetadata?.find) meta = await window.Store.GroupMetadata.find(wid);
        const raw = meta?.participants;
        const parts = raw?.getModelsArray ? raw.getModelsArray() : (Array.isArray(raw) ? raw : []);
        return parts.map(p => ({
          id: p.id?._serialized || null,
          pn: p.phoneNumber?._serialized || p.pn?._serialized || null,
        })).filter(p => p.id);
      }, chatId);
      if (Array.isArray(list) && list.length) return list;
    } catch (e) {
      console.error(`⚠️ getGroupMembers (Store) falló: ${shortErr(e)}`);
    }
  }
  // 2) Respaldo: getChatById clásico
  const chat = await safeCall(() => client.getChatById(chatId), 'getChatById (miembros)', 2);
  if (chat) {
    const parts = await ensureParticipants(chat);
    return parts.map(p => ({ id: p.id?._serialized, pn: null })).filter(p => p.id);
  }
  // 3) Respaldo: miembros que hemos visto escribir o entrar a este grupo
  const seen = groupSeen.get(chatId);
  if (seen && seen.size) {
    console.warn(`⚠️ Usando miembros vistos (${seen.size}) porque WhatsApp Web no permite leer el grupo. Actualiza whatsapp-web.js.`);
    return [...seen].map(id => ({ id, pn: null }));
  }
  return [];
}

function countryFromDigits(digits) {
  if (!digits) return null;
  try { return parsePhoneNumberFromString(`+${digits}`)?.country || null; }
  catch (_) { return null; }
}

const cityName = zone => zone.split('/').pop().replace(/_/g, ' ');

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

// Número (10 dígitos) del remitente. Barato si el id es @c.us; solo consulta el
// contacto cuando WhatsApp lo identifica como @lid.
async function senderBase10(msg) {
  const raw = msg.author || msg.from;
  if (!raw) return '';
  if (!String(raw).endsWith('@lid')) return extractUserBase10(raw);
  const contact = await msg.getContact().catch(() => null);
  return contact?.number ? toBase10(contact.number) : '';
}
const OWNER_SET = new Set(OWNER_NUMBER_BASE10 ? [OWNER_NUMBER_BASE10] : []);
function idMatches(msg, set) {
  if (!set.size) return false;
  return [msg.author, msg.from].filter(Boolean)
    .some(c => set.has(String(c)) || set.has(String(c).split('@')[0]));
}
async function isOwner(msg) {
  if (idMatches(msg, OWNER_IDS)) return true;
  if (!OWNER_SET.size) return false;
  return OWNER_SET.has(await senderBase10(msg));
}

const sleep = ms => new Promise(res => setTimeout(res, ms));
const shortErr = e => String((e && (e.message || e)) || 'error desconocido').split('\n')[0].slice(0, 200);

// WhatsApp Web a veces rechaza getChat/getChatById (sobre todo justo después de
// vincular, mientras sincroniza). Reintenta y, si no se puede, devuelve null.
async function safeCall(fn, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries) {
        console.error(`⚠️ ${label} falló tras ${tries} intentos: ${shortErr(e)}`);
        return null;
      }
      await sleep(1500 * i);
    }
  }
  return null;
}

// Decide si el remitente está en la lista. Devuelve { ok, reason }.
// Orden: IDs exactos → números → (opcional) admins del grupo según WhatsApp.
async function authorize(msg, isGroupMsg) {
  if (idMatches(msg, OWNER_IDS)) return { ok: true, reason: 'owner (OWNER_IDS)' };
  if (idMatches(msg, ADMIN_IDS)) return { ok: true, reason: 'admin (ADMIN_IDS)' };

  if (OWNER_SET.size || ADMIN_NUMBERS.size) {
    const num = await senderBase10(msg);
    if (num && OWNER_SET.has(num)) return { ok: true, reason: 'owner (OWNER_NUMBER)' };
    if (num && ADMIN_NUMBERS.has(num)) return { ok: true, reason: 'admin (ADMIN_NUMBERS)' };
  }

  if (ALLOW_GROUP_ADMINS && isGroupMsg) {
    const chat = await safeCall(() => msg.getChat(), 'getChat (permisos)');
    if (!chat) return { ok: false, reason: 'no se pudo verificar admin del grupo (error de WhatsApp Web)' };
    try {
      if (await isSenderAdminInGroup(chat, msg)) return { ok: true, reason: 'admin del grupo' };
    } catch (e) {
      return { ok: false, reason: `no se pudo verificar admin del grupo (${shortErr(e)})` };
    }
  }
  return { ok: false, reason: 'no está en la lista de owner/admins' };
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

    if (LOG_MESSAGES) console.log(`📥 [${new Date().toLocaleString()}] ${senderLabel(msg)} | ID: ${msg.author || msg.from} | ${msg.from}: "${rawBody}"`);

    // Recordar quién habla en el grupo (barato, sin tocar el navegador)
    if (isGroupMsg && msg.author) rememberMember(msg.from, msg.author);

    // El 95% de los mensajes de grupo termina aquí
    if (!inFlow && !COMMAND_START.test(normCmd(rawBody))) return;

    const who = senderLabel(msg);
    const senderId = msg.author || msg.from;
    const preview = rawBody.replace(/\s+/g, ' ').slice(0, 60);

    // ============ Control de acceso (solo para comandos) ============
    if (!inFlow) {
      const adminOnly = isCmd(rawBody, ['!skibot', '!encuesta roles', '!encuesta']);
      const auth = await authorize(msg, isGroupMsg);
      const where = isGroupMsg ? `grupo ${msg.from}` : 'DM';
      console.log(`📩 ${who} | ID: ${senderId} | ${where} | "${preview}" → ${auth.ok ? '✅ autorizado: ' + auth.reason : '❌ ' + auth.reason}`);

      if (!auth.ok && (adminOnly || !PUBLIC_COMMANDS)) {
        console.log(`⛔ IGNORADO: ${senderId} (${who}) no es admin/owner → sin respuesta`);
        return;
      }
    }

    // ============ DM: !encuesta (SOLO OWNER) ============
    if (!isGroupMsg && isCmd(rawBody, ['!encuesta'])) {
      if (!(await isOwner(msg))) {
        console.log(`⛔ IGNORADO: ${senderId} puede ser admin pero !encuesta por DM es solo para el owner`);
        return;
      }
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

          // Resumen de horarios locales (según el país real de los miembros)
          const baseTime = DateTime.fromFormat(
            `${state.fecha} ${state.hora}`, 'dd/MM/yyyy HH:mm', { zone: 'America/Mexico_City' }
          );
          const zonasVistas = new Set();
          let tzSummary = '🕒 Horarios locales:\n';
          const participants = await getGroupMembers(target.id);
          const phones = await Promise.all(participants.map(p => resolvePhoneDigits(p.id, p.pn)));
          for (const digits of phones) {
            const country = countryFromDigits(digits);
            if (country && countryTimezoneMap[country]) {
              const { zone, flag } = countryTimezoneMap[country];
              if (!zonasVistas.has(zone)) {
                zonasVistas.add(zone);
                tzSummary += `${flag} ${baseTime.setZone(zone).toFormat('HH:mm')}\n`;
              }
            }
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

    // ============ !id (para configurar OWNER_IDS / ADMIN_IDS) ============
    if (isCmd(rawBody, ['!id'])) {
      if (onCooldown(msg, 'id')) return;
      return msg.reply(`🆔 *Tu ID:* ${msg.author || msg.from}\n💬 *Chat:* ${msg.from}`);
    }

    // ============ !skibot (admins/owner) ============
    if (isCmd(rawBody, ['!skibot'])) {
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
          await client.sendMessage(msg.from, new Poll(title, options, { allowMultipleAnswers: true }));
        } else {
          await client.sendMessage(msg.from, title + '\n\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n'));
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
   ➤ Comando: \`Consultar hora HH:MM\`
   ➤ Ejemplo: \`Consultar hora 15:30\`
   ➤ Opcional: agrega una bandera para usar otra zona base, ej. \`Consultar hora 15:30 🇦🇷\`

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

    // ============ Consultar hora ============
    // Responde primero con la hora en la zona del remitente (o la bandera indicada)
    // y debajo la conversión a los países de los demás miembros del grupo.
    if (startsWithCmd(rawBody, ['consultar hora', '!consultar hora'])) { // con o sin !
      if (onCooldown(msg, 'hora')) return;

      const clean = rawBody.replace(/\u200B/g, '');
      const m = clean.match(/consultar hora\s+(\d{1,2}):(\d{2})\s*(.+)?/i);
      if (!m) {
        return msg.reply('⛔ Usa el formato: *Consultar hora 20:00*\n(opcional: agrega una bandera para usar otra zona base, ej. *Consultar hora 20:00 🇦🇷*)');
      }

      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const flagInput = m[3] ? m[3].trim() : '';

      if (hour > 23 || minute > 59) {
        return msg.reply('⛔ Hora inválida. Usa formato 24h como *20:00* 🕒');
      }

      // ---- 1) Zona base: bandera (si la pones) o país del remitente ----
      let baseCode = null;

      if (flagInput) {
        for (const [code, data] of Object.entries(countryTimezoneMap)) {
          if (data.flag === flagInput || code === flagInput.toUpperCase()) { baseCode = code; break; }
        }
        if (!baseCode) {
          let banderas = '🚩 *Banderas disponibles:*\n';
          for (const [code, data] of Object.entries(countryTimezoneMap)) {
            banderas += `• ${data.flag} ${code} (${cityName(data.zone)})\n`;
          }
          return msg.reply(`⛔ Bandera no reconocida: "${flagInput}"\n\n${banderas}`);
        }
      } else {
        let digits = await resolvePhoneDigits(msg.author || msg.from);
        if (!digits) {
          const c = await msg.getContact().catch(() => null);
          digits = String(c?.number || '').replace(/\D/g, '');
        }
        const c = countryFromDigits(digits);
        baseCode = (c && countryTimezoneMap[c]) ? c : 'MX'; // fallback CDMX
        console.log(`🕒 Zona base de ${who}: tel=${digits || '?'} → ${baseCode}`);
      }

      const base = countryTimezoneMap[baseCode];
      const baseTime = DateTime.fromObject({ hour, minute }, { zone: base.zone });

      let response =
        `🕓 *Tu hora: ${baseTime.toFormat('HH:mm')}* ${base.flag} (${cityName(base.zone)})\n`;

      // ---- 2) Conversión a los países de los demás miembros ----
      if (isGroupMsg) {
        const participants = await getGroupMembers(msg.from);

        const phones = await Promise.all(participants.map(p => resolvePhoneDigits(p.id, p.pn)));
        participants.forEach((p, i) => {
          const d = phones[i];
          console.log(`   👤 ${p.id} → tel=${d || '❌ sin resolver'} → país=${countryFromDigits(d) || '?'}`);
        });
        const seen = new Set([baseCode]);
        const lines = [];

        phones.forEach(digits => {
          const iso = countryFromDigits(digits);
          if (!iso || seen.has(iso) || !countryTimezoneMap[iso]) return;
          seen.add(iso);

          const tz = countryTimezoneMap[iso];
          const local = baseTime.setZone(tz.zone);
          const diff = local.startOf('day').diff(baseTime.startOf('day'), 'days').days; // sin depender de local.day
          const cambioDia = diff > 0 ? ' (día siguiente)' : diff < 0 ? ' (día anterior)' : '';
          lines.push(`${tz.flag} *${local.toFormat('HH:mm')}* – ${cityName(tz.zone)}${cambioDia}`);
        });

        console.log(`🕒 Participantes: ${participants.length}, con teléfono resuelto: ${phones.filter(Boolean).length}, zonas: ${lines.length}`);

        response += lines.length
          ? `\n🌎 *Conversión para el grupo:*\n${lines.join('\n')}`
          : '\nℹ️ No se detectaron miembros de otros países en el grupo.';
      } else {
        response += '\nℹ️ Usa este comando en un grupo para ver la conversión de sus miembros.';
      }

      return msg.reply(response);
    }
  } catch (err) {
    console.error('❌ Error en message handler:', shortErr(err), '\n', String(err && err.stack || '').split('\n').slice(1, 4).join('\n'));
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
    const chatKey = notification.chatId || notification.id?.remote;
    if (!chatKey) return;
    const joinedIds = collectIds(notification);
    if (!joinedIds.length) return;

    for (const participantId of joinedIds) {
      const key = welcomeKey(chatKey, participantId);
      const now = Date.now();
      if (now - (lastWelcomeAt.get(key) || 0) < MIN_INTERVAL_MS) continue;
      lastWelcomeAt.set(key, now); // marcar ANTES de await evita dobles por carrera
      rememberMember(chatKey, participantId);

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

      await client.sendMessage(chatKey, bienvenida, { mentions: contact ? [contact] : [] });
      console.log(`✅ Bienvenida enviada a ${contact?.pushname || contact?.number || participantId}`);
    }
  } catch (error) {
    console.error('❌ Error en handleWelcome:', error);
  }
}

// Si alguien sale, limpiamos su marca para que un reingreso inmediato VUELVA a saludar.
async function handleLeave(notification) {
  try {
    const chatKey = notification.chatId || notification.id?.remote;
    if (!chatKey) return;
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
(async function initClient() {
  const MAX_TRIES = 3;
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      await client.initialize();
      return;
    } catch (err) {
      console.error(`❌ Error al inicializar el cliente (intento ${i}/${MAX_TRIES}): ${shortErr(err)}`);
      if (i === MAX_TRIES) break;
      try { await client.destroy(); } catch (_) { /* noop */ }
      prepareProfile();
      await sleep(3000 * i);
    }
  }
  // Pausa antes de salir: evita un bucle de reinicios ultrarrápido
  await sleep(15000);
  shutdown(1);
})();
