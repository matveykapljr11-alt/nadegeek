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
// По умолчанию — модерация: чужие раскидки попадают в очередь, админы публикуются сразу.
// AUTO_APPROVE=1 — публиковать всех без модерации.
const AUTO_APPROVE = process.env.AUTO_APPROVE === '1';
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
// Cloudflare R2 (S3-совместимое). Если задано — видео хранится там (без лимита 20 МБ Telegram),
// отдаётся напрямую по публичному URL (Range/стриминг из коробки).
// Универсальное S3-хранилище видео (Cloudflare R2 / Supabase / Backblaze B2 и т.п.).
// R2_* — обратная совместимость: если заданы, строим из них S3_ENDPOINT.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const S3_ENDPOINT = (process.env.S3_ENDPOINT || (R2_ACCOUNT_ID ? 'https://' + R2_ACCOUNT_ID + '.r2.cloudflarestorage.com' : '')).replace(/\/$/, '');
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET || process.env.R2_BUCKET || '';
const S3_PUBLIC_URL = (process.env.S3_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const S3_HOST = (() => { try { return new URL(S3_ENDPOINT).host; } catch (e) { return ''; } })();
const S3_BASE = (() => { try { return new URL(S3_ENDPOINT).pathname.replace(/\/$/, ''); } catch (e) { return ''; } })();
const S3_ON = !!(S3_ENDPOINT && S3_HOST && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && S3_BUCKET && S3_PUBLIC_URL);
const MAX_S3_BYTES = 300 * 1024 * 1024;

const DATA_FILE = path.join(__dirname, 'lineups-data.json');
const HTML_FILE = path.join(__dirname, 'lineups.html');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // Bot API getFile качает только до 20 МБ — иначе видео не отдать

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
  params.delete('hash'); // signature (если есть) ВХОДИТ в data_check_string — не удаляем
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
function isAdmin(u) {
  if (!u) return false;
  const id = String(u.id);
  if (ADMIN_IDS.includes(id)) return true;                       // владельцы из env (несменяемы)
  if ((db.admins || []).some(a => String(a.id) === id)) return true; // назначенные из приложения
  if (!ADMIN_IDS.length && !(db.admins || []).length) return true;   // никто не задан → все (MVP)
  return false;
}

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
const MAPS = ['sandstone', 'province', 'rust', 'breeze', 'dune', 'hanami', 'prison'];
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
    video: (typeof l.video === 'string' && (/^https:\/\/[\w./:?=&%~-]{10,300}$/.test(l.video) || /^[A-Za-z0-9_-]{10,220}$/.test(l.video))) ? l.video : ''
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
// Подпись AWS SigV4 для PUT в S3-совместимое хранилище (UNSIGNED-PAYLOAD — тело стримится).
function s3SignedPutHeaders(key, contentType, contentLength) {
  const host = S3_HOST;
  const canonicalUri = S3_BASE + '/' + S3_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const amzdate = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const datestamp = amzdate.slice(0, 8);
  const region = S3_REGION, service = 's3', payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + S3_SECRET_ACCESS_KEY, datestamp);
  k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  const headers = {
    'Host': host, 'x-amz-date': amzdate, 'x-amz-content-sha256': payloadHash,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType
  };
  if (contentLength != null) headers['Content-Length'] = contentLength;
  return { host, path: canonicalUri, headers };
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
    authorAvatar: (db.users[rec.ownerId] && db.users[rec.ownerId].avatar) ? ('/api/avatar?user=' + rec.ownerId) : '',
    mine: meId != null && rec.ownerId === meId,
    pending: rec.status !== 'approved'
  });
}

