// Вхід на mdmy.me: логін і пароль облікового запису (таблиця accounts).
// Сесія — cookie HttpOnly + SameSite=Strict на весь сайт; кожна зміна (не GET)
// вимагає заголовок X-MDMY: 1, якого сторонній сайт надіслати не може.
const D = require('./db');
const { send, readBody, cookies, clientIp, limiter } = require('./util');

const COOKIE = 'mdmy_session';
const SESSION_DAYS = 30;
const tries = limiter(8, 10 * 60e3);

module.exports = function makeAuth(db) {
  const log = (a, action, target, details) => db.prepare('INSERT INTO audit (at, account_id, login, action, target, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), a ? a.id : null, a ? a.login : 'система', action, target || null, details ? JSON.stringify(details) : null);

  function current(req) {
    const t = cookies(req)[COOKIE]; if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
    const h = D.sha(t), s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last_used > SESSION_DAYS * 864e5) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h); return null; }
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(s.account_id);
    if (!a || a.disabled) return null;
    if (now - s.last_used > 60e3) db.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now, h);
    a.tokenHash = h;
    return a;
  }
  const secure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const setCookie = (req, val, maxAge) =>
    `${COOKIE}=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

  // Повертає обліковий запис, якщо запит можна обслуговувати далі; інакше сам відповідає й повертає null.
  async function handle(req, res, url) {
    const m = req.method, ip = clientIp(req);

    if (url === '/api/login' && m === 'POST') {
      if (tries.blocked(ip)) { send(res, 429, { error: 'Забагато спроб. Спробуйте за 10 хвилин.' }); return null; }
      tries.note(ip);
      const b = await readBody(req, 4096);
      const a = b && db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(b.login || '').trim());
      if (!a || a.disabled || !D.checkPass(b.password || '', a.salt, a.hash)) { send(res, 401, { error: 'Неправильний логін або пароль.' }); return null; }
      const token = D.newToken(), now = Date.now();
      db.prepare('INSERT INTO sessions (token_hash, account_id, created, last_used) VALUES (?, ?, ?, ?)').run(D.sha(token), a.id, now, now);
      db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?').run(now, a.id);
      log(a, 'login', null, { ip });
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, token, SESSION_DAYS * 86400) });
      return null;
    }

    const a = current(req);
    if (!a) { send(res, 401, { error: 'Потрібно увійти.' }); return null; }
    if (m !== 'GET' && req.headers['x-mdmy'] !== '1') { send(res, 403, { error: 'Заборонено.' }); return null; }

    if (url === '/api/logout' && m === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(a.tokenHash);
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) });
      return null;
    }
    if (url === '/api/me') {
      send(res, 200, { account: { id: a.id, login: a.login, name: a.name } });
      return null;
    }
    if (url === '/api/password' && m === 'POST') {
      const b = await readBody(req, 4096);
      if (!b || !D.checkPass(b.old || '', a.salt, a.hash)) { send(res, 400, { error: 'Поточний пароль неправильний.' }); return null; }
      if (String(b.password || '').length < 8) { send(res, 400, { error: 'Новий пароль — щонайменше 8 символів.' }); return null; }
      const salt = D.newSalt();
      db.prepare('UPDATE accounts SET salt = ?, hash = ? WHERE id = ?').run(salt, D.hashPass(b.password, salt), a.id);
      db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').run(a.id, a.tokenHash);
      log(a, 'own-password');
      send(res, 200, { ok: true });
      return null;
    }
    return a;
  }

  return { handle, log };
};
