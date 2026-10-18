// Ритуали дня: повторювані короткі завдання з фото чи відео («зарядка», «зарядка для очей», «склянка води»).
// Кожен ритуал має свій розклад — певні години або «кожні N хвилин з … до …», — і дні тижня.
// У потрібний час приходить сповіщення (push із великою картинкою, Telegram із фото/відео й кнопками),
// а в застосунку відкривається екран виконання: медіа, кроки з таймером, «Зроблено / +15 хв / Пропустити».
// Файли медіа лежать у DATA_DIR/media під випадковими іменами й віддаються за адресою /m/<імʼя>
// без входу (Telegram і сповіщення забирають їх за посиланням), тож імена неможливо вгадати.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { send, readBody } = require('./util');

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MEDIA_TYPES = ['image', 'video', 'youtube', 'link', 'eyes', 'water', 'breath'];
const BUILTIN = ['eyes', 'water', 'breath'];            // анімації, що малюються в застосунку
const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
               'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const CTYPE = Object.fromEntries(Object.entries(MIME).map(([k, v]) => [v, k]));
const MAX_UPLOAD = 60 * 1024 * 1024;
const LATER_MIN = 15, GRACE_MIN = 30;                 // «пізніше» — через 15 хв; раз, пропущений більше ніж на 30 хв, не надсилаємо
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const P = s => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } };
const toMin = hm => +hm.slice(0, 2) * 60 + +hm.slice(3);
const toHm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Готові ритуали — стартова точка; усе редагується (свої фото, відео, час)
const TEMPLATES = [
  { key: 'morning', icon: '🤸', title: 'Ранкова зарядка', body: '10 хвилин, щоб прокинутись. Рухайся у своєму темпі.',
    times: ['08:00'], steps: [['Обертання головою', 30], ['Кола плечима вперед і назад', 30], ['Нахили в сторони', 40], ['Присідання — 15 разів', 45],
      ['Віджимання від стіни — 10 разів', 40], ['Планка', 30], ['Глибоке дихання', 30]] },
  { key: 'eyes', icon: '👁', title: 'Зарядка для очей', body: 'Відведи погляд від екрана й стеж за крапкою. Голова нерухома.',
    every: 120, from: '10:00', to: '18:00', days: [1, 2, 3, 4, 5], media: [{ type: 'eyes' }],
    steps: [['Погляд вліво-вправо', 20], ['Погляд вгору-вниз', 20], ['Кола очима', 20], ['Подивись удалину, потім на кінчик носа', 30],
      ['Часто поморгай', 15], ['Закрий очі й розслабся', 20]] },
  { key: 'water', icon: '💧', title: 'Склянка води', body: 'Випий склянку води — 250 мл.', every: 120, from: '09:00', to: '21:00', media: [{ type: 'water' }] },
  { key: 'back', icon: '🧘', title: 'Розтяжка спини', body: 'Встань з-за столу на 3 хвилини.', times: ['12:30', '16:30'], days: [1, 2, 3, 4, 5],
    steps: [['Потягнись руками вгору', 20], ['Нахил уперед, руки вільно вниз', 30], ['Скручування стоячи — в кожен бік', 40], ['Нахили голови до плечей', 30],
      ['Зведи лопатки й розслаб', 20]] },
  { key: 'breath', icon: '🌬', title: 'Дихання 4-7-8', body: 'Вдих 4 с, затримка 7 с, видих 8 с. Чотири цикли — і стрес знижується.',
    times: ['21:30'], media: [{ type: 'breath' }], steps: [['Чотири цикли дихання', 76]] }
];