/* ----------------------------------------------------- html serving */
function serveHtml(res) {
  fs.readFile(HTML_FILE, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('lineups.html not found next to server'); return; }
    const cfg = { enabled: true, apiBase: '', botUsername: BOT_USERNAME, appName: APP_NAME, videoMaxMB: parseInt(process.env.VIDEO_MAX_MB || '0', 10) || (S3_ON ? 300 : 20) };
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
  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/lineups.html')) { serveHtml(res); return; }

  // ---- вход + синхронизация ----
  if (p === '/api/sync' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    const rec = user ? userRec(user.id) : { saved: [], visited: [] };
    if (user) { rec.seen = Date.now(); rec.visits = (rec.visits || 0) + 1; rec.name = authName(user); if (!rec.first) rec.first = Date.now(); persist(); }
    const community = Object.values(db.subs)
      .filter(s => s.status === 'approved' || (user && s.ownerId === user.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(s => subToLineup(s, user ? user.id : null));
    const maps = db.maps ? Object.keys(db.maps).reduce((o, k) => { o[k] = true; return o; }, {}) : {};
    json(res, 200, {
      user: user ? { id: user.id, name: authName(user) } : null,
      nick: (user && rec.nick) || '',
      bio: (user && rec.bio) || '',
      avatar: (user && rec.avatar) ? ('/api/avatar?user=' + user.id) : '',
      saved: rec.saved, visited: rec.visited, community, maps, admin: isAdmin(user)
    });
    return;
  }

  // ---- аналитика (владелец) ----
  if (p === '/api/stats' && req.method === 'GET') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    if (!isAdmin(user)) { json(res, 403, { error: 'not admin' }); return; }
    const now = Date.now(), day = 86400000;
    const users = Object.values(db.users);
    const subs = Object.values(db.subs);
    const byMap = {}, byType = {}, authors = {};
    subs.forEach(s => { const l = s.lineup || {}; byMap[l.map] = (byMap[l.map] || 0) + 1; byType[l.type] = (byType[l.type] || 0) + 1; authors[s.authorName] = (authors[s.authorName] || 0) + 1; });
    json(res, 200, {
      users: users.length,
      active24h: users.filter(u => u.seen && now - u.seen < day).length,
      active7d: users.filter(u => u.seen && now - u.seen < 7 * day).length,
      opens: users.reduce((n, u) => n + (u.visits || 0), 0),
      lineups: subs.length,
      withVideo: subs.filter(s => s.lineup && s.lineup.video).length,
      pending: subs.filter(s => s.status !== 'approved').length,
      saves: users.reduce((n, u) => n + (u.saved ? u.saved.length : 0), 0),
      studied: users.reduce((n, u) => n + (u.visited ? u.visited.length : 0), 0),
      mapBg: Object.keys(db.maps || {}),
      byMap, byType,
      topAuthors: Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })),
      recent: subs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map(s => ({ title: s.lineup.title, map: s.lineup.map, type: s.lineup.type, author: s.authorName, video: !!s.lineup.video, at: s.createdAt })),
      admins: ADMIN_IDS.map(id => ({ id, name: 'владелец', env: true })).concat((db.admins || []).map(a => ({ id: String(a.id), name: a.name || ('id ' + a.id), env: false }))),
      people: Object.entries(db.users).map(([id, u]) => ({ id, name: u.name || ('id ' + id), seen: u.seen || 0 })).sort((a, b) => b.seen - a.seen).slice(0, 40),
      queue: subs.filter(s => s.status !== 'approved').sort((a, b) => b.createdAt - a.createdAt).map(s => ({ id: s.id, title: s.lineup.title, map: s.lineup.map, type: s.lineup.type, author: s.authorName, video: !!s.lineup.video, from: s.lineup.from.n, to: s.lineup.to.n }))
    });
    return;
  }

  // ---- назначение/снятие админов (админ) ----
  if (p === '/api/admins' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    if (!isAdmin(user)) { json(res, 403, { error: 'not admin' }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    const id = String((b && b.id) || '').replace(/\D/g, '');
    if (!id) { json(res, 400, { error: 'bad id' }); return; }
    if (ADMIN_IDS.includes(id)) { json(res, 400, { error: 'owner (env) — нельзя менять' }); return; }
    if (!db.admins) db.admins = [];
    if (b.action === 'add') { if (!db.admins.some(a => String(a.id) === id)) db.admins.push({ id, name: String(b.name || '').slice(0, 40), by: user ? user.id : 0, at: Date.now() }); }
    else if (b.action === 'remove') { db.admins = db.admins.filter(a => String(a.id) !== id); }
    else { json(res, 400, { error: 'bad action' }); return; }
    persist();
    json(res, 200, { ok: true, admins: db.admins });
    return;
  }

  // ---- удаление раскидки (владелец раскидки или админ) ----
  if (p === '/api/delete' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    const rec = b && db.subs[b.id];
    if (!rec) { json(res, 404, { error: 'not found' }); return; }
    if (!((user && rec.ownerId === user.id) || isAdmin(user))) { json(res, 403, { error: 'not owner' }); return; }
    delete db.subs[b.id];
    persist();
    json(res, 200, { ok: true });
    return;
  }

  // ---- модерация раскидок (админ) ----
  if (p === '/api/moderate' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    if (!isAdmin(user)) { json(res, 403, { error: 'not admin' }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    const rec = b && db.subs[b.id];
    if (!rec) { json(res, 404, { error: 'not found' }); return; }
    if (b.action === 'approve') rec.status = 'approved';
    else if (b.action === 'reject') delete db.subs[b.id];
    else { json(res, 400, { error: 'bad action' }); return; }
    persist();
    json(res, 200, { ok: true });
    return;
  }

  // ---- профиль: ник + био ----
  if (p === '/api/profile' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (!user) { json(res, 401, { error: 'auth' }); return; }
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { b = null; }
    const rec = userRec(user.id);
    if (b && typeof b.nick === 'string') rec.nick = b.nick.replace(/[\r\n\t]/g, ' ').trim().slice(0, 24);
    if (b && typeof b.bio === 'string') rec.bio = b.bio.replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);
    const display = rec.nick || authName(user);
    Object.values(db.subs).forEach(s => { if (s.ownerId === user.id) s.authorName = display; });
    persist();
    json(res, 200, { nick: rec.nick || '', bio: rec.bio || '' });
    return;
  }

  // ---- аватар: загрузка (свой) ----
  if (p === '/api/avatar' && req.method === 'POST') {
    const user = verifyInitData(req.headers['x-init-data']);
    if (BOT_TOKEN && !user) { json(res, 401, { error: 'auth' }); return; }
    if (!BOT_TOKEN) { json(res, 503, { error: 'no bot token' }); return; }
    let buf; try { buf = await readBodyRaw(req, 12 * 1024 * 1024); } catch (e) { json(res, 413, { error: 'too large (max 12MB)' }); return; }
    if (!buf.length) { json(res, 400, { error: 'empty' }); return; }
    const chatId = STORAGE_CHAT_ID || (user && user.id);
    if (!chatId) { json(res, 500, { error: 'no storage chat' }); return; }
    try {
      const fid = await tgSendPhoto(chatId, buf, req.headers['content-type']);
      if (!fid) { json(res, 502, { error: 'send failed' }); return; }
      userRec(user.id).avatar = fid; persist();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 502, { error: String(e.message || e) }); }
    return;
  }

  // ---- аватар: отдача (публично, прокси из Telegram) ----
  if (p === '/api/avatar' && req.method === 'GET') {
    const uid = u.searchParams.get('user') || '';
    const rec = db.users[uid];
    const fid = rec && rec.avatar;
    if (!BOT_TOKEN || !fid) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no avatar'); return; }
    let gf; try { gf = await tgCall('getFile', { file_id: fid }); } catch (e) { gf = null; }
    if (!gf || !gf.ok || !gf.result.file_path) { res.writeHead(404); res.end('no file'); return; }
    https.get('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + gf.result.file_path, tr => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
      tr.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end('upstream'); });
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
      authorName: (user && userRec(user.id).nick) || authName(user),
      status: (AUTO_APPROVE || isAdmin(user)) ? 'approved' : 'pending',
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
    if ((BOT_TOKEN || S3_ON) && !user) { json(res, 401, { error: 'auth' }); return; }
    // --- S3-хранилище: стримим прямо в бакет (без лимита 20 МБ) ---
    if (S3_ON) {
      const cl = parseInt(req.headers['content-length'] || '0', 10);
      if (cl > MAX_S3_BYTES) { json(res, 413, { error: 'too large' }); return; }
      const key = 'videos/' + genId() + '.mp4';
      const ct = req.headers['content-type'] || 'video/mp4';
      const opts = s3SignedPutHeaders(key, ct, req.headers['content-length']);
      const s3req = https.request({ hostname: opts.host, path: opts.path, method: 'PUT', headers: opts.headers }, s3res => {
        let body = ''; s3res.on('data', c => body += c);
        s3res.on('end', () => {
          if (s3res.statusCode >= 200 && s3res.statusCode < 300) json(res, 200, { video: S3_PUBLIC_URL + '/' + key });
          else json(res, 502, { error: 's3 ' + s3res.statusCode, detail: body.slice(0, 200) });
        });
      });
      s3req.on('error', e => { if (!res.headersSent) json(res, 502, { error: String(e.message || e) }); });
      req.on('error', () => s3req.destroy());
      req.pipe(s3req);
      return;
    }
    // --- Telegram fallback (≤20 МБ) ---
    if (!BOT_TOKEN) { json(res, 503, { error: 'no storage' }); return; }
    let buf; try { buf = await readBodyRaw(req, MAX_VIDEO_BYTES); } catch (e) { json(res, 413, { error: 'too large (max 20MB)' }); return; }
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
    // Проброс Range-запросов к файловому серверу Telegram — обязательно для <video> на iOS,
    // иначе Safari/Telegram-WebView показывает чёрный экран.
    const fileUrl = new URL('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + gf.result.file_path);
    const reqHeaders = {};
    if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];
    https.get({ hostname: fileUrl.hostname, path: fileUrl.pathname + fileUrl.search, headers: reqHeaders }, tr => {
      const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' };
      if (tr.headers['content-length']) h['Content-Length'] = tr.headers['content-length'];
      if (tr.headers['content-range']) h['Content-Range'] = tr.headers['content-range'];
      res.writeHead(tr.statusCode === 206 ? 206 : 200, h);
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

  // ---- временная проверка S3 (без секретов) ----
  if (p === '/api/_r2test' && req.method === 'GET') {
    const out = {
      s3On: S3_ON,
      has: { endpoint: !!S3_ENDPOINT, host: !!S3_HOST, accessKeyId: !!S3_ACCESS_KEY_ID, secret: !!S3_SECRET_ACCESS_KEY, bucket: !!S3_BUCKET, publicUrl: !!S3_PUBLIC_URL },
      host: S3_HOST || null, region: S3_REGION, bucket: S3_BUCKET || null, publicUrl: S3_PUBLIC_URL || null
    };
    if (S3_ON) {
      const key = 'test/ping.txt', body = Buffer.from('ok');
      const opts = s3SignedPutHeaders(key, 'text/plain', body.length);
      await new Promise(resolve => {
        const rr = https.request({ hostname: opts.host, path: opts.path, method: 'PUT', headers: opts.headers }, rp => {
          let b = ''; rp.on('data', c => b += c); rp.on('end', () => { out.putStatus = rp.statusCode; if (rp.statusCode >= 300) out.putDetail = b.slice(0, 300); resolve(); });
        });
        rr.on('error', e => { out.putErr = String(e.message || e); resolve(); });
        rr.write(body); rr.end();
      });
      out.testUrl = S3_PUBLIC_URL + '/' + key;
    }
    json(res, 200, out);
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
  if (!db.admins) db.admins = [];
  server.listen(PORT, () => {
    console.log(`Lineups server on :${PORT}`);
    console.log(`  bot: ${BOT_USERNAME || '(BOT_USERNAME не задан)'}  app: ${APP_NAME || '(APP_NAME не задан)'}`);
    console.log(`  auth: ${BOT_TOKEN ? 'строгая (initData проверяется)' : 'DEV (BOT_TOKEN не задан — подпись не проверяется)'}`);
    console.log(`  submissions: ${AUTO_APPROVE ? 'авто-публикация всех' : 'модерация (админы — сразу, остальные в очередь)'}`);
    console.log(`  video: ${S3_ON ? ('S3 (' + S3_HOST + ') → ' + S3_PUBLIC_URL) : (BOT_TOKEN ? ('Telegram ≤20МБ, storage=' + (STORAGE_CHAT_ID || 'чат загрузившего')) : 'выключено')}`);
    console.log(`  storage: ${KV_ON ? 'Upstash KV (постоянно)' : 'локальный JSON (ЭФЕМЕРНО на Render free — данные сбрасываются)'}`);
    if (PUBLIC_URL) console.log(`  public: ${PUBLIC_URL}`);
  });
});
