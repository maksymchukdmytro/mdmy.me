// Сервер mdmy.me (by Maksymchuk Dmytro).
//  • /                — головна сторінка;
//  • /nakladna/       — видаткові накладні з LP-CRM у PDF;
//  • /                — персональний асистент (застосунок mdmy): голос і текст → задачі, нагадування, нотатки, ритуали дня, Telegram-бот;
//                       його файли — /assistant/… (js, css, іконки), сервіс-воркер — /sw.js; стара адреса /assistant/ → 301 на /;
//  • /m/<файл>        — фото й відео ритуалів власника (випадкові імена, без входу — їх забирають Telegram і сповіщення);
//    /m/u5/<файл>     — медіа окремої бази: за сесією її власника або за підписаним посиланням;
//  • /api/*           — вхід (lib/auth.js) і API розділів; усе, крім входу, лише після входу.
// Запуск: npm install && npm start, потім відкрити http://localhost:3001
// Перший обліковий запис: npm run account -- create <логін> "<Ім'я>"
const http = require('http');
const fs = require('fs');
const path = require('path');
const DB = require('./lib/db');
const keys = require('./lib/keys');
const { send } = require('./lib/util');

const PORT = process.env.PORT || 3001;
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = DB.open(DATA);
// старі незашифровані знімки й окремі бази (наприклад, вимкнених акаунтів) — зашифрувати одразу; основну вже відкрито й зашифровано
try { const n = DB.encryptPlainFiles(DATA, 2, new Set([path.resolve(db.file)])); if (n) console.log(`[db] зашифровано старих файлів: ${n}`); } catch (e) { console.error('[db]', e.message); }
const auth = require('./lib/auth')(db);
const nakladna = require('./lib/nakladna')(db, auth.log);
const stt = require('./lib/stt')();
const assistant = require('./lib/assistant').get(db);
const push = require('./lib/push').get(db);
// статистика для адмінки: день — за часовим поясом власника
const usage = require('./lib/usage');
usage.init(db, () => assistant.settings().tz || 'Europe/Kyiv');
const { readBody } = require('./lib/util');

// ---------- окремі бази облікових записів (accounts.ws, див. lib/db.js v8) ----------
// Кожна — свій файл DATA_DIR/ws/<ws>/mdmy.db зі своїми задачами, звичками, ритуалами й сповіщеннями.
// Ключ Claude, модель і Telegram-бот — з основної бази (бот один, чати — свої).
const crypto = require('crypto');
const WS = new Map();
function workspace(ws) {
  if (!ws) return { db, assistant, push };
  let w = WS.get(ws); if (w) return w;
  const acc = db.prepare('SELECT role FROM accounts WHERE ws = ?').get(ws);
  const wdb = DB.open(DB.wsDir(DATA, ws));
  const as = require('./lib/assistant').make(wdb, { shared: () => assistant.settings(), ws, allow: () => allowAI(ws), budget: () => admin.budgetAllows(ws), signMedia: u => signMedia(u) });
  w = { db: wdb, assistant: as, push: as.push, ws };
  WS.set(ws, w);
  if (acc && acc.role === 'demo') { try { require('./lib/demo')(wdb, as); } catch (e) { console.error('[demo] заповнення:', e.message); } }
  as.start();
  return w;
}
const wsOf = a => workspace(a.ws);
function closeWorkspace(ws) {
  const w = WS.get(ws); if (!w) return;
  w.assistant.stop(); WS.delete(ws);
  try { w.db.close(); } catch (e) {}
}

