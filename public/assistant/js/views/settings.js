// Налаштування: простори, асистент (Claude), стиль спілкування, сповіщення, Telegram, розклад, вигляд, пристрої й входи, обліковий запис.
// «Асистент» і «Telegram» (ключ Claude, модель, бот) бачить і змінює лише адміністратор (accounts.role = 'admin').
import { get, post, patch, del, api } from '../api.js';
import { icon, SPACE_ICONS } from '../icons.js';
import { $, $$, esc, pref, toast, fail, menu, confirmBox, fmtDate, sheet } from '../ui.js';
import { meta, refreshMeta } from '../store.js';
import * as push from '../push.js';

const TZ = [['Europe/Kyiv', 'Київ'], ['Europe/Chisinau', 'Кишинів'], ['Europe/Warsaw', 'Варшава'], ['Europe/Berlin', 'Берлін'], ['Europe/Prague', 'Прага'], ['Europe/London', 'Лондон'], ['America/New_York', 'Нью-Йорк']];
const ADMIN = ['ai', 'google', 'users'];                // ключ Claude і модель — лише для адміністратора; бота (токен) — теж, а привʼязати свій Telegram може кожен
const STYLES = [
  ['Коротко', 'Відповідай дуже коротко, 1–2 речення, без вступів і без емодзі.'],
  ['Дружньо', 'Звертайся на «ти», тепло й підбадьорливо, можна 1–2 емодзі.'],
  ['Діловито', 'Стримано й по суті, на «ви», списками, без емодзі.'],
  ['З гумором', 'Легко і з добрим гумором, але без зайвого тексту.']
];
const CLIENT = { web: 'Браузер', android: 'Android', telegram: 'Telegram', app: 'Застосунок' };

