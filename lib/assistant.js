// Персональний асистент власника (сторінка /assistant + Telegram-бот).
// Текст (розшифрований голос або набраний) → Claude (агент з інструментами) → дії над записами в базі.
//   Інструменти Claude: search_memory (пошук по всьому, що казав власник),
//   save_actions (фінальний: створити/змінити/виконати/видалити/скасувати записи).
// Ритуали дня (повторювані завдання з фото/відео) — окремий модуль lib/routines.js.
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
  morningTime: '08:00', morningOn: true, lastMorningDay: '',
  habitsTime: '22:00', habitsOn: true, lastHabitsDay: '',
  style: ''                 // як асистент спілкується: промпт власника (відповіді, ранковий план, підсумок дня)
};
const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const str = (v, max = 2000) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const newCode = () => crypto.randomBytes(6).toString('hex');
const PRIO = ['', '❗', '‼️'];
// Як оформлювати текст для власника (Telegram і застосунок показують звичайний текст, без Markdown)
const FORMAT = [
  'Оформлення: коротко й структуровано, без суцільних абзаців-перелічень.',
  '- Перше речення — суть відповіді. Далі, якщо є кілька речей (справи, задачі, знайдене), — кожна з нового рядка, починаючи з «• ».',
  '- Групуй окремими абзацами з короткою назвою групи на своєму рядку («Нагадування:», «Задачі:», «Прострочене:»), між абзацами — порожній рядок.',
  '- Час — на початку пункту: «• 09:00 — написати Георгію». Строк задачі — «• до 15:00 — звіт для клієнта».',
  '- Без Markdown (*, #, _, `). Емодзі — щонайбільше одне-два на все повідомлення і лише де доречно (наприклад, 🙂 наприкінці для тону); не став емодзі перед кожним пунктом.',
  'Приклад:\nЗавтра, 19 жовтня, день насичений.\n\nНагадування:\n• 09:00 — написати Георгію про товари iHunt\n• 10:00 — зустріч з командою керівників\n\nЗадачі:\n• до 15:00 — звіт для клієнта (важлива)\n• до 19:00 — купити продукти\n\nВільний час — лише ввечері 🙂'
].join('\n');

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
              type: { type: 'string', enum: ['reminder', 'task', 'note', 'complete', 'reopen', 'update', 'delete', 'undo', 'routine', 'habit'],
                description: 'reminder — нагадати в конкретний час; task — справа (можна зі строком); note — думка/ідея/запис у щоденник; complete — виконано; reopen — повернути у невиконані; update — змінити наявний запис; delete — видалити; undo — скасувати попередню дію помічника; routine — щоденне завдання: коротка справа, що повторюється кілька разів на день або щодня в певний час із нагадуванням (вода, зарядка, очі, розтяжка); habit — відмітити звичку зі списку звичок: виконав (done true) чи ні (done false), text — назва звички' },
              id: { type: 'integer', description: 'Для complete / reopen / update / delete — id запису' },
              text: { type: 'string', description: 'Суть коротко, мовою власника, без «нагадай»/«додай». Для note — повна думка, підчищена від слів-паразитів. Для update — новий текст, якщо його змінюють.' },
              at: { type: 'string', description: 'Місцевий час YYYY-MM-DDTHH:MM: для reminder обовʼязково; для task — строк; для update — новий час/строк' },
              clear_at: { type: 'boolean', description: 'Для update: прибрати строк/час' },
              kind: { type: 'string', enum: ['task', 'reminder'], description: 'Для update: перетворити задачу на нагадування чи навпаки' },
              priority: { type: 'integer', description: '0 звичайна, 1 важлива, 2 термінова. Лише якщо власник це сказав або очевидно' },
              area: { type: 'string', description: 'Для reminder / task (і update): ключ простору зі списку просторів у системному промпті. Лише якщо це однозначно випливає зі слів власника чи опису простору; якщо сумніваєшся — inbox. Для update — лише коли власник просить перенести' },
              status: { type: 'string', description: 'Для task / update: ключ статусу зі списку статусів («почав робити» → в роботі, «чекаю від когось» → чекаю). Зазвичай не вказуй — нова задача отримує перший статус' },
              description: { type: 'string', description: 'Для task / update: деталі задачі, якщо власник продиктував подробиці (кроки, контакти, умови). Коротку назву — у text' },
              parent_id: { type: 'integer', description: 'Для підзадачі — id батьківської задачі' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Теги в нижньому регістрі, 1–3 слова. Для note — завжди; для task / reminder / update — лише якщо власник назвав тему чи напрям («для сайту» → сайт, «по магазину» → магазин). Бери наявні теги зі списку, якщо підходять. В update — повний новий список' },
              repeat: REPEAT_SCHEMA,
              stop_repeat: { type: 'boolean', description: 'Для update: прибрати повтор' },
              times: { type: 'array', items: { type: 'string' }, description: 'Для routine: години HH:MM («о 8 і о 20» → ["08:00","20:00"])' },
              every: { type: 'integer', description: 'Для routine: інтервал у хвилинах («кожні 2 години» → 120), разом із from і to' },
              from: { type: 'string', description: 'Для routine з every: початок HH:MM (за замовчуванням 09:00)' },
              to: { type: 'string', description: 'Для routine з every: кінець HH:MM (за замовчуванням 21:00)' },
              days: { type: 'array', items: { type: 'integer' }, description: 'Для routine: дні тижня пн=1 … нд=7, якщо не щодня («по буднях» → 1–5)' },
              icon: { type: 'string', description: 'Для routine: один емодзі' },
              done: { type: 'boolean', description: 'Для habit: true — виконав, false — не виконав' },
              day: { type: 'string', description: 'Для habit: дата YYYY-MM-DD, якщо не сьогодні («вчора не курив»)' }
            },
            required: ['type']
          }
        },
        reply: { type: 'string', description: 'Відповідь власнику мовою його повідомлення: коротко, за правилами оформлення із системного промпту (суть першим реченням, перелік — з нового рядка через «• », групи — абзацами). Не перелічуй збережені дії (їх покаже система). Тут — відповідь на питання (зокрема за результатами пошуку), уточнення, коротка підтримка.' }
      },
      required: ['actions', 'reply']
    }
  }
];

