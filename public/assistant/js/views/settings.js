// Налаштування: простори, асистент (Claude), Telegram, розклад, вигляд, пристрої й входи, обліковий запис.
import { get, post, patch, del, api } from '../api.js';
import { icon, SPACE_ICONS } from '../icons.js';
import { $, $$, esc, pref, toast, fail, menu, confirmBox, fmtDate } from '../ui.js';
import { meta, refreshMeta } from '../store.js';

const TZ = [['Europe/Kyiv', 'Київ'], ['Europe/Chisinau', 'Кишинів'], ['Europe/Warsaw', 'Варшава'], ['Europe/Berlin', 'Берлін'], ['Europe/Prague', 'Прага'], ['Europe/London', 'Лондон'], ['America/New_York', 'Нью-Йорк']];
const CLIENT = { web: 'Браузер', android: 'Android', telegram: 'Telegram', app: 'Застосунок' };

export function settingsPage(sub) {
  let root, s = null, linkPoll = 0;
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page settings">
      <div class="page-head"><div class="page-icon">${icon('settings', 30)}</div><h1 class="page-title">Налаштування</h1></div>
      <nav class="set-nav">${[['spaces', 'Простори'], ['ai', 'Асистент'], ['tg', 'Telegram'], ['plan', 'Розклад'], ['look', 'Вигляд'], ['devices', 'Пристрої'], ['account', 'Обліковий запис']]
        .map(([k, l]) => `<a href="#/settings/${k}" data-k="${k}">${l}</a>`).join('')}</nav>

      <section class="set" id="set-spaces">
        <h2>Простори</h2>
        <p class="muted">Простори розділяють задачі: робота, особисте, магазин, навчання… Опис простору — підказка для асистента: за ним він одразу розкладає нові задачі. Що незрозуміло — потрапляє у «Вхідні».</p>
        <div class="spaces-list"></div>
        <button type="button" class="btn sm" data-a="space-add">${icon('plus', 14)}Новий простір</button>
      </section>

      <section class="set" id="set-ai">
        <h2>Асистент</h2>
        <p class="muted">Розуміє голос і текст, перетворює на задачі, нагадування й нотатки. Ключ створюється на <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>; зберігається лише на сервері.</p>
        <div class="kv"><span>Ключ Claude API</span><div><input type="password" data-f="anthropicKey" placeholder="sk-ant-…" autocomplete="off"><p class="small key-state"></p></div></div>
        <div class="kv"><span>Модель</span><div><input data-f="model" placeholder="claude-haiku-5-5"></div></div>
      </section>

      <section class="set" id="set-tg">
        <h2>Telegram</h2>
        <p class="muted">Бот приймає голосові й текст, надсилає нагадування, ранковий план і підсумок дня, а кнопка «Задачі» в ньому відкриває цей застосунок. Створіть бота в <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> (<code>/newbot</code>) і вставте токен.</p>
        <div class="kv"><span>Токен бота</span><div><input type="password" data-f="botToken" placeholder="123456789:AA…" autocomplete="off"></div></div>
        <div class="bot-state"></div>
      </section>

      <section class="set" id="set-plan">
        <h2>Розклад</h2>
        <div class="kv"><span>Часовий пояс</span><div><select data-f="tz">${TZ.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div></div>
        <div class="kv"><span>Ранковий план</span><div class="inline"><input type="time" data-f="morningTime" max="11:59"><label class="switch"><input type="checkbox" data-f="morningOn"><span>надсилати в Telegram</span></label></div></div>
        <div class="kv"><span>Підсумок дня</span><div class="inline"><input type="time" data-f="summaryTime"><label class="switch"><input type="checkbox" data-f="summaryOn"><span>надсилати в Telegram</span></label></div></div>
        <div class="kv"><span>Мова голосових у Telegram</span><div><select data-f="voiceLang"><option value="uk">Українська</option><option value="ru">Русский</option><option value="auto">Авто</option></select></div></div>
      </section>
      <div class="set-save"><p class="err"></p><button type="button" class="btn primary" data-a="save">Зберегти</button></div>

      <section class="set" id="set-look">
        <h2>Вигляд</h2>
        <div class="seg theme-seg">${[['system', 'Як у системі'], ['light', 'Світла'], ['dark', 'Темна']].map(([k, l]) => `<button type="button" data-theme="${k}">${l}</button>`).join('')}</div>
        <p class="muted small">Гарячі клавіші: <kbd>Ctrl K</kbd> або <kbd>/</kbd> — пошук і перехід, <kbd>N</kbd> — нова задача, <kbd>B</kbd> — список ↔ дошка, <kbd>Esc</kbd> — закрити.</p>
      </section>

      <section class="set" id="set-devices">
        <h2>Пристрої й входи</h2>
        <p class="muted">Звідки зараз виконано вхід: браузери, застосунок Android, Telegram. Для застосунків — вхід по токену через <code>POST /api/auth/token</code> (див. docs/API.md у репозиторії).</p>
        <div class="sessions"></div>
        <button type="button" class="btn sm" data-a="revoke">${icon('logout', 14)}Вийти на всіх інших пристроях</button>
      </section>

      <section class="set" id="set-account">
        <h2>Обліковий запис</h2>
        <div class="kv"><span>Поточний пароль</span><div><input type="password" data-p="old" autocomplete="current-password"></div></div>
        <div class="kv"><span>Новий пароль</span><div><input type="password" data-p="new" autocomplete="new-password" placeholder="щонайменше 8 символів"></div></div>
        <div class="row-act"><button type="button" class="btn sm" data-a="password">Змінити пароль</button><button type="button" class="btn sm ghost" data-a="logout">${icon('logout', 14)}Вийти</button></div>
      </section>
    </div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    $$('[data-theme]', root).forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === pref.get('theme', 'system'))));
    drawSpaces(); load(); loadSessions();
    if (sub) setTimeout(() => { const t = $('#set-' + sub, root); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }
  async function load() {
    try { fill(await get('assistant/settings')); } catch (e) { fail(e); }
  }
  function fill(x) {
    s = x;
    const f = k => $(`[data-f="${k}"]`, root);
    f('anthropicKey').value = ''; f('botToken').value = '';
    f('model').value = s.model;
    $('.key-state', root).innerHTML = s.hasKey ? `Ключ задано (${esc(s.keyHint)}) · <button type="button" class="link" data-a="clear-key">видалити</button>` : '<span class="muted">Ключ не задано — асистент не зможе розбирати повідомлення.</span>';
    const tz = f('tz'); tz.value = s.tz; if (tz.value !== s.tz) { tz.add(new Option(s.tz, s.tz)); tz.value = s.tz; }
    f('morningTime').value = s.morningTime; f('morningOn').checked = s.morningOn;
    f('summaryTime').value = s.summaryTime; f('summaryOn').checked = s.summaryOn;
    f('voiceLang').value = s.voiceLang;
    const bs = $('.bot-state', root);
    if (!s.hasBot) bs.innerHTML = '<p class="muted small">Бот не підключено.</p>';
    else if (!s.linked) bs.innerHTML = `<p>Бот <b>@${esc(s.botName)}</b> підключено. Привʼяжіть свій Telegram:</p><a class="btn primary sm" href="${esc(s.linkUrl)}" target="_blank" rel="noopener">${icon('telegram', 14)}Відкрити бота й натиснути Start</a>`;
    else bs.innerHTML = `<p>${icon('checkCircle', 14)} Привʼязано до <b>@${esc(s.botName)}</b>.</p><div class="row-act"><button type="button" class="btn sm ghost" data-a="unlink">Відвʼязати чат</button><button type="button" class="btn sm ghost danger" data-a="clear-bot">Видалити бота</button></div>`;
    if (s.botError) bs.insertAdjacentHTML('beforeend', `<p class="err small">${esc(s.botError)}</p>`);
    clearInterval(linkPoll);
    if (s.hasBot && !s.linked) linkPoll = setInterval(async () => { try { const n = await get('assistant/settings'); if (n.linked) fill(n); } catch (e) {} }, 3000);
  }
  async function saveSettings(extra) {
    const f = k => $(`[data-f="${k}"]`, root), err = $('.set-save .err', root); err.textContent = '';
    const body = extra || { model: f('model').value.trim() || 'claude-haiku-5-5', tz: f('tz').value, morningTime: f('morningTime').value || '08:00', morningOn: f('morningOn').checked,
                            summaryTime: f('summaryTime').value || '21:00', summaryOn: f('summaryOn').checked, voiceLang: f('voiceLang').value };
    if (!extra && f('anthropicKey').value.trim()) body.anthropicKey = f('anthropicKey').value.trim();
    if (!extra && f('botToken').value.trim()) body.botToken = f('botToken').value.trim();
    try { fill(await post('assistant/settings', body)); toast('Збережено'); } catch (e) { err.textContent = e.message; }
  }

  // ---------- простори ----------
  function drawSpaces() {
    $('.spaces-list', root).innerHTML = meta.spaces.map(sp => `<div class="sp-row${sp.archived ? ' arch' : ''}" data-key="${sp.key}">
      <button type="button" class="icon-btn sp-ic" data-a="sp-icon" title="Іконка">${icon(sp.icon, 18)}</button>
      <div class="sp-main">
        <input class="sp-name" value="${esc(sp.name)}" maxlength="40" aria-label="Назва">
        <textarea class="sp-desc" rows="1" maxlength="600" placeholder="${sp.key === 'inbox' ? 'Вхідні — для нерозкладених задач' : 'Що сюди належить: напр. інтернет-магазин, клієнти, постачальники, LP-CRM…'}" ${sp.key === 'inbox' ? 'disabled' : ''}>${esc(sp.key === 'inbox' ? '' : sp.description)}</textarea>
      </div>
      <button type="button" class="icon-btn" data-a="sp-more" title="Ще">${icon('more')}</button>
    </div>`).join('');
  }
  async function saveSpace(key, body) {
    try { await patch('assistant/spaces/' + key, body); await refreshMeta(); } catch (e) { fail(e); }
  }

  // ---------- пристрої ----------
  async function loadSessions() {
    try {
      const { list } = await get('sessions');
      $('.sessions', root).innerHTML = list.map(x => `<div class="sess">${icon(x.client === 'web' ? 'eye' : x.client === 'telegram' ? 'telegram' : 'device', 16)}
        <span><b>${esc(CLIENT[x.client] || x.client)}</b>${x.current ? ' · цей пристрій' : ''}</span><span class="muted small">активність ${esc(fmtDate(x.last_used))}</span></div>`).join('');
    } catch (e) {}
  }

  async function onClick(e) {
    const a = e.target.closest('[data-a]'), th = e.target.closest('[data-theme]');
    if (th) { window.MDMY.setTheme(th.dataset.theme); $$('[data-theme]', root).forEach(b => b.setAttribute('aria-checked', String(b === th))); return; }
    if (!a) return;
    const k = a.dataset.a, row = a.closest('[data-key]'), key = row && row.dataset.key;
    if (k === 'save') saveSettings();
    if (k === 'clear-key' && await confirmBox('Видалити ключ Claude API?')) saveSettings({ clearKey: true });
    if (k === 'unlink' && await confirmBox('Відвʼязати Telegram-чат? Нагадування перестануть приходити.', { ok: 'Відвʼязати' })) saveSettings({ unlink: true });
    if (k === 'clear-bot' && await confirmBox('Видалити бота з налаштувань?')) saveSettings({ clearBot: true });
    if (k === 'space-add') {
      try { await post('assistant/spaces', { name: 'Новий простір', icon: 'folder' }); await refreshMeta(); drawSpaces(); const r = [...$$('.sp-name', root)].pop(); r.focus(); r.select(); } catch (err) { fail(err); }
    }
    if (k === 'sp-icon') {
      const v = await menu(a, SPACE_ICONS.map(n => ({ value: n, label: n, icon: n })), { width: 200 });
      if (v) { await saveSpace(key, { icon: v }); drawSpaces(); }
    }
    if (k === 'sp-more') {
      const sp = meta.spaces.find(x => x.key === key);
      const items = [{ value: 'up', label: 'Вище', icon: 'chevronDown' }, { value: 'down', label: 'Нижче', icon: 'chevronDown' }];
      if (key !== 'inbox') items.push({ value: 'arch', label: sp.archived ? 'Повернути з архіву' : 'В архів (сховати)', icon: 'inbox' });
      if (!sp.system) items.push({ sep: true }, { value: 'del', label: 'Видалити простір', icon: 'trash', danger: true });
      const v = await menu(a, items);
      const list = meta.spaces, i = list.findIndex(x => x.key === key);
      if (v === 'up' && i > 0) await saveSpace(key, { position: (list[i - 1].position + (i > 1 ? list[i - 2].position : list[i - 1].position - 2)) / 2 });
      if (v === 'down' && i < list.length - 1) await saveSpace(key, { position: (list[i + 1].position + (i < list.length - 2 ? list[i + 2].position : list[i + 1].position + 2)) / 2 });
      if (v === 'arch') await saveSpace(key, { archived: !sp.archived });
      if (v === 'del' && await confirmBox(`Видалити простір «${sp.name}»? Його задачі повернуться у «Вхідні».`)) {
        try { const r = await del('assistant/spaces/' + key); await refreshMeta(); toast(`Видалено. У вхідні повернулося задач: ${r.moved}`); } catch (err) { fail(err); }
      }
      drawSpaces();
    }
    if (k === 'revoke' && await confirmBox('Вийти на всіх інших пристроях (браузери, Android, Telegram)?', { ok: 'Вийти' })) {
      try { const r = await api('sessions/others', { method: 'DELETE' }); toast('Завершено сесій: ' + r.revoked); loadSessions(); } catch (err) { fail(err); }
    }
    if (k === 'password') {
      const o = $('[data-p="old"]', root), n = $('[data-p="new"]', root);
      try { await post('password', { old: o.value, password: n.value }); o.value = ''; n.value = ''; toast('Пароль змінено. Інші пристрої вийдуть із системи.'); } catch (err) { fail(err); }
    }
    if (k === 'logout') window.MDMY.logout();
  }
  async function onChange(e) {
    const row = e.target.closest('[data-key]'); if (!row) return;
    if (e.target.classList.contains('sp-name') && e.target.value.trim()) saveSpace(row.dataset.key, { name: e.target.value.trim() });
    if (e.target.classList.contains('sp-desc')) saveSpace(row.dataset.key, { description: e.target.value.trim() });
  }
  return { render, destroy: () => clearInterval(linkPoll), refresh: () => { drawSpaces(); } };
}
