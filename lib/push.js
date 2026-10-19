// Push-сповіщення (Web Push) у браузер і встановлений застосунок — навіть коли сайт закритий.
// Ключі VAPID генеруються один раз і зберігаються в meta (push_vapid); сервіс-воркер — public/assistant/sw.js.
// Кнопки в сповіщенні («Готово», «+1 год») викликають POST /api/push/action з підписаним токеном дії:
// він діє лише для однієї задачі й 3 доби, тож сесія браузера для цього не потрібна.
const crypto = require('crypto');
const webpush = require('web-push');
const { send, readBody } = require('./util');

const KEY = 'push_vapid';
const K = require('./keys');
let instance = null;
module.exports = { get: db => instance || (instance = make(db)), make };

// opts.prefix — для окремої бази облікового запису: токен кнопки починається з «u5~», щоб сервер знав, куди його нести
function make(db, { prefix = '' } = {}) {
  // приватний ключ VAPID і секрет підпису кнопок — зашифровані в базі (lib/keys.js)
  const SECRET = ['privateKey', 'secret'];
  function keys() {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
    if (row) {
      const k = JSON.parse(row.value);
      if (K.hasPlain(k, SECRET)) db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(K.sealFields(k, SECRET)), KEY);
      return K.unsealFields(k, SECRET);
    }
    const k = { ...webpush.generateVAPIDKeys(), secret: crypto.randomBytes(32).toString('hex') };
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(K.sealFields(k, SECRET)));
    return k;
  }
  const subject = () => /^https:\/\//.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL : 'mailto:owner@mdmy.me';
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;

  // ---------- підпис кнопок дій ----------
  const sign = s => crypto.createHmac('sha256', keys().secret).update(s).digest('hex').slice(0, 32);
  function actionToken(id) { const exp = Date.now() + 3 * 864e5; return `${prefix}${id}.${exp}.${sign(`${id}.${exp}`)}`; }
  function checkToken(t) {
    t = String(t || ''); if (prefix) { if (!t.startsWith(prefix)) return null; t = t.slice(prefix.length); }
    // id — номер задачі, 'r<номер>' для щоденного завдання або 'h<номер>' для звички
    const m = /^([rh]?\d+)\.(\d+)\.([a-f0-9]{32})$/.exec(String(t || '')); if (!m) return null;
    if (+m[2] < Date.now()) return null;
    const ok = crypto.timingSafeEqual(Buffer.from(sign(`${m[1]}.${m[2]}`)), Buffer.from(m[3]));
    return ok ? (/^[rh]/.test(m[1]) ? m[1] : +m[1]) : null;
  }

  // ---------- надсилання ----------
  // payload: { title, body, url, tag, id, actions: [{action, title}], kind }
  async function sendAll(payload) {
    const subs = db.prepare('SELECT * FROM push_subscriptions').all();
    if (!subs.length) return 0;
    const k = keys(), body = JSON.stringify(payload);
    let ok = 0;
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
          { vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 6 * 3600, urgency: 'high', timeout: 15000 });
        ok++;
        db.prepare('UPDATE push_subscriptions SET last_ok = ?, fails = 0 WHERE id = ?').run(Date.now(), s.id);
      } catch (e) {
        // 404 / 410 — підписку скасовано в браузері; якщо пристрій мовчить понад 3 доби й помилок багато — прибираємо
        const dead = e.statusCode === 404 || e.statusCode === 410 || (s.fails >= 20 && (s.last_ok || s.created) < Date.now() - 3 * 864e5);
        if (dead) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else db.prepare('UPDATE push_subscriptions SET fails = fails + 1 WHERE id = ?').run(s.id);
        console.error('[push]', e.statusCode || '', (e.body || e.message || '').toString().slice(0, 160));
      }
    }));
    return ok;
  }
  const PRIO = ['', ' ❗', ' ‼️'];
  function sendReminder(it, whenText) {
    return sendAll({
      kind: 'reminder', id: it.id, tag: 'item-' + it.id, title: '⏰ ' + it.text.slice(0, 120) + PRIO[it.priority || 0],
      body: whenText || 'Нагадування', url: '/assistant/#/today/t/' + it.id, token: actionToken(it.id),
      actions: [{ action: 'done', title: '✓ Готово' }, { action: 'snooze', title: '+1 год' }]
    });
  }
  // Ритуал дня: картинка (якщо є) показується великою в сповіщенні Android
  function sendRoutine(r, body, image) {
    return sendAll({
      kind: 'routine', id: 'r' + r.id, tag: 'routine-' + r.id, title: `${r.icon} ${r.title}`.slice(0, 120), body: String(body || '').slice(0, 300),
      image: image || undefined, url: '/assistant/#/r/' + r.id, token: actionToken('r' + r.id),
      actions: [{ action: 'rdone', title: '✓ Зроблено' }, { action: 'rlater', title: '+15 хв' }]
    });
  }
  const sendText = (title, text, url = '/assistant/#/today') =>
    sendAll({ kind: 'text', tag: 'digest', title, body: String(text || '').slice(0, 600), url });

  // ---------- API ----------
  function device(ua) {
    ua = String(ua || '');
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Пристрій';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'браузер';
    return `${os} · ${br}`;
  }
  // Авторизовані маршрути /api/push/*
  async function handle(req, res, url, a) {
    const m = req.method;
    if (url === '/api/push/key' && m === 'GET') return send(res, 200, { publicKey: keys().publicKey });
    if (url === '/api/push/subscriptions' && m === 'GET') {
      return send(res, 200, { list: db.prepare('SELECT id, endpoint, device, created, last_ok FROM push_subscriptions ORDER BY created DESC').all()
        .map(s => ({ id: s.id, device: s.device, created: s.created, last_ok: s.last_ok, endpointHash: crypto.createHash('sha256').update(s.endpoint).digest('hex').slice(0, 16) })) });
    }
    if (url === '/api/push/subscribe' && m === 'POST') {
      const b = await readBody(req, 8192), s = b && b.subscription;
      if (!s || !/^https:\/\//.test(s.endpoint || '') || !s.keys || !s.keys.p256dh || !s.keys.auth) return send(res, 400, { error: 'Неправильна підписка.' });
      db.prepare(`INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, device, created) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, fails = 0`)
        .run(a.id, String(s.endpoint).slice(0, 1000), String(s.keys.p256dh).slice(0, 200), String(s.keys.auth).slice(0, 100), device(req.headers['user-agent']), Date.now());
      return send(res, 200, { ok: true, devices: count() });
    }
    if (url === '/api/push/unsubscribe' && m === 'POST') {
      const b = await readBody(req, 4096);
      if (b && b.endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(b.endpoint));
      else if (b && b.id) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(+b.id);
      return send(res, 200, { ok: true, devices: count() });
    }
    if (url === '/api/push/test' && m === 'POST') {
      const n = await sendAll({ kind: 'text', tag: 'test', title: 'mdmy', body: 'Сповіщення працюють ✓ Так приходитимуть нагадування.', url: '/assistant/#/today' });
      return send(res, 200, { sent: n, devices: count() });
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }

  return { keys, count, has: () => count() > 0, sendAll, sendReminder, sendRoutine, sendText, actionToken, checkToken, handle };
}
