// Персональний асистент власника (сторінка /assistant + Telegram-бот).
// Текст (розшифрований голос або набраний) → Claude (агент з інструментами) → дії над записами в базі.
//   Інструменти Claude: search_memory (пошук по всьому, що казав власник), get_state (настрій/сон/звички),
//   save_actions (фінальний: створити/змінити/виконати/видалити/скасувати записи, щоденник стану).
// Дані — через lib/assistant-store.js (журнал змін, скасування, пошук), час — lib/assistant-time.js.
// Нагадування, ранковий план і підсумок дня надсилаються в Telegram (lib/telegram.js).
// Ключ Claude API й токен бота — у таблиці meta (assistant_settings), у браузер не віддаються.
const crypto = require('crypto');
const T = require('./assistant-time');
const { send, readBody } = require('./util');

const KEY = 'assistant_settings';
const DEFAULTS = {
  anthropicKey: '', model: 'claude-haiku-5-5',
  botToken: '', botName: '', chatId: null, linkCode: '',
  tz: 'Europe/Kyiv', voiceLang: 'uk',
  summaryTime: '21:00', summaryOn: true, lastSummaryDay: '',
  morningTime: '08:00', morningOn: true, lastMorningDay: ''
};
const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const str = (v, max = 2000) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const newCode = () => crypto.randomBytes(6).toString('hex');
const PRIO = ['', '❗', '‼️'];

// ---------- інструменти Claude ----------
const REPEAT_SCHEMA = {
  type: 'object', description: 'Повтор: щодня / щотижня (у вказані дні) / щомісяця / щороку',
  properties: {
    freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: 'integer', description: 'Кожні N періодів, за замовчуванням 1' },
    days: { type: 'array', items: { type: 'integer' }, description: 'Для weekly: дні тижня, пн=1 … нд=7' }
  },
  required: ['freq']
};
const TOOLS = [
  {
    name: 'search_memory',
    description: 'Пошук по всьому, що власник колись казав чи записував (повідомлення, нотатки, задачі, зокрема виконані). Використовуй, коли питають про минуле («що я казав про…», «коли я був…», «які ідеї щодо…») або коли треба знайти запис, якого немає в списку відкритих.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Ключові слова, 1–6 слів' },
      only: { type: 'string', enum: ['all', 'messages', 'notes', 'tasks'], description: 'Що шукати, за замовчуванням all' }
    }, required: ['query'] }
  },
  {
    name: 'get_state',
    description: 'Щоденник стану за останні N днів: настрій, енергія (1–10), сон (год), звички по днях, середні значення. Для питань «як я спав цього тижня», «скільки разів робив зарядку».',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: '1–60, за замовчуванням 7' } } }
  },
  {
    name: 'save_actions',
    description: 'Фінальний крок: зберегти дії з повідомлення й відповідь власнику. Викликай завжди рівно один раз наприкінці.',
    input_schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Дії в порядку згадування. Порожній масив, якщо діяти не треба (питання, розмова).',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['reminder', 'task', 'note', 'complete', 'reopen', 'update', 'delete', 'checkin', 'undo'],
                description: 'reminder — нагадати в конкретний час; task — справа (можна зі строком); note — думка/ідея/запис у щоденник; complete — виконано; reopen — повернути у невиконані; update — змінити наявний запис; delete — видалити; checkin — стан за день (настрій, енергія, сон, звички); undo — скасувати попередню дію помічника' },
              id: { type: 'integer', description: 'Для complete / reopen / update / delete — id запису' },
              text: { type: 'string', description: 'Суть коротко, мовою власника, без «нагадай»/«додай». Для note — повна думка, підчищена від слів-паразитів. Для update — новий текст, якщо його змінюють.' },
              at: { type: 'string', description: 'Місцевий час YYYY-MM-DDTHH:MM: для reminder обовʼязково; для task — строк; для update — новий час/строк' },
              clear_at: { type: 'boolean', description: 'Для update: прибрати строк/час' },
              kind: { type: 'string', enum: ['task', 'reminder'], description: 'Для update: перетворити задачу на нагадування чи навпаки' },
              priority: { type: 'integer', description: '0 звичайна, 1 важлива, 2 термінова. Лише якщо власник це сказав або очевидно' },
              project: { type: 'string', description: 'Назва проєкту (наявного зі списку або нового), якщо власник його згадав. Порожній рядок в update — прибрати з проєкту' },
              parent_id: { type: 'integer', description: 'Для підзадачі — id батьківської задачі' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Для note: 1–3 теги в нижньому регістрі' },
              repeat: REPEAT_SCHEMA,
              stop_repeat: { type: 'boolean', description: 'Для update: прибрати повтор' },
              day: { type: 'string', description: 'Для checkin: дата YYYY-MM-DD, якщо не сьогодні («вчора спав…»)' },
              mood: { type: 'number', description: 'checkin: настрій 1–10' },
              energy: { type: 'number', description: 'checkin: енергія 1–10' },
              sleep: { type: 'number', description: 'checkin: години сну' },
              note: { type: 'string', description: 'checkin: коротко, як минув день / що вплинуло на стан' },
              habits: { type: 'array', description: 'checkin: звички за день', items: { type: 'object', properties: {
                name: { type: 'string', description: 'Назва звички в нижньому регістрі; використовуй наявну зі списку, якщо підходить' },
                done: { type: 'boolean' } }, required: ['name', 'done'] } }
            },
            required: ['type']
          }
        },
        reply: { type: 'string', description: 'Відповідь власнику 0–4 речення мовою його повідомлення. Не перелічуй збережені дії (їх покаже система). Тут — відповідь на питання (зокрема за результатами пошуку), уточнення, коротка підтримка.' }
      },
      required: ['actions', 'reply']
    }
  }
];