// Денний ліміт запитів до асистента для окремих баз (адмінка → «Ліміти»: загальний, для гостя, особистий; 0 — без обмежень).
// Повідомлення асистенту рахує сам асистент через allow — і з сайту, і з Telegram. Лічильник — usage_daily (kind msg).
function allowAI(ws) {
  const acc = db.prepare('SELECT * FROM accounts WHERE ws = ?').get(ws);
  const limit = admin.limitsFor(acc).ai;
  if (limit && admin.used(ws, 'msg').n >= limit) return false;
  usage.note(ws, 'msg');
  return true;
}
// Ліміт файлів для облікових записів з окремою базою (крім адмінів): місце разом (вкладення, фото й відео, докази) і завантажень на добу —
// з адмінки («Ліміти», за замовчуванням 50 МБ і 10). Посилання ({url}) не рахуються. Лічильник дня — usage_daily (kind upload).
const UPLOAD_RE = /^\/api\/(routines\/media|assistant\/items\/\d+\/attachments|team\/tasks\/\d+\/files|challenges\/\d+\/files(\/\d+)?)$/;
const isUpload = (req, url) => req.method === 'POST' && UPLOAD_RE.test(url) && !/json/.test(req.headers['content-type'] || '');
function dirSize(d) {
  let n = 0;
  try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? dirSize(f) : e.isFile() ? fs.statSync(f).size : 0; } } catch (e) {}
  return n;
}
function storageUsed(a) {
  const dir = DB.wsDir(DATA, a.ws);
  return dirSize(path.join(dir, 'files')) + dirSize(path.join(dir, 'media')) +
    (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM shared_files WHERE by_account = ?').get(a.id).n || 0);
}
const hasQuota = a => !!a.ws && a.role !== 'admin';
function quotaView(a) {
  if (!hasQuota(a)) return null;
  const L = admin.limitsFor(a);
  if (!L.storageMb && !L.uploadsDay) return null;
  return { used: storageUsed(a), limit: L.storageMb * 1048576, today: admin.used(a.ws, 'upload').n, perDay: L.uploadsDay };
}
function uploadBlocked(a, req, url, res) {
  if (!hasQuota(a) || !isUpload(req, url)) return null;
  const L = admin.limitsFor(a), len = +req.headers['content-length'] || 0;
  if (L.uploadsDay && admin.used(a.ws, 'upload').n >= L.uploadsDay) return `На сьогодні вже завантажено ${L.uploadsDay} файлів — це ліміт на добу. Посилання можна додавати й далі.`;
  if (L.storageMb && storageUsed(a) + len > L.storageMb * 1048576) return `Місце для файлів закінчилось (${L.storageMb} МБ). Видаліть непотрібні вкладення або додайте посилання.`;
  res.on('finish', () => { if (res.statusCode < 300) usage.note(a.ws, 'upload', 1, len); });
  return null;
}

function blocked(a, req, url) {
  if (a.role === 'nakladna' && !url.startsWith('/api/nakladna/')) return 'Цей обліковий запис — лише для накладних.';
  if (url.startsWith('/api/nakladna/') && a.ws) return 'Накладні доступні лише власнику.';
  if (!a.ws) return null;
  if (a.role === 'demo' && url === '/api/routines/media' && req.method === 'POST') return 'У гостьовому вході завантаження фото й відео вимкнено.';
  if (req.method === 'POST' && /^\/api\/(assistant\/(triage|summary|plan)|stt\/transcribe)$/.test(url) && !allowAI(a.ws))
    return 'Ліміт асистента на сьогодні вичерпано. Спробуйте завтра.';
  return null;
}

// Медіа окремих баз (/m/u5/<файл>): лише власнику за сесією або за підписаним посиланням (Telegram і сповіщення забирають файл без входу).
function mediaSecret() {
  if (mediaSecret.v) return mediaSecret.v;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'media_secret'").get();
  if (row) {
    if (!keys.isSealed(row.value)) db.prepare("UPDATE meta SET value = ? WHERE key = 'media_secret'").run(keys.seal(row.value));
    return (mediaSecret.v = keys.unseal(row.value));
  }
  const v = crypto.randomBytes(32).toString('hex'); db.prepare("INSERT INTO meta (key, value) VALUES ('media_secret', ?)").run(keys.seal(v)); return (mediaSecret.v = v);
}
const mediaMac = (p, e) => crypto.createHmac('sha256', mediaSecret()).update(`${p}.${e}`).digest('base64url').slice(0, 32);
function signMedia(u) { const e = Date.now() + 7 * 864e5; return `${u}?e=${e}&s=${mediaMac(u, e)}`; }
function mediaAllowed(req, url, ws) {
  const q = new URL(req.url, 'http://x').searchParams, e = +q.get('e'), sig = q.get('s') || '';
  if (e > Date.now() && sig.length === 32 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mediaMac(url, e)))) return true;
  const a = auth.current(req);
  return !!(a && a.ws === ws);
}