let instance = null;
module.exports = { get: db => instance || (instance = make(db)), make };

// opts для окремої бази облікового запису (accounts.ws):
//   shared()   — налаштування основної бази: ключ Claude і модель беруться звідти (їх змінює лише адміністратор);
//   ws         — імʼя бази (u5): префікс токенів push і адреса медіа /m/u5/…;
//                Telegram — той самий бот основної бази, але свій привʼязаний чат (chatId, linkCode); бот окремої бази не опитує Telegram.
//   allow()    — чи можна ще звертатись до Claude (денний ліміт гостьового входу).
const SHARED = ['anthropicKey', 'model', 'botToken', 'botName', 'lastUpdateId'];
function make(db, opts = {}) {
  const store = require('./assistant-store')(db);
  const spaceMap = () => Object.fromEntries(store.spaces().map(x => [x.key, x]));
  const statusMap = () => Object.fromEntries(store.statuses().map(x => [x.key, x]));

  // ---------- налаштування ----------
  function load() {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
    let s = {}; try { s = row ? JSON.parse(row.value) : {}; } catch (e) {}
    if (opts.shared) { const m = opts.shared(); return { ...DEFAULTS, ...s, anthropicKey: m.anthropicKey, model: m.model, botToken: m.botToken, botName: m.botName }; }
    return { ...DEFAULTS, ...s };
  }
  function save(s) {
    if (opts.shared) { s = { ...s }; SHARED.forEach(k => delete s[k]); }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(s)); }
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
    const v = store.view(it, tz), sp = spaceMap()[v.area], stn = statusMap()[v.status];
    const bits = ['простір ' + (sp ? `${sp.name} [${v.area}]` : v.area)];
    if (stn && v.status !== store.firstStatus()) bits.push('статус ' + stn.name);
    if (v.tags.length) bits.push('#' + v.tags.join(' #'));
    if (v.priority) bits.push(v.priority === 2 ? 'термінова' : 'важлива');
    if (v.due_at) bits.push((v.kind === 'task' ? 'строк ' : 'час ') + T.localIso(v.due_at, tz).replace('T', ' '));
    if (v.repeatText) bits.push('повтор: ' + v.repeatText);
    if (v.parent_id) bits.push('підзадача #' + v.parent_id);
    if (v.sent) bits.push('вже надіслано');
    return `#${v.id} [${v.kind === 'task' ? 'задача' : 'нагадування'}] ${v.text}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`;
  }
  // Стиль спілкування від власника (Налаштування → Стиль): тон, довжина, звертання, емодзі.
  const styleNote = s => s.style ? `\nСтиль, який задав власник (має перевагу над тоном і довжиною вище, але без вигаданих фактів): «${s.style}»` : '';
  function systemPrompt(s, msgId) {
    const tz = s.tz, t = Date.now(), p = T.parts(t, tz), today = T.dayKey(t, tz);
    const open = store.openItems(), tags = store.tags().slice(0, 40);
    const convo = store.recentConversation(7, t - 3 * 3600e3).filter(m => m.id !== msgId);
    return [
      'Ти — особистий помічник власника. Він диктує або пише короткі повідомлення українською чи російською; розшифровки голосу можуть містити помилки розпізнавання — розумій за змістом.',
      'Перетвори повідомлення на дії. Якщо питають про минуле або потрібен запис, якого немає нижче, — спершу search_memory. Наприкінці завжди виклич save_actions.',
      `Зараз: ${T.WD[p.wd]}, ${T.localIso(t, tz).replace('T', ' ')} (${tz}).`,
      'Правила:',
      '- «нагадай …» з часом або днем → reminder з точним at. Лише день — 09:00. «Вранці» 09:00, «вдень» 13:00, «після обіду» 15:00, «ввечері» 19:00, «через годину» = зараз + 1 год. Якщо названий час сьогодні вже минув — наступний такий день.',
      '- «щодня / щопонеділка / кожного 1-го числа …» → reminder (або task) з repeat і at = найближчий раз.',
      '- Справа без часу нагадування → task; at — лише якщо назвали строк. Теги й пріоритет — лише якщо власник їх згадав («для сайту» → тег сайт, «терміново», «важливо»).',
      '- «У задачу X додай …» → task з parent_id = id задачі X (сфера підзадачі — як у задачі X).',
      '- Простір кожної задачі й нагадування (area) — ключ зі списку просторів нижче. Визначай за змістом, тегами, описом простору й тим, як розкладені схожі відкриті задачі. ' +
        'Якщо власник сам називає простір («робоче», «по роботі», «особисте», «для магазину»…) — так і став. Якщо незрозуміло — inbox (Вхідні): краще у вхідні, ніж не туди.',
      '- «Перенеси X у …» (простір) → update з area; «почав / роблю X» → update зі status в роботі; «чекаю від … X» → status чекаю; «зробив» → complete.',
      '- Думки, ідеї, враження, «запиши …» без дії → note з тегами.',
      '- «Нагадуй пити воду кожні 2 години», «щоранку зарядка о 8», «по буднях кожні 2 години зарядка для очей» → routine (щоденне завдання: приходить сповіщенням, з фото/відео й таймером — їх власник додасть у розділі «Щоденні завдання»). Разові справи — не routine.',
      '- «Сьогодні зробив зарядку», «не курив», «вчора не читав» — якщо це звичка зі списку звичок нижче → habit з назвою звички й done. Нову звичку не вигадуй.',
      '- «Зробив / купив / готово …» → complete; «перенеси / зміни / перейменуй / зроби важливим …» → update; «видали / скасуй задачу …» → delete; «скасуй останнє / не те записав / відміни» → undo.',
      '- Самопочуття, настрій, сон окремо не відстежуються: якщо власник про це розповідає — note з тегом стан.',
      '- «Його / її / це / туди» — найімовірніше про записи з останніх реплік нижче.',
      '- Одне повідомлення може містити кілька дій. Нічого не вигадуй і не дублюй записи, які вже є.',
      '- Текст дій — мовою власника, коротко й зрозуміло; виправ очевидні помилки розпізнавання.',
      'Поле reply. ' + FORMAT,
      s.style ? `Стиль відповідей (поле reply), який задав власник, — дотримуйся його, але не вигадуй фактів і не змінюй текст самих дій:\n«${s.style}»` : '',
      open.length ? 'Відкриті задачі й нагадування:\n' + open.map(it => itemLine(it, tz)).join('\n') : 'Відкритих задач і нагадувань немає.',
      tags.length ? 'Теги, які вже є: ' + tags.map(x => x.name).join(', ') : '',
      (hl => hl.length ? 'Звички, які власник формує: ' + hl.map(h => h.title + (h.today === 1 ? ' (сьогодні ✓)' : h.today === 0 ? ' (сьогодні ✗)' : '')).join(', ') : '')(habits.list().filter(h => h.active)),
      'Простори (ключ — назва — що туди належить):\n' + store.spaces().filter(x => !x.archived).map(x => `[${x.key}] ${x.name}${x.description ? ' — ' + x.description : ''}`).join('\n'),
      'Статуси (ключ — назва): ' + store.statuses().map(x => `[${x.key}] ${x.name}`).join(', '),
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
    return 'Невідомий інструмент.';
  }

  // ---------- виконання дій ----------
  function marks(v) {
    const sp = v.kind !== 'note' && v.area && spaceMap()[v.area];
    return (sp ? ' · ' + sp.name : '') + (v.priority ? ' ' + PRIO[v.priority] : '') + (v.tags && v.tags.length && v.kind !== 'note' ? ' · #' + v.tags.join(' #') : '') + (v.repeatText ? ` · 🔁 ${v.repeatText}` : '');
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
          const it = store.createItem({ kind, text: txt, due_at: due, priority: a.priority, tags: a.tags, parent_id: a.parent_id, repeat: a.repeat, area: a.area, status: a.status, description: a.description }, msgId, tz);
          if (!it) continue;
          const v = store.view(it, tz); items.push(v);
          const parent = v.parent_id && store.item(v.parent_id);
          if (parent) done.push(`• Підзадача до «${parent.text}»: ${v.text}${marks(v)}`);
          else if (kind === 'reminder') done.push(`• Нагадування ${v.when} — ${v.text}${marks(v)}`);
          else done.push(`• Задача: ${v.text}${due ? ` (до ${v.when})` : ''}${marks(v)}${a.type === 'reminder' ? ' — час не зрозумів' : ''}`);
        } else if (a.type === 'note') {
          if (!txt) continue;
          const it = store.createItem({ kind: 'note', text: txt, tags: a.tags }, msgId, tz);
          const v = store.view(it, tz); items.push(v);
          done.push(`• Нотатка${v.tags.length ? ' · ' + v.tags.map(x => '#' + x).join(' ') : ''}`);
        } else if (['complete', 'reopen', 'update', 'delete'].includes(a.type)) {
          const old = Number.isInteger(a.id) && store.item(a.id);
          if (!old) continue;
          if (a.type === 'complete') {
            const r = store.completeItem(old.id, msgId, tz);
            done.push(r.next ? `• Виконано: ${old.text} — наступний раз ${T.fmtWhen(r.next, tz)}` : `• Виконано: ${old.text}`);
          } else if (a.type === 'reopen') { store.reopenItem(old.id, msgId, tz); done.push(`• Знову відкрито: ${old.text}`); }
          else if (a.type === 'delete') { store.deleteItem(old.id, msgId); done.push(`• Видалено: ${old.text}`); }
          else {
            const patch = {}, what = [];
            if (txt && txt !== old.text) { patch.text = txt; what.push('текст'); }
            if (a.clear_at) { patch.due_at = null; what.push('без строку'); }
            else if (a.at) { const d = at(a); if (d) { patch.due_at = d; what.push(T.fmtWhen(d, tz)); } }
            if (a.kind && a.kind !== old.kind) { patch.kind = a.kind; what.push(a.kind === 'reminder' ? 'тепер нагадування' : 'тепер задача'); }
            if (a.priority != null && a.priority !== old.priority) { patch.priority = a.priority; what.push(['звичайна', 'важлива', 'термінова'][Math.max(0, Math.min(2, a.priority))]); }
            if (Array.isArray(a.tags)) { patch.tags = a.tags; what.push(a.tags.length ? '#' + a.tags.join(' #') : 'без тегів'); }
            if (a.parent_id !== undefined) patch.parent_id = a.parent_id;
            if (a.area && a.area !== old.area && store.isSpace(a.area)) { patch.area = a.area; what.push('→ ' + spaceMap()[a.area].name); }
            if (a.status && a.status !== old.status && store.isStatus(a.status)) { patch.status = a.status; what.push(statusMap()[a.status].name.toLowerCase()); }
            if (a.description != null && str(a.description)) { patch.description = [old.description, str(a.description, 5000)].filter(Boolean).join('\n'); what.push('опис'); }
            if (a.stop_repeat) { patch.repeat = null; what.push('без повтору'); }
            else if (a.repeat) { patch.repeat = a.repeat; }
            const it = store.updateItem(old.id, patch, msgId, tz);
            const v = store.view(it, tz); items.push(v);
            if (patch.repeat) what.push('🔁 ' + v.repeatText);
            done.push(`• Змінено: ${v.text}${what.length ? ' — ' + what.join(', ') : ''}`);
          }
        } else if (a.type === 'routine') {
          if (!txt) continue;
          try {
            const every = +a.every || 0;
            const r = routines.add({ title: txt, icon: str(a.icon, 8) || '✨', body: str(a.description, 1000) || null, days: Array.isArray(a.days) && a.days.length ? a.days : undefined,
              ...(every ? { times: [], every, from: a.from || '09:00', to: a.to || '21:00' } : { times: Array.isArray(a.times) && a.times.length ? a.times : ['09:00'] }) });
            done.push(`• Щоденне завдання: ${r.icon} ${r.title} — ${r.schedule}`);
          } catch (e) { done.push('⚠️ Ритуал не створено: ' + e.message); }
        } else if (a.type === 'habit') {
          const h = habits.find(txt);
          if (!h) { done.push(`⚠️ Звичку «${txt}» не знайшов — створи її в розділі «Щоденні завдання → Звички»`); continue; }
          try {
            habits.mark(h.id, /^\d{4}-\d{2}-\d{2}$/.test(a.day || '') ? a.day : habits.today(), a.done !== false);
            done.push(`• Звичка «${h.title}» — ${a.done !== false ? 'виконано' : 'не виконано'}${a.day && a.day !== habits.today() ? ' · ' + a.day : ''}`);
          } catch (e) { done.push('⚠️ ' + e.message); }
        } else if (a.type === 'undo') {
          const prev = store.lastUndoable(msgId);
          const r = prev ? store.undoMessage(prev) : [];
          done.push(r.length ? `• Скасовано: ${r.join('; ')}` : 'Немає що скасовувати');
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
    if (opts.allow && !opts.allow()) return { error: 'Гостьовий ліміт асистента на сьогодні вичерпано. Спробуйте завтра.' };
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
      noDate: open.filter(it => !it.due_at && it.kind === 'task')
    };
  }
  const lineFor = (it, tz) => { const v = store.view(it, tz); return `${v.due_at ? T.hhmm(v.due_at, tz) + ' ' : ''}${v.text}${marks(v)}`; };
  function planFallback(d) {
    const L = [];
    const block = (title, list) => { if (list.length) L.push((L.length ? '\n' : '') + title, ...list); };
    block('Прострочене:', d.overdue.map(it => '• ' + store.view(it, d.tz).when + ' — ' + it.text));
    block('Сьогодні:', d.todayItems.map(it => '• ' + lineFor(it, d.tz)));
    block('Важливе:', d.important.slice(0, 7).map(it => '• ' + lineFor(it, d.tz)));
    return L.join('\n');
  }
  async function morningPlan() {
    const s = load(), d = dayData(s);
    if (!d.todayItems.length && !d.overdue.length && !d.important.length && !d.noDate.length) return null;
    const base = planFallback(d) || 'На сьогодні нічого не заплановано.';
    if (!s.anthropicKey) return base;
    try {
      const r = await claude(s, {
        max_tokens: 700,
        system: 'Ти — особистий помічник. Склади короткий ранковий план дня українською, до 100 слів. ' +
                'Структура: одне речення-привітання з урахуванням дня тижня; абзац «Сьогодні:» — справи з часом, кожна з нового рядка; ' +
                'якщо щось прострочено — абзац «Прострочене:»; наприкінці абзац «Головне:» — одна найважливіша справа з наведених (обери сам за пріоритетом, строком і простроченням). Нічого не вигадуй.\n' + FORMAT + styleNote(s),
        messages: [{ role: 'user', content: `Сьогодні ${T.WD[T.parts(d.t, d.tz).wd]}, ${d.today}.\n${base}` +
          (d.noDate.length ? '\nЗадачі без строку:\n' + d.noDate.slice(0, 15).map(it => '• ' + lineFor(it, d.tz)).join('\n') : '') }]
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
    const data = [
      `Сьогодні ${T.WD[T.parts(d.t, tz).wd]}, ${d.today}.`,
      'Що власник казав сьогодні:', ...(msgs.length ? msgs.map(m => `[${T.hhmm(m.at, tz)}] ${m.text}`) : ['(нічого)']),
      'Нотатки за сьогодні:', ...(notes.length ? notes.map(n => `- ${n.text}`) : ['(немає)']),
      'Виконано сьогодні:', ...(doneToday.length ? doneToday.map(x => '- ' + x.text) : ['(нічого не позначено)']),
      ...(routinesToday => routinesToday.length ? ['Щоденні завдання сьогодні:', ...routinesToday] : [])(routines.todayLines()),
      ...(hl => hl.length ? ['Звички сьогодні:', ...hl] : [])(habits.list().filter(h => h.active && h.todayPlanned)
        .map(h => `- ${h.title}: ${h.today === 1 ? 'виконано' : h.today === 0 ? 'не виконано' : 'ще не відмічено'}${h.streak > 1 ? `, серія ${h.streak} дн.` : ''}`)),
      'На завтра заплановано:', ...(tomorrow.length ? tomorrow.map(x => '- ' + lineFor(x, tz)) : ['(нічого)']),
      'Відкриті задачі без строку:', ...(d.noDate.length ? d.noDate.slice(0, 20).map(x => '- ' + lineFor(x, tz)) : ['(немає)'])
    ].join('\n');
    const r = await claude(s, {
      max_tokens: 900,
      system: 'Ти — особистий помічник. Склади короткий теплий підсумок дня для власника українською, до 130 слів. ' +
              'Структура абзацами: одне-два речення — що було важливого сьогодні (з його слів і нотаток); «Зроблено:» — пункти (разом із щоденними завданнями й звичками, якщо є); ' +
              '«Завтра:» — пункти з часом; наприкінці одне мʼяке спостереження або порада, якщо доречно. Не вигадуй нічого, чого немає в даних.\n' + FORMAT + styleNote(s),
      messages: [{ role: 'user', content: data }]
    });
    return (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || null;
  }

  // ---------- Telegram і таймер ----------
  const bot = require('./telegram')({ load, update, handleText, undo, summary, morningPlan, store, db, newCode, T, noPoll: !!opts.ws });
  const push = opts.ws ? require('./push').make(db, { prefix: opts.ws + '~' }) : require('./push').get(db);
  // текст під заголовком push-нагадування: простір і теги
  const pushWhen = it => { const sp = spaceMap()[it.area], tg = store.tagsOf(it.id);
    return [sp && it.area !== 'inbox' ? sp.name : '', tg.length ? '#' + tg.join(' #') : '', it.repeat ? 'повторюване' : ''].filter(Boolean).join(' · ') || 'Нагадування'; };
  const routines = require('./routines')(db, { load, bot, push, T, ...(opts.ws ? { mediaBase: `/m/${opts.ws}/` } : {}) });
  const habits = require('./habits')(db, { load, update, bot, push, T });
  async function deliver(title, text) {
    let n = 0;
    if (bot.ready() && await bot.sendText(`${title}\n\n${text}`)) n++;
    if (push.has()) n += await push.sendText(title, text);
    return n;
  }
  // Кнопки в push-сповіщенні: { token, action: done | snooze } — токен підписаний і привʼязаний до однієї задачі
  async function pushAction(req, res, body) {
    const b = body || await readBody(req, 2048), id = push.checkToken(b && b.token);
    if (typeof id === 'string' && id[0] === 'r') return routines.pushAction(+id.slice(1), b.action, res);
    if (typeof id === 'string' && id[0] === 'h') return habits.pushAction(+id.slice(1), b.action, res);
    const it = id && store.item(id);
    if (!it) return send(res, 404, { error: 'Нагадування не знайдено або посилання застаріло.' });
    const tz = load().tz;
    if (b.action === 'done') {
      // повторюване вже переставлено на наступний раз під час надсилання — «готово» лише підтверджує
      if (!it.repeat && !it.done_at) store.completeItem(id, null, tz);
      return send(res, 200, { ok: true, text: it.repeat ? 'Готово, наступний раз — за розкладом' : 'Виконано' });
    }
    if (b.action === 'snooze') {
      const at = Date.now() + 3600e3;
      if (it.repeat) store.cloneOnce(id, at, null, tz); else store.updateItem(id, { due_at: at, kind: 'reminder', done_at: null }, null, tz);
      return send(res, 200, { ok: true, text: 'Нагадаю через годину' });
    }
    return send(res, 400, { error: 'Невідома дія.' });
  }
  let ticking = false;
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const s = load(), tz = s.tz, t = Date.now();
      // надіслане одноразове нагадування без реакції за добу вважаємо закритим
      db.prepare("UPDATE assistant_items SET done_at = sent_at, updated = ? WHERE kind = 'reminder' AND done_at IS NULL AND sent_at < ? AND repeat IS NULL").run(t, t - 864e5);
      // канали доставки: Telegram (якщо привʼязано) і push-сповіщення (якщо хоч один пристрій підписаний)
      const tg = bot.ready(), pu = push.has();
      if (tg || pu) {
        // нагадування, що прострочились понад 12 год і так і не були надіслані (каналу не було чи сервер стояв), не вивалюємо пачкою
        db.prepare("UPDATE assistant_items SET sent_at = ? WHERE kind = 'reminder' AND sent_at IS NULL AND done_at IS NULL AND repeat IS NULL AND due_at < ?").run(t, t - 12 * 3600e3);
        const due = db.prepare("SELECT * FROM assistant_items WHERE kind = 'reminder' AND due_at <= ? AND sent_at IS NULL AND done_at IS NULL ORDER BY due_at LIMIT 10").all(t);
        for (const it of due) {
          let ok = false;
          if (tg) ok = !!(await bot.sendReminder(it)) || ok;
          if (pu) ok = (await push.sendReminder(it, pushWhen(it))) > 0 || ok;
          if (ok) store.advanceAfterSend(it.id, tz);
        }
        await routines.tick();
        await habits.tick();
        const today = T.dayKey(t, tz), hm = T.hhmm(t, tz);
        if (s.morningOn && s.lastMorningDay !== today && hm >= s.morningTime && hm < '12:00') {
          update({ lastMorningDay: today });
          try { const text = await morningPlan(); if (text) await deliver('☀️ План на сьогодні', text); }
          catch (e) { console.error('[assistant] ранковий план:', e.message); }
        }
        if (s.summaryOn && s.anthropicKey && s.lastSummaryDay !== today && hm >= s.summaryTime) {
          update({ lastSummaryDay: today });
          try { const text = await summary(); if (text) await deliver('🌙 Підсумок дня', text); }
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
  const publicView = (s, admin, demo) => ({
    ...(admin ? {
      hasKey: !!s.anthropicKey, keyHint: s.anthropicKey ? '…' + s.anthropicKey.slice(-4) : '', model: s.model, botError: bot.lastError()
    } : {}),
    hasBot: !!s.botToken, botName: s.botName, linked: !!s.chatId,
    linkUrl: s.botName && !s.chatId && s.linkCode ? `https://t.me/${s.botName}?start=${s.linkCode}` : '',
    admin: !!admin, demo: !!demo, tz: s.tz, voiceLang: s.voiceLang, style: s.style || '',
    summaryTime: s.summaryTime, summaryOn: !!s.summaryOn, morningTime: s.morningTime, morningOn: !!s.morningOn
  });
  const ADMIN_ONLY = ['anthropicKey', 'clearKey', 'model', 'botToken', 'clearBot'];
  const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

  // Поля задачі від клієнта (веб, Android, Telegram). due — місцевий час YYYY-MM-DDTHH:MM або '' / null (прибрати строк).
  function itemFields(b, tz) {
    const v = {};
    if (b.text !== undefined) v.text = str(b.text, 2000);
    if (b.area !== undefined) { if (!store.isSpace(b.area)) return { error: 'Невідомий простір.' }; v.area = b.area; }
    if (b.status !== undefined) { if (!store.isStatus(b.status)) return { error: 'Невідомий статус.' }; v.status = b.status; }
    if (b.priority !== undefined) v.priority = Math.max(0, Math.min(2, +b.priority || 0));
    if (b.description !== undefined) v.description = str(b.description, 20000);
    if (b.tags !== undefined) v.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,#\s]+/)).map(x => str(x, 30)).filter(Boolean);
    if (b.kind !== undefined) { if (!['task', 'reminder', 'note'].includes(b.kind)) return { error: 'Невідомий тип.' }; v.kind = b.kind; }
    if (b.parent_id !== undefined) v.parent_id = +b.parent_id || null;
    if (b.due !== undefined) {
      if (!b.due) v.due_at = null;
      else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.due)) return { error: 'Неправильна дата.' };
      else v.due_at = T.localToUtc(b.due, tz);
    }
    return v;
  }
  function patchItem(id, v, tz) {
    const it = store.item(id), patch = {};
    for (const k of ['text', 'area', 'status', 'priority', 'kind', 'description', 'tags']) if (v[k] !== undefined) patch[k] = v[k];
    if (v.due_at !== undefined) patch.due_at = v.due_at;
    if (patch.kind === 'reminder' && !(patch.due_at !== undefined ? patch.due_at : it.due_at)) patch.kind = 'task';
    if (patch.due_at === null && it.repeat) patch.repeat = null;
    // повторювана задача → «готово»: переходить на наступний раз
    if (patch.status && store.isDoneStatus(patch.status) && it.repeat && it.due_at && !it.done_at) {
      delete patch.status; if (Object.keys(patch).length) store.updateItem(id, patch, null, tz);
      return store.completeItem(id, null, tz).item;
    }
    return store.updateItem(id, patch, null, tz);
  }
  const fullItem = (it, tz) => {
    if (!it) return null;
    const kids = db.prepare('SELECT * FROM assistant_items WHERE parent_id = ? ORDER BY position, id').all(it.id).map(c => store.view(c, tz));
    const parent = it.parent_id && store.item(it.parent_id);
    return { ...store.view(it, tz), children: kids, parent: parent ? { id: parent.id, text: parent.text } : null, updated: it.updated };
  };
  const metaInfo = tz => ({ spaces: store.spaces(), statuses: store.statuses(), icons: store.ICONS, counts: store.taskCounts({}, tz),
                            tags: store.tags().map(t => ({ name: t.name, open: t.open || 0 })), activity: store.activity(14, tz) });

  // Підказки просторів для задач у «Вхідних» (Claude). Нічого не змінює — лише пропонує.
  async function suggestAreas() {
    const s = load(), tz = s.tz;
    const rows = db.prepare(`SELECT * FROM assistant_items WHERE kind IN ('task', 'reminder') AND area = 'inbox' AND done_at IS NULL AND parent_id IS NULL
                             ORDER BY id DESC LIMIT 80`).all();
    if (!rows.length) return [];
    const spaces = store.spaces().filter(x => !x.archived && x.key !== 'inbox');
    const examples = key => db.prepare(`SELECT text FROM assistant_items WHERE kind IN ('task', 'reminder') AND area = ? ORDER BY updated DESC LIMIT 10`).all(key).map(r => '  - ' + r.text.slice(0, 120));
    const r = await claude(s, {
      max_tokens: 3000,
      system: 'Ти допомагаєш розкласти задачі власника по просторах. Якщо з тексту неможливо зрозуміти — unsure. Не вгадуй навмання.',
      tools: [{ name: 'classify', description: 'Простір для кожної задачі', input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'integer' }, area: { type: 'string', enum: [...spaces.map(x => x.key), 'unsure'] } }, required: ['id', 'area'] } } }, required: ['items'] } }],
      tool_choice: /(opus|sonnet|fable|mythos)/i.test(s.model) ? { type: 'auto' } : { type: 'tool', name: 'classify' },
      messages: [{ role: 'user', content: [
        'Простори:\n' + spaces.map(x => { const ex = examples(x.key); return `[${x.key}] ${x.name}${x.description ? ' — ' + x.description : ''}${ex.length ? '\n  приклади задач:\n' + ex.join('\n') : ''}`; }).join('\n'),
        'Розклади (виклич classify):\n' + rows.map(it => itemLine(it, tz)).join('\n')
      ].join('\n\n') }]
    });
    const use = (r.content || []).find(b => b.type === 'tool_use' && b.name === 'classify');
    const ok = new Set(rows.map(x => x.id)), keys = new Set(spaces.map(x => x.key));
    return ((use && use.input && use.input.items) || []).filter(x => ok.has(x.id) && keys.has(x.area));
  }

  async function handle(req, res, url, a, log) {
    const m = req.method, qs = new URL(req.url, 'http://x').searchParams, tz = load().tz;
    const admin = a.role === 'admin';
    if (url === '/api/assistant/settings' && m === 'GET') {
      let s = load(); if (!s.linkCode) s = update({ linkCode: newCode() });   // посилання для привʼязки Telegram
      return send(res, 200, publicView(s, admin, a.role === 'demo'));
    }
    if (url === '/api/assistant/settings' && m === 'POST') {
      const b = await readBody(req, 8192);
      if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      if (!admin && ADMIN_ONLY.some(k => b[k] != null && b[k] !== false && b[k] !== '')) return send(res, 403, { error: 'Ключ Claude, модель і бота Telegram змінює лише адміністратор.' });
      const s = load(), changed = [];
      if (b.style != null) { s.style = str(b.style, 1500); changed.push('стиль'); }
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
      return send(res, 200, publicView(s, admin, a.role === 'demo'));
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
    // ---------- довідники й лічильники ----------
    if (url === '/api/assistant/meta' && m === 'GET') return send(res, 200, metaInfo(tz));
    if (url === '/api/assistant/spaces' && m === 'GET') return send(res, 200, { list: store.spaces(), icons: store.ICONS });
    if (url === '/api/assistant/spaces' && m === 'POST') {
      const b = await readBody(req, 8192);
      try { const key = store.saveSpace(null, b || {}); log(a, 'assistant:space', key); return send(res, 200, { key, list: store.spaces() }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    let mm = /^\/api\/assistant\/spaces\/([a-z0-9]+)$/.exec(url);
    if (mm && (m === 'PATCH' || m === 'POST')) {
      const b = await readBody(req, 8192);
      try { store.saveSpace(mm[1], b || {}); return send(res, 200, { list: store.spaces() }); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (mm && m === 'DELETE') {
      try { const n = store.deleteSpace(mm[1]); log(a, 'assistant:space-delete', mm[1], { moved: n }); return send(res, 200, { moved: n, list: store.spaces() }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (url === '/api/assistant/statuses' && m === 'GET') return send(res, 200, { list: store.statuses() });

    // ---------- задачі ----------
    const F = () => Object.fromEntries(['area', 'view', 'status', 'q', 'tag', 'prio', 'sort', 'offset', 'limit'].map(k => [k, qs.get(k) || '']));
    if (url === '/api/assistant/tasks' && m === 'GET') {
      const f = F();
      return send(res, 200, { ...store.listTasks(f, tz), counts: store.taskCounts(f, tz) });
    }
    if (url === '/api/assistant/board' && m === 'GET') {
      const f = F();
      return send(res, 200, { columns: store.board(f, tz), counts: store.taskCounts(f, tz) });
    }
    if (url === '/api/assistant/items' && m === 'POST') {
      const b = await readBody(req, 65536); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      const v = itemFields(b, tz); if (v.error) return send(res, 400, v);
      if (!v.text) return send(res, 400, { error: 'Напишіть, що зробити.' });
      const it = store.createItem({ ...v, kind: v.kind === 'note' ? 'note' : v.kind === 'reminder' && v.due_at ? 'reminder' : 'task' }, null, tz);
      if (b.after != null || b.before != null) store.moveItem(it.id, { after: b.after, before: b.before }, tz);
      return send(res, 200, fullItem(store.item(it.id), tz));
    }
    mm = /^\/api\/assistant\/items\/(\d+)(?:\/(move|complete|reopen))?$/.exec(url);
    if (mm) {
      const id = +mm[1], it = store.item(id), sub = mm[2];
      if (!it) return send(res, 404, { error: 'Запис не знайдено.' });
      if (!sub && m === 'GET') return send(res, 200, fullItem(it, tz));
      if (!sub && m === 'PATCH') {
        const b = await readBody(req, 65536); if (!b) return send(res, 400, { error: 'Неправильні дані.' });
        const v = itemFields(b, tz); if (v.error) return send(res, 400, v);
        if (v.text === '') return send(res, 400, { error: 'Назва не може бути порожньою.' });
        return send(res, 200, fullItem(patchItem(id, v, tz), tz));
      }
      if (!sub && m === 'DELETE') { store.deleteItem(id, null); return send(res, 200, { ok: true }); }
      if (sub === 'move' && m === 'POST') {
        const b = await readBody(req, 4096) || {};
        if (b.status && !store.isStatus(b.status)) return send(res, 400, { error: 'Невідомий статус.' });
        if (b.area && !store.isSpace(b.area)) return send(res, 400, { error: 'Невідомий простір.' });
        return send(res, 200, fullItem(store.moveItem(id, b, tz), tz));
      }
      if (sub === 'complete' && m === 'POST') { const r = store.completeItem(id, null, tz); return send(res, 200, { ...fullItem(r.item, tz), next: r.next }); }
      if (sub === 'reopen' && m === 'POST') return send(res, 200, fullItem(store.reopenItem(id, null, tz), tz));
      return send(res, 405, { error: 'Метод не підтримується.' });
    }
    if (url === '/api/assistant/notes' && m === 'GET') {
      const text = (qs.get('q') || '').trim();
      let rows;
      if (text.startsWith('#')) rows = db.prepare(`SELECT i.* FROM assistant_items i JOIN assistant_item_tags x ON x.item_id = i.id JOIN assistant_tags t ON t.id = x.tag_id
                                                   WHERE i.kind = 'note' AND t.name = ? ORDER BY i.created DESC LIMIT 200`).all(text.slice(1).toLowerCase());
      else if (text) rows = store.search(text, { limit: 100, type: 'item' }).filter(r => r.kind === 'note').map(r => store.item(r.id));
      else rows = db.prepare("SELECT * FROM assistant_items WHERE kind = 'note' ORDER BY created DESC LIMIT 200").all();
      return send(res, 200, { list: rows.filter(Boolean).map(it => store.view(it, tz)) });
    }
    // Масові дії: done | reopen | delete | area | status | priority | due (today / tomorrow / week / none)
    if (url === '/api/assistant/bulk' && m === 'POST') {
      const b = await readBody(req, 65536);
      const ids = Array.isArray(b && b.ids) ? [...new Set(b.ids.map(Number).filter(Number.isInteger))].slice(0, 500) : [];
      if (!ids.length) return send(res, 400, { error: 'Нічого не вибрано.' });
      const today = T.dayKey(Date.now(), tz);
      const dueFor = { today: `${today}T18:00`, tomorrow: `${T.addDays(today, 1)}T09:00`, week: `${T.addDays(today, 7 - ((T.isoWeekday(today) + 6) % 7))}T09:00` };
      if (b.action === 'area' && !store.isSpace(b.value)) return send(res, 400, { error: 'Невідомий простір.' });
      if (b.action === 'status' && !store.isStatus(b.value)) return send(res, 400, { error: 'Невідомий статус.' });
      if (b.action === 'due' && !(b.value in dueFor) && b.value !== 'none') return send(res, 400, { error: 'Невідомий строк.' });
      let n = 0;
      db.transaction(() => {
        for (const id of ids) {
          const it = store.item(id); if (!it) continue;
          if (b.action === 'done') { if (!it.done_at) { store.completeItem(id, null, tz); n++; } }
          else if (b.action === 'reopen') { if (it.done_at) { store.reopenItem(id, null, tz); n++; } }
          else if (b.action === 'delete') { store.deleteItem(id, null); n++; }
          else if (b.action === 'area') { if (it.area !== b.value) { store.updateItem(id, { area: b.value }, null, tz); n++; } }
          else if (b.action === 'status') { if (it.status !== b.value) { patchItem(id, { status: b.value }, tz); n++; } }
          else if (b.action === 'priority') { store.updateItem(id, { priority: +b.value || 0 }, null, tz); n++; }
          else if (b.action === 'due') {
            store.updateItem(id, b.value === 'none' ? { due_at: null, repeat: null, ...(it.kind === 'reminder' ? { kind: 'task' } : {}) }
                                                    : { due_at: T.localToUtc(dueFor[b.value], tz) }, null, tz); n++;
          }
        }
      })();
      log(a, 'assistant:bulk', null, { action: b.action, value: b.value, n });
      return send(res, 200, { ok: true, changed: n });
    }
    if (url === '/api/assistant/triage' && m === 'POST') {
      try { return send(res, 200, { suggestions: await suggestAreas() }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (url === '/api/assistant/search' && m === 'GET') {
      const list = store.search(qs.get('q') || '', { limit: 40 });
      return send(res, 200, { list: list.map(r => ({ ...r, when: T.fmtWhen(r.at, tz) })) });
    }
    if ((url === '/api/assistant/summary' || url === '/api/assistant/plan') && m === 'POST') {
      const isPlan = url.endsWith('/plan');
      try {
        const text = isPlan ? await morningPlan() : await summary();
        const title = isPlan ? '☀️ План на сьогодні' : '🌙 Підсумок дня';
        const sent = !!(text && await deliver(title, text));
        return send(res, 200, { text: text || (isPlan ? 'На сьогодні нічого не заплановано.' : 'Сьогодні ще нічого не записано.'), sent });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }

  const unlinkTelegram = () => update({ chatId: null, linkCode: newCode() });
  return { handle, start, handleText, summary, morningPlan, tick, settings: load, store, pushAction, routines, habits, push, bot, unlinkTelegram };
}