export function settingsPage(sub) {
  let root, s = null, linkPoll = 0;
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page settings">
      <div class="page-head"><h1 class="page-title">Налаштування</h1></div>
      <nav class="set-nav">${[['spaces', 'Простори'], ['ai', 'Асистент'], ['style', 'Стиль спілкування'], ['notify', 'Сповіщення'], ['tg', 'Telegram'], ['plan', 'Розклад'], ['look', 'Вигляд'], ['team', 'Команда'], ['devices', 'Пристрої'], ['account', 'Обліковий запис'], ['google', 'Вхід через Google'], ['users', 'Користувачі']]
        .map(([k, l]) => `<a href="#/settings/${k}" data-k="${k}"${ADMIN.includes(k) ? ' hidden' : ''}>${l}</a>`).join('')}</nav>

      <section class="set" id="set-spaces">
        <h2>Простори</h2>
        <p class="muted">Простори розділяють задачі: робота, особисте, магазин, навчання… Опис простору — підказка для асистента: за ним він одразу розкладає нові задачі. Що незрозуміло — потрапляє у «Вхідні».</p>
        <div class="spaces-list"></div>
        <button type="button" class="btn sm" data-a="space-add">${icon('plus', 14)}Новий простір</button>
      </section>

      <section class="set" id="set-ai" hidden>
        <h2>Асистент</h2>
        <p class="muted">Розуміє голос і текст, перетворює на задачі, нагадування й нотатки. Ключ створюється на <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>; зберігається лише на сервері.</p>
        <div class="kv"><span>Ключ Claude API</span><div><input type="password" data-f="anthropicKey" placeholder="sk-ant-…" autocomplete="off"><p class="small key-state"></p></div></div>
        <div class="kv"><span>Модель</span><div><input data-f="model" placeholder="claude-haiku-5-5"></div></div>
      </section>

      <section class="set" id="set-style">
        <h2>Стиль спілкування</h2>
        <p class="muted">Опишіть своїми словами, як асистент має з вами говорити — у застосунку й у Telegram: відповіді, ранковий план, підсумок дня.</p>
        <div class="style-presets">${STYLES.map(([l, t]) => `<button type="button" class="chip" data-style="${esc(t)}">${l}</button>`).join('')}</div>
        <textarea class="style-in" data-f="style" rows="4" maxlength="1500" placeholder="Наприклад: на «ти», коротко, без зайвих емодзі. Ранковий план — списком із 3 головних справ. Підсумок — чесно, з одним порадою на завтра."></textarea>
        <div class="row-act"><button type="button" class="btn sm primary" data-a="style-save">Зберегти стиль</button><span class="muted small style-state"></span></div>
      </section>

      <section class="set" id="set-notify">
        <h2>Сповіщення</h2>
        <p class="muted">Нагадування, ранковий план і підсумок дня приходять прямо на телефон чи компʼютер — навіть коли mdmy закрито. У нагадуванні є кнопки «Готово» і «+1 год». Працює паралельно з Telegram.</p>
        <div class="push-state"></div>
        <div class="push-devices"></div>
      </section>

      <section class="set" id="set-tg">
        <h2>Telegram</h2>
        <p class="muted">Бот приймає голосові й текст, надсилає нагадування, ранковий план і підсумок дня, а кнопка «Задачі» в ньому відкриває цей застосунок.<span class="admin-only" hidden> Створіть бота в <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> (<code>/newbot</code>) і вставте токен.</span></p>
        <div class="kv admin-only" hidden><span>Токен бота</span><div><input type="password" data-f="botToken" placeholder="123456789:AA…" autocomplete="off"></div></div>
        <div class="bot-state"></div>
      </section>

      <section class="set" id="set-plan">
        <h2>Розклад</h2>
        <div class="kv"><span>Часовий пояс</span><div><select data-f="tz">${TZ.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div></div>
        <div class="kv"><span>Ранковий план</span><div class="inline"><input type="time" data-f="morningTime" max="11:59"><label class="switch"><input type="checkbox" data-f="morningOn"><span>надсилати (сповіщення й Telegram)</span></label></div></div>
        <div class="kv"><span>Підсумок дня</span><div class="inline"><input type="time" data-f="summaryTime"><label class="switch"><input type="checkbox" data-f="summaryOn"><span>надсилати (сповіщення й Telegram)</span></label></div></div>
        <div class="kv"><span>Мова голосових у Telegram</span><div><select data-f="voiceLang"><option value="uk">Українська</option><option value="ru">Русский</option><option value="auto">Авто</option></select></div></div>
      </section>
      <div class="set-save"><p class="err"></p><button type="button" class="btn primary" data-a="save">Зберегти</button></div>

      <div class="demo-out" hidden><p class="muted">Гостьовий вхід: демо-дані, окремі від інших. Асистент — до 40 запитів на день.</p><button type="button" class="btn sm ghost" data-a="logout">${icon('logout', 14)}Вийти</button></div>

      <section class="set" id="set-look">
        <h2>Вигляд</h2>
        <div class="seg theme-seg">${[['system', 'Як у системі'], ['light', 'Світла'], ['dark', 'Темна']].map(([k, l]) => `<button type="button" data-theme="${k}">${l}</button>`).join('')}</div>
        <p class="muted small">Гарячі клавіші: <kbd>Ctrl K</kbd> або <kbd>/</kbd> — пошук і перехід, <kbd>N</kbd> — нова задача, <kbd>B</kbd> — список ↔ дошка, <kbd>Esc</kbd> — закрити.</p>
      </section>

      <section class="set" id="set-team">
        <h2>Команда</h2>
        <p class="muted">Доручення між акаунтами mdmy: хтось дає вам задачу, ви виконуєте й надсилаєте звіт із фото чи файлом, він підтверджує. Усе — у розділі «Доручення».</p>
        <div class="kv"><span>Мій ID</span><div class="inline"><b class="team-id"></b><button type="button" class="link" data-a="copy-id">копіювати</button></div></div>
        <div class="kv"><span>Отримувати задачі від</span><div><form class="inline team-allow"><input placeholder="ID людини, напр. K7Q2XP" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false" style="width:200px"><button class="btn sm primary" type="submit">Дозволити</button></form>
          <p class="muted small">Ця людина зможе давати вам задачі й бачити ваші звіти до них — і нічого більше з ваших записів.</p></div></div>
        <div class="team-lists"></div>
      </section>

      <section class="set" id="set-devices">
        <h2>Пристрої й входи</h2>
        <p class="muted">Звідки зараз виконано вхід: браузери, застосунок Android, Telegram. Для застосунків — вхід по токену через <code>POST /api/auth/token</code> (див. docs/API.md у репозиторії).</p>
        <div class="sessions"></div>
        <button type="button" class="btn sm" data-a="revoke">${icon('logout', 14)}Вийти на всіх інших пристроях</button>
      </section>

      <section class="set" id="set-account">
        <h2>Обліковий запис</h2>
        <div class="acc-who"></div>
        <div class="acc-google"></div>
        <div class="acc-quota"></div>
        <div class="acc-pass">
          <div class="kv acc-old"><span>Поточний пароль</span><div><input type="password" data-p="old" autocomplete="current-password"></div></div>
          <div class="kv"><span class="acc-new-l">Новий пароль</span><div><input type="password" data-p="new" autocomplete="new-password" placeholder="щонайменше 8 символів"></div></div>
          <div class="row-act"><button type="button" class="btn sm" data-a="password">Змінити пароль</button><button type="button" class="btn sm ghost" data-a="logout">${icon('logout', 14)}Вийти</button></div>
        </div>
        <div class="danger-zone">
          <div class="dz-row"><div><b>Почати спочатку</b><p class="muted small">Стерти всі задачі, нотатки, звички, щоденні завдання й історію розмов. Акаунт, вхід, налаштування й Telegram залишаться.</p></div>
            <button type="button" class="btn sm ghost danger" data-a="reset">Очистити</button></div>
          <div class="dz-row acc-del"><div><b>Видалити акаунт</b><p class="muted small">Назавжди видалити акаунт і всі його дані з сервера. Скасувати не можна.</p></div>
            <button type="button" class="btn sm ghost danger" data-a="delete-account">Видалити</button></div>
        </div>
      </section>

      <section class="set" id="set-google" hidden>
        <h2>Вхід через Google</h2>
        <p class="muted">Вхід і реєстрація одним кроком. Створіть OAuth-клієнт у <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a> (тип «Web application») і додайте адресу повернення нижче.</p>
        <div class="kv"><span>Адреса повернення</span><div><code class="g-redirect"></code> <button type="button" class="link" data-a="copy-redirect">копіювати</button></div></div>
        <div class="kv"><span>Client ID</span><div><input data-g="clientId" placeholder="….apps.googleusercontent.com" autocomplete="off" spellcheck="false"></div></div>
        <div class="kv"><span>Client secret</span><div><input type="password" data-g="clientSecret" placeholder="GOCSPX-…" autocomplete="off"><p class="small g-secret"></p></div></div>
        <div class="kv"><span>Реєстрація</span><div><label class="switch"><input type="checkbox" data-g="signup"><span>нові користувачі можуть зареєструватись</span></label></div></div>
        <div class="kv"><span>Ліміт асистента</span><div class="inline"><input type="number" min="0" max="10000" data-g="userLimit" style="width:110px"><span class="muted small">запитів на день для кожного користувача (0 — без ліміту)</span></div></div>
        <div class="kv"><span>Контакт</span><div><input type="email" data-g="contact" placeholder="пошта для питань про дані"><p class="muted small">Показується на сторінці <a href="/privacy.html" target="_blank" rel="noopener">конфіденційності</a> — потрібна Google.</p></div></div>
        <div class="row-act"><button type="button" class="btn sm primary" data-a="google-save">Зберегти</button><span class="small g-state"></span></div>
      </section>

      <section class="set" id="set-users" hidden>
        <h2>Користувачі</h2>
        <p class="muted">Хто має доступ до mdmy. Дані кожного — в окремій базі; тут лише облікові записи.</p>
        <div class="users-list"></div>
      </section>
    </div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    $$('[data-theme]', root).forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === pref.get('theme', 'system'))));
    drawSpaces(); load(); loadSessions(); drawPush(); loadMe(); loadTeam();
    $('.team-allow', root).addEventListener('submit', async e => {
      e.preventDefault(); const inp = $('input', e.target);
      try { loadTeam(await post('team/allow', { pub_id: inp.value })); inp.value = ''; toast('Дозволено'); } catch (err) { fail(err); }
    });
    if (sub) setTimeout(() => { const t = $('#set-' + sub, root); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }
  async function load() {
    try { fill(await get('assistant/settings')); } catch (e) { fail(e); }
  }
  function fill(x) {
    s = x;
    const f = k => $(`[data-f="${k}"]`, root);
    ADMIN.forEach(k => { $(`#set-${k}`, root).hidden = !s.admin; $(`.set-nav [data-k="${k}"]`, root).hidden = !s.admin; });
    // гостьовий вхід: пароль спільний, входи чужі — ці розділи не показуємо
    if (s.demo) ['devices'].forEach(k => { $(`#set-${k}`, root).hidden = true; $(`.set-nav [data-k="${k}"]`, root).hidden = true; });
    $('.demo-out', root).hidden = !s.demo;
    if (document.activeElement !== f('style')) f('style').value = s.style || '';
    const tz = f('tz'); tz.value = s.tz; if (tz.value !== s.tz) { tz.add(new Option(s.tz, s.tz)); tz.value = s.tz; }
    f('morningTime').value = s.morningTime; f('morningOn').checked = s.morningOn;
    f('summaryTime').value = s.summaryTime; f('summaryOn').checked = s.summaryOn;
    f('voiceLang').value = s.voiceLang;
    $$('.admin-only', root).forEach(x => { x.hidden = !s.admin; });
    const bs = $('.bot-state', root);
    if (!s.hasBot) bs.innerHTML = `<p class="muted small">${s.admin ? 'Бот не підключено.' : 'Бот ще не підключено — це робить адміністратор.'}</p>`;
    else if (!s.linked) bs.innerHTML = `<p>Привʼяжіть свій Telegram до бота <b>@${esc(s.botName)}</b>:</p><a class="btn primary sm" href="${esc(s.linkUrl)}" target="_blank" rel="noopener">${icon('telegram', 14)}Відкрити бота й натиснути Start</a>
      ${s.demo ? '<p class="muted small">Гостьовий акаунт спільний: якщо його привʼяже хтось інший, повідомлення підуть уже йому.</p>' : ''}`;
    else bs.innerHTML = `<p>${icon('checkCircle', 14)} Привʼязано до <b>@${esc(s.botName)}</b>.</p><div class="row-act"><button type="button" class="btn sm ghost" data-a="unlink">Відвʼязати чат</button>${s.admin ? '<button type="button" class="btn sm ghost danger" data-a="clear-bot">Видалити бота</button>' : ''}</div>`;
    if (s.admin && s.botError) bs.insertAdjacentHTML('beforeend', `<p class="err small">${esc(s.botError)}</p>`);
    if (s.admin) {
      f('anthropicKey').value = ''; f('botToken').value = '';
      f('model').value = s.model;
      $('.key-state', root).innerHTML = s.hasKey ? `Ключ задано (${esc(s.keyHint)}) · <button type="button" class="link" data-a="clear-key">видалити</button>` : '<span class="muted">Ключ не задано — асистент не зможе розбирати повідомлення.</span>';
    }
    clearInterval(linkPoll);
    if (s.hasBot && !s.linked) linkPoll = setInterval(async () => { try { const n = await get('assistant/settings'); if (n.linked) fill(n); } catch (e) {} }, 3000);
  }
  async function saveSettings(extra) {
    const f = k => $(`[data-f="${k}"]`, root), err = $('.set-save .err', root); err.textContent = '';
    const body = extra || { tz: f('tz').value, morningTime: f('morningTime').value || '08:00', morningOn: f('morningOn').checked,
                            summaryTime: f('summaryTime').value || '21:00', summaryOn: f('summaryOn').checked, voiceLang: f('voiceLang').value };
    if (!extra && s && s.admin) {
      body.model = f('model').value.trim() || 'claude-haiku-5-5';
      if (f('anthropicKey').value.trim()) body.anthropicKey = f('anthropicKey').value.trim();
      if (f('botToken').value.trim()) body.botToken = f('botToken').value.trim();
    }
    try { fill(await post('assistant/settings', body)); toast('Збережено'); } catch (e) { err.textContent = e.message; }
  }

  // ---------- обліковий запис ----------
  let me = null, users = [];
  async function loadMe() {
    try { me = (await get('me')).account; } catch (e) { return; }
    $('.acc-who', root).innerHTML = `<p><b>${esc(me.name)}</b> <span class="muted">· ${esc(me.login)}${me.email ? ' · ' + esc(me.email) : ''}</span></p>`;
    $('.acc-google', root).innerHTML = me.google ? `<p class="small">${icon('checkCircle', 14)} Вхід через Google привʼязано</p>`
      : me.googleOn && !me.demo ? `<a class="btn sm" href="/api/auth/google/start?link=1">Привʼязати вхід через Google</a>` : '';
    $('.acc-old', root).hidden = !me.hasPassword;
    $('.acc-new-l', root).textContent = me.hasPassword ? 'Новий пароль' : 'Пароль для входу за логіном';
    $('[data-a="password"]', root).textContent = me.hasPassword ? 'Змінити пароль' : 'Задати пароль';
    $('.acc-del', root).hidden = me.own || me.demo;
    $('.acc-pass', root).hidden = me.demo;                        // гостьовий пароль спільний
    if (me.admin) { loadGoogle(); loadUsers(); }
    loadQuota();
  }
  // місце для файлів: 50 МБ і 10 завантажень на добу (адміни й основна база — без ліміту)
  async function loadQuota() {
    let q; try { q = (await get('account/quota')).quota; } catch (e) { return; }
    const el = $('.acc-quota', root); if (!q) { el.innerHTML = ''; return; }
    const mb = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace('.0', '');
    const pct = Math.min(100, Math.round(q.used / q.limit * 100));
    el.innerHTML = `<div class="quota"><div class="quota-l"><span>Файли</span><span class="muted small">${mb(q.used)} з ${mb(q.limit)} МБ · сьогодні ${q.today} з ${q.perDay}</span></div>
      <div class="quota-bar"><i style="width:${pct}%"></i></div></div>`;
  }
  async function loadGoogle() {
    let g; try { g = await get('admin/auth'); } catch (e) { return; }
    const f = k => $(`[data-g="${k}"]`, root);
    $('.g-redirect', root).textContent = g.redirectUri;
    f('clientId').value = g.clientId; f('clientSecret').value = ''; f('signup').checked = g.signup; f('userLimit').value = g.userLimit; f('contact').value = g.contact;
    $('.g-secret', root).innerHTML = g.hasSecret ? 'Секрет задано · <button type="button" class="link" data-a="google-clear">видалити</button>' : '<span class="muted">Секрет не задано</span>';
    $('.g-state', root).innerHTML = g.enabled ? `${icon('checkCircle', 14)} Увімкнено` : '<span class="muted">Вимкнено — потрібні Client ID і секрет</span>';
  }
  async function loadUsers() {
    let r; try { r = await get('admin/users'); } catch (e) { return; }
    const ROLE = { admin: 'адмін', demo: 'гість', user: '' };
    users = r.list;
    $('.users-list', root).innerHTML = r.list.map(u => `<div class="sess${u.disabled ? ' off' : ''}">${icon(u.google ? 'checkCircle' : 'circle', 16)}<span><b>${esc(u.name)}</b> <span class="muted small">${esc(u.email || u.login)}${ROLE[u.role] ? ' · ' + ROLE[u.role] : ''}${u.disabled ? ' · вимкнено' : ''}</span>
        ${!u.ws && u.role !== 'admin' ? '<span class="small u-warn">спільна база з вами — бачить ваші записи</span>' : ''}</span>
      <span class="muted small">${u.last_login ? 'вхід ' + esc(fmtDate(u.last_login)) : 'з ' + esc(fmtDate(u.created))}</span>
      ${u.role !== 'admin' ? `<button type="button" class="icon-btn xs" data-a="user-more" data-id="${u.id}" title="Дії">${icon('more', 14)}</button>` : ''}</div>`).join('') + `<p class="muted small">Усього: ${r.list.length}</p>`;
  }
  // підтвердження незворотної дії: треба ввести слово (ОЧИСТИТИ / ВИДАЛИТИ)
  function typed(word, text, ok) {
    return new Promise(resolve => {
      let done = false;
      const s = sheet(`<div class="sheet-head"><b>${esc(ok)}</b></div><form class="confirm-type"><p>${text}</p>
        <p class="muted small">Щоб підтвердити, введіть <b>${word}</b></p><input autocomplete="off" autocapitalize="characters" spellcheck="false">
        <button class="btn primary danger-btn wide" type="submit" disabled>${esc(ok)}</button></form>`, { label: ok, onClose: () => { if (!done) resolve(null); } });
      const inp = $('input', s.el), btn = $('button[type=submit]', s.el);
      setTimeout(() => inp.focus(), 250);
      inp.addEventListener('input', () => { btn.disabled = inp.value.trim().toUpperCase() !== word; });
      $('form', s.el).addEventListener('submit', e => { e.preventDefault(); if (btn.disabled) return; done = true; s.close(); resolve(word); });
    });
  }

  // ---------- команда ----------
  async function loadTeam(t) {
    try { t = t || await get('team'); } catch (e) { return; }
    $('.team-id', root).textContent = t.me.pub_id;
    const row = (p, kind) => `<div class="sess">${icon('users', 16)}<span><b>${esc(p.name)}</b> <span class="muted small">${esc(p.pub_id)}</span></span>
      <button type="button" class="icon-btn xs" data-a="team-del" data-kind="${kind}" data-id="${p.id}" title="${kind === 'bosses' ? 'Заборонити давати мені задачі' : 'Прибрати з команди'}">${icon('x', 14)}</button></div>`;
    $('.team-lists', root).innerHTML = (t.bosses.length ? `<p class="small muted" style="margin:12px 0 4px">Можуть давати мені задачі:</p>${t.bosses.map(b => row(b, 'bosses')).join('')}` : '') +
      (t.members.length ? `<p class="small muted" style="margin:12px 0 4px">Я можу давати задачі:</p>${t.members.map(m => row(m, 'members')).join('')}` : '');
  }

  // ---------- простори ----------
  function drawSpaces() {
    $('.spaces-list', root).innerHTML = meta.spaces.map(sp => `<div class="sp-row${sp.archived ? ' arch' : ''}" data-key="${sp.key}">
      <button type="button" class="icon-btn sp-ic" data-a="sp-icon" title="Іконка">${icon(sp.icon, 18)}</button>
      <div class="sp-main">
        <input class="sp-name" value="${esc(sp.name)}" maxlength="40" aria-label="Назва">
        <textarea class="sp-desc" rows="1" maxlength="600" placeholder="${sp.key === 'inbox' ? 'Вхідні — для нерозкладених задач' : 'Що сюди належить — підказка асистенту'}" ${sp.key === 'inbox' ? 'disabled' : ''}>${esc(sp.key === 'inbox' ? '' : sp.description)}</textarea>
      </div>
      <button type="button" class="icon-btn" data-a="sp-more" title="Ще">${icon('more')}</button>
    </div>`).join('');
  }
  async function saveSpace(key, body) {
    try { await patch('assistant/spaces/' + key, body); await refreshMeta(); } catch (e) { fail(e); }
  }

  // ---------- сповіщення ----------
  async function drawPush() {
    const st = await push.status(), box = $('.push-state', root);
    let html;
    if (!st.supported) html = st.needsInstall
      ? `<p>${icon('device', 14)} На iPhone сповіщення працюють лише в установленому застосунку: Safari → «Поділитися» → «На початковий екран», потім відкрийте mdmy звідти.</p>`
      : `<p class="muted">${icon('x', 14)} Цей браузер не підтримує сповіщення. Спробуйте Chrome, Edge, Firefox або Samsung Internet.</p>`;
    else if (st.permission === 'denied') html = `<p>${icon('x', 14)} Сповіщення для mdmy.me заборонено в браузері. Відкрийте налаштування сайту (значок 🔒 біля адреси) → Сповіщення → Дозволити, і оновіть сторінку.</p>`;
    else if (st.subscribed) html = `<p>${icon('checkCircle', 14)} Увімкнено на цьому пристрої.</p><div class="row-act"><button type="button" class="btn sm" data-a="push-test">${icon('bell', 14)}Надіслати тестове</button><button type="button" class="btn sm ghost" data-a="push-off">Вимкнути тут</button></div>`;
    else html = `<p class="muted">На цьому пристрої вимкнено.</p><button type="button" class="btn sm primary" data-a="push-on">${icon('bell', 14)}Увімкнути на цьому пристрої</button>`;
    box.innerHTML = html;
    try {
      const { list } = await get('push/subscriptions');
      $('.push-devices', root).innerHTML = list.length ? `<p class="small muted" style="margin:12px 0 4px">Пристрої, що отримують сповіщення:</p>` + list.map(d => `<div class="sess">${icon('bell', 16)}<span><b>${esc(d.device || 'Пристрій')}</b></span>
        <span class="muted small">${d.last_ok ? 'останнє ' + esc(fmtDate(d.last_ok)) : 'з ' + esc(fmtDate(d.created))}</span><button type="button" class="icon-btn xs" data-a="push-del" data-id="${d.id}" title="Прибрати">${icon('x', 14)}</button></div>`).join('') : '';
    } catch (e) {}
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
    const a = e.target.closest('[data-a]'), th = e.target.closest('[data-theme]'), sty = e.target.closest('[data-style]');
    if (sty) {
      const ta = $('[data-f="style"]', root), t = sty.dataset.style;
      ta.value = ta.value.trim() && !STYLES.some(([, x]) => x === ta.value.trim()) ? ta.value.trim() + ' ' + t : t;
      $('.style-state', root).textContent = 'Не збережено'; ta.focus(); return;
    }
    if (th) { window.MDMY.setTheme(th.dataset.theme); $$('[data-theme]', root).forEach(b => b.setAttribute('aria-checked', String(b === th))); return; }
    if (!a) return;
    const k = a.dataset.a, row = a.closest('[data-key]'), key = row && row.dataset.key;
    if (k === 'save') saveSettings();
    if (k === 'style-save') { await saveSettings({ style: $('[data-f="style"]', root).value }); $('.style-state', root).textContent = ''; }
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
      try { await post('password', { old: o.value, password: n.value }); o.value = ''; n.value = ''; toast(me && !me.hasPassword ? 'Пароль задано' : 'Пароль змінено. Інші пристрої вийдуть із системи.'); loadMe(); } catch (err) { fail(err); }
    }
    if (k === 'logout') window.MDMY.logout();
    if (k === 'reset') {
      if (await typed('ОЧИСТИТИ', 'Усі задачі, нотатки, звички, щоденні завдання й історія розмов зникнуть. Акаунт і налаштування залишаться.', 'Почати спочатку') !== 'ОЧИСТИТИ') return;
      try { await post('account/reset', { confirm: 'ОЧИСТИТИ' }); await refreshMeta(); document.dispatchEvent(new CustomEvent('mdmy:changed')); toast('Готово — чистий аркуш'); location.hash = '#/today'; } catch (err) { fail(err); }
    }
    if (k === 'delete-account') {
      if (await typed('ВИДАЛИТИ', 'Акаунт і всі його дані буде видалено з сервера назавжди.', 'Видалити акаунт') !== 'ВИДАЛИТИ') return;
      try { await post('account/delete', { confirm: 'ВИДАЛИТИ' }); toast('Акаунт видалено'); setTimeout(() => location.replace('/assistant/'), 800); } catch (err) { fail(err); }
    }
    if (k === 'copy-id') navigator.clipboard.writeText($('.team-id', root).textContent).then(() => toast('ID скопійовано'), () => {});
    if (k === 'team-del' && await confirmBox(a.dataset.kind === 'bosses' ? 'Заборонити цій людині давати вам задачі?' : 'Прибрати людину з команди? Давати їй задачі більше не вийде.', { ok: 'Так' })) {
      try { loadTeam(await api('team/' + a.dataset.kind + '/' + a.dataset.id, { method: 'DELETE' })); } catch (err) { fail(err); }
    }
    if (k === 'user-more') {
      const u = users.find(x => x.id === +a.dataset.id); if (!u) return;
      const items = [];
      if (!u.ws) items.push({ value: 'separate', label: 'Дати окрему базу', icon: 'layers' });
      items.push(u.disabled ? { value: 'enable', label: 'Увімкнути вхід', icon: 'check' } : { value: 'disable', label: 'Вимкнути вхід', icon: 'x' });
      if (u.ws && u.role !== 'demo') items.push({ sep: true }, { value: 'delete', label: 'Видалити з даними', icon: 'trash', danger: true });
      const v = await menu(a, items); if (!v) return;
      const q = { separate: `Дати «${u.name}» окрему порожню базу? Ваші записи цей акаунт більше не бачитиме.`, disable: `Вимкнути вхід для «${u.name}»?`, delete: `Видалити «${u.name}» разом з усіма даними? Скасувати не можна.` }[v];
      if (q && !await confirmBox(q, { ok: 'Так', danger: v === 'delete' })) return;
      try { await post('admin/users/' + u.id, { action: v }); toast('Готово'); loadUsers(); } catch (err) { fail(err); }
    }
    if (k === 'copy-redirect') navigator.clipboard.writeText($('.g-redirect', root).textContent).then(() => toast('Скопійовано'), () => {});
    if (k === 'google-clear' && await confirmBox('Видалити секрет Google? Вхід через Google вимкнеться.')) { try { await post('admin/auth', { clearSecret: true }); loadGoogle(); } catch (err) { fail(err); } }
    if (k === 'google-save') {
      const f = x => $(`[data-g="${x}"]`, root), body = { clientId: f('clientId').value.trim(), signup: f('signup').checked, userLimit: +f('userLimit').value || 0, contact: f('contact').value.trim() };
      if (f('clientSecret').value.trim()) body.clientSecret = f('clientSecret').value.trim();
      try { await post('admin/auth', body); toast('Збережено'); loadGoogle(); } catch (err) { fail(err); }
    }
    if (k === 'push-on') { a.disabled = true; try { await push.enable(); toast('Сповіщення увімкнено'); } catch (err) { fail(err); } drawPush(); }
    if (k === 'push-off') { await push.disable(); toast('Вимкнено на цьому пристрої'); drawPush(); }
    if (k === 'push-test') { try { const r = await push.test(); toast(r.sent ? `Надіслано на пристроїв: ${r.sent}` : 'Не вдалося надіслати — спробуйте вимкнути й увімкнути знову'); } catch (err) { fail(err); } }
    if (k === 'push-del') { try { await post('push/unsubscribe', { id: +a.dataset.id }); drawPush(); } catch (err) { fail(err); } }
  }
  async function onChange(e) {
    const row = e.target.closest('[data-key]'); if (!row) return;
    if (e.target.classList.contains('sp-name') && e.target.value.trim()) saveSpace(row.dataset.key, { name: e.target.value.trim() });
    if (e.target.classList.contains('sp-desc')) saveSpace(row.dataset.key, { description: e.target.value.trim() });
  }
  return { render, destroy: () => clearInterval(linkPoll), refresh: () => { drawSpaces(); } };
}