// ---------- спільне між акаунтами: доручення, челенджі, файли-докази (lib/team.js) ----------
const T = require('./lib/assistant-time');
const accWs = id => db.prepare('SELECT ws, disabled FROM accounts WHERE id = ?').get(id);
const todayOf = a => T.dayKey(Date.now(), wsOf(a).assistant.settings().tz);
// сповістити акаунт: Telegram (якщо привʼязаний) і push на його пристрої
function notify(accountId, title, text, url) {
  const r = accWs(accountId); if (!r || r.disabled) return;
  let w; try { w = workspace(r.ws); } catch (e) { return; }
  const pub = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (w.assistant.bot.ready()) w.assistant.bot.sendText(`${title}\n\n${text}`, /^https:/.test(pub) && url ? { reply_markup: { inline_keyboard: [[{ text: 'Відкрити', url: pub + url }]] } } : {}).catch(() => {});
  w.push.sendText(title, text, url).catch(() => {});
}
const team = require('./lib/team')(db, { dataDir: DATA, notify, todayOf });

// ---------- адмінка (/admin/, lib/admin.js): огляд, користувачі, ліміти ----------
const admin = require('./lib/admin')(db, { DATA, DB, workspace, closeWorkspace, team, auth, stt: require('./lib/stt'), notify });
// бюджет на Claude і резервні копії: перевірка за хвилину після старту, далі кожні 10 хв
setTimeout(() => admin.tick(), 60e3).unref();
setInterval(() => admin.tick(), 10 * 60e3).unref();

