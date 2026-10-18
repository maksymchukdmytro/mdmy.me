// Сервер mdmy.me (by Maksymchuk Dmytro).
//  • /                — головна сторінка;
//  • /nakladna/       — видаткові накладні з LP-CRM у PDF;
//  • /assistant/      — персональний асистент: голос і текст → задачі, нагадування, нотатки, Telegram-бот;
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
  if (url === '/api/push/action' && req.method === 'POST') return assistant.pushAction(req, res);   // кнопка в сповіщенні, без сесії
  const a = await auth.handle(req, res, url);
  if (!a) return;                                            // відповідь уже надіслано (вхід, вихід, помилка доступу)
  if (url.startsWith('/api/nakladna/')) return nakladna.handle(req, res, url, a);
  if (url.startsWith('/api/stt/')) return stt.handle(req, res, url);
  if (url.startsWith('/api/assistant/')) return assistant.handle(req, res, url, a, auth.log);
  if (url.startsWith('/api/push/')) return push.handle(req, res, url, a);
  return send(res, 404, { error: 'Не знайдено.' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  try {
    if (url.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Помилка сервера.' });
  }
});

// Прибирання прострочених сесій раз на добу
setInterval(() => db.prepare('DELETE FROM sessions WHERE last_used < ?').run(Date.now() - 30 * 864e5), 864e5).unref();

const shutdown = () => { try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  assistant.start();   // нагадування, ранковий план, підсумок дня, Telegram-бот
  console.log(`mdmy.me: http://localhost:${PORT}`);
  console.log(`База даних: ${db.file}`);
  if (!db.prepare('SELECT 1 FROM accounts').get()) console.log('Облікового запису ще немає. Створіть: npm run account -- create <логін> "<Ім\'я>"');
});
