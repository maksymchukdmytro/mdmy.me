// Вхід і реєстрація через Google (OpenID Connect, authorization code + PKCE).
//  • GET /api/auth/config               — чи увімкнено вхід через Google (для екрана входу), контакт для політики конфіденційності.
//  • GET /api/auth/google/start[?link=1] — перехід до Google; link=1 — привʼязати Google до поточного акаунта.
//  • GET /api/auth/google/callback      — повернення від Google: перевірка state, обмін коду на id_token, вхід / реєстрація / привʼязка.
//  • GET|POST /api/admin/auth, GET /api/admin/users — налаштування (Client ID і секрет) і список користувачів, лише адміністратор.
// Захист: state + PKCE (code_verifier) + nonce лежать у підписаному короткому cookie; id_token береться напряму з
// токен-ендпоінта Google по TLS (OIDC Core 3.1.3.7), перевіряються iss, aud, exp, nonce і email_verified.
// Користувача шукаємо за незмінним google sub, не за поштою. Новий користувач отримує окрему базу (accounts.ws).
const crypto = require('crypto');
const D = require('./db');
const { send, readBody, cookies, clientIp, limiter } = require('./util');

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const ISS = ['https://accounts.google.com', 'accounts.google.com'];
const KEY = 'auth_settings', COOKIE = 'mdmy_oauth';
const keys = require('./keys');
const DEFAULTS = { googleClientId: '', googleClientSecret: '', signup: true, userLimit: 100, contact: '' };
const b64u = b => Buffer.from(b).toString('base64url');
const tries = limiter(30, 10 * 60e3);

