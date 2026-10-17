// Telegram-бот персонального асистента (lib/assistant.js). Без сторонніх бібліотек: Bot API через fetch, long polling.
// Бот приватний: працює лише з одним чатом, привʼязаним кодом зі сторінки /assistant (посилання t.me/<бот>?start=<код>).
// Голосові → служба розшифровки (lib/stt.js) → асистент. Під кожною відповіддю з діями — кнопка «↩️ Скасувати».
// Нагадування: одноразові — «Готово / +1 год / Завтра», повторювані — «Готово / +1 год / Зупинити повтор».
const stt = require('./stt');

const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const COMMANDS = [
  ['today', 'Що сьогодні'], ['plan', 'План дня'], ['tasks', 'Усі задачі'], ['notes', 'Останні нотатки'],
  ['find', 'Пошук: /find слово'], ['state', 'Стан за тиждень'], ['summary', 'Підсумок дня'], ['undo', 'Скасувати останнє'], ['help', 'Довідка']
];
const HELP = [
  'Надсилай голосові або текст — я зрозумію й збережу:',
  '• «нагадай завтра о 10 подзвонити мамі» → нагадування',
  '• «щопонеділка о 9 планування тижня» → повторюване',
  '• «треба купити фільтр, проєкт дім, важливо» → задача',
  '• «у задачу ремонт додай купити фарбу» → підзадача',
  '• «купив фільтр» / «перенеси дзвінок на пʼятницю» → виконано / змінено',
  '• думки, ідеї → нотатки з тегами',
  '• «настрій 7, спав 6 годин, зробив зарядку» → щоденник стану',
  '• «що я казав про сайт?», «як я спав цього тижня?» → знайду й відповім',
  '• «скасуй» або кнопка ↩️ → відміню останнє',
  '',
  'Команди: ' + COMMANDS.map(([c, d]) => `/${c} — ${d.toLowerCase()}`).join(', ') + '.'
].join('\n');