// ---------- «Почати спочатку» і видалення акаунта ----------
const wipe = require('./lib/wipe');
async function account(req, res, url, a) {
  const b = await readBody(req, 1024) || {};
  // імʼя в привітанні, листах і списку користувачів
  if (url === '/api/account/name' && req.method === 'POST') {
    if (a.role === 'demo') return send(res, 403, { error: 'У гостьовому вході імʼя не змінюється.' });
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'Напишіть імʼя.' });
    db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, a.id);
    auth.log(a, 'account:name', name);
    return send(res, 200, { ok: true, name });
  }
  if (url === '/api/account/reset' && req.method === 'POST') {
    if (b.confirm !== 'ОЧИСТИТИ') return send(res, 400, { error: 'Підтвердіть словом ОЧИСТИТИ.' });
    const w = wsOf(a);
    if (!a.ws) {                                   // основна база власника — перед очищенням знімок поруч із базою
      const snap = path.join(DATA, `mdmy-before-reset-${new Date().toISOString().slice(0, 10)}.db`);
      try { if (!fs.existsSync(snap)) db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`); } catch (e) { return send(res, 500, { error: 'Не вдалося зберегти копію перед очищенням.' }); }
    }
    wipe(w.db); w.assistant.store.resetDict();
    if (a.role === 'demo') require('./lib/demo')(w.db, w.assistant);
    auth.log(a, 'account:reset');
    return send(res, 200, { ok: true });
  }
  if (url === '/api/account/delete' && req.method === 'POST') {
    if (!a.ws) return send(res, 400, { error: 'Основний акаунт власника не видаляється.' });
    if (a.role === 'demo') return send(res, 400, { error: 'Гостьовий акаунт не видаляється — можна почати спочатку.' });
    if (b.confirm !== 'ВИДАЛИТИ') return send(res, 400, { error: 'Підтвердіть словом ВИДАЛИТИ.' });
    team.forgetAccount(a.id);
    closeWorkspace(a.ws);
    try { fs.rmSync(DB.wsDir(DATA, a.ws), { recursive: true, force: true }); } catch (e) { console.error('[account] видалення файлів:', e.message); }
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(a.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    auth.log(null, 'account:delete', a.login);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.setCookie(req, '', 0) });
  }
  return send(res, 404, { error: 'Не знайдено.' });
}

// Telegram: один бот (основної бази) — багато чатів. Чат окремої бази знаходимо за її chatId або кодом привʼязки.
const wsList = () => [...WS.values()];
assistant.bot.setRouter({
  find(chat, code) {
    const target = code ? wsList().find(w => w.assistant.settings().linkCode === code) : null;
    if (target) { this.release(chat, target); return target.assistant.bot; }
    const w = wsList().find(x => x.assistant.settings().chatId === chat);
    return w ? w.assistant.bot : null;
  },
  isCode: code => wsList().some(w => w.assistant.settings().linkCode === code),
  // чат переходить до іншого облікового запису — відвʼязуємо його від окремих баз (крім keep)
  release(chat, keep) { for (const w of wsList()) if (w !== keep && w.assistant.settings().chatId === chat) w.assistant.unlinkTelegram(); }
});
// Telegram Web App: вхід у той обліковий запис, до чиєї бази привʼязаний чат
auth.setTelegramLookup(uid => {
  const w = [...WS.entries()].find(([, x]) => +x.assistant.settings().chatId === +uid);
  return w ? db.prepare('SELECT * FROM accounts WHERE ws = ? AND disabled = 0').get(w[0]) : null;
});

// ---------- сторінки ----------
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
                '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8',
                '.webmanifest':'application/manifest+json' };
const SECTIONS = ['nakladna', 'assistant', 'admin'];                 // сторінки, що працюють лише після входу
const REDIRECTS = { '/speachtotext': '/', '/speachtotext/': '/', '/speechtotext': '/', '/speechtotext/': '/', '/assistant': '/', '/assistant/': '/', '/assistant/index.html': '/' };
// застосунок відкривається з кореня сайту; сервіс-воркер — з кореня, щоб керувати всім сайтом (файл лежить у public/assistant/)
const ROOT_FILES = { '/sw.js': 'assistant/sw.js' };

function serveStatic(req, res, url) {
  // ?welcome=1, ?auth_error=… переносяться; #/… браузер зберігає сам
  if (REDIRECTS[url]) { const q = req.url.indexOf('?'); res.writeHead(301, { Location: REDIRECTS[url] + (q >= 0 ? req.url.slice(q) : '') }); return res.end(); }
  if (SECTIONS.includes(url.slice(1))) { res.writeHead(301, { Location: url + '/' }); return res.end(); }
  if (url.endsWith('/')) url += 'index.html';
  const rel = ROOT_FILES[url] || path.normalize(url).replace(/^[/\\]+/, '');
  if (rel.includes('..') || rel.split(/[/\\]/).some(p => p.startsWith('.'))) { res.writeHead(404); return res.end('Не знайдено'); }
  const file = path.join(PUBLIC, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не знайдено'); }
    const top = rel === 'index.html' ? 'assistant' : rel.split(/[/\\]/)[0];      // головна сторінка — застосунок
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...SECURITY };
    if (SECTIONS.includes(top)) {
      // асистент можна відкривати як Telegram Web App (у вебверсії Telegram це iframe); решту — лише напряму.
      // CSP: скрипти лише власні (жодних inline і чужих) — навіть якщо десь проскочить вставка HTML, чужий код не виконається.
      if (top === 'assistant') headers['Content-Security-Policy'] = CSP_APP;
      else headers['X-Frame-Options'] = 'DENY';
      if (top === 'admin') headers['Content-Security-Policy'] = CSP_ADMIN;
      headers['Cache-Control'] = rel.includes('vendor') ? 'public, max-age=604800' : 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Заголовки безпеки для сторінок: HTTPS назавжди (HSTS), без витоку адрес у Referer, без доступу до камери / геолокації
const SECURITY = { 'Strict-Transport-Security': 'max-age=31536000', 'Referrer-Policy': 'same-origin',
                   'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)' };
const CSP_APP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
                 "img-src 'self' data: blob: https:", "media-src 'self' blob: https:", "frame-src https://www.youtube-nocookie.com", "connect-src 'self'",
                 "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self' https://web.telegram.org"].join('; ');
// адмінка: лише власні скрипти й запити, жодних вбудовувань
const CSP_ADMIN = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
                   "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

// ---------- API ----------
async function api(req, res, url) {
  if (url === '/api/ping') return send(res, 200, { ok: true, encrypted: DB.encrypted });
  if (url === '/api/push/action' && req.method === 'POST') {    // кнопка в сповіщенні, без сесії; токен «u5~…» — з окремої бази
    const b = await readBody(req, 2048), m = /^(u\d+)~/.exec((b && b.token) || '');
    if (m && !db.prepare('SELECT 1 FROM accounts WHERE ws = ?').get(m[1])) return send(res, 404, { error: 'Посилання застаріло.' });
    return workspace(m ? m[1] : null).assistant.pushAction(req, res, b || {});
  }
  const a = await auth.handle(req, res, url);
  if (!a) return;                                            // відповідь уже надіслано (вхід, вихід, помилка доступу)
  const no = blocked(a, req, url);
  if (no) return send(res, a.role !== 'nakladna' && (url.startsWith('/api/assistant/') || url.startsWith('/api/stt/')) ? 429 : 403, { error: no });
  const full = uploadBlocked(a, req, url, res);
  if (full) { req.resume(); return send(res, 413, { error: full }); }
  usage.seen(a.id);
  if (url === '/api/account/quota' && req.method === 'GET') return send(res, 200, { quota: quotaView(a) });
  if (url.startsWith('/api/account/')) return account(req, res, url, a);
  if (url === '/api/admin/auth') return auth.google.admin(req, res, url, a);
  if (url.startsWith('/api/admin/')) return admin.handle(req, res, url, a);
  if (url === '/api/team' || url.startsWith('/api/team/')) return team.handleTeam(req, res, url, a);
  if (url === '/api/challenges' || url.startsWith('/api/challenges/')) return team.handleChallenges(req, res, url, a);
  if (url.startsWith('/api/shared/')) return team.handleShared(req, res, url, a);
  const w = wsOf(a);
  if (url.startsWith('/api/nakladna/')) return nakladna.handle(req, res, url, a);
  if (url.startsWith('/api/stt/')) return stt.handle(req, res, url, a.ws);
  if (url.startsWith('/api/assistant/')) return w.assistant.handle(req, res, url, a, auth.log);
  if (url === '/api/routines' || url.startsWith('/api/routines/')) return w.assistant.routines.handle(req, res, url);
  if (url === '/api/habits' || url.startsWith('/api/habits/')) return w.assistant.habits.handle(req, res, url);
  if (url.startsWith('/api/push/')) return w.push.handle(req, res, url, a);
  return send(res, 404, { error: 'Не знайдено.' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  try {
    if (url.startsWith('/api/')) return await api(req, res, url);
    if (url.startsWith('/m/')) {
      const m = /^\/m\/(u\d+)\//.exec(url);
      if (m && (!db.prepare('SELECT 1 FROM accounts WHERE ws = ?').get(m[1]) || !mediaAllowed(req, url, m[1]))) { res.writeHead(404); return res.end(); }
      return workspace(m ? m[1] : null).assistant.routines.serveMedia(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Помилка сервера.' });
  }
});

// Прибирання прострочених сесій раз на добу
setInterval(() => db.prepare('DELETE FROM sessions WHERE last_used < ?').run(Date.now() - 30 * 864e5), 864e5).unref();

const shutdown = () => { for (const w of WS.values()) { try { w.db.close(); } catch (e) {} } try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  assistant.start();   // нагадування, ранковий план, підсумок дня, Telegram-бот
  // окремі бази: їхні нагадування, ритуали й звички теж мають працювати без входу
  for (const { ws } of db.prepare('SELECT DISTINCT ws FROM accounts WHERE ws IS NOT NULL AND disabled = 0').all()) {
    try { workspace(ws); } catch (e) { console.error('[ws]', ws, e.message); }
  }
  console.log(`mdmy.me: http://localhost:${PORT}`);
  console.log(`База даних: ${db.file}`);
  if (!db.prepare('SELECT 1 FROM accounts').get()) console.log('Облікового запису ще немає. Створіть: npm run account -- create <логін> "<Ім\'я>"');
});