module.exports = function makeGoogle(db, { newSession, setCookie, current, log }) {
  // секрет Google і ключ підпису cookie зберігаються зашифрованими (lib/keys.js)
  const SECRET = ['googleClientSecret', 'cookieSecret'];
  const save = s => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(keys.sealFields(s, SECRET)));
  const load = () => {
    let s; try { s = JSON.parse((db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) || {}).value || '{}'); } catch (e) { s = {}; }
    if (keys.hasPlain(s, SECRET)) save(s);
    return { ...DEFAULTS, ...keys.unsealFields(s, SECRET) };
  };
  const enabled = () => { const s = load(); return !!(s.googleClientId && s.googleClientSecret); };
  // секрет для підпису cookie зі state — генерується один раз
  function secret() {
    const s = load();
    if (s.cookieSecret) return s.cookieSecret;
    s.cookieSecret = crypto.randomBytes(32).toString('hex'); save(s); return s.cookieSecret;
  }
  const sign = v => crypto.createHmac('sha256', secret()).update(v).digest('base64url');
  const pub = req => (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, '');
  const redirectUri = req => pub(req) + '/api/auth/google/callback';
  const secure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const go = (res, url, headers = {}) => { res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', ...headers }); res.end(); };
  const fail = (req, res, msg) => go(res, '/assistant/?auth_error=' + encodeURIComponent(msg), { 'Set-Cookie': clearState(req) });
  const clearState = req => `${COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`;

  async function start(req, res, qs) {
    if (!enabled()) return fail(req, res, 'Вхід через Google ще не налаштовано.');
    let link = 0;
    if (qs.get('link') === '1') {
      const a = current(req);
      if (!a) return fail(req, res, 'Спершу увійдіть.');
      if (a.role === 'demo') return fail(req, res, 'Гостьовий акаунт не привʼязується до Google.');
      link = a.id;
    }
    const state = b64u(crypto.randomBytes(18)), verifier = b64u(crypto.randomBytes(32)), nonce = b64u(crypto.randomBytes(18));
    const payload = b64u(JSON.stringify({ s: state, v: verifier, n: nonce, l: link, e: Date.now() + 10 * 60e3 }));
    const s = load();
    const url = AUTH_URL + '?' + new URLSearchParams({
      client_id: s.googleClientId, redirect_uri: redirectUri(req), response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      prompt: 'select_account', access_type: 'online'
    });
    go(res, url, { 'Set-Cookie': `${COOKIE}=${payload}.${sign(payload)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure(req) ? '; Secure' : ''}` });
  }

  async function callback(req, res, qs) {
    const ip = clientIp(req);
    if (tries.blocked(ip)) return fail(req, res, 'Забагато спроб. Спробуйте за 10 хвилин.');
    tries.note(ip);
    if (qs.get('error')) return fail(req, res, qs.get('error') === 'access_denied' ? 'Вхід скасовано.' : 'Google не дозволив вхід.');
    const raw = cookies(req)[COOKIE] || '', [payload, mac] = raw.split('.');
    let st = null;
    try { if (payload && mac && crypto.timingSafeEqual(Buffer.from(sign(payload)), Buffer.from(mac))) st = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) {}
    if (!st || st.e < Date.now() || st.s !== qs.get('state') || !qs.get('code')) return fail(req, res, 'Сесія входу застаріла — спробуйте ще раз.');
    const s = load();
    // обмін коду на токени
    let tok;
    try {
      const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15e3),
        body: new URLSearchParams({ code: qs.get('code'), client_id: s.googleClientId, client_secret: s.googleClientSecret, redirect_uri: redirectUri(req), grant_type: 'authorization_code', code_verifier: st.v }) });
      tok = await r.json();
      if (!r.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'HTTP ' + r.status);
    } catch (e) { console.error('[google] токен:', e.message); return fail(req, res, 'Не вдалося підтвердити вхід у Google.'); }
    let c;
    try { c = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()); } catch (e) { return fail(req, res, 'Неправильна відповідь Google.'); }
    if (!ISS.includes(c.iss) || c.aud !== s.googleClientId || !(c.exp * 1000 > Date.now()) || c.nonce !== st.n || !c.sub) return fail(req, res, 'Відповідь Google не пройшла перевірку.');
    if (c.email && c.email_verified === false) return fail(req, res, 'Пошту в Google не підтверджено.');
    const sub = String(c.sub), email = c.email ? String(c.email).toLowerCase() : null;
    const owner = db.prepare('SELECT * FROM accounts WHERE google_sub = ?').get(sub);

    // привʼязка до поточного акаунта
    if (st.l) {
      const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND disabled = 0').get(st.l);
      if (!a) return fail(req, res, 'Акаунт не знайдено.');
      if (owner && owner.id !== a.id) return fail(req, res, 'Цей Google уже привʼязаний до іншого акаунта mdmy.');
      db.prepare('UPDATE accounts SET google_sub = ?, email = ? WHERE id = ?').run(sub, email, a.id);
      log(a, 'google:link', null, { ip });
      return go(res, '/assistant/#/settings/account', { 'Set-Cookie': clearState(req) });
    }
    let a = owner, fresh = false;
    if (a && a.disabled) return fail(req, res, 'Цей акаунт вимкнено.');
    if (!a) {
      if (!s.signup) return fail(req, res, 'Реєстрація нових користувачів зараз закрита.');
      a = D.createUser(db, { name: c.name || c.given_name || (email || '').split('@')[0], email, googleSub: sub });
      fresh = true;
      log(a, 'account:signup', 'google', { ip });
    } else if (email && email !== a.email) db.prepare('UPDATE accounts SET email = ? WHERE id = ?').run(email, a.id);
    const token = newSession(a, 'web');
    log(a, 'login', 'google', { ip });
    res.writeHead(302, { Location: '/assistant/' + (fresh ? '?welcome=1' : '') + '#/today', 'Cache-Control': 'no-store',
                         'Set-Cookie': [setCookie(req, token, 30 * 86400), clearState(req)] });
    res.end();
  }

  // ---------- для адміністратора ----------
  const adminView = s => ({ clientId: s.googleClientId, hasSecret: !!s.googleClientSecret, signup: !!s.signup, userLimit: s.userLimit, contact: s.contact, enabled: enabled() });
  async function admin(req, res, url, a) {
    if (a.role !== 'admin') return send(res, 403, { error: 'Лише для адміністратора.' });
    if (url === '/api/admin/auth' && req.method === 'GET') return send(res, 200, { ...adminView(load()), redirectUri: redirectUri(req) });
    if (url === '/api/admin/auth' && req.method === 'POST') {
      const b = await readBody(req, 8192); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      const s = load();
      if (b.clientId != null) {
        const id = String(b.clientId).trim();
        if (id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return send(res, 400, { error: 'Client ID має вигляд …apps.googleusercontent.com' });
        s.googleClientId = id;
      }
      if (b.clientSecret) s.googleClientSecret = String(b.clientSecret).trim().slice(0, 200);
      if (b.clearSecret) s.googleClientSecret = '';
      if (b.signup != null) s.signup = !!b.signup;
      if (b.userLimit != null) s.userLimit = Math.max(0, Math.min(10000, Math.round(+b.userLimit) || 0));
      if (b.contact != null) { const c = String(b.contact).trim().slice(0, 120); if (c && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return send(res, 400, { error: 'Контакт — адреса пошти.' }); s.contact = c; }
      save(s);
      log(a, 'auth:settings', null, { google: enabled(), signup: s.signup });
      return send(res, 200, { ...adminView(s), redirectUri: redirectUri(req) });
    }
    if (url === '/api/admin/users' && req.method === 'GET') {
      const list = db.prepare(`SELECT id, login, name, email, role, ws, disabled, created, last_login, google_sub IS NOT NULL AS google FROM accounts ORDER BY created DESC`).all();
      return send(res, 200, { list: list.map(x => ({ ...x, google: !!x.google, disabled: !!x.disabled })) });
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }

  async function handle(req, res, url) {
    const qs = new URL(req.url, 'http://x').searchParams;
    if (url === '/api/auth/config') { const s = load(); return send(res, 200, { google: enabled(), signup: !!s.signup && enabled(), contact: s.contact || '' }); }
    if (url === '/api/auth/google/start' && req.method === 'GET') return start(req, res, qs);
    if (url === '/api/auth/google/callback' && req.method === 'GET') return callback(req, res, qs);
    return send(res, 404, { error: 'Не знайдено.' });
  }
  return { handle, admin, settings: load, enabled };
};
