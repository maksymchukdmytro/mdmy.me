// Сховище особистого помічника: усі зміни записів ідуть тільки через цей модуль.
// Кожна зміна пишеться в assistant_events (стан до/після) — так працює «скасуй» і контекст розмови,
// а пошуковий індекс assistant_fts оновлюється тут же. Схема — lib/db.js.
const T = require('./assistant-time');

const KINDS = ['task', 'reminder', 'note'];
const AREAS = ['inbox', 'work', 'personal'];   // несортовані / робочі / особисті
const STOP = new Set(['що', 'як', 'про', 'я', 'ти', 'мене', 'мені', 'мій', 'моя', 'і', 'й', 'та', 'в', 'у', 'на', 'з', 'із', 'за', 'до', 'це', 'чи', 'коли', 'де', 'був', 'була',
  'було', 'що', 'там', 'тут', 'вже', 'ще', 'не', 'так', 'який', 'яка', 'яке', 'записував', 'казав', 'говорив', 'что', 'как', 'и', 'с', 'это', 'когда', 'где', 'я', 'мне', 'меня', 'не']);
const str = (v, max = 2000) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const J = v => v == null ? null : JSON.stringify(v);
const P = s => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } };

module.exports = function makeStore(db) {
  const now = () => Date.now();
  const q = {
    item: db.prepare('SELECT * FROM assistant_items WHERE id = ?'),
    children: db.prepare('SELECT id FROM assistant_items WHERE parent_id = ?'),
    tagsOf: db.prepare('SELECT t.name FROM assistant_item_tags x JOIN assistant_tags t ON t.id = x.tag_id WHERE x.item_id = ? ORDER BY t.name'),
    addTag: db.prepare('INSERT INTO assistant_tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id'),
    link: db.prepare('INSERT OR IGNORE INTO assistant_item_tags (item_id, tag_id) VALUES (?, ?)'),
    unlinkAll: db.prepare('DELETE FROM assistant_item_tags WHERE item_id = ?'),
    project: db.prepare('SELECT * FROM assistant_projects WHERE id = ?'),
    projectByName: db.prepare('SELECT * FROM assistant_projects WHERE name = ?'),
    addProject: db.prepare('INSERT INTO assistant_projects (name, created) VALUES (?, ?)'),
    ftsDel: db.prepare('DELETE FROM assistant_fts WHERE ref_type = ? AND ref_id = ?'),
    ftsAdd: db.prepare('INSERT INTO assistant_fts (text, ref_type, ref_id) VALUES (?, ?, ?)'),
    event: db.prepare('INSERT INTO assistant_events (at, msg_id, kind, ref, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    checkin: db.prepare('SELECT * FROM assistant_checkins WHERE day = ?'),
    habitByName: db.prepare('SELECT * FROM assistant_habits WHERE name = ?'),
    habitLog: db.prepare('SELECT 1 FROM assistant_habit_log WHERE habit_id = ? AND day = ?')
  };
  const COLS = ['id', 'kind', 'text', 'due_at', 'sent_at', 'done_at', 'msg_id', 'created', 'updated', 'project_id', 'priority', 'parent_id', 'repeat', 'area'];

  // ---------- допоміжне ----------
  const tagsOf = id => q.tagsOf.all(id).map(r => r.name);
  function setTags(id, tags) {
    q.unlinkAll.run(id);
    for (const t of (tags || []).map(x => str(x, 30).toLowerCase().replace(/^#/, '')).filter(Boolean).slice(0, 6)) q.link.run(id, q.addTag.get(t).id);
  }
  function projectId(name) {
    name = str(name, 60); if (!name) return null;
    const p = q.projectByName.get(name);
    if (p) { if (p.archived) db.prepare('UPDATE assistant_projects SET archived = 0 WHERE id = ?').run(p.id); return p.id; }
    return q.addProject.run(name, now()).lastInsertRowid;
  }
  function reindexItem(id) {
    q.ftsDel.run('item', id);
    const it = q.item.get(id); if (!it) return;
    const tags = tagsOf(id), pr = it.project_id && q.project.get(it.project_id);
    q.ftsAdd.run([it.text, tags.join(' '), pr ? pr.name : ''].join(' ').trim(), 'item', id);
  }
  // знімок запису (з тегами; для видалення — з підзадачами), щоб можна було точно відновити
  function snapshot(id, deep) {
    const it = q.item.get(id); if (!it) return null;
    const pr = it.project_id && q.project.get(it.project_id);
    const s = { item: it, tags: tagsOf(id), project: pr ? pr.name : null };
    if (deep) s.children = q.children.all(id).map(c => snapshot(c.id, true));
    return s;
  }
  function restore(s) {   // повністю повертає запис до знімка (вставляє, якщо його немає)
    const it = { ...s.item };
    // проєкт міг бути прибраний (порожній), а батьківська задача — видалена: повертаємо проєкт, відвʼязуємо від зниклого батька
    if (it.project_id && !q.project.get(it.project_id)) it.project_id = s.project ? projectId(s.project) : null;
    if (it.parent_id && !q.item.get(it.parent_id)) it.parent_id = null;
    if (!AREAS.includes(it.area)) it.area = 'inbox';   // знімки, зроблені до появи сфер
    db.prepare(`INSERT INTO assistant_items (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
                ON CONFLICT(id) DO UPDATE SET ${COLS.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ')}`)
      .run(...COLS.map(c => it[c] === undefined ? null : it[c]));
    setTags(it.id, s.tags); reindexItem(it.id);
    for (const c of s.children || []) restore(c);
  }
  // проєкти створюються автоматично, тож і прибираються, коли в них не лишилося жодного запису
  const pruneProjects = () => db.prepare('DELETE FROM assistant_projects WHERE NOT EXISTS (SELECT 1 FROM assistant_items i WHERE i.project_id = assistant_projects.id)').run();
  const logEvent = (msgId, kind, ref, action, before, after) => q.event.run(now(), msgId || null, kind, String(ref), action, J(before), J(after));

  // ---------- записи ----------
  function view(it, tz) {
    if (!it) return null;
    const rep = P(it.repeat), pr = it.project_id && q.project.get(it.project_id), t = now();
    return {
      id: it.id, kind: it.kind, area: it.area || 'inbox', text: it.text, tags: tagsOf(it.id), project: pr ? pr.name : null, project_id: it.project_id,
      priority: it.priority || 0, parent_id: it.parent_id, repeat: rep, repeatText: T.describeRepeat(rep),
      due_at: it.due_at, when: it.due_at ? T.fmtWhen(it.due_at, tz, t) : null, sent: !!it.sent_at, done: !!it.done_at,
      done_at: it.done_at, created: it.created, overdue: !!(it.due_at && it.due_at < t && !it.done_at)
    };
  }

  function createItem(d, msgId, tz) {
    const kind = KINDS.includes(d.kind) ? d.kind : 'task', t = now();
    const text = str(d.text); if (!text) return null;
    const parent = d.parent_id && q.item.get(d.parent_id) ? d.parent_id : null;
    const repeat = d.due_at ? T.cleanRepeat(d.repeat, d.due_at, tz) : null;
    // сфера: явно задана → вона; підзадача → як у батьківської; інакше — «Несортовані»
    const area = AREAS.includes(d.area) && d.area !== 'inbox' ? d.area : parent ? q.item.get(parent).area : 'inbox';
    const id = db.prepare(`INSERT INTO assistant_items (kind, text, due_at, msg_id, created, updated, project_id, priority, parent_id, repeat, area)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, text, d.due_at || null, msgId || null, t, t,
           d.project ? projectId(d.project) : (parent ? q.item.get(parent).project_id : null),
           Math.max(0, Math.min(2, Math.round(+d.priority || 0))), parent, J(repeat), area).lastInsertRowid;
    setTags(id, d.tags); reindexItem(id);
    logEvent(msgId, 'item', id, 'create', null, snapshot(id));
    return q.item.get(id);
  }

  // patch: text, due_at (null — прибрати строк), priority, project ('' — прибрати), parent_id, repeat (null — прибрати), tags, kind,
  //        area (разом із задачею переносяться й її підзадачі)
  function updateItem(id, patch, msgId, tz, action = 'update') {
    const before = snapshot(id); if (!before) return null;
    const it = { ...before.item };
    if (patch.text != null && str(patch.text)) it.text = str(patch.text);
    if (patch.kind && KINDS.includes(patch.kind)) it.kind = patch.kind;
    if (patch.due_at !== undefined) { it.due_at = patch.due_at || null; it.sent_at = null; }
    if (patch.priority != null) it.priority = Math.max(0, Math.min(2, Math.round(+patch.priority || 0)));
    if (patch.project !== undefined) it.project_id = patch.project ? projectId(patch.project) : null;
    if (patch.parent_id !== undefined) it.parent_id = patch.parent_id && patch.parent_id !== id && q.item.get(patch.parent_id) ? patch.parent_id : null;
    if (patch.repeat !== undefined) it.repeat = J(patch.repeat ? T.cleanRepeat(patch.repeat, it.due_at, tz) : null);
    if (patch.done_at !== undefined) it.done_at = patch.done_at;
    if (patch.area && AREAS.includes(patch.area)) it.area = patch.area;
    it.updated = now();
    db.prepare(`UPDATE assistant_items SET ${COLS.filter(c => c !== 'id').map(c => c + ' = ?').join(', ')} WHERE id = ?`)
      .run(...COLS.filter(c => c !== 'id').map(c => it[c] === undefined ? null : it[c]), id);
    if (patch.tags) setTags(id, patch.tags);
    if (patch.project !== undefined) pruneProjects();
    reindexItem(id);
    logEvent(msgId, 'item', id, action, before, snapshot(id));
    if (patch.area && it.area !== before.item.area) {
      for (const c of q.children.all(id)) if (q.item.get(c.id).area !== it.area) updateItem(c.id, { area: it.area }, msgId, tz, action);
    }
    return q.item.get(id);
  }

  // Виконати. Повторюваний запис не закривається, а переходить на наступний раз. Повертає { item, next }.
  function completeItem(id, msgId, tz) {
    const it = q.item.get(id); if (!it) return null;
    const rep = P(it.repeat);
    if (rep && it.due_at) {
      const next = T.nextOccurrence(it.due_at, rep, tz);
      if (next) return { item: updateItem(id, { due_at: next }, msgId, tz, 'complete'), next };
    }
    return { item: updateItem(id, { done_at: now() }, msgId, tz, 'complete'), next: null };
  }
  const reopenItem = (id, msgId, tz) => updateItem(id, { done_at: null }, msgId, tz, 'update');
  // Після надсилання повторюваного нагадування — одразу ставимо наступний раз
  function advanceAfterSend(id, tz) {
    const it = q.item.get(id), rep = it && P(it.repeat);
    if (!rep || !it.due_at) { db.prepare('UPDATE assistant_items SET sent_at = ? WHERE id = ?').run(now(), id); return null; }
    const next = T.nextOccurrence(it.due_at, rep, tz);
    if (!next) { db.prepare('UPDATE assistant_items SET sent_at = ? WHERE id = ?').run(now(), id); return null; }
    db.prepare('UPDATE assistant_items SET due_at = ?, sent_at = NULL, updated = ? WHERE id = ?').run(next, now(), id);
    return next;
  }
  function deleteItem(id, msgId) {
    const before = snapshot(id, true); if (!before) return null;
    db.prepare('DELETE FROM assistant_items WHERE id = ?').run(id);
    const gone = [id]; (function walk(s) { for (const c of s.children || []) { gone.push(c.item.id); walk(c); } })(before);
    for (const g of gone) q.ftsDel.run('item', g);
    pruneProjects();
    logEvent(msgId, 'item', id, 'delete', before, null);
    return before.item;
  }
  // Окремий одноразовий клон (наприклад, «+1 год» для повторюваного нагадування)
  function cloneOnce(id, dueAt, msgId, tz) {
    const s = snapshot(id); if (!s) return null;
    return createItem({ kind: 'reminder', text: s.item.text, due_at: dueAt, priority: s.item.priority,
                        project: s.item.project_id && q.project.get(s.item.project_id).name, tags: s.tags }, msgId, tz);
  }

  // ---------- щоденник стану й звички ----------
  function checkin(day, d, msgId) {
    const before = q.checkin.get(day) || null;
    const row = { mood: null, energy: null, sleep: null, note: null, ...(before || {}) };
    const n = (v, lo, hi) => v == null || v === '' || !Number.isFinite(+v) ? undefined : Math.max(lo, Math.min(hi, +v));
    const mood = n(d.mood, 1, 10), energy = n(d.energy, 1, 10), sleep = n(d.sleep, 0, 24);
    if (mood !== undefined) row.mood = Math.round(mood);
    if (energy !== undefined) row.energy = Math.round(energy);
    if (sleep !== undefined) row.sleep = Math.round(sleep * 10) / 10;
    if (str(d.note)) row.note = [before && before.note, str(d.note, 1000)].filter(Boolean).join(' · ').slice(0, 2000);
    db.prepare(`INSERT INTO assistant_checkins (day, mood, energy, sleep, note, updated) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(day) DO UPDATE SET mood = excluded.mood, energy = excluded.energy, sleep = excluded.sleep, note = excluded.note, updated = excluded.updated`)
      .run(day, row.mood, row.energy, row.sleep, row.note, now());
    const after = q.checkin.get(day);
    logEvent(msgId, 'checkin', day, 'checkin', before, after);
    return after;
  }
  function habit(name, day, done, msgId) {
    name = str(name, 50).toLowerCase(); if (!name) return null;
    let h = q.habitByName.get(name);
    if (!h) h = { id: db.prepare('INSERT INTO assistant_habits (name, created) VALUES (?, ?)').run(name, now()).lastInsertRowid, name };
    else if (h.archived) db.prepare('UPDATE assistant_habits SET archived = 0 WHERE id = ?').run(h.id);
    const was = !!q.habitLog.get(h.id, day);
    if (done && !was) db.prepare('INSERT INTO assistant_habit_log (habit_id, day) VALUES (?, ?)').run(h.id, day);
    if (!done && was) db.prepare('DELETE FROM assistant_habit_log WHERE habit_id = ? AND day = ?').run(h.id, day);
    logEvent(msgId, 'habit', `${h.id}:${day}`, 'habit', { done: was }, { done: !!done });
    return { id: h.id, name: h.name || name, done: !!done };
  }
  function state(days, tz) {
    const today = T.dayKey(now(), tz), from = T.addDays(today, -(days - 1));
    const checkins = Object.fromEntries(db.prepare('SELECT * FROM assistant_checkins WHERE day >= ?').all(from).map(r => [r.day, r]));
    const habits = db.prepare('SELECT * FROM assistant_habits WHERE archived = 0 ORDER BY name').all();
    const logs = db.prepare('SELECT habit_id, day FROM assistant_habit_log WHERE day >= ?').all(from);
    const list = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = T.addDays(today, -i), c = checkins[day] || {};
      list.push({ day, mood: c.mood ?? null, energy: c.energy ?? null, sleep: c.sleep ?? null, note: c.note || null,
                  habits: logs.filter(l => l.day === day).map(l => l.habit_id) });
    }
    const avg = k => { const v = list.map(x => x[k]).filter(x => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    return { from, to: today, days: list, habits: habits.map(h => ({ id: h.id, name: h.name, count: logs.filter(l => l.habit_id === h.id).length })),
             avg: { mood: avg('mood'), energy: avg('energy'), sleep: avg('sleep') } };
  }

  // ---------- скасування ----------
  // Скасовує всі ще не скасовані зміни одного повідомлення (у зворотному порядку). Повертає описи.
  function undoMessage(msgId) {
    const evs = db.prepare('SELECT * FROM assistant_events WHERE msg_id = ? AND undone_at IS NULL ORDER BY id DESC').all(msgId);
    const out = [];
    db.transaction(() => {
      for (const e of evs) {
        const before = P(e.before), after = P(e.after);
        if (e.kind === 'item') {
          const id = +e.ref;
          if (!before) { const s = snapshot(id); if (s) { db.prepare('DELETE FROM assistant_items WHERE id = ?').run(id); q.ftsDel.run('item', id); } out.push(`прибрано «${after.item.text}»`); }
          else { restore(before); out.push(e.action === 'delete' ? `повернуто «${before.item.text}»` : `відновлено «${before.item.text}»`); }
        } else if (e.kind === 'checkin') {
          if (before) db.prepare('INSERT OR REPLACE INTO assistant_checkins (day, mood, energy, sleep, note, updated) VALUES (?, ?, ?, ?, ?, ?)')
            .run(before.day, before.mood, before.energy, before.sleep, before.note, before.updated);
          else db.prepare('DELETE FROM assistant_checkins WHERE day = ?').run(e.ref);
          out.push('щоденник стану за ' + e.ref + ' відновлено');
        } else if (e.kind === 'habit') {
          const [hid, day] = e.ref.split(':');
          if (before.done) db.prepare('INSERT OR IGNORE INTO assistant_habit_log (habit_id, day) VALUES (?, ?)').run(+hid, day);
          else db.prepare('DELETE FROM assistant_habit_log WHERE habit_id = ? AND day = ?').run(+hid, day);
          out.push('звичку відновлено');
        }
        db.prepare('UPDATE assistant_events SET undone_at = ? WHERE id = ?').run(now(), e.id);
      }
      pruneProjects();
    })();
    return out;
  }
  // Останнє повідомлення, зміни якого ще можна скасувати
  const lastUndoable = (exceptMsgId) => (db.prepare(`SELECT msg_id FROM assistant_events WHERE msg_id IS NOT NULL AND undone_at IS NULL AND msg_id <> ?
                                                     ORDER BY id DESC LIMIT 1`).get(exceptMsgId || 0) || {}).msg_id || null;

  // ---------- повідомлення й пам'ять ----------
  function addMessage(text, source) {
    const id = db.prepare('INSERT INTO assistant_messages (at, source, text) VALUES (?, ?, ?)').run(now(), source, text).lastInsertRowid;
    q.ftsAdd.run(text, 'msg', id);
    return id;
  }
  const setReply = (id, reply) => db.prepare('UPDATE assistant_messages SET reply = ? WHERE id = ?').run(reply, id);
  // Кілька останніх реплік (для «а перенеси його на 5»): що сказано, що відповіли, які записи зачеплено
  function recentConversation(limit, sinceMs) {
    const msgs = db.prepare('SELECT * FROM assistant_messages WHERE at >= ? ORDER BY id DESC LIMIT ?').all(sinceMs, limit).reverse();
    for (const m of msgs) m.touched = db.prepare("SELECT DISTINCT ref, action FROM assistant_events WHERE msg_id = ? AND kind = 'item' AND undone_at IS NULL").all(m.id);
    return msgs;
  }
  function ftsQuery(text) {
    const words = (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= 2 && !STOP.has(w));
    return [...new Set(words)].slice(0, 10).map(w => `"${w.length > 5 ? w.slice(0, Math.max(4, w.length - 2)) : w}"*`).join(' OR ');
  }
  // Пошук по всьому: що казав власник (msg) і записи (item). Найрелевантніші, потім свіжіші.
  function search(text, { limit = 15, type } = {}) {
    const fq = ftsQuery(text); if (!fq) return [];
    let rows;
    try {
      rows = db.prepare(`SELECT ref_type, ref_id, bm25(assistant_fts) AS score FROM assistant_fts WHERE assistant_fts MATCH ?
                         ${type ? 'AND ref_type = ?' : ''} ORDER BY score LIMIT ?`).all(...[fq, ...(type ? [type] : []), limit * 2]);
    } catch (e) { return []; }
    const out = [];
    for (const r of rows) {
      if (r.ref_type === 'msg') {
        const m = db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(r.ref_id);
        if (m) out.push({ type: 'msg', id: m.id, at: m.at, text: m.text });
      } else {
        const it = q.item.get(r.ref_id);
        if (it) out.push({ type: 'item', id: it.id, at: it.created, kind: it.kind, text: it.text, done: !!it.done_at, due_at: it.due_at, tags: tagsOf(it.id) });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------- списки ----------
  const openItems = () => db.prepare(`SELECT * FROM assistant_items WHERE kind IN ('task', 'reminder') AND done_at IS NULL
                                      ORDER BY priority DESC, due_at IS NULL, due_at, id LIMIT 100`).all();
  const projects = () => db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM assistant_items i WHERE i.project_id = p.id AND i.done_at IS NULL AND i.kind != 'note') AS open
                                     FROM assistant_projects p WHERE p.archived = 0 ORDER BY p.name`).all();
  const habits = () => db.prepare('SELECT * FROM assistant_habits WHERE archived = 0 ORDER BY name').all();

  // ---------- задачі для сторінки: фільтри, сортування, сторінки ----------
  // f: { area: inbox|work|personal|all, view: open|today|overdue|week|nodate|done, q, project, prio, sort: smart|prio|created|alpha, offset, limit }
  // Повертає верхньорівневі задачі (з підзадачами в children) і загальну кількість для «Показати ще».
  const VIEWS = ['open', 'today', 'overdue', 'week', 'nodate', 'done'];
  function bounds(tz) {
    const t = now(), today = T.dayKey(t, tz);
    return { t, endToday: T.localToUtc(`${T.addDays(today, 1)}T00:00`, tz), endWeek: T.localToUtc(`${T.addDays(today, 7)}T00:00`, tz) };
  }
  function viewSql(view, b) {
    switch (view) {
      case 'today':   return { sql: 'i.done_at IS NULL AND i.due_at < ?', args: [b.endToday] };
      case 'overdue': return { sql: "i.done_at IS NULL AND i.due_at < ? AND NOT (i.kind = 'reminder' AND i.sent_at IS NOT NULL)", args: [b.t] };
      case 'week':    return { sql: 'i.done_at IS NULL AND i.due_at < ?', args: [b.endWeek] };
      case 'nodate':  return { sql: 'i.done_at IS NULL AND i.due_at IS NULL', args: [] };
      case 'done':    return { sql: 'i.done_at IS NOT NULL', args: [] };
      default:        return { sql: 'i.done_at IS NULL', args: [] };
    }
  }
  function taskWhere(f, b, { withView = true } = {}) {
    const w = ["i.kind IN ('task', 'reminder')", 'i.parent_id IS NULL'], args = [];
    if (AREAS.includes(f.area)) { w.push('i.area = ?'); args.push(f.area); }
    if (withView) { const v = viewSql(VIEWS.includes(f.view) ? f.view : 'open', b); w.push(v.sql); args.push(...v.args); }
    if (+f.project) { w.push('i.project_id = ?'); args.push(+f.project); }
    if (+f.prio) { w.push('i.priority >= ?'); args.push(+f.prio); }
    const text = str(f.q, 100).toLowerCase();
    if (text) {
      // шукаємо в тексті задачі, її підзадачах, проєкті й тегах (ulower — регістр кирилиці)
      const like = '%' + text.replace(/[%_\\]/g, c => '\\' + c) + '%';
      w.push(`(ulower(i.text) LIKE ?1 ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM assistant_items c WHERE c.parent_id = i.id AND ulower(c.text) LIKE ?1 ESCAPE '\\')
              OR EXISTS (SELECT 1 FROM assistant_projects p WHERE p.id = i.project_id AND ulower(p.name) LIKE ?1 ESCAPE '\\')
              OR EXISTS (SELECT 1 FROM assistant_item_tags x JOIN assistant_tags t ON t.id = x.tag_id WHERE x.item_id = i.id AND ulower(t.name) LIKE ?1 ESCAPE '\\'))`.replace(/\?1/g, '@like'));
      args.like = like;
    }
    return { sql: w.join(' AND '), args };
  }
  const bind = args => args.like ? [...args, { like: args.like }] : args;
  const ORDERS = {
    smart:   'i.due_at IS NULL, i.due_at, i.priority DESC, i.id DESC',
    prio:    'i.priority DESC, i.due_at IS NULL, i.due_at, i.id DESC',
    created: 'i.id DESC',
    alpha:   'ulower(i.text), i.id'
  };
  function listTasks(f, tz) {
    const b = bounds(tz), wh = taskWhere(f, b);
    const limit = Math.max(1, Math.min(200, +f.limit || 100)), offset = Math.max(0, +f.offset || 0);
    const order = f.view === 'done' ? 'i.done_at DESC' : (ORDERS[f.sort] || ORDERS.smart);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM assistant_items i WHERE ${wh.sql}`).get(...bind(wh.args)).n;
    const rows = db.prepare(`SELECT i.* FROM assistant_items i WHERE ${wh.sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(...bind(wh.args));
    const kids = {};
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const cs = db.prepare(`SELECT * FROM assistant_items WHERE parent_id IN (${ids.map(() => '?').join(',')})
                             AND (done_at IS NULL OR done_at > ? OR ?) ORDER BY done_at IS NOT NULL, due_at IS NULL, due_at, id`)
        .all(...ids, b.t - 7 * 864e5, f.view === 'done' ? 1 : 0);
      for (const c of cs) (kids[c.parent_id] = kids[c.parent_id] || []).push(view(c, tz));
    }
    return { total, offset, list: rows.map(r => ({ ...view(r, tz), children: kids[r.id] || [] })) };
  }
  // Лічильники: відкриті задачі в кожній сфері й розподіл за видами для поточної сфери (з урахуванням пошуку й фільтрів)
  function taskCounts(f, tz) {
    const b = bounds(tz);
    const areas = { inbox: 0, work: 0, personal: 0, all: 0 };
    for (const r of db.prepare(`SELECT area, COUNT(*) AS n FROM assistant_items WHERE kind IN ('task', 'reminder') AND parent_id IS NULL AND done_at IS NULL GROUP BY area`).all()) {
      areas[r.area] = r.n; areas.all += r.n;
    }
    const wh = taskWhere(f, b, { withView: false });
    const v = db.prepare(`SELECT
        SUM(i.done_at IS NULL) AS open,
        SUM(i.done_at IS NULL AND i.due_at < @endToday) AS today,
        SUM(i.done_at IS NULL AND i.due_at < @t AND NOT (i.kind = 'reminder' AND i.sent_at IS NOT NULL)) AS overdue,
        SUM(i.done_at IS NULL AND i.due_at < @endWeek) AS week,
        SUM(i.done_at IS NULL AND i.due_at IS NULL) AS nodate,
        SUM(i.done_at IS NOT NULL) AS done
      FROM assistant_items i WHERE ${wh.sql}`).get(...wh.args, { ...(wh.args.like ? { like: wh.args.like } : {}), endToday: b.endToday, t: b.t, endWeek: b.endWeek });
    const views = Object.fromEntries(VIEWS.map(k => [k, v[k] || 0]));
    return { areas, views };
  }

  return { item: id => q.item.get(id), view, tagsOf, createItem, updateItem, completeItem, reopenItem, advanceAfterSend, deleteItem, cloneOnce,
           checkin, habit, state, undoMessage, lastUndoable, addMessage, setReply, recentConversation, search, ftsQuery,
           openItems, projects, habits, project: id => q.project.get(id), P, listTasks, taskCounts, AREAS };
};
