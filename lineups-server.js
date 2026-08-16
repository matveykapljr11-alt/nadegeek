/*
 * Lineups — минимальный бэкенд для Telegram Mini App (Telegram-first MVP).
 * Зависимостей нет (только стандартная библиотека Node). Node 18+.
 *
 * Что делает:
 *   - Отдаёт lineups.html, инжектируя window.LINEUPS_CONFIG (бэкенд + имя бота).
 *   - POST /api/sync          — вход по Telegram initData: возвращает saved/visited
 *                               пользователя и community-раскидки (чтобы клиент
 *                               добавил их к встроенному каталогу).
 *   - POST /api/save          — сохранить/убрать раскидку { id, on } (нужен initData)
 *   - POST /api/visit         — отметить просмотренной { id }
 *   - POST /api/submit        — предложить свою раскидку { lineup } -> { id, lineup }
 *   - GET  /api/lineup?id=     — публичная одиночная раскидка (для deep-link шаринга)
 *   - GET  /health
 *
 * Шаринг / deep-link: клиент строит t.me/<bot>/<app>?startapp=<lineupId>.
 * Telegram открывает Mini App с этим id в start_param — код бота НЕ нужен,
 * достаточно один раз в @BotFather включить Web App и указать URL этого сервера.
 *
 * Каталог: базовые раскидки живут в самом lineups.html (офлайн-фолбэк).
 * Сервер хранит только пользовательское состояние и community-раскидки —
 * так клиент работает и без сервера, и с сервером (синхронизация поверх).
 *
 * Хранилище: lineups-data.json рядом с файлом (для MVP; для прод — БД).
 *
 * Запуск:
 *   BOT_TOKEN=123:ABC BOT_USERNAME=lineups_bot APP_NAME=app \
 *   PUBLIC_URL=https://your-host node lineups-server.js
 *
 * Переменные окружения:
 *   PORT           порт (по умолчанию 8080)
 *   BOT_TOKEN      токен бота из BotFather. Если задан — initData проверяется строго.
 *   BOT_USERNAME   username бота без @ (для ссылок «поделиться»)
 *   APP_NAME       short name Mini App из BotFather (если приложение именованное)
 *   PUBLIC_URL     публичный адрес сервера (для справки/логов)
 *   AUTO_APPROVE   "1" (по умолчанию) — предложенные раскидки сразу видны сообществу;
 *                  "0" — попадают в модерацию (видны только автору со статусом pending).
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || process.argv[2] || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const APP_NAME = process.env.APP_NAME || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const AUTO_APPROVE = process.env.AUTO_APPROVE !== '0';
// Куда бот кладёт видео (приватный канал/группа с ботом-админом). Если пусто —
// видео отправляется в чат самого загрузившего (нужно чтобы он нажал Start у бота).
const STORAGE_CHAT_ID = process.env.STORAGE_CHAT_ID || '';
// Постоянное хранилище (Upstash Redis REST). Если задано — данные (раскидки,
// сейвы, просмотры) переживают засыпание/передеплой. Если нет — локальный JSON
// (эфемерно на Render free). Поддерживаются и дефолтные имена Upstash.
const KV_URL = (process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_ON = !!(KV_URL && KV_TOKEN);
// Telegram id владельцев (через запятую), кому можно менять фоны карт.
// Пусто = разрешено любому авторизованному (MVP; для прода задай свой id).
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const DATA_FILE = path.join(__dirname, 'lineups-data.json');
const HTML_FILE = path.join(__dirname, 'lineups.html');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024; // 32 МБ (лимит sendVideo у бота — 50 МБ)

/* ----------------------------------------------------- storage */
let db = { users: {}, subs: {}, seq: 1 };
const KV_KEY = 'lineups_db';
function kvReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    let uu; try { uu = new URL(KV_URL + urlPath); } catch (e) { reject(e); return; }
    const opts = { method, hostname: uu.hostname, port: 443, path: uu.pathname + uu.search, headers: { Authorization: 'Bearer ' + KV_TOKEN } };
    if (body != null) { opts.headers['Content-Type'] = 'text/plain'; opts.headers['Content-Length'] = Buffer.byteLength(body); }
    const r = https.request(opts, resp => { let b = ''; resp.on('data', c => b += c); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ result: b }); } }); });
    r.on('error', reject); if (body != null) r.write(body); r.end();
  });
}
async function loadDb() {
  if (KV_ON) {
    try { const j = await kvReq('GET', '/get/' + KV_KEY); if (j && j.result) db = Object.assign(db, JSON.parse(j.result)); }
    catch (e) { console.error('KV load failed:', e.message); }
    return;
  }
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (KV_ON) kvReq('POST', '/set/' + KV_KEY, JSON.stringify(db)).catch(e => console.error('KV save:', e.message));
    else fs.writeFile(DATA_FILE, JSON.stringify(db), err => { if (err) console.error('persist', err); });
  }, 300);
}
function genId() { return 'u' + (db.seq++).toString(36) + crypto.randomBytes(2).toString('hex'); }
function userRec(id) {
  const k = String(id);
  if (!db.users[k]) db.users[k] = { saved: [], visited: [] };
  return db.users[k];
}

