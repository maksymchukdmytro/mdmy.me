// Адмінка сервісу (/admin/, API /api/admin/*): огляд зі статистикою, користувачі, ліміти, ціни моделей.
// Принцип: адмін бачить цифри, але не вміст — скільки задач, а не що в них.
// Налаштування Google — /api/admin/auth (lib/google.js); ключ Claude, модель і бот — /api/assistant/settings (поля лише для адміна).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { send, readBody } = require('./util');
const usage = require('./usage');
const T = require('./assistant-time');

// Загальні ліміти; 0 — без обмежень. Особисті — accounts.limits (JSON), перекривають загальні.
const DEF_LIMITS = { ai: 100, aiDemo: 40, storageMb: 50, uploadsDay: 10 };
// Ціни Claude API, $ за 1 млн токенів (platform.claude.com/docs/en/about-claude/pricing, жовтень 2026); можна змінити в адмінці
const DEF_PRICES = [
  { match: 'haiku', in: 0.10, out: 0.50 },
  { match: 'sonnet', in: 2, out: 10 },
  { match: 'opus', in: 4, out: 20 },
  { match: 'fable', in: 10, out: 50 },
  { match: 'mythos', in: 10, out: 50 }
];
const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/mdmy';

module.exports = function makeAdmin(db, d) {
  const { DATA, DB, workspace, closeWorkspace, team, auth, stt } = d;
  const meta = (k, def) => { try { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? JSON.parse(r.value) : def; } catch (e) { return def; } };
  const setMeta = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

  // ---------- ліміти ----------
  function limits() {
    const m = meta('service_limits', null);
    if (m) return { ...DEF_LIMITS, ...m };
    const old = auth.google.settings().userLimit;                // до адмінки ліміт асистента жив у налаштуваннях Google
    return { ...DEF_LIMITS, ...(Number.isFinite(+old) ? { ai: +old } : {}) };
  }
  const own = acc => { try { return JSON.parse(acc.limits || 'null') || {}; } catch (e) { return {}; } };
  // для облікового запису: адмін і основна база власника — без обмежень
  function limitsFor(acc) {
    if (!acc || acc.role === 'admin' || !acc.ws) return { ai: 0, storageMb: 0, uploadsDay: 0 };
    const L = limits(), o = own(acc), pick = (k, def) => Number.isFinite(o[k]) ? o[k] : def;
    return { ai: pick('ai', acc.role === 'demo' ? L.aiDemo : L.ai), storageMb: pick('storageMb', L.storageMb), uploadsDay: pick('uploadsDay', L.uploadsDay) };
  }
  const clampLimit = (v, max) => v === null || v === '' || v === undefined ? undefined : Math.max(0, Math.min(max, Math.round(+v) || 0));

  // ---------- лічильники ----------
  const dayAgo = (n) => T.addDays(usage.today(), -n);
  const used = (ws, kind, day = usage.today()) => (db.prepare('SELECT n, a FROM usage_daily WHERE day = ? AND ws = ? AND kind = ?').get(day, ws || 'main', kind) || { n: 0, a: 0 });

  function prices() {
    const custom = meta('ai_prices', {});
    return model => {
      if (custom[model]) return custom[model];
      const p = DEF_PRICES.find(x => String(model).toLowerCase().includes(x.match));
      return p ? { in: p.in, out: p.out } : { in: 0, out: 0 };
    };
  }
  const costOf = (model, tin, tout, pr) => { const p = pr(model); return (tin * p.in + tout * p.out) / 1e6; };

  // ---------- сервер ----------
  function dirSize(dir) {
    let n = 0;
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); n += e.isDirectory() ? dirSize(f) : e.isFile() ? fs.statSync(f).size : 0; } } catch (e) {}
    return n;
  }
  function backups() {
    try {
      const list = fs.readdirSync(BACKUP_DIR).filter(x => /^mdmy-\d{4}-\d{2}-\d{2}\.db$/.test(x)).map(x => { const st = fs.statSync(path.join(BACKUP_DIR, x)); return { name: x, at: st.mtimeMs, size: st.size }; })
        .sort((a, b) => b.at - a.at);
      return { count: list.length, last: list[0] || null };
    } catch (e) { return { count: 0, last: null, error: 'недоступно' }; }
  }
  let version = 'dev'; try { version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || 'dev'; } catch (e) {}
  async function server() {
    let disk = null; try { const s = fs.statfsSync(DATA); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (e) {}
    let sttOk = null; try { sttOk = await stt.health(); } catch (e) { sttOk = null; }
    return {
      version, node: process.version, uptime: Math.round(process.uptime()), hostUptime: Math.round(os.uptime()),
      mem: { total: os.totalmem(), free: os.freemem(), app: process.memoryUsage().rss }, load: os.loadavg(), cpus: os.cpus().length,
      disk, data: dirSize(DATA), backups: backups(), stt: sttOk
    };
  }

  // ---------- облікові записи ----------
  const accounts = () => db.prepare('SELECT * FROM accounts ORDER BY created DESC').all();
  // що є в базі людини (лише кількості) — кеш на хвилину, щоб огляд не відкривав бази на кожен запит
  const shapeCache = new Map();
  function shape(acc) {
    const key = acc.ws || 'main', c = shapeCache.get(key);
    if (c && c.at > Date.now() - 60e3) return c.v;
    let v = null;
    try {
      const w = acc.ws ? (acc.disabled ? null : workspace(acc.ws)) : workspace(null);
      if (w) {
        const q = sql => w.db.prepare(sql).get().n;
        const st = (() => { try { return JSON.parse((w.db.prepare("SELECT value FROM meta WHERE key = 'assistant_settings'").get() || {}).value || '{}'); } catch (e) { return {}; } })();
        v = {
          tasks: q("SELECT COUNT(*) AS n FROM assistant_items WHERE kind != 'note'"),
          open: q("SELECT COUNT(*) AS n FROM assistant_items WHERE kind != 'note' AND done_at IS NULL"),
          notes: q("SELECT COUNT(*) AS n FROM assistant_items WHERE kind = 'note'"),
          habits: q('SELECT COUNT(*) AS n FROM habits'), routines: q('SELECT COUNT(*) AS n FROM routines'),
          messages: q('SELECT COUNT(*) AS n FROM assistant_messages'),
          telegram: !!st.chatId, push: q('SELECT COUNT(*) AS n FROM push_subscriptions')
        };
      }
    } catch (e) { v = null; }
    if (acc.ws) {
      const dir = DB.wsDir(DATA, acc.ws);
      v = { ...(v || {}), storage: dirSize(path.join(dir, 'files')) + dirSize(path.join(dir, 'media')) +
        (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM shared_files WHERE by_account = ?').get(acc.id).n || 0) };
    }
    shapeCache.set(key, { at: Date.now(), v });
    return v;
  }
  const lastSeen = id => (db.prepare('SELECT MAX(day) AS d FROM activity WHERE account_id = ?').get(id) || {}).d || null;
  function aiOf(ws, from, pr) {
    const rows = db.prepare("SELECT kind, SUM(n) AS n, SUM(a) AS a, SUM(b) AS b FROM usage_daily WHERE ws = ? AND day >= ? AND kind LIKE 'ai:%' GROUP BY kind").all(ws || 'main', from);
    return rows.reduce((s, r) => ({ n: s.n + r.n, cost: s.cost + costOf(r.kind.slice(3), r.a, r.b, pr) }), { n: 0, cost: 0 });
  }
  function userRow(acc, pr) {
    const L = limitsFor(acc);
    return {
      id: acc.id, login: acc.login, name: acc.name, email: acc.email || null, role: acc.role, ws: acc.ws, disabled: !!acc.disabled,
      created: acc.created, last_login: acc.last_login, seen: lastSeen(acc.id), google: !!acc.google_sub, hasPassword: !!acc.hash,
      // основна база спільна: витрати й вміст рахуються власнику, а не акаунту накладних
      limits: L, own: own(acc), ai30: acc.role === 'nakladna' ? { n: 0, cost: 0 } : aiOf(acc.ws, dayAgo(29), pr), shape: acc.role === 'nakladna' ? null : shape(acc)
    };
  }

  // ---------- огляд ----------
  function series(sql, days, ...args) {
    const from = dayAgo(days - 1), map = Object.fromEntries(db.prepare(sql).all(from, ...args).map(r => [r.day, r.v]));
    return Array.from({ length: days }, (_, i) => { const day = T.addDays(from, i); return { day, v: map[day] || 0 }; });
  }
  async function overview() {
    const pr = prices(), today = usage.today(), tz = usage.tz();
    const accs = accounts().filter(a => a.role !== 'nakladna');
    const createdDay = a => T.dayKey(a.created, tz);
    const regSeries = (() => {
      const from = dayAgo(29), by = {};
      for (const a of accs) { const k = createdDay(a); if (k >= from) by[k] = (by[k] || 0) + 1; }
      return Array.from({ length: 30 }, (_, i) => { const day = T.addDays(from, i); return { day, v: by[day] || 0 }; });
    })();
    const activeIn = n => db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM activity WHERE day >= ?').get(dayAgo(n - 1)).n;
    // утримання: серед тих, хто зареєструвався щонайменше N днів тому, — частка тих, хто заходив на N-й день або пізніше
    const retention = n => {
      const base = accs.filter(a => createdDay(a) <= dayAgo(n));
      if (!base.length) return { pct: null, base: 0 };
      const back = base.filter(a => db.prepare('SELECT 1 FROM activity WHERE account_id = ? AND day >= ?').get(a.id, T.addDays(createdDay(a), n))).length;
      return { pct: Math.round(back / base.length * 100), base: base.length };
    };
    // активація: хто почав користуватись (є задачі), підключив Telegram, сповіщення
    const shapes = accs.filter(a => a.role !== 'demo').map(a => shape(a)).filter(Boolean);
    const aiRows = db.prepare("SELECT day, kind, SUM(n) AS n, SUM(a) AS a, SUM(b) AS b FROM usage_daily WHERE day >= ? AND kind LIKE 'ai:%' GROUP BY day, kind").all(dayAgo(59));
    const aiBy = {}; for (const r of aiRows) { const x = aiBy[r.day] || (aiBy[r.day] = { n: 0, cost: 0, tin: 0, tout: 0 }); x.n += r.n; x.tin += r.a; x.tout += r.b; x.cost += costOf(r.kind.slice(3), r.a, r.b, pr); }
    const month = today.slice(0, 7), dim = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate(), dom = +today.slice(8, 10);
    const mtd = Object.entries(aiBy).filter(([k]) => k.startsWith(month)).reduce((s, [, v]) => ({ n: s.n + v.n, cost: s.cost + v.cost }), { n: 0, cost: 0 });
    const sum = (kind, from = today) => db.prepare('SELECT COALESCE(SUM(n), 0) AS n, COALESCE(SUM(a), 0) AS a FROM usage_daily WHERE day >= ? AND kind = ?').get(from, kind);
    const errToday = sum('ai_error');
    const byModel = db.prepare("SELECT kind, SUM(n) AS n, SUM(a) AS a, SUM(b) AS b FROM usage_daily WHERE day >= ? AND kind LIKE 'ai:%' GROUP BY kind ORDER BY n DESC").all(month + '-01')
      .map(r => ({ model: r.kind.slice(3), n: r.n, cost: costOf(r.kind.slice(3), r.a, r.b, pr) }));
    return {
      today, tz,
      users: {
        total: accs.length, demo: accs.filter(a => a.role === 'demo').length, disabled: accs.filter(a => a.disabled).length,
        google: accs.filter(a => a.google_sub).length,
        new1: regSeries.slice(-1)[0].v, new7: regSeries.slice(-7).reduce((s, x) => s + x.v, 0), new30: regSeries.reduce((s, x) => s + x.v, 0), series: regSeries
      },
      active: { d1: activeIn(1), d7: activeIn(7), d30: activeIn(30), series: series('SELECT day, COUNT(*) AS v FROM activity WHERE day >= ? GROUP BY day', 30) },
      retention: { d1: retention(1), d7: retention(7), d30: retention(30) },
      activation: { base: shapes.length, tasks: shapes.filter(s => s.tasks > 0).length, telegram: shapes.filter(s => s.telegram).length, push: shapes.filter(s => s.push > 0).length },
      ai: {
        today: aiBy[today] || { n: 0, cost: 0, tin: 0, tout: 0 }, errors: errToday.n, month: mtd, forecast: dom ? mtd.cost / dom * dim : 0, byModel,
        series: Array.from({ length: 30 }, (_, i) => { const day = dayAgo(29 - i); return { day, v: +(aiBy[day] ? aiBy[day].cost : 0).toFixed(4), n: aiBy[day] ? aiBy[day].n : 0 }; })
      },
      voice: { today: sum('stt'), month: sum('stt', month + '-01') },
      reminders: { ok: sum('remind_ok').n, fail: sum('remind_fail').n, week: sum('remind_ok', dayAgo(6)).n },
      uploads: { today: sum('upload') },
      server: await server()
    };
  }

  // ---------- картка людини ----------
  function detail(acc) {
    const pr = prices();
    const sessions = db.prepare('SELECT client, created, last_used FROM sessions WHERE account_id = ? ORDER BY last_used DESC LIMIT 10').all(acc.id);
    const act = series('SELECT day, n AS v FROM activity WHERE day >= ? AND account_id = ?', 30, acc.id);
    const use = db.prepare('SELECT kind, SUM(n) AS n, SUM(a) AS a, SUM(b) AS b FROM usage_daily WHERE ws = ? AND day >= ? GROUP BY kind').all(acc.ws || 'main', dayAgo(29));
    const audit = db.prepare("SELECT at, action, target FROM audit WHERE account_id = ? OR (target = ? AND action LIKE 'admin:%') ORDER BY at DESC LIMIT 20").all(acc.id, acc.login);
    const ai = aiOf(acc.ws, dayAgo(29), pr);
    const pick = k => use.filter(r => r.kind === k).reduce((s, r) => ({ n: s.n + r.n, a: s.a + r.a }), { n: 0, a: 0 });
    return { ...userRow(acc, pr), sessions, activity: act, usage: { ai, voice: pick('stt'), reminders: pick('remind_ok').n, uploads: pick('upload'), msgToday: used(acc.ws, 'msg').n }, audit };
  }

  // ---------- дії з обліковим записом ----------
  async function act(req, res, a, acc, b) {
    const self = acc.id === a.id;
    switch (b.action) {
      case 'disable': case 'enable':
        if (self || acc.role === 'admin') return send(res, 400, { error: 'Адміністратора вимкнути не можна — спершу зніміть роль.' });
        db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(b.action === 'disable' ? 1 : 0, acc.id);
        if (b.action === 'disable') { db.prepare('DELETE FROM sessions WHERE account_id = ?').run(acc.id); if (acc.ws) closeWorkspace(acc.ws); }
        else if (acc.ws) { try { workspace(acc.ws); } catch (e) {} }
        break;
      case 'logout':
        db.prepare('DELETE FROM sessions WHERE account_id = ?' + (self ? ' AND token_hash != ?' : '')).run(...(self ? [acc.id, a.tokenHash] : [acc.id]));
        break;
      case 'separate':
        if (acc.ws) return send(res, 400, { error: 'У цього акаунта вже окрема база.' });
        if (self || acc.role === 'admin' || acc.role === 'nakladna') return send(res, 400, { error: 'Цьому акаунту окрема база не потрібна.' });
        db.prepare('UPDATE accounts SET ws = ? WHERE id = ?').run('u' + acc.id, acc.id);
        db.prepare('DELETE FROM sessions WHERE account_id = ?').run(acc.id);
        break;
      case 'role': {
        if (!['admin', 'user'].includes(b.role)) return send(res, 400, { error: 'Невідома роль.' });
        if (!['admin', 'user'].includes(acc.role)) return send(res, 400, { error: 'Роль гостя й акаунта накладних тут не змінюється.' });
        if (b.role === 'user' && db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND disabled = 0 AND id != ?").get(acc.id).n === 0)
          return send(res, 400, { error: 'Це єдиний адміністратор.' });
        if (b.role === 'admin' && !acc.ws && acc.id !== a.id) { /* спільна база з власником — нехай так, але адмін бачить і його записи */ }
        db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(b.role, acc.id);
        break;
      }
      case 'limits': {
        const o = {}, l = b.limits || {};
        const ai = clampLimit(l.ai, 100000), st = clampLimit(l.storageMb, 100000), up = clampLimit(l.uploadsDay, 10000);
        if (ai !== undefined) o.ai = ai; if (st !== undefined) o.storageMb = st; if (up !== undefined) o.uploadsDay = up;
        db.prepare('UPDATE accounts SET limits = ? WHERE id = ?').run(Object.keys(o).length ? JSON.stringify(o) : null, acc.id);
        break;
      }
      case 'delete':
        if (self || acc.role === 'admin') return send(res, 400, { error: 'Адміністратора видалити не можна — спершу зніміть роль.' });
        if (!acc.ws) return send(res, 400, { error: 'Спершу дайте акаунту окрему базу — інакше його дані змішані з вашими.' });
        team.forgetAccount(acc.id); closeWorkspace(acc.ws);
        try { fs.rmSync(DB.wsDir(DATA, acc.ws), { recursive: true, force: true }); } catch (e) {}
        db.prepare('DELETE FROM sessions WHERE account_id = ?').run(acc.id);
        db.prepare('DELETE FROM activity WHERE account_id = ?').run(acc.id);
        db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
        auth.log(a, 'admin:user', acc.login, { action: 'delete' });
        return send(res, 200, { ok: true, deleted: true });
      default: return send(res, 400, { error: 'Невідома дія.' });
    }
    shapeCache.delete(acc.ws || 'main');
    auth.log(a, 'admin:user', acc.login, { action: b.action, ...(b.role ? { role: b.role } : {}), ...(b.limits ? { limits: b.limits } : {}) });
    return send(res, 200, detail(db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc.id)));
  }

  // ---------- API ----------
  async function handle(req, res, url, a) {
    if (a.role !== 'admin') return send(res, 403, { error: 'Лише для адміністратора.' });
    const m = req.method;
    if (url === '/api/admin/overview' && m === 'GET') return send(res, 200, await overview());
    if (url === '/api/admin/users' && m === 'GET') { const pr = prices(); return send(res, 200, { list: accounts().map(x => userRow(x, pr)) }); }
    const mm = /^\/api\/admin\/users\/(\d+)$/.exec(url);
    if (mm) {
      const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(+mm[1]);
      if (!acc) return send(res, 404, { error: 'Акаунт не знайдено.' });
      if (m === 'GET') return send(res, 200, detail(acc));
      if (m === 'POST') return act(req, res, a, acc, await readBody(req, 4096) || {});
    }
    // ключ Claude, модель і бот — налаштування основної бази (адмін може мати й окрему базу — пишемо завжди в основну)
    if (url === '/api/admin/service') return workspace(null).assistant.handle(req, res, '/api/assistant/settings', a, auth.log);
    if (url === '/api/admin/limits' && m === 'GET') return send(res, 200, { limits: limits(), defaults: DEF_LIMITS });
    if (url === '/api/admin/limits' && m === 'POST') {
      const b = await readBody(req, 2048) || {}, L = limits();
      for (const [k, max] of [['ai', 100000], ['aiDemo', 100000], ['storageMb', 100000], ['uploadsDay', 10000]]) { const v = clampLimit(b[k], max); if (v !== undefined) L[k] = v; }
      setMeta('service_limits', L);
      auth.log(a, 'admin:limits', null, L);
      return send(res, 200, { limits: L, defaults: DEF_LIMITS });
    }
    if (url === '/api/admin/prices' && m === 'GET') {
      const pr = prices(), models = db.prepare("SELECT DISTINCT substr(kind, 4) AS model FROM usage_daily WHERE kind LIKE 'ai:%'").all().map(r => r.model);
      const cur = workspace(null).assistant.settings().model;
      return send(res, 200, { list: [...new Set([cur, ...models])].filter(Boolean).map(x => ({ model: x, ...pr(x), custom: !!meta('ai_prices', {})[x] })) });
    }
    if (url === '/api/admin/prices' && m === 'POST') {
      const b = await readBody(req, 2048) || {}, all = meta('ai_prices', {}), model = String(b.model || '').slice(0, 60);
      if (!model) return send(res, 400, { error: 'Вкажіть модель.' });
      if (b.reset) delete all[model];
      else all[model] = { in: Math.max(0, +b.in || 0), out: Math.max(0, +b.out || 0) };
      setMeta('ai_prices', all);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }

  return { handle, limits, limitsFor, used };
};
