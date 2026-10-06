// SkiBot — versión consolidada y optimizada para Docker
'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { DateTime } = require('luxon');
const { parsePhoneNumber } = require('libphonenumber-js');
const ct = require('countries-and-timezones');

// ================== Config (variables de entorno) ==================
const BOT_NAME = process.env.BOT_NAME || 'Skibot';
const DATA_DIR = process.env.DATA_DIR || '.';
const SESSION_PATH = path.join(DATA_DIR, '.wwebjs_auth');
const CACHE_PATH = path.join(DATA_DIR, '.wwebjs_cache');
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/skibot-heartbeat';
const LOG_MESSAGES = process.env.LOG_MESSAGES === 'true'; // loguear TODOS los mensajes (debug)
// Por defecto SOLO la lista (owner/admins) puede usar comandos; el resto se ignora en silencio.
const PUBLIC_COMMANDS = process.env.PUBLIC_COMMANDS === 'true';       // true = !comandos, !link gremio, etc. abiertos a todos
const ALLOW_GROUP_ADMINS = process.env.ALLOW_GROUP_ADMINS !== 'false'; // default true: los admins del grupo (según WhatsApp) también pueden; 'false' = solo la lista
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3000);
const WATCHDOG_MS = 5 * 60 * 1000;

const botStartTime = new Date();

// Número del owner: últimos 10 dígitos SIN +52 ni prefijos
const OWNER_NUMBER_BASE10 = toBase10(process.env.OWNER_NUMBER || '');
// Listas por variable de entorno. Se acepta separar con coma, punto y coma o espacios,
// y entradas con comillas. Cada entrada puede ser:
//   • un ID exacto  → 50337134186514@lid   (o solo 50337134186514)
//   • un teléfono   → 528123456789          (se compara contra el número del remitente)
const splitList = v => String(v || '').split(/[,;\s]+/)
  .map(x => x.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean);
const isPhoneLike = x => !x.includes('@') && /^\+?\d{7,15}$/.test(x);
const idsOf = v => new Set(splitList(v).filter(x => !isPhoneLike(x)));
const phonesOf = v => splitList(v).filter(isPhoneLike).map(toBase10);

const OWNER_IDS = idsOf(process.env.OWNER_IDS);
const ADMIN_IDS = idsOf(process.env.ADMIN_IDS);
// Teléfonos de admin: ADMIN_NUMBERS + teléfonos escritos dentro de ADMIN_IDS
const ADMIN_NUMBERS = new Set(
  [...splitList(process.env.ADMIN_NUMBERS).map(toBase10), ...phonesOf(process.env.ADMIN_IDS)].filter(x => x.length >= 7)
);
const OWNER_EXTRA_NUMBERS = phonesOf(process.env.OWNER_IDS).filter(x => x.length >= 7);
if (!OWNER_NUMBER_BASE10) {
  console.warn('⚠️ OWNER_NUMBER no está definido: nadie tendrá permisos de owner.');
}

// (Las zonas horarias ahora se calculan para TODOS los países; ver sección "Zonas horarias")

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
  for (const [k, v] of adminCache) if (now - v.ts > ADMIN_STALE_MS) adminCache.delete(k);
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

// ---------- Admins del grupo (según WhatsApp) ----------
// Se compara por ID exacto (@lid o @c.us) y por teléfono (últimos 10 dígitos), con caché:
//  • 60 s de caché "fresca" para no consultar WhatsApp Web en cada comando
//  • si WhatsApp Web falla, se usa la última lista conocida (hasta 15 min)
const adminCache = new Map(); // chatId -> { ids:Set, phones:Set, ts }
const ADMIN_FRESH_MS = 60 * 1000;
const ADMIN_STALE_MS = 15 * 60 * 1000;

async function loadGroupAdmins(chat) {
  const admins = (await ensureParticipants(chat)).filter(isAdminFlag);
  const ids = new Set(admins.map(p => p?.id?._serialized).filter(Boolean));
  const { numbers } = await participantNumbers(admins); // resuelve @lid → teléfono
  const phones = new Set(numbers.map(toBase10).filter(x => x.length >= 7));
  return { ids, phones, ts: Date.now() };
}