module.exports = function makeBot(ctx) {
  const { store, T } = ctx;
  let gen = 0, lastError = '';

  async function call(token, method, params, timeoutMs = 20e3) {
    let r;
    try {
      r = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params || {}), signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) { const err = new Error(e.name === 'TimeoutError' ? 'немає відповіді' : e.message); err.network = true; throw err; }
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) { const e = new Error((d && d.description) || `HTTP ${r.status}`); e.code = d && d.error_code; throw e; }
    return d.result;
  }
  const token = () => ctx.load().botToken;
  const ready = () => { const s = ctx.load(); return !!(s.botToken && s.chatId); };
  const typing = () => { const s = ctx.load(); call(s.botToken, 'sendChatAction', { chat_id: s.chatId, action: 'typing' }).catch(() => {}); };

  async function sendText(text, extra = {}, chatId) {
    const s = ctx.load(), chat = chatId || s.chatId;
    if (!s.botToken || !chat) return false;
    const chunks = [];
    for (let rest = String(text); rest.length; rest = rest.slice(4000)) chunks.push(rest.slice(0, 4000));
    try {
      let last = null;
      for (let i = 0; i < chunks.length; i++) {
        last = await call(s.botToken, 'sendMessage', { chat_id: chat, text: chunks[i], disable_web_page_preview: true, ...(i === chunks.length - 1 ? extra : {}) });
      }
      return last || true;
    } catch (e) { lastError = 'Не вдалося надіслати: ' + e.message; console.error('[telegram]', lastError); return false; }
  }

  // ---------- нагадування ----------
  function reminderKeyboard(it) {
    return { inline_keyboard: [it.repeat
      ? [{ text: '✅ Готово', callback_data: `ack:${it.id}` }, { text: '⏱ +1 год', callback_data: `snz:${it.id}:60` }, { text: '🛑 Зупинити повтор', callback_data: `stop:${it.id}` }]
      : [{ text: '✅ Готово', callback_data: `done:${it.id}` }, { text: '⏱ +1 год', callback_data: `snz:${it.id}:60` }, { text: '🌅 Завтра', callback_data: `tmr:${it.id}` }]] };
  }
  const sendReminder = it => sendText(`⏰ ${it.text}${it.priority ? ' ' + ['', '❗', '‼️'][it.priority] : ''}`, { reply_markup: reminderKeyboard(it) });

  // Відкласти: одноразове — переносимо; повторюване — окрема одноразова копія (серія не збивається)
  function snooze(id, how, tz) {
    const it = store.item(id); if (!it) return null;
    let at;
    if (how === 'tomorrow') at = T.localToUtc(`${T.addDays(T.dayKey(Date.now(), tz), 1)}T09:00`, tz);
    else at = Date.now() + Math.max(5, Math.min(7 * 1440, +how || 60)) * 60e3;
    if (it.repeat) { store.cloneOnce(id, at, null, tz); return at; }
    store.updateItem(id, { due_at: at, kind: 'reminder', done_at: null }, null, tz);
    return at;
  }

  // ---------- відповіді на команди ----------
  const line = (it, tz) => { const v = store.view(it, tz);
    return `${v.priority ? ['', '❗', '‼️'][v.priority] + ' ' : ''}${v.text}${v.when ? ' — ' + v.when : ''}${v.repeatText ? ' 🔁' : ''}${v.project ? ' · 📁 ' + v.project : ''}`; };
  function todayText() {
    const tz = ctx.load().tz, t = Date.now(), start = T.dayStart(t, tz), end = T.localToUtc(`${T.addDays(T.dayKey(t, tz), 1)}T00:00`, tz);
    const open = store.openItems();
    const overdue = open.filter(it => it.due_at && it.due_at < start && !it.sent_at);
    const today = open.filter(it => it.due_at && it.due_at >= start && it.due_at < end);
    const noDate = open.filter(it => !it.due_at && it.kind === 'task' && !it.parent_id);
    const L = [];
    if (overdue.length) L.push('⚠️ Прострочене:', ...overdue.map(it => '• ' + line(it, tz)), '');
    if (today.length) L.push('📅 Сьогодні:', ...today.map(it => `• ${T.hhmm(it.due_at, tz)} ${it.text}${it.repeat ? ' 🔁' : ''}${it.sent_at ? ' ✓' : ''}`), '');
    if (noDate.length) L.push('☑️ Без строку:', ...noDate.slice(0, 15).map(it => '• ' + line(it, tz)));
    return L.length ? L.join('\n').trim() : 'На сьогодні нічого не заплановано 🙂';
  }
  function tasksMessage() {
    const tz = ctx.load().tz, open = store.openItems().filter(it => !it.parent_id);
    if (!open.length) return { text: 'Відкритих задач і нагадувань немає 🎉' };
    const groups = new Map();
    for (const it of open) { const p = it.project_id && store.project(it.project_id); const k = p ? '📁 ' + p.name : 'Без проєкту'; (groups.get(k) || groups.set(k, []).get(k)).push(it); }
    const L = [];
    for (const [k, list] of [...groups].sort((a, b) => a[0] === 'Без проєкту' ? 1 : b[0] === 'Без проєкту' ? -1 : a[0].localeCompare(b[0]))) {
      L.push(k + ':');
      for (const it of list.slice(0, 20)) {
        L.push('• ' + line(it, tz).replace(/ · 📁 .*$/, ''));
        for (const c of store.openItems().filter(x => x.parent_id === it.id)) L.push('   ↳ ' + c.text);
      }
      L.push('');
    }
    const kb = open.slice(0, 10).map(it => [{ text: '✅ ' + it.text.slice(0, 40), callback_data: `done:${it.id}` }]);
    return { text: L.join('\n').trim() + '\n\nНатисни, щоб позначити виконаним:', extra: { reply_markup: { inline_keyboard: kb } } };
  }
  function notesText() {
    const tz = ctx.load().tz;
    const rows = ctx.db.prepare("SELECT * FROM assistant_items WHERE kind = 'note' ORDER BY created DESC LIMIT 10").all();
    if (!rows.length) return 'Нотаток ще немає. Просто надиктуй думку — збережу.';
    return 'Останні нотатки:\n\n' + rows.map(n => { const tags = store.tagsOf(n.id); return `${T.fmtWhen(n.created, tz)}${tags.length ? ' · #' + tags.join(' #') : ''}\n${n.text}`; }).join('\n\n');
  }
  function findText(query) {
    const tz = ctx.load().tz;
    if (!query) return 'Напиши, що шукати: /find сайт\nАбо просто спитай: «що я казав про сайт?»';
    const res = store.search(query, { limit: 12 });
    if (!res.length) return `За «${query}» нічого не знайшов.`;
    const icon = { note: '📝', task: '☑️', reminder: '⏰' };
    return `Знайдено за «${query}»:\n\n` + res.map(r => r.type === 'msg'
      ? `🗣 ${T.fmtWhen(r.at, tz)}: «${r.text.slice(0, 200)}»`
      : `${icon[r.kind]} ${r.done ? '✓ ' : ''}${r.text.slice(0, 200)}${r.tags.length ? ' #' + r.tags.join(' #') : ''}`).join('\n\n');
  }
  function stateText() {
    const st = store.state(7, ctx.load().tz);
    const filled = st.days.filter(d => d.mood != null || d.energy != null || d.sleep != null || d.habits.length);
    if (!filled.length) return 'Записів стану за тиждень немає.\nСкажи, наприклад: «настрій 7, енергія 6, спав 7 годин, зробив зарядку».';
    const names = Object.fromEntries(st.habits.map(h => [h.id, h.name]));
    const wd = d => T.WD_SHORT[T.isoWeekday(d) % 7];
    return ['📊 Стан за 7 днів', '',
      ...filled.map(d => `${wd(d.day)} ${d.day.slice(8)}.${d.day.slice(5, 7)}: ` + [d.mood != null && `😊 ${d.mood}`, d.energy != null && `⚡ ${d.energy}`, d.sleep != null && `😴 ${d.sleep} год`,
        d.habits.length && '✓ ' + d.habits.map(h => names[h]).join(', ')].filter(Boolean).join(' · ')),
      '', `Середні: настрій ${st.avg.mood ?? '—'}, енергія ${st.avg.energy ?? '—'}, сон ${st.avg.sleep ?? '—'} год`,
      st.habits.length ? 'Звички: ' + st.habits.map(h => `${h.name} ${h.count}/7`).join(', ') : ''].filter(x => x !== false).join('\n').trim();
  }
  function resultMessage(r) {
    if (r.error) return { text: '⚠️ ' + r.error };
    const text = [r.reply, r.done.length ? r.done.join('\n') : ''].filter(Boolean).join('\n\n') || 'Записав 👍';
    return { text, extra: r.undoable ? { reply_markup: { inline_keyboard: [[{ text: '↩️ Скасувати', callback_data: `undo:${r.msgId}` }]] } } : {} };
  }

  // ---------- вхідні оновлення ----------
  async function onMessage(msg) {
    const s = ctx.load(), chat = msg.chat && msg.chat.id;
    if (!chat || msg.chat.type !== 'private') return;
    const text = (msg.text || '').trim();

    if (!s.chatId) {
      const code = /^\/start\s+(\S+)/.exec(text);
      if (code && s.linkCode && code[1] === s.linkCode) {
        // якщо привʼязали вже після часу плану/підсумку — перші прийдуть наступного дня
        const now = Date.now(), hm = T.hhmm(now, s.tz), today = T.dayKey(now, s.tz);
        ctx.update({ chatId: chat, linkCode: ctx.newCode(),
                     ...(hm >= s.summaryTime ? { lastSummaryDay: today } : {}), ...(hm >= s.morningTime ? { lastMorningDay: today } : {}) });
        return sendText('Привʼязано ✅ Тепер я твій персональний асистент.\n\n' + HELP, {}, chat);
      }
      return sendText('Це приватний бот. Відкрий його за посиланням зі сторінки налаштувань.', {}, chat);
    }
    if (chat !== s.chatId) return;   // чужі чати ігноруємо

    const cmd = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text);
    if (cmd) {
      const [, c, arg] = cmd;
      if (c === 'start' || c === 'help') return sendText(HELP);
      if (c === 'today') return sendText(todayText());
      if (c === 'tasks') { const m = tasksMessage(); return sendText(m.text, m.extra); }
      if (c === 'notes') return sendText(notesText());
      if (c === 'find') return sendText(findText(arg.trim()));
      if (c === 'state') return sendText(stateText());
      if (c === 'undo') {
        const prev = store.lastUndoable();
        const r = prev ? ctx.undo(prev) : [];
        return sendText(r.length ? '↩️ Скасовано: ' + r.join('; ') : 'Немає що скасовувати.');
      }
      if (c === 'plan' || c === 'summary') {
        typing();
        try {
          const t = c === 'plan' ? await ctx.morningPlan() : await ctx.summary();
          return sendText(t ? (c === 'plan' ? '☀️ План на сьогодні\n\n' : '🌙 Підсумок дня\n\n') + t : (c === 'plan' ? 'На сьогодні нічого не заплановано 🙂' : 'Сьогодні ще нічого не записано.'));
        } catch (e) { return sendText('⚠️ ' + e.message); }
      }
      return sendText('Не знаю такої команди.\n\n' + HELP);
    }

    const media = msg.voice || msg.audio || msg.video_note;
    if (media) {
      typing();
      let heard;
      try {
        const f = await call(s.botToken, 'getFile', { file_id: media.file_id });
        const r = await fetch(`${API}/file/bot${s.botToken}/${f.file_path}`, { signal: AbortSignal.timeout(60e3) });
        if (!r.ok) throw new Error('не вдалося завантажити файл');
        heard = await stt.transcribe(Buffer.from(await r.arrayBuffer()), s.voiceLang);
      } catch (e) { return sendText('⚠️ Не вдалося розшифрувати: ' + e.message); }
      const said = (heard.text || '').trim();
      if (!said) return sendText('Не розчув 🤔 Спробуй ще раз, ближче до мікрофона.');
      typing();
      const m = resultMessage(await ctx.handleText(said, 'telegram-voice'));
      return sendText(`🎙 «${said}»\n\n${m.text}`, m.extra);
    }
    if (text) {
      typing();
      const m = resultMessage(await ctx.handleText(text, 'telegram'));
      return sendText(m.text, m.extra);
    }
  }

  async function onCallback(q) {
    const s = ctx.load(), tz = s.tz;
    const answer = text => call(s.botToken, 'answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
    if (!q.message || q.message.chat.id !== s.chatId) return answer('Недоступно');
    const m = /^(done|ack|snz|tmr|stop|undo):(\d+)(?::(\d+))?$/.exec(q.data || '');
    if (!m) return answer('Невідома кнопка');
    const id = +m[2];
    const editText = (extra) => call(s.botToken, 'editMessageText', { chat_id: s.chatId, message_id: q.message.message_id, text: `${q.message.text}\n\n${extra}` }).catch(() => {});

    if (m[1] === 'undo') {
      const r = ctx.undo(id);
      await answer(r.length ? 'Скасовано' : 'Вже скасовано');
      return editText(r.length ? '↩️ Скасовано: ' + r.join('; ') : '↩️ Вже скасовано');
    }
    const it = store.item(id);
    if (!it) return answer('Запис уже видалено');
    let status;
    if (m[1] === 'done') { const r = store.completeItem(id, null, tz); status = r.next ? '✅ Готово, наступний раз ' + T.fmtWhen(r.next, tz) : '✅ Виконано'; }
    else if (m[1] === 'ack') status = '✅ Готово' + (it.due_at ? ', наступний раз ' + T.fmtWhen(it.due_at, tz) : '');
    else if (m[1] === 'stop') { store.updateItem(id, { repeat: null, done_at: Date.now() }, null, tz); status = '🛑 Повтор зупинено'; }
    else if (m[1] === 'snz') status = '⏱ Нагадаю ' + T.fmtWhen(snooze(id, +m[3] || 60, tz), tz);
    else status = '🌅 Нагадаю ' + T.fmtWhen(snooze(id, 'tomorrow', tz), tz);
    await answer(status);
    // у нагадуванні замінюємо кнопки на статус; у списку задач — лише прибираємо натиснуту кнопку
    if (/^⏰/.test(q.message.text || '')) return editText(status);
    if (q.message.reply_markup) {
      const kb = q.message.reply_markup.inline_keyboard.filter(row => !row.some(b => b.callback_data === q.data));
      await call(s.botToken, 'editMessageReplyMarkup', { chat_id: s.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: kb } }).catch(() => {});
    }
  }

  // ---------- long polling ----------
  async function loop(myGen) {
    // номер останнього обробленого оновлення зберігається в базі: після перезапуску сервера
    // (а автооновлення перезапускає його з кожним комітом) жодне повідомлення не виконається двічі
    let offset = (ctx.load().lastUpdateId || 0) + 1, delay = 2e3;
    const t = token();
    try { await call(t, 'deleteWebhook', {}); } catch (e) {}
    try { await call(t, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }); } catch (e) {}
    while (myGen === gen) {
      try {
        const updates = await call(t, 'getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 70e3);
        if (myGen !== gen) break;
        lastError = ''; delay = 2e3;
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.update_id <= (ctx.load().lastUpdateId || 0)) continue;
          ctx.update({ lastUpdateId: u.update_id });   // фіксуємо ДО обробки: краще пропустити одне, ніж виконати двічі
          try { if (u.message) await onMessage(u.message); else if (u.callback_query) await onCallback(u.callback_query); }
          catch (e) { console.error('[telegram] обробка:', e); }
        }
      } catch (e) {
        if (myGen !== gen) break;
        lastError = e.message;
        if (e.code === 401 || e.code === 404) { console.error('[telegram] токен недійсний, бот зупинено'); lastError = 'Токен бота недійсний.'; break; }
        console.error('[telegram] getUpdates:', e.message);
        await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 60e3);
      }
    }
  }
  function restart() { gen++; if (token()) loop(gen); }

  return { ready, sendText, sendReminder, restart, lastError: () => lastError, getMe: t => call(t, 'getMe', {}) };
};