module.exports = function makeRoutines(db, { load, bot, push, T, mediaBase = '/m/', signMedia = u => u }) {
  const MEDIA_DIR = path.join(path.dirname(db.file), 'media');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const now = () => Date.now();
  const pub = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  // власні файли окремої бази віддаються лише за сесією або підписаним посиланням (signMedia) — для Telegram і сповіщень
  const abs = u => u && u.startsWith('/') ? pub() + (u.startsWith(mediaBase) ? signMedia(u) : u) : u;

  // ---------- розклад ----------
  function slotsOf(r) {
    const times = P(r.times);
    if (Array.isArray(times) && times.length) return [...new Set(times.filter(x => HM.test(x)))].sort();
    if (r.every && HM.test(r.from_hm || '') && HM.test(r.to_hm || '')) {
      const out = [];
      for (let m = toMin(r.from_hm); m <= toMin(r.to_hm) && out.length < 96; m += r.every) out.push(toHm(m));
      return out;
    }
    return [];
  }
  const daysOf = r => { const d = P(r.days); return Array.isArray(d) && d.length && d.length < 7 ? d : null; };
  const activeOn = (r, day) => { const d = daysOf(r); return !d || d.includes(T.isoWeekday(day)); };
  function scheduleText(r) {
    const d = daysOf(r), DW = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
    const days = !d ? 'щодня' : d.join() === '1,2,3,4,5' ? 'пн–пт' : d.join() === '6,7' ? 'сб, нд' : d.map(x => DW[x]).join(', ');
    const times = P(r.times);
    if (Array.isArray(times) && times.length) return `${days} · ${slotsOf(r).join(', ')}`;
    const ev = r.every < 60 || r.every % 30 ? `${r.every} хв` : `${String(r.every / 60).replace('.', ',')} год`;
    return `${days} · кожні ${ev}, ${r.from_hm}–${r.to_hm}`;
  }
  // останній раз за розкладом, що вже настав сьогодні (або null)
  function dueSlot(r, t, tz) {
    const day = T.dayKey(t, tz); if (!activeOn(r, day)) return null;
    const hm = T.hhmm(t, tz), s = slotsOf(r).filter(x => x <= hm);
    return s.length ? { day, slot: s[s.length - 1] } : null;
  }

  // ---------- подання ----------
  const logFor = (id, day) => Object.fromEntries(db.prepare('SELECT slot, status FROM routine_log WHERE routine_id = ? AND day = ?').all(id, day).map(x => [x.slot, x.status]));
  function view(r, tz) {
    const t = now(), day = T.dayKey(t, tz), hm = T.hhmm(t, tz), log = logFor(r.id, day);
    // рази, що минули ще до створення ритуалу, не рахуються «пропущеними»
    const born = T.dayKey(r.created, tz) === day ? T.hhmm(r.created, tz) : '';
    const on = !!r.active && activeOn(r, day), slots = on ? slotsOf(r).filter(s => s >= born) : [];
    // відмітки «зроблено» поза розкладом (натиснув сам) теж рахуються
    const extra = Object.keys(log).filter(s => !slots.includes(s));
    const today = [...slots, ...extra].sort().map(s => ({ slot: s, status: log[s] || (s <= hm ? 'missed' : 'planned') }));
    const pending = today.filter(x => x.status === 'sent').pop();
    return {
      id: r.id, title: r.title, icon: r.icon, body: r.body || '', steps: P(r.steps) || [], media: P(r.media) || [],
      times: P(r.times) || [], every: r.every || null, from: r.from_hm || null, to: r.to_hm || null, days: daysOf(r),
      active: !!r.active, position: r.position, schedule: scheduleText(r),
      today, done: Math.min(slots.length || Infinity, today.filter(x => x.status === 'done').length), total: slots.length,
      next: slots.find(s => s > hm) || null, pending: pending ? pending.slot : null, snoozeAt: r.snooze_at || null
    };
  }
  const row = id => db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
  const list = tz => db.prepare('SELECT * FROM routines ORDER BY active DESC, position, id').all().map(r => view(r, tz));

  // ---------- збереження ----------
  function clean(b, old) {
    const v = {};
    if (!old || b.title !== undefined) { v.title = str(b.title, 80); if (!v.title) throw new Error('Назва ритуалу обовʼязкова.'); }
    if (b.icon !== undefined) v.icon = str(b.icon, 8) || '✨';
    if (b.body !== undefined) v.body = str(b.body, 1000) || null;
    if (b.steps !== undefined) {
      v.steps = JSON.stringify((Array.isArray(b.steps) ? b.steps : []).slice(0, 20)
        .map(x => ({ text: str(x && x.text, 200), sec: Math.max(0, Math.min(3600, Math.round(+(x && x.sec) || 0))) })).filter(x => x.text));
    }
    if (b.media !== undefined) {
      v.media = JSON.stringify((Array.isArray(b.media) ? b.media : []).slice(0, 6).filter(m => m && MEDIA_TYPES.includes(m.type)).map(m => {
        if (BUILTIN.includes(m.type)) return { type: m.type };
        const url = str(m.url, 1000);
        const own = url.startsWith(mediaBase) && /^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test(url.slice(mediaBase.length));
        if (!own && !/^https:\/\//.test(url)) throw new Error('Посилання на медіа має починатися з https://');
        if (m.type === 'video' && !own) throw new Error('Відео — завантажте файлом або дайте посилання на YouTube.');
        return { type: m.type, url, name: str(m.name, 120) || undefined };
      }));
    }
    if (b.times !== undefined || b.every !== undefined) {
      const times = Array.isArray(b.times) ? [...new Set(b.times.filter(x => HM.test(x)))].sort().slice(0, 24) : [];
      if (times.length) { v.times = JSON.stringify(times); v.every = null; v.from_hm = null; v.to_hm = null; }
      else {
        const every = Math.round(+b.every || 0);
        if (every < 15 || every > 720) throw new Error('Вкажіть час або інтервал від 15 хвилин до 12 годин.');
        if (!HM.test(b.from || '') || !HM.test(b.to || '') || b.from >= b.to) throw new Error('Інтервал: «з» має бути раніше за «до».');
        Object.assign(v, { times: null, every, from_hm: b.from, to_hm: b.to });
      }
    }
    if (b.days !== undefined) {
      const d = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(x => x >= 1 && x <= 7))].sort() : [];
      if (Array.isArray(b.days) && !d.length) throw new Error('Оберіть хоча б один день.');
      v.days = d.length && d.length < 7 ? JSON.stringify(d) : null;
    }
    if (b.active !== undefined) v.active = b.active ? 1 : 0;
    if (b.position !== undefined && Number.isFinite(+b.position)) v.position = +b.position;
    if (!old && v.times === undefined && v.every === undefined) throw new Error('Вкажіть, коли нагадувати.');
    return v;
  }
  // щойно створений або змінений ритуал не має «вистрілити» за раз, що вже минув
  function markPast(id, tz) {
    const r = row(id), d = dueSlot(r, now(), tz);
    db.prepare('UPDATE routines SET last_slot = ? WHERE id = ?').run(d ? `${d.day} ${d.slot}` : r.last_slot, id);
  }
  function create(b, tz) {
    const tpl = b.template && TEMPLATES.find(x => x.key === b.template);
    const src = tpl ? { title: tpl.title, icon: tpl.icon, body: tpl.body, steps: (tpl.steps || []).map(([text, sec]) => ({ text, sec })), media: tpl.media || [],
                        times: tpl.times, every: tpl.every, from: tpl.from, to: tpl.to, days: tpl.days || [1, 2, 3, 4, 5, 6, 7] } : b;
    const v = { icon: '✨', body: null, steps: '[]', media: '[]', days: null, active: 1, ...clean(src, null) };
    const t = now(), pos = (db.prepare('SELECT MAX(position) AS p FROM routines').get().p ?? 0) + 1;
    const id = db.prepare(`INSERT INTO routines (title, icon, body, steps, media, times, every, from_hm, to_hm, days, active, position, created, updated)
                           VALUES (@title, @icon, @body, @steps, @media, @times, @every, @from_hm, @to_hm, @days, @active, @pos, @t, @t)`)
      .run({ times: null, every: null, from_hm: null, to_hm: null, ...v, pos, t }).lastInsertRowid;
    markPast(id, tz);
    return row(id);
  }
  function update(id, b, tz) {
    const old = row(id); if (!old) return null;
    const v = clean(b, old); if (!Object.keys(v).length) return old;
    db.prepare(`UPDATE routines SET ${Object.keys(v).map(k => `${k} = @${k}`).join(', ')}, updated = @t WHERE id = @id`).run({ ...v, t: now(), id });
    if (v.times !== undefined || v.every !== undefined || v.days !== undefined || v.active) markPast(id, tz);
    if (v.media !== undefined) cleanupMedia();
    return row(id);
  }
  function remove(id) { db.prepare('DELETE FROM routines WHERE id = ?').run(id); cleanupMedia(); }

  // ---------- відмітки ----------
  // Поточний раз: надісланий і ще без відповіді → останній, що настав → «зараз» (поза розкладом)
  function currentSlot(r, tz) {
    const t = now(), day = T.dayKey(t, tz);
    if (r.snooze_slot && r.snooze_slot.startsWith(day)) return { day, slot: r.snooze_slot.slice(11) };
    const sent = db.prepare("SELECT slot FROM routine_log WHERE routine_id = ? AND day = ? AND status = 'sent' ORDER BY slot DESC LIMIT 1").get(r.id, day);
    if (sent) return { day, slot: sent.slot };
    const d = dueSlot(r, t, tz);
    if (d && !db.prepare('SELECT 1 FROM routine_log WHERE routine_id = ? AND day = ? AND slot = ?').get(r.id, d.day, d.slot)) return d;
    return { day, slot: T.hhmm(t, tz) };
  }
  function mark(id, action, tz) {
    const r = row(id); if (!r) return null;
    const c = currentSlot(r, tz);
    if (action === 'later') {
      db.prepare('UPDATE routines SET snooze_at = ?, snooze_slot = ? WHERE id = ?').run(now() + LATER_MIN * 60e3, `${c.day} ${c.slot}`, id);
      return `⏱ Нагадаю через ${LATER_MIN} хв`;
    }
    db.prepare(`INSERT INTO routine_log (routine_id, day, slot, status, at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(routine_id, day, slot) DO UPDATE SET status = excluded.status, at = excluded.at`).run(id, c.day, c.slot, action === 'done' ? 'done' : 'skip', now());
    db.prepare('UPDATE routines SET snooze_at = NULL, snooze_slot = NULL WHERE id = ?').run(id);
    if (action !== 'done') return '⏭ Пропущено';
    const v = view(row(id), tz);
    return `✅ Зроблено${v.total > 1 ? ` · ${v.done} з ${v.total} сьогодні` : ''}`;
  }

  // ---------- надсилання ----------
  const fmtSec = s => s >= 60 ? `${Math.floor(s / 60)} хв${s % 60 ? ' ' + (s % 60) + ' с' : ''}` : `${s} с`;
  async function deliver(r, slot, day) {
    const v = view(r, load().tz), first = v.media[0], https = /^https:\/\//.test(pub());
    const caption = `${r.icon} ${r.title}` + (v.body ? `\n${v.body}` : '') +
      (v.steps.length ? '\n\n' + v.steps.map((x, i) => `${i + 1}. ${x.text}${x.sec ? ' — ' + fmtSec(x.sec) : ''}`).join('\n') : '');
    let n = 0;
    if (bot.ready()) {
      const m = first && (first.type === 'image' || first.type === 'video') ? (https || /^https:/.test(first.url) ? { type: first.type, url: abs(first.url) } : null)
              : first && (first.type === 'youtube' || first.type === 'link') ? first : null;
      if (await bot.sendRoutine(r, caption, m, https ? `${pub()}/assistant/#/r/${r.id}` : '')) n++;
    }
    if (push.has()) {
      const img = v.media.find(x => x.type === 'image');
      const body = v.body || (v.steps.length ? v.steps.slice(0, 3).map(x => x.text).join(' · ') : 'Час для ритуалу');
      n += await push.sendRoutine(r, body, img ? abs(img.url) : null);
    }
    db.prepare("INSERT OR IGNORE INTO routine_log (routine_id, day, slot, status, at) VALUES (?, ?, ?, 'sent', ?)").run(r.id, day, slot, now());
    return n;
  }
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const tz = load().tz, t = now();
      for (const r of db.prepare('SELECT * FROM routines WHERE active = 1').all()) {
        if (r.snooze_at && r.snooze_at <= t) {
          db.prepare('UPDATE routines SET snooze_at = NULL WHERE id = ?').run(r.id);
          const [day, slot] = (r.snooze_slot || '').split(' ');
          const st = day && db.prepare('SELECT status FROM routine_log WHERE routine_id = ? AND day = ? AND slot = ?').get(r.id, day, slot);
          if (!st || st.status === 'sent') await deliver(r, slot || T.hhmm(t, tz), day || T.dayKey(t, tz)).catch(e => console.error('[routines]', e.message));
          continue;
        }
        const d = dueSlot(r, t, tz); if (!d) continue;
        const key = `${d.day} ${d.slot}`;
        if (r.last_slot && r.last_slot >= key) continue;
        db.prepare('UPDATE routines SET last_slot = ? WHERE id = ?').run(key, r.id);   // фіксуємо до надсилання — двічі не прийде
        if (toMin(T.hhmm(t, tz)) - toMin(d.slot) > GRACE_MIN) continue;                 // сервер стояв — старе не надсилаємо
        if (db.prepare('SELECT 1 FROM routine_log WHERE routine_id = ? AND day = ? AND slot = ?').get(r.id, d.day, d.slot)) continue;   // вже зроблено вручну
        await deliver(r, d.slot, d.day).catch(e => console.error('[routines]', e.message));
      }
    } finally { busy = false; }
  }
  // для підсумку дня
  function todayLines() {
    const tz = load().tz;
    return list(tz).filter(r => r.active && r.total).map(r => `- ${r.title}: ${r.done} з ${r.total}`);
  }

  // ---------- медіа ----------
  function cleanupMedia() {
    const used = new Set();
    for (const r of db.prepare('SELECT media FROM routines').all()) for (const m of P(r.media) || []) if (m.url && m.url.startsWith(mediaBase)) used.add(m.url.slice(mediaBase.length));
    const old = now() - 864e5;   // щойно завантажене, але ще не збережене в ритуалі, не чіпаємо
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      if (used.has(f) || f.startsWith('.')) continue;
      try { if (fs.statSync(path.join(MEDIA_DIR, f)).mtimeMs < old) fs.unlinkSync(path.join(MEDIA_DIR, f)); } catch (e) {}
    }
  }
  function upload(req, res) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), ext = MIME[type];
    if (!ext) return send(res, 415, { error: 'Підтримуються фото (JPG, PNG, WebP, GIF) і відео (MP4, WebM, MOV).' });
    if (+req.headers['content-length'] > MAX_UPLOAD) return send(res, 413, { error: 'Файл завеликий — до 60 МБ.' });
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext, file = path.join(MEDIA_DIR, name), tmp = file + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (code, error) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, () => {}); if (!res.headersSent) send(res, code, { error }); };
    req.on('data', c => { size += c.length; if (size > MAX_UPLOAD) { fail(413, 'Файл завеликий — до 60 МБ.'); req.destroy(); } });
    req.on('error', () => fail(400, 'Завантаження перервано.'));
    out.on('error', () => fail(500, 'Не вдалося зберегти файл.'));
    out.on('finish', () => {
      if (failed) return;
      if (size < 100) return fail(400, 'Порожній файл.');
      fs.rename(tmp, file, e => e ? fail(500, 'Не вдалося зберегти файл.')
        : send(res, 200, { url: mediaBase + name, type: type.startsWith('video') ? 'video' : 'image', size }));
    });
    req.pipe(out);
  }
  // GET /m/<імʼя> — з підтримкою Range (перемотування відео)
  function serveMedia(req, res, url) {
    const m = url.startsWith(mediaBase) ? /^([a-f0-9]{32}\.([a-z0-9]{2,4}))$/.exec(url.slice(mediaBase.length)) : null;
    if (!m || !CTYPE[m[2]]) { res.writeHead(404); return res.end(); }
    const file = path.join(MEDIA_DIR, m[1]);
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404); return res.end(); }
      const headers = { 'Content-Type': CTYPE[m[2]], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? +range[2] : st.size - 1;
        if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // ---------- API /api/routines/* ----------
  async function handle(req, res, url) {
    const m = req.method, tz = load().tz;
    if (url === '/api/routines' && m === 'GET') {
      return send(res, 200, { list: list(tz), templates: TEMPLATES.map(t => ({ key: t.key, icon: t.icon, title: t.title, body: t.body })) });
    }
    if (url === '/api/routines' && m === 'POST') {
      const b = await readBody(req, 65536); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      try { return send(res, 200, view(create(b, tz), tz)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (url === '/api/routines/media' && m === 'POST') return upload(req, res);
    const mm = /^\/api\/routines\/(\d+)(?:\/(done|skip|later|send))?$/.exec(url);
    if (!mm) return send(res, 404, { error: 'Не знайдено.' });
    const id = +mm[1], r = row(id), sub = mm[2];
    if (!r) return send(res, 404, { error: 'Ритуал не знайдено.' });
    if (!sub && m === 'GET') return send(res, 200, view(r, tz));
    if (!sub && m === 'PATCH') {
      const b = await readBody(req, 65536); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      try { return send(res, 200, view(update(id, b, tz), tz)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (!sub && m === 'DELETE') { remove(id); return send(res, 200, { ok: true }); }
    if (sub === 'send' && m === 'POST') {
      const n = await deliver(r, T.hhmm(now(), tz), T.dayKey(now(), tz));
      return send(res, 200, { sent: n, text: n ? 'Надіслано' : 'Немає куди надсилати: увімкніть сповіщення або привʼяжіть Telegram.' });
    }
    if (sub && m === 'POST') { const text = mark(id, sub, tz); return send(res, 200, { text, routine: view(row(id), tz) }); }
    return send(res, 405, { error: 'Метод не підтримується.' });
  }
  // кнопки в push-сповіщенні: rdone / rlater
  function pushAction(id, action, res) {
    if (!row(id)) return send(res, 404, { error: 'Ритуал не знайдено.' });
    const a = { rdone: 'done', rlater: 'later', rskip: 'skip' }[action];
    if (!a) return send(res, 400, { error: 'Невідома дія.' });
    return send(res, 200, { ok: true, text: mark(id, a, load().tz) });
  }
  bot.onRoutine((id, action) => mark(id, action, load().tz) || 'Ритуал уже видалено');

  // ритуал з повідомлення асистенту («нагадуй пити воду кожні 2 години з 9 до 21»)
  const add = b => { const tz = load().tz; return view(create(b, tz), tz); };
  return { handle, tick, serveMedia, pushAction, todayLines, list, add, TEMPLATES };
};
