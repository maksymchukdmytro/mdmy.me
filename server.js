// Сервер mdmy.me (by Maksymchuk Dmytro).
//  • /                — головна сторінка;
//  • /nakladna/       — видаткові накладні з LP-CRM у PDF;
//  • /assistant/      — персональний асистент: голос і текст → задачі, нагадування, нотатки, ритуали дня, Telegram-бот;
//  • /m/<файл>        — фото й відео ритуалів (випадкові імена, без входу — їх забирають Telegram і сповіщення);
//  • /api/*           — вхід (lib/auth.js) і API розділів; усе, крім входу, лише після входу.
// Запуск: npm install && npm start, потім відкрити http://localhost:3001
// Перший обліковий запис: npm run account -- create <логін> "<Ім'я>"
const http = require('http');
const fs = require('fs');
const path = require('path');
const DB = require('./lib/db');
const { send } = require('./lib/util');

const PORT = process.env.PORT || 3001;
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = DB.open(DATA);
const auth = require('./lib/auth')(db);
const nakladna = require('./lib/nakladna')(db, auth.log);
const stt = require('./lib/stt')();
const assistant = require('./lib/assistant').get(db);
const push = require('./lib/push').get(db);
const { readBody } = require('./lib/util');

// ---------- окремі бази облікових записів (accounts.ws, див. lib/db.js v8) ----------
// Кожна — свій файл DATA_DIR/ws/<ws>/mdmy.db зі своїми задачами, звичками, ритуалами й сповіщеннями.
// Ключ Claude і модель — з основної бази; Telegram-бот — лише в основній.
const WS = new Map();
function workspace(ws) {
  if (!ws) return { assistant, push };
  let w = WS.get(ws); if (w) return w;
  const wdb = DB.open(DB.wsDir(DATA, ws));
  const as = require('./lib/assistant').make(wdb, { shared: () => assistant.settings(), ws });
  w = { db: wdb, assistant: as, push: as.push };
  WS.set(ws, w);
  const acc = db.prepare('SELECT role FROM accounts WHERE ws = ?').get(ws);
  if (acc && acc.role === 'demo') { try { require('./lib/demo')(wdb, as); } catch (e) { console.error('[demo] заповнення:', e.message); } }
  as.start();
  return w;
}
const wsOf = a => workspace(a.ws);

// Гостьовий вхід (роль demo): спільний пароль, тож обмежуємо дороге — асистент і розшифровку голосу — денним лімітом.
const DEMO_LIMIT = 40, demoUse = new Map();
function demoBlocked(a, req, url) {
  if (a.role !== 'demo') return null;
  if (url.startsWith('/api/nakladna/')) return 'Накладні в гостьовому вході недоступні.';
  if (url === '/api/routines/media' && req.method === 'POST') return 'У гостьовому вході завантаження фото й відео вимкнено.';
  if (req.method === 'POST' && /^\/api\/(assistant\/(message|triage|summary|plan)|stt\/transcribe)$/.test(url)) {
    const day = new Date().toISOString().slice(0, 10), u = demoUse.get(a.ws);
    const n = u && u.day === day ? u.n + 1 : 1;
    demoUse.set(a.ws, { day, n });
    if (n > DEMO_LIMIT) return 'Гостьовий ліміт асистента на сьогодні вичерпано. Спробуйте завтра.';
  }
  return null;
}

// ---------- сторінки ----------
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
                '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8',
                '.webmanifest':'application/manifest+json' };
const SECTIONS = ['nakladna', 'assistant'];                 // сторінки, що працюють лише після входу
const REDIRECTS = { '/speachtotext': '/assistant/', '/speachtotext/': '/assistant/', '/speechtotext': '/assistant/', '/speechtotext/': '/assistant/' };

function serveStatic(req, res, url) {
  if (REDIRECTS[url]) { res.writeHead(301, { Location: REDIRECTS[url] }); return res.end(); }
  if (SECTIONS.includes(url.slice(1))) { res.writeHead(301, { Location: url + '/' }); return res.end(); }
  if (url.endsWith('/')) url += 'index.html';
  const rel = path.normalize(url).replace(/^[/\\]+/, '');
  if (rel.includes('..') || rel.split(/[/\\]/).some(p => p.startsWith('.'))) { res.writeHead(404); return res.end('Не знайдено'); }
  const file = path.join(PUBLIC, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не знайдено'); }
    const top = rel.split(/[/\\]/)[0];
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    if (SECTIONS.includes(top)) {
      // асистент можна відкривати як Telegram Web App (у вебверсії Telegram це iframe); решту — лише напряму
      if (top === 'assistant') headers['Content-Security-Policy'] = "frame-ancestors 'self' https://web.telegram.org";
      else headers['X-Frame-Options'] = 'DENY';
      headers['Cache-Control'] = rel.includes('vendor') ? 'public, max-age=604800' : 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------- API ----------
async function api(req, res, url) {
  if (url === '/api/ping') return send(res, 200, { ok: true });
  if (url === '/api/push/action' && req.method === 'POST') {    // кнопка в сповіщенні, без сесії; токен «u5~…» — з окремої бази
    const b = await readBody(req, 2048), m = /^(u\d+)~/.exec((b && b.token) || '');
    if (m && !db.prepare('SELECT 1 FROM accounts WHERE ws = ?').get(m[1])) return send(res, 404, { error: 'Посилання застаріло.' });
    return workspace(m ? m[1] : null).assistant.pushAction(req, res, b || {});
  }
  const a = await auth.handle(req, res, url);
  if (!a) return;                                            // відповідь уже надіслано (вхід, вихід, помилка доступу)
  const blocked = demoBlocked(a, req, url);
  if (blocked) return send(res, url.startsWith('/api/assistant/') || url.startsWith('/api/stt/') ? 429 : 403, { error: blocked });
  const w = wsOf(a);
  if (url.startsWith('/api/nakladna/')) return a.ws ? send(res, 403, { error: 'Накладні доступні лише власнику.' }) : nakladna.handle(req, res, url, a);
  if (url.startsWith('/api/stt/')) return stt.handle(req, res, url);
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
      if (m && !db.prepare('SELECT 1 FROM accounts WHERE ws = ?').get(m[1])) { res.writeHead(404); return res.end(); }
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