/* ----------------------------------------------------- telegram auth */
// Проверка подписи initData по документации Telegram Web Apps.
function verifyInitData(initData) {
  if (!initData) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  params.delete('signature'); // новое поле Telegram (Ed25519) — в hash-проверку не входит
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  if (!BOT_TOKEN) {
    try { const u = JSON.parse(params.get('user') || 'null'); return u ? { ...u, _unverified: true } : null; }
    catch (e) { return null; }
  }
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc !== hash) return null;
  // защита от протухшего initData (24 часа)
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
}
function authName(u) {
  if (!u) return 'Гость';
  if (u.username) return '@' + u.username;
  return (u.first_name || 'Игрок');
}
function isAdmin(u) { if (!u) return false; if (!ADMIN_IDS.length) return true; return ADMIN_IDS.includes(String(u.id)); }

/* ----------------------------------------------------- helpers */
function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MAPS = ['sandstone', 'province', 'rust', 'zone9', 'sakura', 'dune', 'village'];
const TYPES = ['smoke', 'flash', 'molotov'];
// Санитизация предложенной раскидки.
function cleanLineup(l) {
  if (!l || typeof l !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n).trim() : '');
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const pt = p => (p && typeof p === 'object' ? { x: num(p.x, 0, 512, 256), y: num(p.y, 0, 512, 256), n: str(p.n, 28) || 'Точка' } : null);
  const from = pt(l.from), to = pt(l.to);
  const title = str(l.title, 60);
  if (!from || !to || !title) return null;
  return {
    map: MAPS.includes(l.map) ? l.map : 'sandstone',
    side: l.side === 'defense' ? 'defense' : 'attack',
    type: TYPES.includes(l.type) ? l.type : 'smoke',
    zone: ['A', 'B', 'Mid', 'Long'].includes(l.zone) ? l.zone : 'A',
    title, from, to,
    thr: str(l.thr, 20) || 'Stand',
    dur: /^\d:\d\d$/.test(l.dur) ? l.dur : '0:05',
    diff: l.diff === 'advanced' ? 'advanced' : 'easy',
    desc: str(l.desc, 140),
    aim: str(l.aim, 60),
    video: (typeof l.video === 'string' && /^[A-Za-z0-9_-]{10,220}$/.test(l.video)) ? l.video : ''
  };
}