async function checkGroupAdmin(msg) {
  const chatId = msg.from;
  let info = adminCache.get(chatId);

  if (!info || Date.now() - info.ts > ADMIN_FRESH_MS) {
    let loaded = null;
    const chat = await safeCall(() => msg.getChat(), 'getChat (permisos)');
    if (chat && chat.isGroup) {
      try { loaded = await loadGroupAdmins(chat); } catch (e) { console.error('⚠️ No pude leer admins del grupo:', shortErr(e)); }
    }
    if (loaded && loaded.ids.size + loaded.phones.size > 0) {
      adminCache.set(chatId, loaded);
      info = loaded;
    } else if (info && Date.now() - info.ts <= ADMIN_STALE_MS) {
      console.log('ℹ️ WhatsApp Web no respondió; uso la lista de admins en caché');
    } else {
      return { ok: false, reason: 'no se pudo verificar admin del grupo (error de WhatsApp Web)' };
    }
  }

  const author = String(msg.author || '');
  if (author && info.ids.has(author)) return { ok: true, reason: 'admin del grupo' };

  const num = await senderFullNumber(msg);
  if (num && info.phones.has(toBase10(num))) return { ok: true, reason: 'admin del grupo' };

  return { ok: false, reason: 'no está en la lista ni es admin del grupo' };
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
const OWNER_SET = new Set([...(OWNER_NUMBER_BASE10 ? [OWNER_NUMBER_BASE10] : []), ...OWNER_EXTRA_NUMBERS]);
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

  let num = '';
  if (OWNER_SET.size || ADMIN_NUMBERS.size) {
    num = await senderBase10(msg);
    if (num && OWNER_SET.has(num)) return { ok: true, reason: 'owner (por número)' };
    if (num && ADMIN_NUMBERS.has(num)) return { ok: true, reason: 'admin (por número)' };
  }

  if (ALLOW_GROUP_ADMINS && isGroupMsg) {
    const r = await checkGroupAdmin(msg);
    return { ok: r.ok, num, reason: r.reason };
  }
  return { ok: false, num, reason: 'no está en la lista de owner/admins' };
}

// ================== Zonas horarias (todos los países) ==================
// Para países con varias zonas, el número de teléfono no dice en cuál vive la persona:
// usamos la zona "principal". Para el resto se usa la única zona del país.
const MAIN_ZONE = {
  MX: 'America/Mexico_City', US: 'America/New_York', CA: 'America/Toronto', BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires', CL: 'America/Santiago', EC: 'America/Guayaquil',
  ES: 'Europe/Madrid', PT: 'Europe/Lisbon', RU: 'Europe/Moscow', AU: 'Australia/Sydney',
  ID: 'Asia/Jakarta', KZ: 'Asia/Almaty', MN: 'Asia/Ulaanbaatar', CD: 'Africa/Kinshasa',
  NZ: 'Pacific/Auckland', UA: 'Europe/Kyiv', GL: 'America/Nuuk', FM: 'Pacific/Chuuk',
  PF: 'Pacific/Tahiti', KI: 'Pacific/Tarawa', CN: 'Asia/Shanghai',
};
const zoneOk = z => Boolean(z) && DateTime.now().setZone(z).isValid;
const zoneCache = new Map();
function countryZone(iso) {
  if (zoneCache.has(iso)) return zoneCache.get(iso);
  let zone = null;
  if (zoneOk(MAIN_ZONE[iso])) {
    zone = MAIN_ZONE[iso];
  } else {
    const zones = (ct.getCountry(iso)?.timezones || []).filter(zoneOk);
    if (zones.length === 1) zone = zones[0];
    else if (zones.length > 1) { // la zona cuyo offset es el más repetido
      const count = new Map();
      for (const z of zones) { const o = DateTime.now().setZone(z).offset; count.set(o, (count.get(o) || 0) + 1); }
      const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      zone = zones.find(z => DateTime.now().setZone(z).offset === best);
    }
  }
  zoneCache.set(iso, zone);
  return zone;
}

