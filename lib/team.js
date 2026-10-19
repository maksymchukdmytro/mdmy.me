// Спільне між акаунтами (основна база): доручення з підтвердженням виконання і челенджі.
//  • Дозвіл: виконавець у налаштуваннях вводить публічний ID (accounts.pub_id) того, хто може давати йому задачі (team_links).
//  • Доручення: open → (виконавець здає з коментарем і доказами) submitted → (перевіряючий) approved | rework | failed; rework → знову open-подібне.
//  • Челендж: код для приєднання, N днів від дати старту; щоденна відмітка учасника (з доказом за потреби);
//    якщо confirm — відмітку підтверджує автор (pending → ok | rejected), інакше одразу ok.
//  • Докази (фото, файли, посилання) — shared_files, файли в DATA_DIR/shared; віддаються лише учасникам (/api/shared/<ключ>).
// Сповіщення — notify(accountId, title, text, url): Telegram і push того акаунта (server.js).
const path = require('path');
const files = require('./files');
const D = require('./db');
const { send, readBody, limiter } = require('./util');
const guess = limiter(20, 10 * 60e3);     // перебір ID / кодів челенджів: не більше 20 спроб за 10 хв на акаунт

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const STATUS = { open: 'До виконання', submitted: 'На перевірці', rework: 'На доопрацюванні', approved: 'Виконано', failed: 'Не виконано' };

