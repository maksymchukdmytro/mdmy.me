// Формування звичок: звички й відмітки по днях (✓ виконав / ✗ ні).
// Нагадування звички (remind, HH:MM) — у заплановані дні в цей час, якщо ще не відмічено: Telegram «Зроблено / Не сьогодні» і push.
// Щовечора (за замовчуванням о 22:00) асистент питає в Telegram і сповіщенням, чи виконано звички цього дня, —
// під кожною кнопки «Так / Ні». Відмітити можна й у календарі звички, і голосом («сьогодні зробив зарядку»).
const { send, readBody } = require('./util');

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const P = s => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } };

module.exports = function makeHabits(db, { load, update, bot, push, T }) {
  const now = () => Date.now();
  const tz = () => load().tz;
  const today = () => T.dayKey(now(), tz());
  const row = id => db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
  const daysOf = h => { const d = P(h.days); return Array.isArray(d) && d.length && d.length < 7 ? d : null; };
  const onDay = (h, day) => { const d = daysOf(h); return !d || d.includes(T.isoWeekday(day)); };
  const marksOf = (id, from, to) => Object.fromEntries(db.prepare('SELECT day, done FROM habit_marks WHERE habit_id = ? AND day >= ? AND day <= ?').all(id, from, to).map(m => [m.day, m.done ? 1 : 0]));

  // Серія: скільки запланованих днів поспіль виконано (сьогодні без відмітки серію не обриває)
  function streaks(h) {
    const t = today(), all = marksOf(h.id, h.start_day, t);
    let cur = 0, best = 0, run = 0, broke = false;
    for (let d = t, i = 0; d >= h.start_day && i < 3660; d = T.addDays(d, -1), i++) {
      if (!onDay(h, d)) continue;
      const m = all[d];
      if (m === 1) { if (!broke) cur++; }
      else if (!(d === t && m === undefined)) broke = true;
    }
    for (let d = h.start_day, i = 0; d <= t && i < 3660; d = T.addDays(d, 1), i++) {
      if (!onDay(h, d)) continue;
      if (all[d] === 1) { run++; best = Math.max(best, run); } else if (d !== t) run = 0;
    }
    return { streak: cur, best };
  }
  const dayNo = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);
  function view(h, month) {
    const t = today();
    // 7 кружечків — тиждень звички: перший кружечок = перший день (start_day), далі 8-й день починає новий ряд.
    const from = T.addDays(h.start_day, Math.floor(Math.max(0, dayNo(h.start_day, t)) / 7) * 7), to = T.addDays(from, 6);
    const week = marksOf(h.id, from, to <= t ? to : t);
    if (week[t] === undefined) Object.assign(week, marksOf(h.id, t, t));
    const v = {
      id: h.id, title: h.title, icon: h.icon, why: h.why || '', days: daysOf(h), ask: !!h.ask, active: !!h.active, start: h.start_day, remind: h.remind || null,
      todayPlanned: onDay(h, t), today: week[t] ?? null, dayNo: dayNo(h.start_day, t) + 1,
      week: Array.from({ length: 7 }, (_, i) => { const d = T.addDays(from, i); return { day: d, planned: onDay(h, d) && d >= h.start_day, mark: week[d] ?? null, future: d > t, today: d === t }; }),
      ...streaks(h)
    };
    if (month) {
      const [y, mo] = month.split('-').map(Number), nm = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
      const first = `${month}-01`, last = T.addDays(`${nm}-01`, -1);
      const marks = marksOf(h.id, first, last);
      let planned = 0, done = 0, missed = 0;
      const days = [];
      for (let d = first; d <= last; d = T.addDays(d, 1)) {
        const p = onDay(h, d) && d >= h.start_day && d <= t;
        if (p) { planned++; if (marks[d] === 1) done++; if (marks[d] === 0) missed++; }
        days.push({ day: d, planned: onDay(h, d), mark: marks[d] ?? null, future: d > t, before: d < h.start_day });
      }
      v.month = { month, days, planned, done, missed };
    }
    return v;
  }
  const list = () => db.prepare('SELECT * FROM habits ORDER BY active DESC, position, id').all().map(h => view(h));

  // ---------- зміни ----------
  function clean(b, old) {
    const v = {};
    if (!old || b.title !== undefined) { v.title = str(b.title, 80); if (!v.title) throw new Error('Назва звички обовʼязкова.'); }
    if (b.icon !== undefined) v.icon = str(b.icon, 8) || '✨';
    if (b.why !== undefined) v.why = str(b.why, 600) || null;
    if (b.days !== undefined) {
      const d = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(x => x >= 1 && x <= 7))].sort() : [];
      if (Array.isArray(b.days) && !d.length) throw new Error('Оберіть хоча б один день.');
      v.days = d.length && d.length < 7 ? JSON.stringify(d) : null;
    }
    if (b.ask !== undefined) v.ask = b.ask ? 1 : 0;
    if (b.remind !== undefined) {
      if (b.remind && !HM.test(b.remind)) throw new Error('Час нагадування — у форматі 09:00.');
      v.remind = b.remind || null;
      // новий час сьогодні ще попереду — нагадаємо сьогодні
      if (v.remind && v.remind > T.hhmm(now(), tz())) v.reminded_day = null;
    }
    if (b.active !== undefined) v.active = b.active ? 1 : 0;
    return v;
  }
  function create(b) {
    const v = { icon: '✨', why: null, days: null, ask: 1, active: 1, remind: null, ...clean(b, null) };
    delete v.reminded_day;
    const t = now(), pos = (db.prepare('SELECT MAX(position) AS p FROM habits').get().p ?? 0) + 1;
    // нагадування на сьогодні, якщо його час уже минув, не надсилаємо — почнемо із завтра
    const rd = v.remind && v.remind <= T.hhmm(t, tz()) ? today() : null;
    const id = db.prepare(`INSERT INTO habits (title, icon, why, days, ask, active, remind, reminded_day, position, start_day, created, updated)
                           VALUES (@title, @icon, @why, @days, @ask, @active, @remind, @rd, @pos, @start, @t, @t)`).run({ ...v, rd, pos, start: today(), t }).lastInsertRowid;
    return row(id);
  }
  function patch(id, b) {
    const v = clean(b, row(id));
    if (Object.keys(v).length) db.prepare(`UPDATE habits SET ${Object.keys(v).map(k => `${k} = @${k}`).join(', ')}, updated = @t WHERE id = @id`).run({ ...v, t: now(), id });
    return row(id);
  }
  // done: true — ✓, false — ✗, null — прибрати відмітку
  function mark(id, day, done) {
    const h = row(id); if (!h) return null;
    if (!DAY.test(day || '') || day > today()) throw new Error('Можна відмічати лише сьогодні й минулі дні.');
    if (done === null) db.prepare('DELETE FROM habit_marks WHERE habit_id = ? AND day = ?').run(id, day);
    else db.prepare(`INSERT INTO habit_marks (habit_id, day, done, at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(habit_id, day) DO UPDATE SET done = excluded.done, at = excluded.at`).run(id, day, done ? 1 : 0, now());
    // відмітка за день до початку — рахуємо звичку з того дня
    if (day < h.start_day) db.prepare('UPDATE habits SET start_day = ? WHERE id = ?').run(day, id);
    return row(id);
  }
  // за назвою (для асистента): точний збіг, потім «містить»
  function find(name) {
    const n = str(name, 80).toLowerCase(); if (!n) return null;
    const all = db.prepare('SELECT * FROM habits WHERE active = 1').all();
    return all.find(h => h.title.toLowerCase() === n) || all.find(h => h.title.toLowerCase().includes(n) || n.includes(h.title.toLowerCase())) || null;
  }

  // ---------- вечірнє питання ----------
  const dueToday = () => db.prepare('SELECT * FROM habits WHERE active = 1 AND ask = 1 ORDER BY position, id').all().filter(h => onDay(h, today()));
  function askText(list, day) {
    const m = Object.fromEntries(db.prepare(`SELECT habit_id, done FROM habit_marks WHERE day = ?`).all(day).map(x => [x.habit_id, x.done]));
    return '🌙 Як сьогодні зі звичками?\n\n' + list.map(h => `${m[h.id] === 1 ? '✅' : m[h.id] === 0 ? '✖️' : '▫️'} ${h.icon} ${h.title}`).join('\n');
  }
  function askKeyboard(list, day) {
    return { inline_keyboard: list.map(h => [{ text: `✅ ${h.title}`.slice(0, 40), callback_data: `hb:${h.id}:${day}:y` }, { text: '✖️ Ні', callback_data: `hb:${h.id}:${day}:n` }]) };
  }
  async function ask(force) {
    const list = dueToday(); if (!list.length) return 0;
    const day = today();
    let n = 0;
    if (bot.ready() && await bot.sendText(askText(list, day), { reply_markup: askKeyboard(list, day) })) n++;
    if (push.has()) {
      const one = list.length === 1 && list[0];
      n += await push.sendAll({
        kind: 'habits', tag: 'habits-' + day, title: '🌙 Як сьогодні зі звичками?',
        body: list.map(h => `${h.icon} ${h.title}`).join(' · ').slice(0, 300), url: '/#/habits/check',
        ...(one ? { token: push.actionToken('h' + one.id), actions: [{ action: 'hyes', title: '✅ Так' }, { action: 'hno', title: '✖️ Ні' }] } : {})
      });
    }
    return n;
  }
  // ---------- нагадування в певний час ----------
  const remindKeyboard = (h, day) => ({ inline_keyboard: [[{ text: '✅ Зроблено', callback_data: `hb:${h.id}:${day}:y:r` }, { text: '✖️ Не сьогодні', callback_data: `hb:${h.id}:${day}:n:r` }]] });
  async function remind(h, day) {
    const text = `⏰ ${h.icon} ${h.title}${h.why ? '\n' + h.why : ''}`;
    if (bot.ready()) await bot.sendText(text, { reply_markup: remindKeyboard(h, day) }).catch(() => {});
    if (push.has()) await push.sendAll({
      kind: 'habits', tag: `habit-${h.id}-${day}`, title: `${h.icon} ${h.title}`, body: h.why || 'Час для звички',
      url: '/#/habits/' + h.id, token: push.actionToken('h' + h.id), actions: [{ action: 'hyes', title: '✅ Зроблено' }, { action: 'hno', title: '✖️ Не сьогодні' }]
    }).catch(() => {});
  }
  async function remindTick(s, day, hm) {
    const list = db.prepare("SELECT * FROM habits WHERE active = 1 AND remind IS NOT NULL AND (reminded_day IS NULL OR reminded_day <> ?)").all(day);
    for (const h of list) {
      if (hm < h.remind) continue;
      db.prepare('UPDATE habits SET reminded_day = ? WHERE id = ?').run(day, h.id);
      const late = (+hm.slice(0, 2) * 60 + +hm.slice(3)) - (+h.remind.slice(0, 2) * 60 + +h.remind.slice(3));
      // не в цей день, уже відмічено або сервер лежав понад 2 год — пропускаємо
      if (!onDay(h, day) || late > 120 || db.prepare('SELECT 1 FROM habit_marks WHERE habit_id = ? AND day = ?').get(h.id, day)) continue;
      try { await remind(h, day); } catch (e) { console.error('[habits] нагадування:', e.message); }
    }
  }
  async function tick() {
    const s = load(), t = now(), day = T.dayKey(t, s.tz), hm = T.hhmm(t, s.tz);
    await remindTick(s, day, hm);
    const at = s.habitsTime || '22:00';
    if (s.habitsOn === false || s.lastHabitsDay === day || hm < at) return;
    update({ lastHabitsDay: day });
    try { await ask(); } catch (e) { console.error('[habits] вечірнє питання:', e.message); }
  }
  // кнопка в Telegram: hb:<id>:<день>:y|n — відмічаємо й оновлюємо повідомлення
  function telegramAnswer(id, day, yes, fromReminder) {
    const h = mark(id, day, yes); if (!h) return null;
    if (fromReminder) return { status: `${yes ? '✅' : '✖️'} ${h.title}`, text: `${yes ? '✅' : '✖️'} ${h.icon} ${h.title} — ${yes ? 'зроблено' : 'не сьогодні'}`, keyboard: { inline_keyboard: [] } };
    const list = dueToday().filter(x => day === today() ? true : onDay(x, day));
    return { status: `${yes ? '✅' : '✖️'} ${h.title}`, text: askText(list.length ? list : [h], day), keyboard: askKeyboard(list.length ? list : [h], day) };
  }
  function pushAction(id, action, res) {
    if (!row(id)) return send(res, 404, { error: 'Звичку не знайдено.' });
    if (action !== 'hyes' && action !== 'hno') return send(res, 400, { error: 'Невідома дія.' });
    const h = mark(id, today(), action === 'hyes');
    return send(res, 200, { ok: true, text: `${action === 'hyes' ? '✅' : '✖️'} ${h.title}` });
  }
  bot.onHabit((id, day, yes, r) => telegramAnswer(id, day, yes, r));

  // ---------- API /api/habits/* ----------
  async function handle(req, res, url) {
    const m = req.method, qs = new URL(req.url, 'http://x').searchParams;
    if (url === '/api/habits' && m === 'GET') {
      const s = load();
      return send(res, 200, { list: list(), today: today(), time: s.habitsTime || '22:00', on: s.habitsOn !== false });
    }
    if (url === '/api/habits' && m === 'POST') {
      const b = await readBody(req, 16384); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      try { return send(res, 200, view(create(b), today().slice(0, 7))); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (url === '/api/habits/settings' && m === 'POST') {
      const b = await readBody(req, 2048) || {};
      if (b.time != null && !HM.test(b.time)) return send(res, 400, { error: 'Час — у форматі 22:00.' });
      const patchS = {};
      if (b.time != null) { patchS.habitsTime = b.time; if (b.time > T.hhmm(now(), tz())) patchS.lastHabitsDay = ''; }
      if (b.on != null) patchS.habitsOn = !!b.on;
      const s = update(patchS);
      return send(res, 200, { time: s.habitsTime || '22:00', on: s.habitsOn !== false });
    }
    if (url === '/api/habits/ask' && m === 'POST') {
      const n = await ask(true);
      return send(res, 200, { sent: n, text: n ? 'Надіслано' : 'Немає куди надсилати або звичок на сьогодні.' });
    }
    const mm = /^\/api\/habits\/(\d+)(?:\/(mark))?$/.exec(url);
    if (!mm) return send(res, 404, { error: 'Не знайдено.' });
    const id = +mm[1], h = row(id);
    if (!h) return send(res, 404, { error: 'Звичку не знайдено.' });
    const month = /^\d{4}-\d{2}$/.test(qs.get('month') || '') ? qs.get('month') : today().slice(0, 7);
    if (!mm[2] && m === 'GET') return send(res, 200, view(h, month));
    if (!mm[2] && m === 'PATCH') {
      const b = await readBody(req, 16384); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      try { return send(res, 200, view(patch(id, b), month)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (!mm[2] && m === 'DELETE') { db.prepare('DELETE FROM habits WHERE id = ?').run(id); return send(res, 200, { ok: true }); }
    if (mm[2] === 'mark' && m === 'POST') {
      const b = await readBody(req, 1024) || {};
      try { mark(id, b.day || today(), b.done === null || b.done === undefined ? null : !!b.done); return send(res, 200, view(row(id), (b.day || today()).slice(0, 7))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    return send(res, 405, { error: 'Метод не підтримується.' });
  }

  return { handle, tick, ask, pushAction, mark, find, list, today, create };
};