const flagOf = iso => String.fromCodePoint(...[...iso.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
function isoFromFlagOrCode(str) {
  const t = String(str || '').trim();
  const cps = [...t].map(c => c.codePointAt(0));
  if (cps.length === 2 && cps.every(c => c >= 0x1F1E6 && c <= 0x1F1FF)) {
    return String.fromCharCode(...cps.map(c => c - 0x1F1E6 + 65));
  }
  if (/^[A-Za-z]{2}$/.test(t) && ct.getCountry(t.toUpperCase())) return t.toUpperCase();
  return null;
}
const regionNames = (() => { try { return new Intl.DisplayNames(['es'], { type: 'region' }); } catch (_) { return null; } })();
const countryName = iso => { try { return regionNames?.of(iso) || iso; } catch (_) { return iso; } };
const cityOf = zone => zone.split('/').pop().replace(/_/g, ' ');

function utcLabel(offsetMin) {
  const a = Math.abs(offsetMin), h = Math.floor(a / 60), m = a % 60;
  return `UTC${offsetMin < 0 ? '−' : '+'}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}
function dayDelta(local, base) {
  const d = x => DateTime.fromISO(x.toISODate(), { zone: 'utc' });
  return Math.round(d(local).diff(d(base), 'days').days);
}
function countryFromNumber(digits) {
  try {
    const p = parsePhoneNumber(`+${digits}`);
    if (!p) return null;
    return p.country || (typeof p.getPossibleCountries === 'function' ? p.getPossibleCountries()[0] : null) || null;
  } catch (_) { return null; }
}

// Número completo (con código de país) de quien envía. Si WhatsApp lo oculta tras un @lid, se resuelve.
const lidCache = new Map(); // lid -> dígitos del teléfono
const cacheLid = (lid, d) => { if (lidCache.size > 5000) lidCache.clear(); lidCache.set(lid, d); };
async function senderFullNumber(msg) {
  const raw = String(msg.author || msg.from || '');
  if (!raw.endsWith('@lid')) return raw.split('@')[0].replace(/\D/g, '');
  if (lidCache.has(raw)) return lidCache.get(raw);
  const contact = await msg.getContact().catch(() => null);
  let d = contact?.number ? String(contact.number).replace(/\D/g, '') : '';
  if (!d) {
    const res = await safeCall(() => client.getContactLidAndPhone([raw]), 'resolver @lid del remitente', 1);
    if (res?.[0]?.pn) d = String(res[0].pn).split('@')[0].replace(/\D/g, '');
  }
  if (d) cacheLid(raw, d);
  return d;
}

// Teléfonos de todos los participantes. Los @lid se resuelven por lotes (con caché).
async function participantNumbers(participants) {
  const numbers = [];
  const pending = [];
  for (const p of participants || []) {
    const ser = p?.id?._serialized || '';
    if (ser.endsWith('@lid') || p?.id?.server === 'lid') {
      const lid = ser || `${p.id.user}@lid`;
      if (lidCache.has(lid)) numbers.push(lidCache.get(lid)); else pending.push(lid);
    } else {
      const d = String(p?.id?.user || p?.number || '').replace(/\D/g, '');
      if (d) numbers.push(d);
    }
  }
  let unresolved = 0;
  for (let i = 0; i < pending.length; i += 40) {
    const chunk = pending.slice(i, i + 40);
    const res = await safeCall(() => client.getContactLidAndPhone(chunk), 'resolver @lid de participantes', 2);
    chunk.forEach((lid, idx) => {
      const pn = res?.[idx]?.pn;
      const d = pn ? String(pn).split('@')[0].replace(/\D/g, '') : '';
      if (d) { cacheLid(lid, d); numbers.push(d); } else unresolved++;
    });
  }
  return { numbers, unresolved };
}

// Agrupa a los miembros por hora local (mismo offset UTC = misma línea)
function convertToZones(numbers, baseTime) {
  const byOffset = new Map();
  let unknown = 0;
  for (const n of numbers) {
    const iso = countryFromNumber(n);
    const zone = iso && countryZone(iso);
    if (!zone) { unknown++; continue; }
    const local = baseTime.setZone(zone);
    if (!byOffset.has(local.offset)) byOffset.set(local.offset, { offset: local.offset, local, countries: new Map() });
    const g = byOffset.get(local.offset);
    g.countries.set(iso, (g.countries.get(iso) || 0) + 1);
  }
  return { groups: [...byOffset.values()].sort((a, b) => a.offset - b.offset), unknown };
}
const dayTag = d => (d > 0 ? ' (día siguiente)' : d < 0 ? ' (día anterior)' : '');
const countriesTxt = g => [...g.countries.entries()].sort((a, b) => b[1] - a[1])
  .map(([iso, n]) => `${flagOf(iso)} ${iso}${n > 1 ? ` ×${n}` : ''}`).join('  ');

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
        const numTxt = auth.num ? `número resuelto: ${auth.num}` : 'número NO resuelto';
        console.log(`⛔ IGNORADO: ${senderId} (${who}) → sin respuesta (${numTxt})`);
        console.log(`   💡 Para autorizarlo agrega a ADMIN_IDS exactamente: ${senderId}`);
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

          const targetChat = await safeCall(() => client.getChatById(target.id), 'getChatById (encuesta)');

          // Resumen de horarios locales (según prefijo telefónico de los miembros)
          const baseTime = DateTime.fromFormat(
            `${state.fecha} ${state.hora}`, 'dd/MM/yyyy HH:mm', { zone: 'America/Mexico_City' }
          );
          const parts = targetChat ? await ensureParticipants(targetChat) : [];
          const { numbers } = await participantNumbers(parts);
          const { groups } = convertToZones(numbers, baseTime);
          let tzSummary = '🕒 Horarios locales:\n';
          for (const g of groups) {
            const flags = [...g.countries.keys()].slice(0, 6).map(flagOf).join('');
            tzSummary += `${flags} ${g.local.toFormat('HH:mm')}${dayTag(dayDelta(g.local, baseTime))}\n`;
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
   ➤ Tu hora local: \`Consultar hora 15:30\`
   ➤ Hora de otro país: \`Consultar hora 15:30 🇦🇷\`

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
    // "Consultar hora 21:39"        → 21:39 en la zona de QUIEN ESCRIBE (según su número)
    // "Consultar hora 21:39 🇦🇷"    → 21:39 en la zona de esa bandera / código de país
    if (startsWithCmd(rawBody, ['consultar hora', '!consultar hora'])) { // con o sin !
      if (onCooldown(msg, 'hora')) return;

      const clean = rawBody.replace(/\u200B/g, '');
      const m = clean.match(/consultar hora\s+(\d{1,2}):(\d{2})\s*(.+)?/i);
      if (!m) {
        return msg.reply('⛔ Usa el formato: *Consultar hora 20:00*\nEjemplos:\n• *Consultar hora 20:00* (tu hora local)\n• *Consultar hora 20:00 🇦🇷* (hora de Argentina)');
      }

      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      if (hour > 23 || minute > 59) {
        return msg.reply('⛔ Hora inválida. Usa formato 24h como *20:00* 🕒');
      }

      // 1) ¿En qué zona está la hora que escribió?
      let baseIso = null;
      let whoTxt = 'hora de quien consulta';
      if (m[3] && m[3].trim()) {
        baseIso = isoFromFlagOrCode(m[3]);
        if (!baseIso) {
          return msg.reply(`⛔ No reconocí "${m[3].trim()}". Usa una bandera (🇦🇷) o el código de país (AR).\nEjemplo: *Consultar hora 20:00 🇲🇽*`);
        }
        whoTxt = `hora en ${countryName(baseIso)}`;
      } else {
        const num = await senderFullNumber(msg);
        baseIso = num ? countryFromNumber(num) : null;
      }
      let baseZone = baseIso && countryZone(baseIso);
      if (!baseZone) { // no se pudo saber: asumimos México
        baseIso = 'MX'; baseZone = 'America/Mexico_City'; whoTxt = 'hora (no pude detectar tu país; asumo México)';
      }

      const baseTime = DateTime.now().setZone(baseZone).set({ hour, minute, second: 0, millisecond: 0 });

      // 2) Conversión para todos los miembros del grupo
      let groups = [], unknown = 0, couldRead = true;
      if (isGroupMsg) {
        const chat = await safeCall(() => msg.getChat(), 'getChat (hora)', 2);
        if (chat) {
          const { numbers, unresolved } = await participantNumbers(await ensureParticipants(chat));
          const r = convertToZones(numbers, baseTime);
          groups = r.groups;
          unknown = r.unknown + unresolved;
        } else {
          couldRead = false;
        }
      }

      const baseOffset = baseTime.offset;
      const sameGroup = groups.find(g => g.offset === baseOffset);
      const others = groups.filter(g => g.offset !== baseOffset);

      let response = `🕓 *${baseTime.toFormat('HH:mm')}* — ${whoTxt}\n` +
        `📍 ${flagOf(baseIso)} ${countryName(baseIso)} · ${cityOf(baseZone)} (${utcLabel(baseOffset)})`;
      if (sameGroup) {
        const extra = [...sameGroup.countries.entries()].filter(([iso]) => iso !== baseIso);
        if (extra.length) response += `\n🤝 Misma hora: ${extra.map(([iso, n]) => `${flagOf(iso)} ${iso}${n > 1 ? ` ×${n}` : ''}`).join('  ')}`;
      }

      if (others.length) {
        const MAX_LINES = 20;
        response += '\n\n🌎 *Hora en el grupo:*\n' +
          others.slice(0, MAX_LINES).map(g =>
            `🕙 *${g.local.toFormat('HH:mm')}*${dayTag(dayDelta(g.local, baseTime))} (${utcLabel(g.offset)}) — ${countriesTxt(g)}`
          ).join('\n');
        if (others.length > MAX_LINES) response += `\n… y ${others.length - MAX_LINES} zonas más`;
      } else if (isGroupMsg && couldRead) {
        response += '\n\nℹ️ No hay miembros en otras zonas horarias.';
      }
      if (!couldRead) response += '\n\n⚠️ No pude leer la lista de miembros (error de WhatsApp Web). Intenta de nuevo en un minuto.';
      if (unknown) response += `\n\nℹ️ ${unknown} miembro(s) sin país identificable.`;
      if (others.length || sameGroup) response += '\n\n_Países con varias zonas (EE. UU., Brasil, México…) usan su zona principal._';

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

// ================== Resumen de configuración ==================
const mask = n => (n.length > 4 ? '…' + n.slice(-4) : n);
console.log('⚙️ Config → ' + [
  `OWNER_IDS=[${[...OWNER_IDS].join(', ')}]`,
  `ADMIN_IDS=[${[...ADMIN_IDS].join(', ')}]`,
  `owner por número=[${[...OWNER_SET].map(mask).join(', ')}]`,
  `admins por número=[${[...ADMIN_NUMBERS].map(mask).join(', ')}]`,
  `PUBLIC_COMMANDS=${PUBLIC_COMMANDS}`,
  `ALLOW_GROUP_ADMINS=${ALLOW_GROUP_ADMINS}`,
].join(' | '));
if (!OWNER_IDS.size && !ADMIN_IDS.size && !OWNER_SET.size && !ADMIN_NUMBERS.size) {
  console.warn('⚠️ No hay NADIE en la lista (OWNER_*/ADMIN_*): el bot ignorará todos los comandos. ¿Las variables llegan al contenedor?');
}

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