/* ----------------------------------------------------- telegram bot api (видео-хранилище) */
function tgCall(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, resp => { let b = ''; resp.on('data', c => b += c); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
// Загрузка видео в Telegram → возвращает постоянный file_id.
function tgSendVideo(chatId, buf, mime) {
  return new Promise((resolve, reject) => {
    const boundary = '----lu' + crypto.randomBytes(8).toString('hex');
    const ct = /^video\//.test(mime || '') ? mime : 'video/mp4';
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="supports_streaming"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="lineup.mp4"\r\nContent-Type: ${ct}\r\n\r\n`, 'utf8');
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([pre, buf, post]);
    const req = https.request('https://api.telegram.org/bot' + BOT_TOKEN + '/sendVideo', {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, resp => {
      let b = ''; resp.on('data', c => b += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.ok) { const f = j.result.video || j.result.animation || j.result.document; resolve(f && f.file_id); }
          else reject(new Error(j.description || 'sendVideo failed'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function readBodyRaw(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Загрузка изображения (фон карты) в Telegram → file_id.
function tgSendPhoto(chatId, buf, mime) {
  return new Promise((resolve, reject) => {
    const boundary = '----lu' + crypto.randomBytes(8).toString('hex');
    const ct = /^image\//.test(mime || '') ? mime : 'image/jpeg';
    const ext = ct.indexOf('png') >= 0 ? 'png' : 'jpg';
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="map.${ext}"\r\nContent-Type: ${ct}\r\n\r\n`, 'utf8');
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([pre, buf, post]);
    const req = https.request('https://api.telegram.org/bot' + BOT_TOKEN + '/sendPhoto', {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, resp => {
      let b = ''; resp.on('data', c => b += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.ok) { const a = j.result.photo; resolve(a && a.length && a[a.length - 1].file_id); }
          else reject(new Error(j.description || 'sendPhoto failed'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
// Раскидка из submission в формат клиента.
function subToLineup(rec, meId) {
  return Object.assign({ id: rec.id }, rec.lineup, {
    authorName: rec.authorName,
    mine: meId != null && rec.ownerId === meId,
    pending: rec.status !== 'approved'
  });
}

/* ----------------------------------------------------- html serving */
function serveHtml(res) {
  fs.readFile(HTML_FILE, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('lineups.html not found next to server'); return; }
    const cfg = { enabled: true, apiBase: '', botUsername: BOT_USERNAME, appName: APP_NAME };
    const inject = `\n<script>window.LINEUPS_CONFIG=${JSON.stringify(cfg)};</script>\n`;
    const outHtml = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(outHtml);
  });
}

/* ----------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
  if (p === '/health') { json(res, 200, { ok: true, users: Object.keys(db.users).length, subs: Object.keys(db.subs).length, kv: KV_ON }); return; }

  // временная диагностика авторизации (секреты не раскрываются)
  if (p === '/api/authdbg' && req.method === 'POST') {
    const initData = req.headers['x-init-data'] || '';
    const out = { present: !!initData, botTokenSet: !!BOT_TOKEN };
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash') || '';
      out.keys = [...params.keys()];
      out.hasSignature = params.has('signature');
      out.givenHash6 = hash.slice(0, 6);
      const ad = parseInt(params.get('auth_date') || '0', 10);
      out.authDateAgeSec = ad ? Math.round(Date.now() / 1000 - ad) : null;
      if (BOT_TOKEN && hash) {
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const build = (exclSig) => { const pp = new URLSearchParams(initData); pp.delete('hash'); if (exclSig) pp.delete('signature'); return [...pp.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n'); };
        const cNo = crypto.createHmac('sha256', secret).update(build(true)).digest('hex');
        const cWith = crypto.createHmac('sha256', secret).update(build(false)).digest('hex');
        out.matchNoSig = cNo === hash; out.matchWithSig = cWith === hash;
      }
    } catch (e) { out.error = String(e.message || e); }
    json(res, 200, out);
    return;
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/lineups.html')) { serveHtml(res); return; }

  // ---- вход + синхронизация ----
  if (p === '/api/sync' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    const rec = user ? userRec(user.id) : { saved: [], visited: [] };
    const community = Object.values(db.subs)
      .filter(s => s.status === 'approved' || (user && s.ownerId === user.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(s => subToLineup(s, user ? user.id : null));
    const maps = db.maps ? Object.keys(db.maps).reduce((o, k) => { o[k] = true; return o; }, {}) : {};
    json(res, 200, {
      user: user ? { id: user.id, name: authName(user) } : null,
      saved: rec.saved, visited: rec.visited, community, maps, admin: isAdmin(user)
    });
    return;
  }

  if (p === '/api/save' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (!user) { json(res, 401, { error: 'auth' }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    if (!b || typeof b.id !== 'string') { json(res, 400, { error: 'bad' }); return; }
    const rec = userRec(user.id);
    const has = rec.saved.includes(b.id);
    if (b.on && !has) rec.saved.push(b.id);
    if (!b.on && has) rec.saved = rec.saved.filter(x => x !== b.id);
    persist();
    json(res, 200, { saved: rec.saved });
    return;
  }

  if (p === '/api/visit' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (!user) { json(res, 200, { ok: false }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    if (b && typeof b.id === 'string') {
      const rec = userRec(user.id);
      if (!rec.visited.includes(b.id)) { rec.visited.push(b.id); persist(); }
    }
    json(res, 200, { ok: true });
    return;
  }

  if (p === '/api/submit' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    const lineup = cleanLineup(b && b.lineup);
    if (!lineup) { json(res, 400, { error: 'bad lineup' }); return; }
    const id = genId();
    const rec = {
      id, lineup,
      ownerId: user ? user.id : 0,
      authorName: authName(user),
      status: AUTO_APPROVE ? 'approved' : 'pending',
      createdAt: Date.now()
    };
    db.subs[id] = rec;
    persist();
    json(res, 200, { id, lineup: subToLineup(rec, user ? user.id : null) });
    return;
  }

  // ---- загрузка видео в Telegram (нужен initData + BOT_TOKEN) ----
  if (p === '/api/upload' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    if (!BOT_TOKEN) { json(res, 503, { error: 'no bot token' }); return; }
    let buf; try { buf = await readBodyRaw(req, MAX_VIDEO_BYTES); } catch (e) { json(res, 413, { error: 'too large (max 32MB)' }); return; }
    if (!buf.length) { json(res, 400, { error: 'empty' }); return; }
    const chatId = STORAGE_CHAT_ID || (user && user.id);
    if (!chatId) { json(res, 500, { error: 'no storage chat' }); return; }
    try {
      const fid = await tgSendVideo(chatId, buf, req.headers['content-type']);
      if (!fid) { json(res, 502, { error: 'send failed' }); return; }
      json(res, 200, { video: fid });
    } catch (e) { json(res, 502, { error: String(e.message || e) }); }
    return;
  }

  // ---- проксирование видео из Telegram (токен не отдаём клиенту) ----
  if (p === '/api/video' && req.method === 'GET') {
    const id = u.searchParams.get('id') || '';
    const rec = db.subs[id];
    const fid = rec && rec.lineup && rec.lineup.video;
    if (!BOT_TOKEN || !fid) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no video'); return; }
    let gf; try { gf = await tgCall('getFile', { file_id: fid }); } catch (e) { gf = null; }
    if (!gf || !gf.ok || !gf.result.file_path) { res.writeHead(404); res.end('no file'); return; }
    https.get('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + gf.result.file_path, tr => {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      tr.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end('upstream'); });
    return;
  }

  // ---- фон карты: загрузка (владелец) ----
  if (p === '/api/mapimg' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    if (!BOT_TOKEN) { json(res, 503, { error: 'no bot token' }); return; }
    if (!isAdmin(user)) { json(res, 403, { error: 'not admin' }); return; }
    const map = u.searchParams.get('map') || '';
    if (!MAPS.includes(map)) { json(res, 400, { error: 'bad map' }); return; }
    let buf; try { buf = await readBodyRaw(req, 12 * 1024 * 1024); } catch (e) { json(res, 413, { error: 'too large (max 12MB)' }); return; }
    if (!buf.length) { json(res, 400, { error: 'empty' }); return; }
    const chatId = STORAGE_CHAT_ID || (user && user.id);
    if (!chatId) { json(res, 500, { error: 'no storage chat' }); return; }
    try {
      const fid = await tgSendPhoto(chatId, buf, req.headers['content-type']);
      if (!fid) { json(res, 502, { error: 'send failed' }); return; }
      if (!db.maps) db.maps = {};
      db.maps[map] = fid; persist();
      json(res, 200, { ok: true, map });
    } catch (e) { json(res, 502, { error: String(e.message || e) }); }
    return;
  }

  // ---- фон карты: отдача (публично, прокси из Telegram) ----
  if (p === '/api/mapimg' && req.method === 'GET') {
    const map = u.searchParams.get('map') || '';
    const fid = db.maps && db.maps[map];
    if (!BOT_TOKEN || !fid) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no map'); return; }
    let gf; try { gf = await tgCall('getFile', { file_id: fid }); } catch (e) { gf = null; }
    if (!gf || !gf.ok || !gf.result.file_path) { res.writeHead(404); res.end('no file'); return; }
    https.get('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + gf.result.file_path, tr => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
      tr.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end('upstream'); });
    return;
  }

  // ---- одиночная раскидка для deep-link (публично) ----
  if (p === '/api/lineup' && req.method === 'GET') {
    const id = u.searchParams.get('id') || '';
    const rec = db.subs[id];
    if (!rec || (rec.status !== 'approved')) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, { lineup: subToLineup(rec, null) });
    return;
  }

  json(res, 404, { error: 'not found' });
});

loadDb().then(() => {
  if (!db.maps) db.maps = {};
  server.listen(PORT, () => {
    console.log(`Lineups server on :${PORT}`);
    console.log(`  bot: ${BOT_USERNAME || '(BOT_USERNAME не задан)'}  app: ${APP_NAME || '(APP_NAME не задан)'}`);
    console.log(`  auth: ${BOT_TOKEN ? 'строгая (initData проверяется)' : 'DEV (BOT_TOKEN не задан — подпись не проверяется)'}`);
    console.log(`  submissions: ${AUTO_APPROVE ? 'авто-публикация' : 'модерация (pending)'}`);
    console.log(`  video: ${BOT_TOKEN ? ('Telegram, storage=' + (STORAGE_CHAT_ID || 'чат загрузившего')) : 'выключено (нет BOT_TOKEN)'}`);
    console.log(`  storage: ${KV_ON ? 'Upstash KV (постоянно)' : 'локальный JSON (ЭФЕМЕРНО на Render free — данные сбрасываются)'}`);
    if (PUBLIC_URL) console.log(`  public: ${PUBLIC_URL}`);
  });
});