let instance = null;
module.exports = { get: db => instance || (instance = make(db)) };

function make(db) {
  const store = require('./assistant-store')(db);

  // ---------- налаштування ----------
  function load() {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
    let s = {}; try { s = row ? JSON.parse(row.value) : {}; } catch (e) {}
    return { ...DEFAULTS, ...s };
  }
  function save(s) { db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(s)); }
  function update(patch) { const s = { ...load(), ...patch }; save(s); return s; }

  // ---------- Claude ----------
  async function claude(s, body) {
    if (!s.anthropicKey) throw new Error('Не задано ключ Claude API (вкладка «Налаштування»).');
    let r;
    try {
      r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: s.model, ...body }), signal: AbortSignal.timeout(90e3)
      });
    } catch (e) { throw new Error('Claude API недоступний: ' + (e.name === 'TimeoutError' ? 'немає відповіді' : e.message)); }
    let data = null; try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      if (r.status === 401) throw new Error('Ключ Claude API неправильний або відкликаний.');
      if (r.status === 400 && /credit|balance/i.test(data && data.error && data.error.message || '')) throw new Error('На балансі Claude API закінчились кошти.');
      throw new Error('Claude API: ' + (data && data.error && data.error.message || `HTTP ${r.status}`));
    }
    return data;
  }

  // ---------- опис записів для Claude ----------
  function itemLine(it, tz) {
    const v = store.view(it, tz), bits = [];
    if (v.project) bits.push('проєкт ' + v.project);
    if (v.priority) bits.push(v.priority === 2 ? 'термінова' : 'важлива');
    if (v.due_at) bits.push((v.kind === 'task' ? 'строк ' : 'час ') + T.localIso(v.due_at, tz).replace('T', ' '));
    if (v.repeatText) bits.push('повтор: ' + v.repeatText);
    if (v.parent_id) bits.push('підзадача #' + v.parent_id);
    if (v.sent) bits.push('вже надіслано');
    return `#${v.id} [${v.kind === 'task' ? 'задача' : 'нагадування'}] ${v.text}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`;
  }
  function systemPrompt(s, msgId) {
    const tz = s.tz, t = Date.now(), p = T.parts(t, tz), today = T.dayKey(t, tz);
    const open = store.openItems(), projects = store.projects(), habits = store.habits();
    const convo = store.recentConversation(7, t - 3 * 3600e3).filter(m => m.id !== msgId);
    const ci = db.prepare('SELECT * FROM assistant_checkins WHERE day = ?').get(today);
    return [
      'Ти — особистий помічник власника. Він диктує або пише короткі повідомлення українською чи російською; розшифровки голосу можуть містити помилки розпізнавання — розумій за змістом.',
      'Перетвори повідомлення на дії. Якщо питають про минуле або потрібен запис, якого немає нижче, — спершу search_memory; про самопочуття за період — get_state. Наприкінці завжди виклич save_actions.',
      `Зараз: ${T.WD[p.wd]}, ${T.localIso(t, tz).replace('T', ' ')} (${tz}).`,
      'Правила:',
      '- «нагадай …» з часом або днем → reminder з точним at. Лише день — 09:00. «Вранці» 09:00, «вдень» 13:00, «після обіду» 15:00, «ввечері» 19:00, «через годину» = зараз + 1 год. Якщо названий час сьогодні вже минув — наступний такий день.',
      '- «щодня / щопонеділка / кожного 1-го числа …» → reminder (або task) з repeat і at = найближчий раз.',
      '- Справа без часу нагадування → task; at — лише якщо назвали строк. Проєкт і пріоритет — лише якщо власник їх згадав («для сайту», «терміново», «важливо»).',
      '- «У задачу X додай …» → task з parent_id = id задачі X.',
      '- Думки, ідеї, враження, «запиши …» без дії → note з тегами.',
      '- «Зробив / купив / готово …» → complete; «перенеси / зміни / перейменуй / зроби важливим …» → update; «видали / скасуй задачу …» → delete; «скасуй останнє / не те записав / відміни» → undo.',
      '- Згадки про стан («настрій 7», «спав 6 годин», «втомився», «зробив зарядку») → checkin. Оцінку настрою/енергії виставляй лише якщо названо число або дуже явно.',
      '- «Його / її / це / туди» — найімовірніше про записи з останніх реплік нижче.',
      '- Одне повідомлення може містити кілька дій. Нічого не вигадуй і не дублюй записи, які вже є.',
      '- Текст дій — мовою власника, коротко й зрозуміло; виправ очевидні помилки розпізнавання.',
      open.length ? 'Відкриті задачі й нагадування:\n' + open.map(it => itemLine(it, tz)).join('\n') : 'Відкритих задач і нагадувань немає.',
      projects.length ? 'Проєкти: ' + projects.map(x => x.name).join(', ') : 'Проєктів ще немає.',
      habits.length ? 'Звички, які власник відстежує: ' + habits.map(h => h.name).join(', ') : '',
      ci ? `Стан сьогодні вже записано: настрій ${ci.mood ?? '—'}, енергія ${ci.energy ?? '—'}, сон ${ci.sleep ?? '—'}.` : '',
      convo.length ? 'Останні репліки (для контексту):\n' + convo.map(m =>
        `[${T.hhmm(m.at, tz)}] Власник: «${m.text.slice(0, 300)}»` + (m.reply ? `\n   Помічник: ${m.reply.replace(/\n/g, ' | ').slice(0, 300)}` : '') +
        (m.touched.length ? `\n   Зачеплені записи: ${m.touched.map(x => '#' + x.ref).join(', ')}` : '')).join('\n') : ''
    ].filter(Boolean).join('\n');
  }

  // ---------- інструменти пошуку для Claude ----------
  function runTool(name, input, tz, msgId) {
    if (name === 'search_memory') {
      const map = { messages: 'msg', notes: 'item', tasks: 'item' };
      // саме поточне запитання в результатах не потрібне
      // поточне повідомлення й минулі запитання (фактів у них немає) Claude не потрібні
      let res = store.search(str(input.query, 200), { limit: 20, type: map[input.only] })
        .filter(r => !(r.type === 'msg' && (r.id === msgId || /\?\s*$/.test(r.text)))).slice(0, 15);
      if (input.only === 'notes') res = res.filter(r => r.kind === 'note');
      if (input.only === 'tasks') res = res.filter(r => r.kind && r.kind !== 'note');
      if (!res.length) return 'Нічого не знайдено.';
      return res.map(r => r.type === 'msg'
        ? `[${T.localIso(r.at, tz).replace('T', ' ')}] сказав: «${r.text.slice(0, 400)}»`
        : `#${r.id} [${{ note: 'нотатка', task: 'задача', reminder: 'нагадування' }[r.kind]}${r.done ? ', виконано' : ''}] ${T.localIso(r.at, tz).slice(0, 10)}: ${r.text.slice(0, 400)}${r.tags.length ? ' #' + r.tags.join(' #') : ''}`).join('\n');
    }
    if (name === 'get_state') {
      const st = store.state(Math.max(1, Math.min(60, +input.days || 7)), tz);
      const names = Object.fromEntries(st.habits.map(h => [h.id, h.name]));
      return [`Середні: настрій ${st.avg.mood ?? '—'}, енергія ${st.avg.energy ?? '—'}, сон ${st.avg.sleep ?? '—'} год.`,
        ...st.days.filter(d => d.mood != null || d.energy != null || d.sleep != null || d.habits.length)
          .map(d => `${d.day}: настрій ${d.mood ?? '—'}, енергія ${d.energy ?? '—'}, сон ${d.sleep ?? '—'}${d.habits.length ? ', звички: ' + d.habits.map(h => names[h]).join(', ') : ''}${d.note ? ' — ' + d.note : ''}`),
        st.habits.length ? 'Звички (днів виконано за період): ' + st.habits.map(h => `${h.name} ${h.count}`).join(', ') : ''].filter(Boolean).join('\n') || 'Записів стану ще немає.';
    }
    return 'Невідомий інструмент.';
  }

  // ---------- виконання дій ----------
  function marks(v) {
    return (v.priority ? ' ' + PRIO[v.priority] : '') + (v.project ? ` · 📁 ${v.project}` : '') + (v.repeatText ? ` · 🔁 ${v.repeatText}` : '');
  }
  function applyActions(actions, msgId, s) {
    const tz = s.tz, done = [], items = [];
    const at = a => a.at ? T.localToUtc(a.at, tz) : null;
    db.transaction(() => {
      for (const a of actions.slice(0, 25)) {
        const txt = str(a.text);
        if (a.type === 'reminder' || a.type === 'task') {
          if (!txt) continue;
          let kind = a.type, due = at(a);
          if (kind === 'reminder' && !due) kind = 'task';
          const it = store.createItem({ kind, text: txt, due_at: due, priority: a.priority, project: a.project, parent_id: a.parent_id, repeat: a.repeat }, msgId, tz);
          if (!it) continue;
          const v = store.view(it, tz); items.push(v);
          const parent = v.parent_id && store.item(v.parent_id);
          if (parent) done.push(`↳ Підзадача до «${parent.text}»: ${v.text}${marks(v)}`);
          else if (kind === 'reminder') done.push(`⏰ ${v.when} — ${v.text}${marks(v)}`);
          else done.push(`☑️ Задача: ${v.text}${due ? ` (до ${v.when})` : ''}${marks(v)}${a.type === 'reminder' ? ' — час не зрозумів' : ''}`);
        } else if (a.type === 'note') {
          if (!txt) continue;
          const it = store.createItem({ kind: 'note', text: txt, tags: a.tags, project: a.project }, msgId, tz);
          const v = store.view(it, tz); items.push(v);
          done.push(`📝 Нотатка${v.tags.length ? ' · ' + v.tags.map(x => '#' + x).join(' ') : ''}${v.project ? ` · 📁 ${v.project}` : ''}`);
        } else if (['complete', 'reopen', 'update', 'delete'].includes(a.type)) {
          const old = Number.isInteger(a.id) && store.item(a.id);
          if (!old) continue;
          if (a.type === 'complete') {
            const r = store.completeItem(old.id, msgId, tz);
            done.push(r.next ? `✅ ${old.text} — наступний раз ${T.fmtWhen(r.next, tz)}` : `✅ Виконано: ${old.text}`);
          } else if (a.type === 'reopen') { store.reopenItem(old.id, msgId, tz); done.push(`↩️ Знову відкрито: ${old.text}`); }
          else if (a.type === 'delete') { store.deleteItem(old.id, msgId); done.push(`🗑 Видалено: ${old.text}`); }
          else {
            const patch = {}, what = [];
            if (txt && txt !== old.text) { patch.text = txt; what.push('текст'); }
            if (a.clear_at) { patch.due_at = null; what.push('без строку'); }
            else if (a.at) { const d = at(a); if (d) { patch.due_at = d; what.push(T.fmtWhen(d, tz)); } }
            if (a.kind && a.kind !== old.kind) { patch.kind = a.kind; what.push(a.kind === 'reminder' ? 'тепер нагадування' : 'тепер задача'); }
            if (a.priority != null && a.priority !== old.priority) { patch.priority = a.priority; what.push(['звичайна', 'важлива', 'термінова'][Math.max(0, Math.min(2, a.priority))]); }
            if (a.project !== undefined) { patch.project = a.project; what.push(a.project ? '📁 ' + a.project : 'без проєкту'); }
            if (a.parent_id !== undefined) patch.parent_id = a.parent_id;
            if (a.stop_repeat) { patch.repeat = null; what.push('без повтору'); }
            else if (a.repeat) { patch.repeat = a.repeat; }
            const it = store.updateItem(old.id, patch, msgId, tz);
            const v = store.view(it, tz); items.push(v);
            if (patch.repeat) what.push('🔁 ' + v.repeatText);
            done.push(`✏️ ${v.text}${what.length ? ' — ' + what.join(', ') : ''}`);
          }
        } else if (a.type === 'checkin') {
          const day = /^\d{4}-\d{2}-\d{2}$/.test(a.day || '') ? a.day : T.dayKey(Date.now(), tz);
          const parts = [];
          if (a.mood != null || a.energy != null || a.sleep != null || str(a.note)) {
            const c = store.checkin(day, a, msgId);
            if (a.mood != null && c.mood != null) parts.push(`настрій ${c.mood}/10`);
            if (a.energy != null && c.energy != null) parts.push(`енергія ${c.energy}/10`);
            if (a.sleep != null && c.sleep != null) parts.push(`сон ${c.sleep} год`);
            if (!parts.length && str(a.note)) parts.push('нотатку про день');
          }
          for (const h of Array.isArray(a.habits) ? a.habits.slice(0, 10) : []) {
            const r = store.habit(h.name, day, h.done !== false, msgId);
            if (r) parts.push((r.done ? '✓ ' : '✗ ') + r.name);
          }
          if (parts.length) done.push(`📊 ${day === T.dayKey(Date.now(), tz) ? 'Стан' : 'Стан за ' + day}: ${parts.join(' · ')}`);
        } else if (a.type === 'undo') {
          const prev = store.lastUndoable(msgId);
          const r = prev ? store.undoMessage(prev) : [];
          done.push(r.length ? `↩️ Скасовано: ${r.join('; ')}` : '↩️ Немає що скасовувати');
        }
      }
    })();
    return { done, items };
  }

  // ---------- головне: повідомлення → дії ----------
  // Повертає { reply, done, items, msgId, undoable } або { error, msgId }.
  async function handleText(text, source) {
    text = str(text, 8000);
    if (!text) return { error: 'Порожнє повідомлення.' };
    const s = load(), tz = s.tz;
    const msgId = store.addMessage(text, source);
    const system = systemPrompt(s, msgId);
    const messages = [{ role: 'user', content: text }];
    // Opus/Sonnet/Fable/Mythos не приймають примусовий вибір інструмента (tool_choice any/tool) — для них auto
    const forced = !/(opus|sonnet|fable|mythos)/i.test(s.model);
    let out = null;
    try {
      for (let step = 0; step < 4 && !out; step++) {
        const last = step === 3;
        const r = await claude(s, { max_tokens: 2000, system, tools: TOOLS, messages,
                                    tool_choice: !forced ? { type: 'auto' } : last ? { type: 'tool', name: 'save_actions' } : { type: 'any' } });
        const uses = (r.content || []).filter(b => b.type === 'tool_use');
        const fin = uses.find(b => b.name === 'save_actions');
        if (fin) { out = fin.input || {}; break; }
        if (!uses.length) {
          const textOut = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          if (textOut) { out = { actions: [], reply: textOut }; break; }
          throw new Error('Claude не повернув дій.');
        }
        messages.push({ role: 'assistant', content: r.content });
        messages.push({ role: 'user', content: uses.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: runTool(b.name, b.input || {}, tz, msgId) })) });
      }
      if (!out) throw new Error('Claude не завершив обробку.');
    } catch (e) {
      store.setReply(msgId, 'Помилка: ' + e.message);
      return { error: e.message, msgId };
    }
    const { done, items } = applyActions(Array.isArray(out.actions) ? out.actions : [], msgId, s);
    const reply = str(out.reply, 3000);
    store.setReply(msgId, [reply, ...done].filter(Boolean).join('\n') || '—');
    const undoable = !!db.prepare('SELECT 1 FROM assistant_events WHERE msg_id = ? AND undone_at IS NULL').get(msgId);
    return { reply, done, items, msgId, undoable };
  }
  function undo(msgId) {
    const r = store.undoMessage(msgId);
    if (r.length) store.setReply(msgId, (db.prepare('SELECT reply FROM assistant_messages WHERE id = ?').get(msgId).reply || '') + '\n↩️ Скасовано');
    return r;
  }

  // ---------- ранковий план і підсумок дня ----------
  function dayData(s) {
    const tz = s.tz, t = Date.now(), today = T.dayKey(t, tz), start = T.dayStart(t, tz), end = T.localToUtc(`${T.addDays(today, 1)}T00:00`, tz);
    const open = store.openItems();
    return {
      tz, t, today, start, end,
      todayItems: open.filter(it => it.due_at && it.due_at >= start && it.due_at < end),
      overdue: open.filter(it => it.due_at && it.due_at < start && !it.sent_at),
      important: open.filter(it => it.priority > 0 && !(it.due_at && it.due_at < end)),
      noDate: open.filter(it => !it.due_at && it.kind === 'task'),
      state: store.state(7, tz)
    };
  }
  const lineFor = (it, tz) => { const v = store.view(it, tz); return `${v.due_at ? T.hhmm(v.due_at, tz) + ' ' : ''}${v.text}${marks(v)}`; };
  function planFallback(d) {
    const L = [];
    if (d.overdue.length) L.push('⚠️ Прострочене:', ...d.overdue.map(it => '• ' + store.view(it, d.tz).when + ' — ' + it.text));
    if (d.todayItems.length) L.push('📅 Сьогодні:', ...d.todayItems.map(it => '• ' + lineFor(it, d.tz)));
    if (d.important.length) L.push('❗ Важливе:', ...d.important.slice(0, 7).map(it => '• ' + lineFor(it, d.tz)));
    return L.join('\n');
  }
  async function morningPlan() {
    const s = load(), d = dayData(s);
    if (!d.todayItems.length && !d.overdue.length && !d.important.length && !d.noDate.length) return null;
    const base = planFallback(d) || 'На сьогодні нічого не заплановано.';
    if (!s.anthropicKey) return base;
    const y = d.state.days.at(-2) || {};
    try {
      const r = await claude(s, {
        max_tokens: 700,
        system: 'Ти — особистий помічник. Склади короткий ранковий план дня українською, звичайним текстом для Telegram (без Markdown), до 100 слів. ' +
                'Спочатку одне речення-привітання з урахуванням дня тижня, далі список справ з часом, потім «🎯 Головне сьогодні:» — одна найважливіша справа з наведених (обери сам за пріоритетом, строком і простроченням). ' +
                'Якщо щось прострочено — мʼяко нагадай. Нічого не вигадуй.',
        messages: [{ role: 'user', content: `Сьогодні ${T.WD[T.parts(d.t, d.tz).wd]}, ${d.today}.\n${base}` +
          (d.noDate.length ? '\nЗадачі без строку:\n' + d.noDate.slice(0, 15).map(it => '• ' + lineFor(it, d.tz)).join('\n') : '') +
          (y.sleep != null || y.mood != null ? `\nВчора: сон ${y.sleep ?? '—'} год, настрій ${y.mood ?? '—'}.` : '') }]
      });
      return (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || base;
    } catch (e) { console.error('[assistant] ранковий план:', e.message); return base; }
  }
  async function summary() {
    const s = load(), d = dayData(s), tz = s.tz;
    const msgs = db.prepare('SELECT at, text FROM assistant_messages WHERE at >= ? ORDER BY at').all(d.start);
    const doneToday = db.prepare("SELECT text FROM assistant_items WHERE done_at >= ? AND kind != 'note'").all(d.start);
    const notes = db.prepare("SELECT id, text FROM assistant_items WHERE kind = 'note' AND created >= ?").all(d.start);
    const tStart = d.end, tomorrow = store.openItems().filter(it => it.due_at && it.due_at >= tStart && it.due_at < tStart + 864e5);
    if (!msgs.length && !doneToday.length && !tomorrow.length && !d.noDate.length) return null;
    const today = d.state.days.at(-1), names = Object.fromEntries(d.state.habits.map(h => [h.id, h.name]));
    const data = [
      `Сьогодні ${T.WD[T.parts(d.t, tz).wd]}, ${d.today}.`,
      'Що власник казав сьогодні:', ...(msgs.length ? msgs.map(m => `[${T.hhmm(m.at, tz)}] ${m.text}`) : ['(нічого)']),
      'Нотатки за сьогодні:', ...(notes.length ? notes.map(n => `- ${n.text}`) : ['(немає)']),
      'Виконано сьогодні:', ...(doneToday.length ? doneToday.map(x => '- ' + x.text) : ['(нічого не позначено)']),
      `Стан сьогодні: настрій ${today.mood ?? '—'}, енергія ${today.energy ?? '—'}, сон ${today.sleep ?? '—'}; звички: ${today.habits.map(h => names[h]).join(', ') || '—'}.`,
      `Середні за тиждень: настрій ${d.state.avg.mood ?? '—'}, енергія ${d.state.avg.energy ?? '—'}, сон ${d.state.avg.sleep ?? '—'}.`,
      'На завтра заплановано:', ...(tomorrow.length ? tomorrow.map(x => '- ' + lineFor(x, tz)) : ['(нічого)']),
      'Відкриті задачі без строку:', ...(d.noDate.length ? d.noDate.slice(0, 20).map(x => '- ' + lineFor(x, tz)) : ['(немає)'])
    ].join('\n');
    const r = await claude(s, {
      max_tokens: 900,
      system: 'Ти — особистий помічник. Склади короткий теплий підсумок дня для власника українською, звичайним текстом для Telegram (без Markdown, без таблиць), до 130 слів. ' +
              'Структура: що було важливого сьогодні (1–3 речення з його слів і нотаток), що зроблено, стан (якщо є дані; порівняй із середнім за тиждень), що на завтра (з часом), одне мʼяке спостереження або порада, якщо доречно. ' +
              'Не вигадуй нічого, чого немає в даних. Можна кілька емодзі як маркери розділів.',
      messages: [{ role: 'user', content: data }]
    });
    return (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || null;
  }

  // ---------- Telegram і таймер ----------
  const bot = require('./telegram')({ load, update, handleText, undo, summary, morningPlan, store, db, newCode, T });
  let ticking = false;
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const s = load(), tz = s.tz, t = Date.now();
      // надіслане одноразове нагадування без реакції за добу вважаємо закритим
      db.prepare("UPDATE assistant_items SET done_at = sent_at, updated = ? WHERE kind = 'reminder' AND done_at IS NULL AND sent_at < ? AND repeat IS NULL").run(t, t - 864e5);
      if (bot.ready()) {
        const due = db.prepare("SELECT * FROM assistant_items WHERE kind = 'reminder' AND due_at <= ? AND sent_at IS NULL AND done_at IS NULL ORDER BY due_at LIMIT 10").all(t);
        for (const it of due) if (await bot.sendReminder(it)) store.advanceAfterSend(it.id, tz);
        const today = T.dayKey(t, tz), hm = T.hhmm(t, tz);
        if (s.morningOn && s.lastMorningDay !== today && hm >= s.morningTime && hm < '12:00') {
          update({ lastMorningDay: today });
          try { const text = await morningPlan(); if (text) await bot.sendText('☀️ План на сьогодні\n\n' + text); }
          catch (e) { console.error('[assistant] ранковий план:', e.message); }
        }
        if (s.summaryOn && s.anthropicKey && s.lastSummaryDay !== today && hm >= s.summaryTime) {
          update({ lastSummaryDay: today });
          try { const text = await summary(); if (text) await bot.sendText('🌙 Підсумок дня\n\n' + text); }
          catch (e) { console.error('[assistant] підсумок дня:', e.message); }
        }
      }
    } catch (e) { console.error('[assistant] таймер:', e.message); }
    finally { ticking = false; }
  }
  function start() {
    bot.restart();
    setInterval(tick, 20e3).unref();
    setTimeout(tick, 3e3).unref();
  }

  // ---------- API для сторінки ----------
  const publicView = s => ({
    hasKey: !!s.anthropicKey, keyHint: s.anthropicKey ? '…' + s.anthropicKey.slice(-4) : '', model: s.model,
    hasBot: !!s.botToken, botName: s.botName, linked: !!s.chatId,
    linkUrl: s.botName && !s.chatId ? `https://t.me/${s.botName}?start=${s.linkCode}` : '',
    botError: bot.lastError(), tz: s.tz, voiceLang: s.voiceLang,
    summaryTime: s.summaryTime, summaryOn: !!s.summaryOn, morningTime: s.morningTime, morningOn: !!s.morningOn
  });
  const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

  async function handle(req, res, url, a, log) {
    const m = req.method, qs = new URL(req.url, 'http://x').searchParams, tz = load().tz;
    if (url === '/api/assistant/settings' && m === 'GET') return send(res, 200, publicView(load()));
    if (url === '/api/assistant/settings' && m === 'POST') {
      const b = await readBody(req, 8192);
      if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      const s = load(), changed = [];
      if (b.anthropicKey) { s.anthropicKey = str(b.anthropicKey, 300); changed.push('ключ Claude'); }
      if (b.clearKey) { s.anthropicKey = ''; changed.push('ключ Claude видалено'); }
      if (b.model != null) { const md = str(b.model, 60); if (!/^claude-[a-z0-9.-]+$/.test(md)) return send(res, 400, { error: 'Неправильна назва моделі.' }); s.model = md; }
      if (b.tz != null) { if (!T.validTz(b.tz)) return send(res, 400, { error: 'Невідомий часовий пояс.' }); s.tz = str(b.tz, 60); }
      for (const [k, label] of [['summaryTime', 'підсумку'], ['morningTime', 'ранкового плану']]) {
        if (b[k] != null) { if (!HM.test(b[k])) return send(res, 400, { error: `Час ${label} — у форматі 08:00.` }); s[k] = b[k]; }
      }
      if (b.morningTime != null && b.morningTime >= '12:00') return send(res, 400, { error: 'Ранковий план — до 12:00.' });
      if (b.summaryOn != null) s.summaryOn = !!b.summaryOn;
      if (b.morningOn != null) s.morningOn = !!b.morningOn;
      if (b.voiceLang != null && ['uk', 'ru', 'auto'].includes(b.voiceLang)) s.voiceLang = b.voiceLang;
      if (b.unlink) { s.chatId = null; s.linkCode = newCode(); changed.push('Telegram відвʼязано'); }
      if (b.clearBot) { s.botToken = ''; s.botName = ''; s.chatId = null; changed.push('бот видалено'); }
      if (b.botToken) {
        const token = str(b.botToken, 120);
        if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) return send(res, 400, { error: 'Токен бота має вигляд 123456789:AA… (видає @BotFather).' });
        let me;
        try { me = await bot.getMe(token); } catch (e) { return send(res, 400, { error: 'Telegram не прийняв токен: ' + e.message }); }
        if (token !== s.botToken) { s.chatId = null; s.lastUpdateId = 0; }
        s.botToken = token; s.botName = me.username; s.linkCode = newCode(); changed.push('бот @' + me.username);
      }
      if (!s.linkCode) s.linkCode = newCode();
      save(s);
      if (b.botToken || b.clearBot || b.unlink) bot.restart();
      if (changed.length) log(a, 'assistant:settings', null, { changed });
      return send(res, 200, publicView(s));
    }
    if (url === '/api/assistant/message' && m === 'POST') {
      const b = await readBody(req, 65536);
      const r = await handleText(b && b.text, 'web');
      return r.error ? send(res, 502, { error: r.error }) : send(res, 200, { reply: r.reply, done: r.done, items: r.items, msgId: r.msgId, undoable: r.undoable });
    }
    if (url === '/api/assistant/undo' && m === 'POST') {
      const b = await readBody(req, 1024), id = b && +b.msgId;
      if (!id) return send(res, 400, { error: 'Не вказано повідомлення.' });
      const r = undo(id);
      return send(res, 200, { undone: r });
    }
    if (url === '/api/assistant/items' && m === 'GET') {
      const kind = qs.get('kind'), text = (qs.get('q') || '').trim(), project = +qs.get('project') || null;
      let rows;
      if (kind === 'note') {
        if (text.startsWith('#')) rows = db.prepare(`SELECT i.* FROM assistant_items i JOIN assistant_item_tags x ON x.item_id = i.id JOIN assistant_tags t ON t.id = x.tag_id
                                                     WHERE i.kind = 'note' AND t.name = ? ORDER BY i.created DESC LIMIT 200`).all(text.slice(1).toLowerCase());
        else if (text) rows = store.search(text, { limit: 100, type: 'item' }).filter(r => r.kind === 'note').map(r => store.item(r.id));
        else rows = db.prepare("SELECT * FROM assistant_items WHERE kind = 'note' ORDER BY created DESC LIMIT 200").all();
      } else {
        rows = [...store.openItems(), ...db.prepare("SELECT * FROM assistant_items WHERE kind IN ('task', 'reminder') AND done_at >= ? ORDER BY done_at DESC LIMIT 60").all(Date.now() - 7 * 864e5)];
        if (project) rows = rows.filter(r => r.project_id === project);
      }
      return send(res, 200, { list: rows.filter(Boolean).map(it => store.view(it, tz)), projects: store.projects().map(p => ({ id: p.id, name: p.name, open: p.open })) });
    }
    if (url === '/api/assistant/item' && m === 'POST') {
      const b = await readBody(req, 4096), id = b && +b.id, it = id && store.item(id);
      if (!it) return send(res, 404, { error: 'Запис не знайдено.' });
      if (b.action === 'done') { const r = store.completeItem(id, null, tz); return send(res, 200, { ...store.view(r.item, tz), next: r.next }); }
      if (b.action === 'undo') return send(res, 200, store.view(store.reopenItem(id, null, tz), tz));
      if (b.action === 'delete') { store.deleteItem(id, null); return send(res, 200, { ok: true }); }
      if (b.action === 'priority') return send(res, 200, store.view(store.updateItem(id, { priority: +b.priority || 0 }, null, tz), tz));
      return send(res, 400, { error: 'Невідома дія.' });
    }
    if (url === '/api/assistant/state' && m === 'GET') return send(res, 200, store.state(Math.max(7, Math.min(60, +qs.get('days') || 14)), tz));
    if (url === '/api/assistant/search' && m === 'GET') {
      const list = store.search(qs.get('q') || '', { limit: 40 });
      return send(res, 200, { list: list.map(r => ({ ...r, when: T.fmtWhen(r.at, tz) })) });
    }
    if ((url === '/api/assistant/summary' || url === '/api/assistant/plan') && m === 'POST') {
      const isPlan = url.endsWith('/plan');
      try {
        const text = isPlan ? await morningPlan() : await summary();
        const title = isPlan ? '☀️ План на сьогодні' : '🌙 Підсумок дня';
        const sent = !!(text && bot.ready() && await bot.sendText(`${title}\n\n${text}`));
        return send(res, 200, { text: text || (isPlan ? 'На сьогодні нічого не заплановано.' : 'Сьогодні ще нічого не записано.'), sent });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }

  return { handle, start, handleText, summary, morningPlan, tick, settings: load, store };
}
