// Вхід на mdmy.me: логін і пароль облікового запису (таблиця accounts).
//  • Браузер: сесія в cookie HttpOnly + SameSite=Strict; кожна зміна (не GET) вимагає заголовок X-MDMY: 1,
//    якого сторонній сайт надіслати не може.
//  • Застосунки (Android тощо): POST /api/auth/token → токен; далі заголовок Authorization: Bearer <токен>.
//  • Telegram Web App: POST /api/auth/telegram з initData — підпис перевіряється токеном бота,
//    вхід дозволено лише привʼязаному до асистента чату (власнику).
// Токени й cookie — ті самі сесії (таблиця sessions), різниця лише в полі client.
const crypto = require('crypto');
const D = require('./db');
const { send, readBody, cookies, clientIp, limiter } = require('./util');

const COOKIE = 'mdmy_session';
const SESSION_DAYS = 30;
const tries = limiter(8, 10 * 60e3);

module.exports = function makeAuth(db) {
  const getAssistantSettings = () => { try { return JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'assistant_settings'").get() || {}).value || '{}'); } catch (e) { return {}; } };
  const log = (a, action, target, details) => db.prepare('INSERT INTO audit (at, account_id, login, action, target, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), a ? a.id : null, a ? a.login : 'система', action, target || null, details ? JSON.stringify(details) : null);

  function bearer(req) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
    return m ? m[1].toLowerCase() : null;
  }
  function current(req) {
    const t = bearer(req) || cookies(req)[COOKIE]; if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
    const h = D.sha(t), s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last_used > SESSION_DAYS * 864e5) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h); return null; }
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(s.account_id);
    if (!a || a.disabled) return null;
    if (now - s.last_used > 60e3) db.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now, h);
    a.tokenHash = h; a.viaBearer = !!bearer(req);
    return a;
  }
  function newSession(a, client) {
    const token = D.newToken(), now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, account_id, created, last_used, client) VALUES (?, ?, ?, ?, ?)').run(D.sha(token), a.id, now, now, client || 'web');
    db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?').run(now, a.id);
    return token;
  }
  // Перевірка initData Telegram Web App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
  function telegramUser(initData, botToken) {
    if (!botToken || typeof initData !== 'string' || initData.length > 4096) return null;
    const p = new URLSearchParams(initData), hash = p.get('hash'); if (!hash) return null;
    p.delete('hash');
    const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 86400) return null;      // initData старше доби — не приймаємо
    try { return JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
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
      const token = newSession(a, 'web');
      log(a, 'login', null, { ip });
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, token, SESSION_DAYS * 86400) });
      return null;
    }
    // Токен для застосунків: { login, password, client: 'android' | … } → { token }
    if (url === '/api/auth/token' && m === 'POST') {
      if (tries.blocked(ip)) { send(res, 429, { error: 'Забагато спроб. Спробуйте за 10 хвилин.' }); return null; }
      tries.note(ip);
      const b = await readBody(req, 4096);
      const a = b && db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(b.login || '').trim());
      if (!a || a.disabled || !D.checkPass(b.password || '', a.salt, a.hash)) { send(res, 401, { error: 'Неправильний логін або пароль.' }); return null; }
      const client = String(b.client || 'app').replace(/[^a-z0-9 ._-]/gi, '').slice(0, 40) || 'app';
      const token = newSession(a, client);
      log(a, 'token', client, { ip });
      send(res, 200, { token, expiresInDays: SESSION_DAYS, account: { id: a.id, login: a.login, name: a.name, admin: a.role === 'admin' } });
      return null;
    }
    // Telegram Web App: { initData } → cookie-сесія (і токен), якщо це привʼязаний до асистента чат
    if (url === '/api/auth/telegram' && m === 'POST') {
      if (tries.blocked(ip)) { send(res, 429, { error: 'Забагато спроб.' }); return null; }
      const b = await readBody(req, 8192);
      const s = getAssistantSettings();
      const u = telegramUser(b && b.initData, s.botToken);
      if (!u || !s.chatId || +u.id !== +s.chatId) { tries.note(ip); send(res, 401, { error: 'Вхід через Telegram доступний лише власнику привʼязаного бота.' }); return null; }
      const a = db.prepare("SELECT * FROM accounts WHERE disabled = 0 ORDER BY role = 'admin' DESC, id LIMIT 1").get();
      if (!a) { send(res, 401, { error: 'Немає облікового запису.' }); return null; }
      const token = newSession(a, 'telegram');
      log(a, 'login', 'telegram', { ip });
      send(res, 200, { ok: true, token }, { 'Set-Cookie': setCookie(req, token, SESSION_DAYS * 86400).replace('SameSite=Strict', 'SameSite=None') });
      return null;
    }

    const a = current(req);
    if (!a) { send(res, 401, { error: 'Потрібно увійти.' }); return null; }
    if (m !== 'GET' && !a.viaBearer && req.headers['x-mdmy'] !== '1') { send(res, 403, { error: 'Заборонено.' }); return null; }

    if (url === '/api/logout' && m === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(a.tokenHash);
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) });
      return null;
    }
    if (url === '/api/me') {
      send(res, 200, { account: { id: a.id, login: a.login, name: a.name, admin: a.role === 'admin' } });
      return null;
    }
    // Активні входи (браузери, застосунки) і вихід з усіх, крім поточного
    if (url === '/api/sessions' && m === 'GET') {
      const list = db.prepare('SELECT token_hash, client, created, last_used FROM sessions WHERE account_id = ? ORDER BY last_used DESC').all(a.id)
        .map(s => ({ id: s.token_hash.slice(0, 12), client: s.client || 'web', created: s.created, last_used: s.last_used, current: s.token_hash === a.tokenHash }));
      send(res, 200, { list });
      return null;
    }
    if (url === '/api/sessions/others' && m === 'DELETE') {
      const n = db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').run(a.id, a.tokenHash).changes;
      log(a, 'sessions:revoke', null, { n });
      send(res, 200, { revoked: n });
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