module.exports = function makeTeam(db, { dataDir, notify, todayOf }) {
  const DIR = path.join(dataDir, 'shared');
  const acc = id => db.prepare('SELECT id, name, login, pub_id, role FROM accounts WHERE id = ?').get(id);
  const who = a => a ? { id: a.id, name: a.name, pub_id: a.pub_id } : null;
  const fileList = (kind, id) => db.prepare('SELECT * FROM shared_files WHERE owner_kind = ? AND owner_id = ? ORDER BY id').all(kind, id).map(r => files.view(r, '/api/shared/'));

  // ---------- доручення ----------
  const isLink = (boss, member) => !!db.prepare('SELECT 1 FROM team_links WHERE boss_id = ? AND member_id = ?').get(boss, member);
  const asg = id => db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  const asgView = (r, me) => ({
    id: r.id, text: r.text, description: r.description || '', due_at: r.due_at, need_proof: !!r.need_proof, status: r.status, statusName: STATUS[r.status],
    report: r.report || '', review_note: r.review_note || '', created: r.created, updated: r.updated, submitted_at: r.submitted_at, reviewed_at: r.reviewed_at,
    boss: who(acc(r.boss_id)), member: who(acc(r.member_id)), mine: r.member_id === me, files: fileList('assignment', r.id)
  });
  function team(a) {
    const bosses = db.prepare('SELECT a.id, a.name, a.pub_id FROM team_links l JOIN accounts a ON a.id = l.boss_id WHERE l.member_id = ? ORDER BY l.created').all(a.id);
    const members = db.prepare('SELECT a.id, a.name, a.pub_id FROM team_links l JOIN accounts a ON a.id = l.member_id WHERE l.boss_id = ? ORDER BY a.name').all(a.id);
    const n = (sql, ...p) => db.prepare(sql).get(...p).n;
    return {
      me: { id: a.id, pub_id: a.pub_id, name: a.name }, bosses, members,
      counts: {
        todo: n("SELECT COUNT(*) AS n FROM assignments WHERE member_id = ? AND status IN ('open', 'rework')", a.id),
        review: n("SELECT COUNT(*) AS n FROM assignments WHERE boss_id = ? AND status = 'submitted'", a.id),
        checks: n(`SELECT COUNT(*) AS n FROM challenge_checks k JOIN challenges c ON c.id = k.challenge_id WHERE c.owner_id = ? AND k.status = 'pending'`, a.id)
      }
    };
  }

  async function handleTeam(req, res, url, a) {
    const m = req.method;
    if (url === '/api/team' && m === 'GET') return send(res, 200, team(a));
    // дозволити акаунту з цим ID давати мені задачі
    if (url === '/api/team/allow' && m === 'POST') {
      if (guess.blocked('a' + a.id)) return send(res, 429, { error: 'Забагато спроб. Спробуйте за 10 хвилин.' });
      guess.note('a' + a.id);
      const b = await readBody(req, 1024) || {}, code = str(b.pub_id, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const boss = db.prepare('SELECT * FROM accounts WHERE pub_id = ? AND disabled = 0').get(code);
      if (!boss) return send(res, 404, { error: 'Акаунт з таким ID не знайдено.' });
      if (boss.id === a.id) return send(res, 400, { error: 'Це ваш власний ID.' });
      db.prepare('INSERT OR IGNORE INTO team_links (boss_id, member_id, created) VALUES (?, ?, ?)').run(boss.id, a.id, Date.now());
      notify(boss.id, 'Нова людина в команді', `${a.name} дозволив(ла) вам давати задачі в mdmy.`, '/assistant/#/team');
      return send(res, 200, team(a));
    }
    let mm = /^\/api\/team\/(bosses|members)\/(\d+)$/.exec(url);
    if (mm && m === 'DELETE') {                       // відкликати дозвіл (виконавець) або прибрати з команди (керівник)
      const other = +mm[2];
      if (mm[1] === 'bosses') db.prepare('DELETE FROM team_links WHERE boss_id = ? AND member_id = ?').run(other, a.id);
      else db.prepare('DELETE FROM team_links WHERE boss_id = ? AND member_id = ?').run(a.id, other);
      return send(res, 200, team(a));
    }
    if (url === '/api/team/tasks' && m === 'GET') {
      const qs = new URL(req.url, 'http://x').searchParams, role = qs.get('role') === 'boss' ? 'boss' : 'member';
      const rows = db.prepare(`SELECT * FROM assignments WHERE ${role}_id = ? ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'rework' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
                               COALESCE(due_at, 9e15), updated DESC LIMIT 300`).all(a.id);
      return send(res, 200, { list: rows.map(r => asgView(r, a.id)) });
    }
    if (url === '/api/team/tasks' && m === 'POST') {
      const b = await readBody(req, 16384); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      const member = +b.member_id, text = str(b.text, 500);
      if (!text) return send(res, 400, { error: 'Напишіть, що зробити.' });
      if (!isLink(a.id, member)) return send(res, 403, { error: 'Ця людина ще не дозволила вам давати їй задачі.' });
      const due = b.due_at ? +b.due_at : null, t = Date.now();
      const id = db.prepare(`INSERT INTO assignments (boss_id, member_id, text, description, due_at, need_proof, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(a.id, member, text, str(b.description, 5000) || null, Number.isFinite(due) && due > 0 ? due : null, b.need_proof ? 1 : 0, t, t).lastInsertRowid;
      notify(member, `Нове доручення від ${a.name}`, text, '/assistant/#/team/a/' + id);
      return send(res, 200, asgView(asg(id), a.id));
    }
    mm = /^\/api\/team\/tasks\/(\d+)(?:\/(submit|review|files))?$/.exec(url);
    if (!mm) return send(res, 404, { error: 'Не знайдено.' });
    const r = asg(+mm[1]);
    if (!r || (r.boss_id !== a.id && r.member_id !== a.id)) return send(res, 404, { error: 'Доручення не знайдено.' });
    const isBoss = r.boss_id === a.id, isMember = r.member_id === a.id, sub = mm[2];
    if (!sub && m === 'GET') return send(res, 200, asgView(r, a.id));
    if (!sub && m === 'DELETE') {
      if (!isBoss) return send(res, 403, { error: 'Видалити може лише той, хто доручив.' });
      for (const f of db.prepare("SELECT * FROM shared_files WHERE owner_kind = 'assignment' AND owner_id = ?").all(r.id)) files.remove(DIR, f);
      db.prepare("DELETE FROM shared_files WHERE owner_kind = 'assignment' AND owner_id = ?").run(r.id);
      db.prepare('DELETE FROM assignments WHERE id = ?').run(r.id);
      return send(res, 200, { ok: true });
    }
    if (!sub && m === 'PATCH') {
      if (!isBoss) return send(res, 403, { error: 'Змінити може лише той, хто доручив.' });
      const b = await readBody(req, 16384) || {}, v = {};
      if (b.text !== undefined) { v.text = str(b.text, 500); if (!v.text) return send(res, 400, { error: 'Назва не може бути порожньою.' }); }
      if (b.description !== undefined) v.description = str(b.description, 5000) || null;
      if (b.due_at !== undefined) v.due_at = b.due_at ? +b.due_at : null;
      if (b.need_proof !== undefined) v.need_proof = b.need_proof ? 1 : 0;
      if (Object.keys(v).length) db.prepare(`UPDATE assignments SET ${Object.keys(v).map(k => k + ' = @' + k).join(', ')}, updated = @t WHERE id = @id`).run({ ...v, t: Date.now(), id: r.id });
      return send(res, 200, asgView(asg(r.id), a.id));
    }
    // докази: виконавець додає, поки задачу не прийнято
    if (sub === 'files' && m === 'POST') {
      if (!isMember) return send(res, 403, { error: 'Докази додає виконавець.' });
      if (r.status === 'approved' || r.status === 'failed') return send(res, 400, { error: 'Доручення вже закрите.' });
      return addFile(req, res, 'assignment', r.id, a.id, () => asgView(asg(r.id), a.id));
    }
    if (sub === 'submit' && m === 'POST') {
      if (!isMember) return send(res, 403, { error: 'Здає виконавець.' });
      if (!['open', 'rework', 'submitted'].includes(r.status)) return send(res, 400, { error: 'Доручення вже закрите.' });
      const b = await readBody(req, 16384) || {};
      if (r.need_proof && !db.prepare("SELECT 1 FROM shared_files WHERE owner_kind = 'assignment' AND owner_id = ?").get(r.id))
        return send(res, 400, { error: 'Додайте фото, файл або посилання — без доказу це доручення не здати.' });
      const t = Date.now();
      db.prepare("UPDATE assignments SET status = 'submitted', report = ?, submitted_at = ?, updated = ? WHERE id = ?").run(str(b.report, 5000) || null, t, t, r.id);
      notify(r.boss_id, `${a.name} виконав(ла) доручення`, `${r.text}\nПеревірте й підтвердьте.`, '/assistant/#/team/a/' + r.id);
      return send(res, 200, asgView(asg(r.id), a.id));
    }
    if (sub === 'review' && m === 'POST') {
      if (!isBoss) return send(res, 403, { error: 'Перевіряє той, хто доручив.' });
      const b = await readBody(req, 16384) || {}, verdict = { approve: 'approved', rework: 'rework', fail: 'failed' }[b.verdict];
      if (!verdict) return send(res, 400, { error: 'Оберіть: підтвердити, на доопрацювання або не виконано.' });
      if (verdict === 'rework' && !str(b.note, 2000)) return send(res, 400, { error: 'Напишіть, що доопрацювати.' });
      const t = Date.now();
      db.prepare('UPDATE assignments SET status = ?, review_note = ?, reviewed_at = ?, updated = ? WHERE id = ?').run(verdict, str(b.note, 2000) || null, t, t, r.id);
      const msg = { approved: 'Підтверджено ✅', rework: 'Повернуто на доопрацювання', failed: 'Позначено як не виконано' }[verdict];
      notify(r.member_id, `${msg}: ${r.text}`, str(b.note, 2000) || STATUS[verdict], '/assistant/#/team/a/' + r.id);
      return send(res, 200, asgView(asg(r.id), a.id));
    }
    return send(res, 405, { error: 'Метод не підтримується.' });
  }

  // ---------- файли-докази ----------
  async function addFile(req, res, kind, ownerId, by, after) {
    if (db.prepare('SELECT COUNT(*) AS n FROM shared_files WHERE owner_kind = ? AND owner_id = ?').get(kind, ownerId).n >= 20) return send(res, 400, { error: 'Щонайбільше 20 вкладень.' });
    let v;
    if (/json/.test(req.headers['content-type'] || '')) { v = files.link(await readBody(req, 4096)); if (!v) return send(res, 400, { error: 'Посилання має починатися з http:// або https://' }); }
    else { v = await files.save(req, res, DIR); if (!v) return; }
    db.prepare('INSERT INTO shared_files (owner_kind, owner_id, by_account, kind, name, mime, size, fkey, url, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, ownerId, by, v.kind, v.name, v.mime || null, v.size || null, v.fkey || null, v.url || null, Date.now());
    return send(res, 200, after());
  }
  // хто може бачити файл: учасники доручення або челенджу
  function canSee(f, a) {
    if (f.owner_kind === 'assignment') { const r = asg(f.owner_id); return !!(r && (r.boss_id === a.id || r.member_id === a.id)); }
    const k = db.prepare('SELECT * FROM challenge_checks WHERE id = ?').get(f.owner_id); if (!k) return false;
    return !!(k.account_id === a.id || db.prepare('SELECT 1 FROM challenges WHERE id = ? AND owner_id = ?').get(k.challenge_id, a.id) || isMember(k.challenge_id, a.id));
  }
  async function handleShared(req, res, url, a) {
    let mm = /^\/api\/shared\/([a-f0-9]{32})$/.exec(url);
    if (mm && (req.method === 'GET' || req.method === 'HEAD')) {
      const f = db.prepare('SELECT * FROM shared_files WHERE fkey = ?').get(mm[1]);
      if (!f || !canSee(f, a)) { res.writeHead(404); return res.end(); }
      return files.serve(req, res, DIR, f);
    }
    mm = /^\/api\/shared\/files\/(\d+)$/.exec(url);
    if (mm && req.method === 'DELETE') {
      const f = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(+mm[1]);
      if (!f || f.by_account !== a.id) return send(res, 404, { error: 'Файл не знайдено.' });
      if (f.owner_kind === 'assignment') { const r = asg(f.owner_id); if (r && ['approved', 'failed'].includes(r.status)) return send(res, 400, { error: 'Доручення вже закрите.' }); }
      db.prepare('DELETE FROM shared_files WHERE id = ?').run(f.id); files.remove(DIR, f);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }

  // ---------- челенджі ----------
  const ch = id => db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
  const isMember = (cid, aid) => !!db.prepare('SELECT 1 FROM challenge_members WHERE challenge_id = ? AND account_id = ?').get(cid, aid);
  const endDay = c => addDays(c.start_day, c.days - 1);
  function chView(c, a, full) {
    const today = todayOf(a), owner = c.owner_id === a.id;
    const dayNo = Math.min(c.days, Math.max(0, dayDiff(c.start_day, today) + 1));
    const st = today < c.start_day ? 'soon' : today > endDay(c) || c.closed ? 'ended' : 'active';
    const mine = db.prepare("SELECT day, status FROM challenge_checks WHERE challenge_id = ? AND account_id = ? AND status <> 'draft'").all(c.id, a.id);
    const by = Object.fromEntries(mine.map(x => [x.day, x.status]));
    const v = {
      id: c.id, code: c.code, title: c.title, description: c.description || '', days: c.days, start_day: c.start_day, end_day: endDay(c),
      confirm: !!c.confirm, need_proof: !!c.need_proof, closed: !!c.closed, owner: who(acc(c.owner_id)), isOwner: owner, joined: isMember(c.id, a.id),
      state: st, dayNo, today, todayStatus: by[today] || null, done: mine.filter(x => x.status === 'ok').length,
      members: db.prepare('SELECT COUNT(*) AS n FROM challenge_members WHERE challenge_id = ?').get(c.id).n,
      pending: owner ? db.prepare("SELECT COUNT(*) AS n FROM challenge_checks WHERE challenge_id = ? AND status = 'pending'").get(c.id).n : 0
    };
    if (full) {
      v.myDays = Array.from({ length: c.days }, (_, i) => { const d = addDays(c.start_day, i); return { day: d, status: by[d] || null, future: d > today }; });
      v.board = db.prepare(`SELECT a.id, a.name, (SELECT COUNT(*) FROM challenge_checks k WHERE k.challenge_id = m.challenge_id AND k.account_id = a.id AND k.status = 'ok') AS done
                            FROM challenge_members m JOIN accounts a ON a.id = m.account_id WHERE m.challenge_id = ? ORDER BY done DESC, m.joined`).all(c.id)
        .map(x => ({ ...x, me: x.id === a.id }));
      if (owner) v.queue = db.prepare(`SELECT k.*, a.name FROM challenge_checks k JOIN accounts a ON a.id = k.account_id WHERE k.challenge_id = ? AND k.status = 'pending' ORDER BY k.created`).all(c.id)
        .map(k => ({ id: k.id, day: k.day, note: k.note || '', name: k.name, account_id: k.account_id, files: fileList('check', k.id) }));
      const t = db.prepare('SELECT * FROM challenge_checks WHERE challenge_id = ? AND account_id = ? AND day = ?').get(c.id, a.id, today);
      v.todayCheck = t ? { id: t.id, status: t.status, note: t.note || '', files: fileList('check', t.id) } : null;
    }
    return v;
  }
  function removeChallenge(c) {
    for (const k of db.prepare('SELECT id FROM challenge_checks WHERE challenge_id = ?').all(c.id)) {
      for (const f of db.prepare("SELECT * FROM shared_files WHERE owner_kind = 'check' AND owner_id = ?").all(k.id)) files.remove(DIR, f);
      db.prepare("DELETE FROM shared_files WHERE owner_kind = 'check' AND owner_id = ?").run(k.id);
    }
    db.prepare('DELETE FROM challenges WHERE id = ?').run(c.id);
  }

  async function handleChallenges(req, res, url, a) {
    const m = req.method;
    if (url === '/api/challenges' && m === 'GET') {
      const rows = db.prepare(`SELECT c.* FROM challenges c WHERE c.owner_id = ? OR c.id IN (SELECT challenge_id FROM challenge_members WHERE account_id = ?) ORDER BY c.closed, c.start_day DESC, c.id DESC`).all(a.id, a.id);
      return send(res, 200, { list: rows.map(c => chView(c, a)) });
    }
    if (url === '/api/challenges' && m === 'POST') {
      const b = await readBody(req, 16384); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      const title = str(b.title, 120), days = Math.round(+b.days);
      if (!title) return send(res, 400, { error: 'Назвіть челендж.' });
      if (!(days >= 1 && days <= 365)) return send(res, 400, { error: 'Тривалість — від 1 до 365 днів.' });
      const start = DAY.test(b.start_day || '') ? b.start_day : todayOf(a);
      let code; do code = D.randCode(6); while (db.prepare('SELECT 1 FROM challenges WHERE code = ?').get(code));
      const id = db.prepare('INSERT INTO challenges (code, owner_id, title, description, days, start_day, confirm, need_proof, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(code, a.id, title, str(b.description, 3000) || null, days, start, b.confirm ? 1 : 0, b.need_proof ? 1 : 0, Date.now()).lastInsertRowid;
      if (b.join !== false) db.prepare('INSERT INTO challenge_members (challenge_id, account_id, joined) VALUES (?, ?, ?)').run(id, a.id, Date.now());
      return send(res, 200, chView(ch(id), a, true));
    }
    if (url === '/api/challenges/join' && m === 'POST') {
      if (guess.blocked('a' + a.id)) return send(res, 429, { error: 'Забагато спроб. Спробуйте за 10 хвилин.' });
      guess.note('a' + a.id);
      const b = await readBody(req, 1024) || {}, code = str(b.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const c = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
      if (!c) return send(res, 404, { error: 'Челендж з таким кодом не знайдено.' });
      if (c.closed) return send(res, 400, { error: 'Цей челендж уже завершено.' });
      db.prepare('INSERT OR IGNORE INTO challenge_members (challenge_id, account_id, joined) VALUES (?, ?, ?)').run(c.id, a.id, Date.now());
      if (c.owner_id !== a.id) notify(c.owner_id, `Новий учасник челенджу «${c.title}»`, `${a.name} долучився(лася).`, '/assistant/#/challenges/' + c.id);
      return send(res, 200, chView(c, a, true));
    }
    let mm = /^\/api\/challenges\/(\d+)(?:\/(check|leave|review|files))?(?:\/(\d+))?$/.exec(url);
    if (!mm) return send(res, 404, { error: 'Не знайдено.' });
    const c = ch(+mm[1]);
    if (!c || (c.owner_id !== a.id && !isMember(c.id, a.id))) return send(res, 404, { error: 'Челендж не знайдено.' });
    const owner = c.owner_id === a.id, sub = mm[2];
    if (!sub && m === 'GET') return send(res, 200, chView(c, a, true));
    if (!sub && m === 'PATCH') {
      if (!owner) return send(res, 403, { error: 'Змінює автор челенджу.' });
      const b = await readBody(req, 16384) || {}, v = {};
      if (b.title !== undefined) { v.title = str(b.title, 120); if (!v.title) return send(res, 400, { error: 'Назвіть челендж.' }); }
      if (b.description !== undefined) v.description = str(b.description, 3000) || null;
      if (b.confirm !== undefined) v.confirm = b.confirm ? 1 : 0;
      if (b.need_proof !== undefined) v.need_proof = b.need_proof ? 1 : 0;
      if (b.closed !== undefined) v.closed = b.closed ? 1 : 0;
      if (b.days !== undefined) { const d = Math.round(+b.days); if (!(d >= 1 && d <= 365)) return send(res, 400, { error: 'Тривалість — від 1 до 365 днів.' }); v.days = d; }
      if (Object.keys(v).length) db.prepare(`UPDATE challenges SET ${Object.keys(v).map(k => k + ' = @' + k).join(', ')} WHERE id = @id`).run({ ...v, id: c.id });
      // підтвердження вимкнули — те, що чекало, зараховуємо
      if (v.confirm === 0) db.prepare("UPDATE challenge_checks SET status = 'ok', reviewed_at = ? WHERE challenge_id = ? AND status = 'pending'").run(Date.now(), c.id);
      return send(res, 200, chView(ch(c.id), a, true));
    }
    if (!sub && m === 'DELETE') {
      if (!owner) return send(res, 403, { error: 'Видаляє автор челенджу.' });
      removeChallenge(c); return send(res, 200, { ok: true });
    }
    if (sub === 'leave' && m === 'POST') {
      if (owner) return send(res, 400, { error: 'Автор не виходить із челенджу — його можна завершити або видалити.' });
      db.prepare('DELETE FROM challenge_members WHERE challenge_id = ? AND account_id = ?').run(c.id, a.id);
      return send(res, 200, { ok: true });
    }
    // відмітка за день (сьогодні або вчора — якщо забув); з коментарем; докази — окремо (files)
    if (sub === 'check' && m === 'POST') {
      if (!isMember(c.id, a.id)) return send(res, 403, { error: 'Спершу долучіться до челенджу.' });
      if (c.closed) return send(res, 400, { error: 'Челендж завершено.' });
      const b = await readBody(req, 16384) || {}, today = todayOf(a), day = DAY.test(b.day || '') ? b.day : today;
      if (day > today || day < addDays(today, -1)) return send(res, 400, { error: 'Відмітити можна сьогодні або вчора.' });
      if (day < c.start_day || day > endDay(c)) return send(res, 400, { error: 'Цей день не входить у челендж.' });
      if (b.undo) {
        const k = db.prepare('SELECT * FROM challenge_checks WHERE challenge_id = ? AND account_id = ? AND day = ?').get(c.id, a.id, day);
        if (k && k.status !== 'ok') {
          for (const f of db.prepare("SELECT * FROM shared_files WHERE owner_kind = 'check' AND owner_id = ?").all(k.id)) files.remove(DIR, f);
          db.prepare("DELETE FROM shared_files WHERE owner_kind = 'check' AND owner_id = ?").run(k.id);
          db.prepare('DELETE FROM challenge_checks WHERE id = ?').run(k.id);
        } else if (k && k.status === 'ok' && !c.confirm) db.prepare('DELETE FROM challenge_checks WHERE id = ?').run(k.id);
        return send(res, 200, chView(c, a, true));
      }
      const k = db.prepare('SELECT * FROM challenge_checks WHERE challenge_id = ? AND account_id = ? AND day = ?').get(c.id, a.id, day);
      if (k && k.status === 'ok') return send(res, 200, chView(c, a, true));
      const status = c.confirm ? 'pending' : 'ok';
      let kid;
      if (k) { db.prepare('UPDATE challenge_checks SET status = ?, note = ?, created = ?, reviewed_at = NULL WHERE id = ?').run(status, str(b.note, 2000) || null, Date.now(), k.id); kid = k.id; }
      else kid = db.prepare('INSERT INTO challenge_checks (challenge_id, account_id, day, status, note, created) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, a.id, day, status, str(b.note, 2000) || null, Date.now()).lastInsertRowid;
      if (c.need_proof && b.final && !db.prepare("SELECT 1 FROM shared_files WHERE owner_kind = 'check' AND owner_id = ?").get(kid)) {
        db.prepare("UPDATE challenge_checks SET status = 'draft' WHERE id = ?").run(kid);
        return send(res, 400, { error: 'Додайте фото, файл або посилання — у цьому челенджі відмітка лише з доказом.' });
      }
      if (status === 'pending' && b.final && c.owner_id !== a.id) notify(c.owner_id, `Відмітка в челенджі «${c.title}»`, `${a.name} — ${day}. Підтвердьте.`, '/assistant/#/challenges/' + c.id);
      return send(res, 200, chView(c, a, true));
    }
    // доказ до своєї відмітки за день (створює чернетку відмітки, якщо її ще немає)
    if (sub === 'files' && m === 'POST') {
      if (!isMember(c.id, a.id)) return send(res, 403, { error: 'Спершу долучіться до челенджу.' });
      const qs = new URL(req.url, 'http://x').searchParams, today = todayOf(a), day = DAY.test(qs.get('day') || '') ? qs.get('day') : today;
      if (day > today || day < addDays(today, -1) || day < c.start_day || day > endDay(c)) return send(res, 400, { error: 'Цей день не можна відмітити.' });
      let k = db.prepare('SELECT * FROM challenge_checks WHERE challenge_id = ? AND account_id = ? AND day = ?').get(c.id, a.id, day);
      if (k && k.status === 'ok') return send(res, 400, { error: 'День уже зараховано.' });
      if (!k) k = { id: db.prepare("INSERT INTO challenge_checks (challenge_id, account_id, day, status, created) VALUES (?, ?, ?, 'draft', ?)").run(c.id, a.id, day, Date.now()).lastInsertRowid };
      return addFile(req, res, 'check', k.id, a.id, () => chView(c, a, true));
    }
    if (sub === 'review' && m === 'POST' && mm[3]) {
      if (!owner) return send(res, 403, { error: 'Підтверджує автор челенджу.' });
      const k = db.prepare('SELECT * FROM challenge_checks WHERE id = ? AND challenge_id = ?').get(+mm[3], c.id);
      if (!k) return send(res, 404, { error: 'Відмітку не знайдено.' });
      const b = await readBody(req, 2048) || {}, ok = !!b.ok;
      db.prepare('UPDATE challenge_checks SET status = ?, reviewed_at = ? WHERE id = ?').run(ok ? 'ok' : 'rejected', Date.now(), k.id);
      if (k.account_id !== a.id) notify(k.account_id, `${c.title}: ${ok ? 'день зараховано ✅' : 'відмітку відхилено'}`, `День ${k.day}`, '/assistant/#/challenges/' + c.id);
      return send(res, 200, chView(c, a, true));
    }
    if (sub === 'leave' || sub === 'review') return send(res, 405, { error: 'Метод не підтримується.' });
    return send(res, 405, { error: 'Метод не підтримується.' });
  }

  // видалити все спільне облікового запису (перед видаленням акаунта): челенджі, які він створив, і файли
  function forgetAccount(id) {
    for (const c of db.prepare('SELECT * FROM challenges WHERE owner_id = ?').all(id)) removeChallenge(c);
    for (const f of db.prepare(`SELECT * FROM shared_files WHERE by_account = ? OR (owner_kind = 'assignment' AND owner_id IN (SELECT id FROM assignments WHERE boss_id = ? OR member_id = ?))
                                 OR (owner_kind = 'check' AND owner_id IN (SELECT id FROM challenge_checks WHERE account_id = ?))`).all(id, id, id, id)) {
      files.remove(DIR, f); db.prepare('DELETE FROM shared_files WHERE id = ?').run(f.id);
    }
  }

  return { handleTeam, handleShared, handleChallenges, forgetAccount, counts: a => team(a).counts };
};
