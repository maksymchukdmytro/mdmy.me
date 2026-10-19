// Адмінка mdmy (/admin/): огляд зі статистикою, користувачі, ліміти, асистент (Claude), Telegram-бот, вхід і реєстрація.
// Лише для ролі admin. Цифри без змісту: скільки задач у людини — видно, що в них — ні.
// Спільні модулі — з застосунку (/assistant/js/): запити до API, іконки, тости, меню, діалоги.
import { get, post, onUnauthorized } from '/assistant/js/api.js';
import { icon } from '/assistant/js/icons.js';
import { $, $$, esc, toast, fail, confirmBox, fmtDate, pref, sheet } from '/assistant/js/ui.js';
import { wordmark } from '/assistant/js/logo.js';

const app = $('#app');
const t = pref.get('theme', 'system'); if (t !== 'system') document.documentElement.dataset.theme = t;

const NAV = [
  ['overview', 'Огляд', 'activity'], ['users', 'Користувачі', 'users'], ['limits', 'Ліміти', 'progress'],
  ['ai', 'Асистент', 'sparkles'], ['bot', 'Telegram-бот', 'telegram'], ['signup', 'Вхід і реєстрація', 'key'],
  ['backups', 'Резервні копії', 'copy'], ['system', 'Система', 'settings']
];
const ROLE = { admin: 'адмін', user: 'користувач', demo: 'гість', nakladna: 'лише накладні' };
let me = null;

// ---------- формати ----------
const nf = new Intl.NumberFormat('uk-UA');
const num = n => nf.format(Math.round(n || 0));
const usd = v => !v ? '$0' : v < 0.01 ? '<$0.01' : '$' + (v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : nf.format(Math.round(v)));
const mb = b => { b = b || 0; return b < 1048576 ? (b / 1024).toFixed(0) + ' КБ' : b < 1073741824 ? (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' МБ' : (b / 1073741824).toFixed(1) + ' ГБ'; };
const mins = s => s < 60 ? Math.round(s) + ' с' : Math.round(s / 60) + ' хв';
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const MON = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const dayLabel = d => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
function ago(day) {
  if (!day) return 'ще не заходив(ла)';
  const diff = Math.round((new Date(new Date().toDateString()) - new Date(day + 'T00:00')) / 864e5);
  return diff <= 0 ? 'сьогодні' : diff === 1 ? 'вчора' : diff < 30 ? `${diff} дн тому` : dayLabel(day);
}
const dur = s => s < 3600 ? Math.round(s / 60) + ' хв' : s < 172800 ? Math.round(s / 3600) + ' год' : Math.round(s / 86400) + ' дн';

// ---------- маленькі графіки: стовпчики за 30 днів (один ряд, без легенди — назва над графіком) ----------
function bars(series, fmt = num, { cls = '', total: totalText } = {}) {
  const max = Math.max(...series.map(x => x.v), 0);
  const total = series.reduce((s, x) => s + x.v, 0);
  return `<div class="chart ${cls}" data-chart>
    <div class="ch-max muted small">${max ? fmt(max) : ''}</div>
    <div class="ch-bars" role="img" aria-label="${esc(series.map(x => dayLabel(x.day) + ': ' + fmt(x.v)).join(', '))}">${series.map((x, i) =>
      `<span class="ch-col" data-i="${i}" data-tip="${esc(dayLabel(x.day) + ' · ' + fmt(x.v))}"><i style="height:${max ? Math.max(x.v ? 3 : 0, x.v / max * 100) : 0}%"${i === series.length - 1 ? ' class="now"' : ''}></i></span>`).join('')}</div>
    <div class="ch-axis muted small"><span>${dayLabel(series[0].day)}</span><span>${totalText ? totalText(series) : total ? 'разом ' + fmt(total) : 'поки порожньо'}</span><span>сьогодні</span></div>
  </div>`;
}
// підказка над стовпчиком (миша й палець)
let tipEl = null;
function tip(e) {
  const col = e.target.closest && e.target.closest('.ch-col');
  if (!col) { if (tipEl) tipEl.hidden = true; return; }
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'ch-tip'; document.body.append(tipEl); }
  tipEl.textContent = col.dataset.tip; tipEl.hidden = false;
  const r = col.getBoundingClientRect(), w = tipEl.offsetWidth;
  tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  tipEl.style.top = (r.top - tipEl.offsetHeight - 6 + scrollY) + 'px';
}
document.addEventListener('pointerover', tip);
document.addEventListener('pointerdown', tip);

const tile = (label, value, sub = '', ic = '') => `<div class="tile">${ic ? `<span class="tile-ic">${icon(ic, 15)}</span>` : ''}<span class="tile-l">${label}</span><b class="tile-v">${value}</b>${sub ? `<span class="tile-s">${sub}</span>` : ''}</div>`;
const meter = (label, a, b, note = '') => `<div class="meter"><div class="meter-l"><span>${label}</span><span class="muted small">${b ? `${pct(a, b)}% · ${num(a)} з ${num(b)}` : '—'}${note}</span></div><div class="meter-bar"><i style="width:${pct(a, b)}%"></i></div></div>`;

// ---------- вхід ----------
function showLogin(err = '') {
  app.innerHTML = `<main class="login"><div class="login-card">
    <div class="login-logo"><span class="ws-logo lg">${wordmark}</span></div>
    <p class="login-sub">Адмінка сервісу</p>
    <p class="err">${esc(err)}</p>
    <form class="login-form" id="lf">
      <label class="field"><span>Логін</span><input name="login" autocomplete="username" autocapitalize="off" required></label>
      <label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary wide" type="submit">Увійти</button>
    </form>
    <p class="muted small center">Входите через Google? Увійдіть у <a href="/">mdmy</a> і поверніться сюди.</p>
  </div></main>`;
  const f = $('#lf'); f.login.focus();
  f.addEventListener('submit', async e => {
    e.preventDefault(); const b = f.querySelector('button'); b.disabled = true;
    try { await post('login', { login: f.login.value, password: f.password.value }); boot(); }
    catch (er) { $('.login-card .err').textContent = er.message; b.disabled = false; }
  });
}
onUnauthorized(() => showLogin('Сесія завершилась — увійдіть знову.'));

// ---------- оболонка ----------
function shell() {
  app.innerHTML = `<div class="adm">
    <aside class="adm-side">
      <a class="adm-brand" href="#/overview"><span class="ws-logo">${wordmark}</span><span class="adm-tag">Адмінка</span></a>
      <nav class="adm-nav">${NAV.map(([k, l, ic]) => `<a href="#/${k}" data-k="${k}">${icon(ic, 16)}<span>${l}</span></a>`).join('')}</nav>
      <div class="adm-foot">
        <a href="/#/today">${icon('arrowRight', 15)}<span>До mdmy</span></a>
        <span class="muted small">${esc(me.name)} · ${esc(me.login)}</span>
      </div>
    </aside>
    <main class="adm-main" id="main"></main>
  </div>`;
}
function setActive(k) { $$('.adm-nav a').forEach(a => a.setAttribute('aria-current', a.dataset.k === k ? 'page' : 'false')); }

async function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'overview';
  const [k, id] = h.split('/');
  setActive(k === 'user' ? 'users' : k);
  // свіжий контейнер на кожну сторінку — обробники попередньої не накопичуються
  const old = $('#main'); if (!old) return;
  const main = old.cloneNode(false); old.replaceWith(main);
  main.innerHTML = `<div class="adm-load"><span class="spin"></span></div>`;
  scrollTo(0, 0);
  try {
    if (k === 'users' && id) await userPage(main, +id);
    else if (k === 'users') await usersPage(main);
    else if (k === 'limits') await limitsPage(main);
    else if (k === 'ai') await aiPage(main);
    else if (k === 'bot') await botPage(main);
    else if (k === 'signup') await signupPage(main);
    else if (k === 'backups') await backupsPage(main);
    else if (k === 'system') await systemPage(main);
    else await overviewPage(main);
  } catch (e) { main.innerHTML = `<div class="adm-page"><p class="err">${esc(e.message)}</p></div>`; }
}
addEventListener('hashchange', route);

async function boot() {
  try { me = (await get('me')).account; } catch (e) { return showLogin(); }
  if (!me.admin) {
    app.innerHTML = `<main class="login"><div class="login-card"><div class="login-logo"><span class="ws-logo lg">${wordmark}</span></div>
      <p class="center">Адмінка — лише для адміністраторів.</p><a class="btn wide" href="/">Повернутися в mdmy</a></div></main>`;
    return;
  }
  shell(); route();
}
boot();

const head = (title, sub = '', act = '') => `<header class="adm-head"><div><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${act}</header>`;

// ---------- огляд ----------
async function overviewPage(main) {
  const o = await get('admin/overview');
  const s = o.server, r = o.retention;
  const ret = x => x.pct == null ? '—' : x.pct + '%';
  const memUsed = s.mem.total - s.mem.free, diskUsed = s.disk ? s.disk.total - s.disk.free : 0;
  const bk = s.backups.last;
  main.innerHTML = `<div class="adm-page">
    ${head('Огляд', `Сьогодні ${dayLabel(o.today)} · ${esc(o.tz)}`, `<button type="button" class="btn sm" data-a="refresh">${icon('repeat', 14)}Оновити</button>`)}
    <section class="tiles">
      ${tile('Користувачі', num(o.users.total), `+${num(o.users.new7)} за 7 днів${o.users.google ? ` · через Google ${num(o.users.google)}` : ''}`, 'users')}
      ${tile('Активні сьогодні', num(o.active.d1), `7 днів: ${num(o.active.d7)} · 30 днів: ${num(o.active.d30)}`, 'activity')}
      ${tile('Повертаються через тиждень', ret(r.d7), `через день ${ret(r.d1)} · через місяць ${ret(r.d30)}`, 'repeat')}
      ${tile('Claude сьогодні', usd(o.ai.today.cost), `${num(o.ai.today.n)} запитів${o.ai.errors ? ` · помилок ${num(o.ai.errors)}` : ''}`, 'sparkles')}
      ${tile('Claude за місяць', usd(o.ai.month.cost), o.ai.budget.usd ? `з бюджету ${usd(o.ai.budget.usd)} · прогноз ${usd(o.ai.forecast)}${o.ai.month.cost >= o.ai.budget.usd ? ' · <span class="bad">вичерпано</span>' : ''}` : `прогноз до кінця місяця ${usd(o.ai.forecast)}`, 'wallet')}
      ${tile('Голос сьогодні', mins(o.voice.today.a), `${num(o.voice.today.n)} записів · за місяць ${mins(o.voice.month.a)}`, 'mic')}
      ${tile('Нагадування сьогодні', num(o.reminders.ok), o.reminders.fail ? `<span class="bad">не доставлено ${num(o.reminders.fail)}</span>` : `за тиждень ${num(o.reminders.week)}`, 'bell')}
      ${tile('Диск', s.disk ? mb(s.disk.free) + ' вільно' : '—', s.disk ? `зайнято ${pct(diskUsed, s.disk.total)}% · дані ${mb(s.data)}` : '', 'layers')}
    </section>

    <section class="charts">
      <div class="box"><h3>Нові користувачі</h3>${bars(o.users.series)}</div>
      <div class="box"><h3>Активні за день</h3>${bars(o.active.series)}</div>
      <div class="box"><h3>Витрати на Claude</h3>${bars(o.ai.series, usd)}</div>
    </section>

    <section class="cols">
      <div class="box">
        <h3>Активація</h3>
        <p class="muted small">Серед ${num(o.activation.base)} користувачів без гостя: скільки почали користуватись і що підключили.</p>
        ${meter('Створили хоч одну задачу', o.activation.tasks, o.activation.base)}
        ${meter('Підключили Telegram', o.activation.telegram, o.activation.base)}
        ${meter('Увімкнули сповіщення', o.activation.push, o.activation.base)}
      </div>
      <div class="box">
        <h3>Моделі цього місяця</h3>
        ${o.ai.byModel.length ? `<table class="tbl"><thead><tr><th>Модель</th><th class="r">Запитів</th><th class="r">Вартість</th></tr></thead><tbody>
          ${o.ai.byModel.map(x => `<tr><td><code>${esc(x.model)}</code></td><td class="r">${num(x.n)}</td><td class="r">${usd(x.cost)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">Цього місяця запитів до Claude ще не було.</p>'}
        <p class="muted small">Ціни моделей — у розділі <a href="#/ai">Асистент</a>.</p>
      </div>
    </section>

    <section class="box">
      <h3>Сервер <a class="h-more muted small" href="#/system">Система →</a></h3>
      <dl class="facts">
        <div><dt>Версія</dt><dd>${esc(s.version)}</dd></div>
        <div><dt>Працює без перезапуску</dt><dd>${dur(s.uptime)}</dd></div>
        <div><dt>Памʼять</dt><dd>${mb(memUsed)} з ${mb(s.mem.total)} · сайт ${mb(s.mem.app)}</dd></div>
        <div><dt>Навантаження</dt><dd>${s.load.map(x => x.toFixed(2)).join(' · ')} <span class="muted">(${s.cpus} ядра)</span></dd></div>
        <div><dt>Резервна копія</dt><dd>${bk ? `${esc(fmtDate(bk.at))} · ${mb(bk.size)} · усього ${s.backups.count}` : `<span class="bad">${s.backups.error ? 'тека копій недоступна' : 'ще не було'}</span>`}</dd></div>
        <div><dt>Розшифровка голосу</dt><dd>${s.stt ? `${icon('checkCircle', 13)} працює · ${esc(s.stt.model || '')}` : '<span class="bad">не відповідає</span>'}</dd></div>
        <div><dt>Node.js</dt><dd>${esc(s.node)}</dd></div>
      </dl>
    </section>
  </div>`;
  $('[data-a="refresh"]', main).onclick = () => route();
}

// ---------- користувачі ----------
const FILTERS = [['all', 'Усі'], ['active', 'Активні за тиждень'], ['google', 'Google'], ['demo', 'Гості'], ['off', 'Вимкнені']];
let usersFilter = 'all', usersQuery = '';
const activeWeek = u => u.seen && (new Date() - new Date(u.seen + 'T00:00')) / 864e5 < 7;
async function usersPage(main) {
  const { list } = await get('admin/users');
  main.innerHTML = `<div class="adm-page">
    ${head('Користувачі', `${num(list.length)} облікових записів. Дані кожного — в окремій базі; тут лише цифри.`)}
    <div class="u-tools">
      <label class="u-search">${icon('search', 15)}<input type="search" placeholder="Імʼя, пошта або логін" value="${esc(usersQuery)}"></label>
      <div class="seg u-filter">${FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-checked="${k === usersFilter}">${l}</button>`).join('')}</div>
    </div>
    <div class="u-list"></div>
  </div>`;
  const draw = () => {
    const q = usersQuery.trim().toLowerCase();
    const rows = list.filter(u => (!q || [u.name, u.login, u.email].some(x => x && x.toLowerCase().includes(q))) &&
      (usersFilter === 'all' || (usersFilter === 'active' && activeWeek(u)) || (usersFilter === 'google' && u.google) || (usersFilter === 'demo' && u.role === 'demo') || (usersFilter === 'off' && u.disabled)));
    $('.u-list', main).innerHTML = rows.length ? `<div class="u-row u-hd muted small"><span>Людина</span><span>Заходив(ла)</span><span class="r">Задач</span><span class="r">Claude 30 дн</span><span class="r">Файли</span></div>` + rows.map(u => {
      const sh = u.shape || {};
      return `<a class="u-row${u.disabled ? ' off' : ''}" href="#/users/${u.id}">
        <span class="u-who"><span class="ava">${esc((u.name || u.login).trim().slice(0, 1).toUpperCase())}</span><span><b>${esc(u.name)}</b>${u.role !== 'user' ? `<span class="tag">${ROLE[u.role] || u.role}</span>` : ''}${u.disabled ? '<span class="tag bad">вимкнено</span>' : ''}<br><span class="muted small">${esc(u.email || u.login)}</span></span></span>
        <span class="u-c" data-l="Заходив(ла)">${ago(u.seen)}</span>
        <span class="u-c r" data-l="Задач">${sh.tasks != null ? num(sh.tasks) : '—'}</span>
        <span class="u-c r" data-l="Claude 30 дн">${u.ai30.n ? `${num(u.ai30.n)} · ${usd(u.ai30.cost)}` : '—'}</span>
        <span class="u-c r" data-l="Файли">${sh.storage != null ? mb(sh.storage) : '—'}</span>
      </a>`; }).join('') : '<p class="muted">Нікого не знайдено.</p>';
  };
  draw();
  $('.u-search input', main).addEventListener('input', e => { usersQuery = e.target.value; draw(); });
  $('.u-filter', main).addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    usersFilter = b.dataset.f; $$('.u-filter button', main).forEach(x => x.setAttribute('aria-checked', String(x === b))); draw();
  });
}

async function userPage(main, id) {
  const u = await get('admin/users/' + id);
  const sh = u.shape || {}, L = u.limits, self = u.id === me.id;
  const limitIn = (k, label, unit) => `<div class="kv"><span>${label}</span><div class="inline"><input type="number" min="0" data-l="${k}" value="${u.own[k] ?? ''}" placeholder="загальний: ${L[k] === 0 && !u.ws ? 'без обмежень' : L[k]}" style="width:150px"><span class="muted small">${unit}</span></div></div>`;
  const facts = [
    ['Задачі', sh.tasks != null ? `${num(sh.open)} відкритих · усього ${num(sh.tasks)}` : '—'],
    ['Нотатки', sh.notes != null ? num(sh.notes) : '—'],
    ['Звички й щоденні', sh.habits != null ? `${num(sh.habits)} · ${num(sh.routines)}` : '—'],
    ['Повідомлень асистенту', sh.messages != null ? num(sh.messages) : '—'],
    ['Claude за 30 днів', u.usage.ai.n ? `${num(u.usage.ai.n)} запитів · ${usd(u.usage.ai.cost)}` : '—'],
    ['Голос за 30 днів', u.usage.voice.n ? `${num(u.usage.voice.n)} записів · ${mins(u.usage.voice.a)}` : '—'],
    ['Нагадувань за 30 днів', num(u.usage.reminders)],
    ['Файли', sh.storage != null ? `${mb(sh.storage)}${L.storageMb ? ` з ${L.storageMb} МБ` : ''}` : '—'],
    ['Telegram', sh.telegram ? 'підключено' : 'ні'], ['Сповіщення', sh.push ? `${num(sh.push)} пристр.` : 'ні'],
    ['Вхід', [u.google ? 'Google' : '', u.hasPassword ? 'логін і пароль' : ''].filter(Boolean).join(' · ') || '—'],
    ['Зареєстровано', fmtDate(u.created)], ['Останній вхід', u.last_login ? fmtDate(u.last_login) : '—'],
    ['База', u.ws ? `окрема (${esc(u.ws)})` : 'основна (спільна з власником)']
  ];
  main.innerHTML = `<div class="adm-page">
    <a class="back muted small" href="#/users">${icon('chevronLeft', 14)}Користувачі</a>
    ${head(`${esc(u.name)}${u.role !== 'user' ? ` <span class="tag">${ROLE[u.role] || u.role}</span>` : ''}${u.disabled ? ' <span class="tag bad">вимкнено</span>' : ''}`, esc([u.email, u.login].filter(Boolean).join(' · ')))}
    <section class="cols">
      <div class="box"><h3>Активність за 30 днів</h3>${bars(u.activity, n => n ? 'заходив(ла)' : 'не заходив(ла)', { total: s => `днів з активністю: ${s.filter(x => x.v).length}` })}<p class="muted small">Останній раз — ${ago(u.seen)}.</p></div>
      <div class="box"><h3>Що в базі</h3><dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div>
    </section>
    ${u.role === 'nakladna' ? '' : `<section class="box">
      <h3>Особисті ліміти</h3>
      <p class="muted small">${u.ws && u.role !== 'admin' ? 'Порожнє поле — загальний ліміт з розділу «Ліміти». 0 — без обмежень.' : 'Адміністратор і основна база працюють без лімітів.'}</p>
      ${u.ws && u.role !== 'admin' ? `${limitIn('ai', 'Запитів до асистента на день', 'запитів')}${limitIn('storageMb', 'Місце для файлів', 'МБ')}${limitIn('uploadsDay', 'Завантажень на день', 'файлів')}
        <div class="row-act"><button type="button" class="btn sm primary" data-a="limits">Зберегти ліміти</button></div>` : ''}
    </section>`}
    <section class="box">
      <h3>Дії</h3>
      <div class="acts">
        <button type="button" class="btn sm" data-a="logout">${icon('logout', 14)}${self ? 'Вийти на інших пристроях' : 'Вийти з усіх пристроїв'}</button>
        ${!self && u.role !== 'admin' ? `<button type="button" class="btn sm" data-a="${u.disabled ? 'enable' : 'disable'}">${icon(u.disabled ? 'check' : 'x', 14)}${u.disabled ? 'Увімкнути вхід' : 'Вимкнути вхід'}</button>` : ''}
        ${['user', 'admin'].includes(u.role) && !self ? `<button type="button" class="btn sm" data-a="role">${icon('key', 14)}${u.role === 'admin' ? 'Зняти роль адміна' : 'Зробити адміном'}</button>` : ''}
        ${!u.ws && !self && !['admin', 'nakladna'].includes(u.role) ? `<button type="button" class="btn sm" data-a="separate">${icon('layers', 14)}Дати окрему базу</button>` : ''}
        ${u.ws && !self && u.role !== 'admin' && u.role !== 'demo' ? `<button type="button" class="btn sm ghost danger" data-a="delete">${icon('trash', 14)}Видалити з даними</button>` : ''}
      </div>
    </section>
    <section class="cols">
      <div class="box"><h3>Пристрої й входи</h3>${u.sessions.length ? u.sessions.map(x => `<div class="sess">${icon(x.client === 'telegram' ? 'telegram' : x.client === 'web' ? 'eye' : 'device', 15)}<span>${esc({ web: 'Браузер', telegram: 'Telegram', android: 'Android', app: 'Застосунок' }[x.client] || x.client)}</span><span class="muted small">${esc(fmtDate(x.last_used))}</span></div>`).join('') : '<p class="muted small">Активних входів немає.</p>'}</div>
      <div class="box"><h3>Журнал</h3>${u.audit.length ? `<div class="log">${u.audit.map(x => `<div><span class="muted small">${esc(fmtDate(x.at))}</span><span>${esc(AUDIT[x.action] || x.action)}${x.target && !/^account:name$/.test(x.action) ? ` <span class="muted">· ${esc(x.target)}</span>` : ''}</span></div>`).join('')}</div>` : '<p class="muted small">Порожньо.</p>'}</div>
    </section>
  </div>`;
  main.querySelector('.acts').addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const k = b.dataset.a;
    const Q = {
      logout: [self ? 'Завершити всі інші сесії?' : `Вийти з усіх пристроїв «${u.name}»?`, 'Вийти', false],
      disable: [`Вимкнути вхід для «${u.name}»? Сесії завершаться, нагадування перестануть приходити.`, 'Вимкнути', true],
      enable: [`Увімкнути вхід для «${u.name}»?`, 'Увімкнути', false],
      role: [u.role === 'admin' ? `Зняти з «${u.name}» роль адміністратора?` : `Зробити «${u.name}» адміністратором? Він бачитиме цю адмінку й налаштування сервісу.`, 'Так', u.role !== 'admin'],
      separate: [`Дати «${u.name}» окрему порожню базу? Записи власника цей акаунт більше не бачитиме.`, 'Дати', false]
    };
    if (k === 'delete') {
      if (await typed(`Акаунт «${u.name}» і всі його дані буде видалено з сервера назавжди.`) !== 'ВИДАЛИТИ') return;
    } else if (Q[k] && !await confirmBox(Q[k][0], { ok: Q[k][1], danger: Q[k][2] })) return;
    try {
      const r = await post('admin/users/' + u.id, { action: k, ...(k === 'role' ? { role: u.role === 'admin' ? 'user' : 'admin' } : {}) });
      toast('Готово');
      if (r.deleted) location.hash = '#/users'; else route();
    } catch (er) { fail(er); }
  });
  const lb = $('[data-a="limits"]', main);
  if (lb) lb.onclick = async () => {
    const v = k => { const x = $(`[data-l="${k}"]`, main).value.trim(); return x === '' ? null : +x; };
    try { await post('admin/users/' + u.id, { action: 'limits', limits: { ai: v('ai'), storageMb: v('storageMb'), uploadsDay: v('uploadsDay') } }); toast('Ліміти збережено'); route(); } catch (er) { fail(er); }
  };
}
const AUDIT = {
  login: 'Вхід', logout: 'Вихід', 'account:signup': 'Реєстрація', 'account:password': 'Зміна пароля', 'account:name': 'Зміна імені', 'account:reset': 'Почав(ла) спочатку',
  'admin:user': 'Дія адміна', 'admin:limits': 'Зміна лімітів', 'assistant:settings': 'Налаштування асистента', 'auth:settings': 'Налаштування входу', 'assistant:bulk': 'Масова зміна задач'
};
// незворотна дія: треба ввести слово
function typed(text, word = 'ВИДАЛИТИ', ok = 'Видалити') {
  return new Promise(resolve => {
    let done = false;
    const s = sheet(`<div class="sheet-head"><b>${esc(ok)}</b></div><form class="confirm-type"><p>${esc(text)}</p>
      <p class="muted small">Щоб підтвердити, введіть <b>${word}</b></p><input autocomplete="off" autocapitalize="characters" spellcheck="false">
      <button class="btn primary danger-btn wide" type="submit" disabled>${esc(ok)}</button></form>`, { label: ok, onClose: () => { if (!done) resolve(null); } });
    const inp = $('input', s.el), btn = $('button[type=submit]', s.el);
    setTimeout(() => inp.focus(), 250);
    inp.addEventListener('input', () => { btn.disabled = inp.value.trim().toUpperCase() !== word; });
    $('form', s.el).addEventListener('submit', e => { e.preventDefault(); if (btn.disabled) return; done = true; s.close(); resolve(word); });
  });
}

// ---------- ліміти ----------
async function limitsPage(main) {
  const { limits: L, defaults: D } = await get('admin/limits');
  const row = (k, label, unit, note) => `<div class="kv"><span>${label}</span><div><div class="inline"><input type="number" min="0" data-l="${k}" value="${L[k]}" style="width:150px"><span class="muted small">${unit}</span></div><p class="muted small">${note} За замовчуванням ${D[k]}.</p></div></div>`;
  main.innerHTML = `<div class="adm-page">
    ${head('Ліміти', 'Для всіх користувачів з окремою базою. Адміністратори й основна база — без обмежень. 0 — без ліміту. Особисті винятки — у картці людини.')}
    <section class="box">
      <h3>Асистент</h3>
      ${row('ai', 'Запитів на день', 'запитів', 'Повідомлення асистенту, розбір «Вхідних», план і підсумок, розшифровка голосу.')}
      ${row('aiDemo', 'Для гостьового входу', 'запитів', 'Демо-акаунт guest — спільний для всіх, хто пробує.')}
    </section>
    <section class="box">
      <h3>Файли</h3>
      ${row('storageMb', 'Місце на людину', 'МБ', 'Вкладення до задач, фото й відео щоденних завдань, докази в дорученнях і челенджах — разом.')}
      ${row('uploadsDay', 'Завантажень на день', 'файлів', 'Посилання не рахуються.')}
    </section>
    <div class="row-act"><button type="button" class="btn primary" data-a="save">Зберегти</button></div>
  </div>`;
  $('[data-a="save"]', main).onclick = async () => {
    const body = {}; $$('[data-l]', main).forEach(i => { body[i.dataset.l] = i.value === '' ? null : +i.value; });
    try { await post('admin/limits', body); toast('Ліміти збережено'); } catch (e) { fail(e); }
  };
}

// ---------- асистент ----------
async function aiPage(main) {
  const [s, p, bu] = await Promise.all([get('admin/service'), get('admin/prices'), get('admin/budget')]);
  main.innerHTML = `<div class="adm-page">
    ${head('Асистент', 'Claude розбирає повідомлення, складає ранковий план і підсумок дня. Ключ зберігається на сервері зашифрованим і в браузер не віддається.')}
    <section class="box">
      <h3>Claude API</h3>
      <div class="kv"><span>Ключ</span><div><input type="password" data-f="anthropicKey" placeholder="${s.hasKey ? 'новий ключ, щоб замінити' : 'sk-ant-…'}" autocomplete="off">
        <p class="small">${s.hasKey ? `${icon('checkCircle', 13)} Ключ задано (${esc(s.keyHint)}) · <button type="button" class="link" data-a="clear-key">видалити</button>` : '<span class="bad">Ключ не задано — асистент не працює.</span>'} · <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a></p></div></div>
      <div class="kv"><span>Модель</span><div><input data-f="model" value="${esc(s.model || '')}" placeholder="claude-haiku-5-5" spellcheck="false"><p class="muted small">Haiku — швидко й дешево, вистачає для задач і нагадувань. Sonnet / Opus — розумніше, у 20–40 разів дорожче.</p></div></div>
      <div class="row-act"><button type="button" class="btn sm primary" data-a="save">Зберегти</button></div>
    </section>
    <section class="box">
      <h3>Бюджет на місяць</h3>
      <div class="meter"><div class="meter-l"><span>${MONTHS[+bu.month.slice(5, 7) - 1][0].toUpperCase() + MONTHS[+bu.month.slice(5, 7) - 1].slice(1)}: ${usd(bu.cost)}${bu.usd ? ` з ${usd(bu.usd)}` : ''}</span><span class="muted small">прогноз до кінця місяця ${usd(bu.forecast)}</span></div>
        ${bu.usd ? `<div class="meter-bar${bu.exceeded ? ' over' : ''}"><i style="width:${Math.min(100, pct(bu.cost, bu.usd))}%"></i></div>` : '<p class="muted small" style="margin:0">Бюджет не задано — витрати не обмежені.</p>'}</div>
      ${bu.exceeded ? `<p class="bad small">Бюджет вичерпано${bu.stop ? ' — асистент для користувачів призупинено до 1-го числа.' : '.'}</p>` : ''}
      <div class="kv"><span>Бюджет</span><div><div class="inline"><input type="number" min="0" step="1" data-b="usd" value="${bu.usd || ''}" placeholder="без бюджету" style="width:150px"><span class="muted small">$ на місяць</span></div>
        <p class="muted small">Коли витрати дійдуть до 80% і до 100%, вам прийде сповіщення в Telegram і на пристрої.</p></div></div>
      <div class="kv"><span>Коли вичерпано</span><div><label class="switch"><input type="checkbox" data-b="stop"${bu.stop ? ' checked' : ''}><span>зупиняти асистента для користувачів</span></label>
        <p class="muted small">Для вас і інших адмінів асистент працює й далі.</p></div></div>
      <div class="row-act"><button type="button" class="btn sm primary" data-a="budget">Зберегти бюджет</button></div>
    </section>
    <section class="box">
      <h3>Ціни моделей</h3>
      <p class="muted small">$ за 1 млн токенів — для підрахунку витрат в огляді. Стандартні — з прайсу Anthropic; змінюйте, якщо ціни оновились.</p>
      <table class="tbl prices"><thead><tr><th>Модель</th><th class="r">Вхід</th><th class="r">Вихід</th><th></th></tr></thead><tbody>
        ${p.list.map(x => `<tr data-m="${esc(x.model)}"><td><code>${esc(x.model)}</code>${x.custom ? ' <span class="tag">своя</span>' : ''}</td>
          <td class="r"><input type="number" step="0.01" min="0" value="${x.in}" data-p="in"></td><td class="r"><input type="number" step="0.01" min="0" value="${x.out}" data-p="out"></td>
          <td class="r"><button type="button" class="link" data-a="price">зберегти</button>${x.custom ? ' · <button type="button" class="link" data-a="price-reset">стандартна</button>' : ''}</td></tr>`).join('')}
      </tbody></table>
    </section>
  </div>`;
  main.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const k = b.dataset.a;
    try {
      if (k === 'save') {
        const body = { model: $('[data-f="model"]', main).value.trim() || 'claude-haiku-5-5' }, key = $('[data-f="anthropicKey"]', main).value.trim();
        if (key) body.anthropicKey = key;
        await post('admin/service', body); toast('Збережено'); route();
      }
      if (k === 'clear-key' && await confirmBox('Видалити ключ Claude API? Асистент перестане працювати для всіх.')) { await post('admin/service', { clearKey: true }); route(); }
      if (k === 'budget') { await post('admin/budget', { usd: +$('[data-b="usd"]', main).value || 0, stop: $('[data-b="stop"]', main).checked }); toast('Бюджет збережено'); route(); }
      const tr = b.closest('tr[data-m]');
      if (k === 'price' && tr) { await post('admin/prices', { model: tr.dataset.m, in: +$('[data-p="in"]', tr).value, out: +$('[data-p="out"]', tr).value }); toast('Ціну збережено'); route(); }
      if (k === 'price-reset' && tr) { await post('admin/prices', { model: tr.dataset.m, reset: true }); route(); }
    } catch (er) { fail(er); }
  });
}

// ---------- Telegram-бот ----------
async function botPage(main) {
  const s = await get('admin/service');
  main.innerHTML = `<div class="adm-page">
    ${head('Telegram-бот', 'Один бот на весь сервіс: кожен користувач привʼязує до нього свій чат у налаштуваннях mdmy.')}
    <section class="box">
      <h3>Стан</h3>
      ${s.hasBot ? `<p>${icon('checkCircle', 14)} Підключено <b>@${esc(s.botName)}</b> · <a href="https://t.me/${esc(s.botName)}" target="_blank" rel="noopener">відкрити</a></p>` : '<p class="bad">Бота не підключено.</p>'}
      ${s.botError ? `<p class="err">${esc(s.botError)}</p>` : ''}
      <div class="kv"><span>Токен бота</span><div><input type="password" data-f="botToken" placeholder="123456789:AA…" autocomplete="off">
        <p class="muted small">Створіть бота в <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> (<code>/newbot</code>) і вставте токен. Новий токен — і всі чати доведеться привʼязати знову.</p></div></div>
      <div class="row-act"><button type="button" class="btn sm primary" data-a="save">Зберегти токен</button>${s.hasBot ? '<button type="button" class="btn sm ghost danger" data-a="clear">Відключити бота</button>' : ''}</div>
    </section>
  </div>`;
  main.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    try {
      if (b.dataset.a === 'save') { const v = $('[data-f="botToken"]', main).value.trim(); if (!v) return toast('Вставте токен'); b.disabled = true; await post('admin/service', { botToken: v }); toast('Бота підключено'); route(); }
      if (b.dataset.a === 'clear' && await confirmBox('Відключити бота? Нагадування в Telegram перестануть приходити всім.')) { await post('admin/service', { clearBot: true }); route(); }
    } catch (er) { b.disabled = false; fail(er); }
  });
}

// ---------- вхід і реєстрація ----------
async function signupPage(main) {
  const g = await get('admin/auth');
  main.innerHTML = `<div class="adm-page">
    ${head('Вхід і реєстрація', 'Вхід через Google — реєстрація одним кроком, без паролів. Кожен новий користувач отримує окрему базу.')}
    <section class="box">
      <h3>Google</h3>
      <p class="small">${g.enabled ? `${icon('checkCircle', 13)} Увімкнено` : '<span class="bad">Вимкнено — потрібні Client ID і секрет.</span>'}</p>
      <p class="muted small">OAuth-клієнт створюється в <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a> (тип «Web application»), адреса повернення — нижче.</p>
      <div class="kv"><span>Адреса повернення</span><div><code class="g-redirect">${esc(g.redirectUri)}</code> <button type="button" class="link" data-a="copy">копіювати</button></div></div>
      <div class="kv"><span>Client ID</span><div><input data-g="clientId" value="${esc(g.clientId || '')}" placeholder="….apps.googleusercontent.com" autocomplete="off" spellcheck="false"></div></div>
      <div class="kv"><span>Client secret</span><div><input type="password" data-g="clientSecret" placeholder="${g.hasSecret ? 'новий секрет, щоб замінити' : 'GOCSPX-…'}" autocomplete="off">
        <p class="small">${g.hasSecret ? 'Секрет задано · <button type="button" class="link" data-a="clear">видалити</button>' : '<span class="muted">Секрет не задано</span>'}</p></div></div>
    </section>
    <section class="box">
      <h3>Реєстрація</h3>
      <div class="kv"><span>Нові користувачі</span><div><label class="switch"><input type="checkbox" data-g="signup"${g.signup ? ' checked' : ''}><span>можуть зареєструватись через Google</span></label>
        <p class="muted small">Вимкніть, щоб входили лише ті, хто вже має акаунт.</p></div></div>
      <div class="kv"><span>Контакт</span><div><input type="email" data-g="contact" value="${esc(g.contact || '')}" placeholder="пошта для питань про дані"><p class="muted small">Показується на сторінці <a href="/privacy.html" target="_blank" rel="noopener">конфіденційності</a> — її вимагає Google.</p></div></div>
    </section>
    <div class="row-act"><button type="button" class="btn primary" data-a="save">Зберегти</button></div>
  </div>`;
  main.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const f = x => $(`[data-g="${x}"]`, main);
    try {
      if (b.dataset.a === 'copy') navigator.clipboard.writeText(g.redirectUri).then(() => toast('Скопійовано'), () => {});
      if (b.dataset.a === 'clear' && await confirmBox('Видалити секрет Google? Вхід через Google вимкнеться.')) { await post('admin/auth', { clearSecret: true }); route(); }
      if (b.dataset.a === 'save') {
        const body = { clientId: f('clientId').value.trim(), signup: f('signup').checked, contact: f('contact').value.trim() };
        if (f('clientSecret').value.trim()) body.clientSecret = f('clientSecret').value.trim();
        await post('admin/auth', body); toast('Збережено'); route();
      }
    } catch (er) { fail(er); }
  });
}

// ---------- резервні копії ----------
async function backupsPage(main) {
  const r = await get('admin/backups');
  const c = r.check, daily = r.list.filter(x => x.kind === 'daily'), last = daily[0];
  const stale = !last || last.at < Date.now() - 2 * 864e5;
  main.innerHTML = `<div class="adm-page">
    ${head('Резервні копії', 'Щоночі о 03:30 сервер копіює всі бази. Копії зашифровані тим самим ключем, що й бази, — без файлу ключа їх не відкрити.', `<button type="button" class="btn sm primary" data-a="make">${icon('copy', 14)}Зробити копію зараз</button>`)}
    <section class="tiles">
      ${tile('Остання копія', last ? ago(new Date(last.at).toISOString().slice(0, 10)) : '—', last ? `${esc(fmtDate(last.at))} · ${mb(last.size + last.wsSize)}` : 'ще не було', 'copy')}
      ${tile('Перевірка', c ? (c.ok ? 'Відкривається' : '<span class="bad">Помилка</span>') : '—', c ? `${esc(fmtDate(c.at))} · ${esc(c.file)}` : 'ще не перевіряли', 'checkCircle')}
      ${tile('Зберігається', num(daily.length), `щоденних · перед оновленнями ${num(r.list.length - daily.length)}`, 'layers')}
    </section>
    ${r.error ? `<p class="err">${esc(r.error)} (${esc(r.dir)})</p>` : ''}
    ${stale && !r.error ? '<p class="bad">Свіжої копії немає понад дві доби — перевірте розклад (cron) на сервері.</p>' : ''}
    ${c && !c.ok ? `<section class="box"><h3 class="bad">Остання перевірка не пройшла</h3>${c.problems.map(p => `<p class="small">${esc(p)}</p>`).join('')}</section>` : ''}
    <section class="box">
      <h3>Перевірка</h3>
      <p class="muted small">Раз на тиждень сервер сам відкриває свіжу копію ключем і перевіряє цілісність кожної бази. Якщо щось не так — прийде сповіщення.</p>
      ${c ? `<dl class="facts"><div><dt>Файл</dt><dd>${esc(c.file)}</dd></div><div><dt>Облікових записів</dt><dd>${num(c.accounts)}</dd></div><div><dt>Окремих баз</dt><dd>${num(c.ws)}</dd></div><div><dt>Версія схеми</dt><dd>${num(c.version)}</dd></div></dl>` : ''}
      <div class="row-act"><button type="button" class="btn sm" data-a="verify">${icon('checkCircle', 14)}Перевірити зараз</button></div>
    </section>
    <section class="box">
      <h3>Копії</h3>
      ${r.list.length ? `<table class="tbl"><thead><tr><th>Коли</th><th>Вид</th><th class="r">Основна</th><th class="r">Окремі бази</th></tr></thead><tbody>
        ${r.list.map(x => `<tr><td>${esc(fmtDate(x.at))}</td><td>${x.kind === 'daily' ? 'щоденна' : 'перед оновленням'}</td><td class="r">${mb(x.size)}</td><td class="r">${x.ws ? `${num(x.ws)} · ${mb(x.wsSize)}` : '—'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">Копій ще немає.</p>'}
      <p class="muted small">Тека: <code>${esc(r.dir)}</code>. Фото, відео й вкладення в копії не входять — лише бази.</p>
    </section>
  </div>`;
  main.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    b.disabled = true; const was = b.innerHTML; b.innerHTML = '<span class="spin"></span>Зачекайте…';
    try {
      if (b.dataset.a === 'make') { const x = await post('admin/backups', { action: 'make' }); toast(`Копію зроблено: ${x.file}${x.check && x.check.ok ? ' · перевірено' : ''}`); }
      if (b.dataset.a === 'verify') { const x = await post('admin/backups', { action: 'verify' }); toast(x.ok ? 'Копія відкривається, бази цілі' : 'Перевірка не пройшла'); }
      route();
    } catch (er) { fail(er); b.disabled = false; b.innerHTML = was; }
  });
}

// ---------- система ----------
async function systemPage(main) {
  const x = await get('admin/system'), s = x.server, st = x.storage;
  const memUsed = s.mem.total - s.mem.free;
  const sum = a => a.reduce((n, d) => n + d.v, 0);
  main.innerHTML = `<div class="adm-page">
    ${head('Система', 'Стан сервера, служб і даних.', `<button type="button" class="btn sm" data-a="refresh">${icon('repeat', 14)}Оновити</button>`)}
    <section class="tiles">
      ${tile('Сайт', 'Працює', `версія ${esc(s.version)} · ${dur(s.uptime)} без перезапуску`, 'checkCircle')}
      ${tile('Розшифровка голосу', s.stt ? 'Працює' : '<span class="bad">Не відповідає</span>', s.stt ? esc(s.stt.model || '') : 'служба dm-stt', 'mic')}
      ${tile('Памʼять', `${pct(memUsed, s.mem.total)}%`, `${mb(memUsed)} з ${mb(s.mem.total)} · сайт ${mb(s.mem.app)}`, 'activity')}
      ${tile('Диск', s.disk ? `${pct(s.disk.total - s.disk.free, s.disk.total)}%` : '—', s.disk ? `вільно ${mb(s.disk.free)} з ${mb(s.disk.total)}` : '', 'layers')}
    </section>
    <section class="cols">
      <div class="box"><h3>Дані</h3><dl class="facts">
        <div><dt>Основна база</dt><dd>${mb(st.main)}</dd></div>
        <div><dt>Окремі бази</dt><dd>${num(st.wsCount)} · ${mb(st.ws)}</dd></div>
        <div><dt>Фото, відео, вкладення</dt><dd>${mb(st.files)}</dd></div>
        <div><dt>Усього в теці даних</dt><dd>${mb(s.data)}</dd></div>
      </dl></div>
      <div class="box"><h3>Доставка</h3><dl class="facts">
        <div><dt>Підписок на сповіщення</dt><dd>${num(x.push.subs)}${x.push.failing ? ` · <span class="bad">з помилками ${num(x.push.failing)}</span>` : ''}</dd></div>
        <div><dt>Нагадувань за 14 днів</dt><dd>${num(sum(x.reminders.ok))}${sum(x.reminders.fail) ? ` · <span class="bad">не доставлено ${num(sum(x.reminders.fail))}</span>` : ''}</dd></div>
        <div><dt>Помилок Claude за 14 днів</dt><dd>${sum(x.aiErrors) ? `<span class="bad">${num(sum(x.aiErrors))}</span>` : '0'}</dd></div>
        <div><dt>Навантаження</dt><dd>${s.load.map(v => v.toFixed(2)).join(' · ')} <span class="muted">(${s.cpus} ядра)</span></dd></div>
        <div><dt>Node.js</dt><dd>${esc(s.node)}</dd></div>
        <div><dt>Сервер без перезавантаження</dt><dd>${dur(s.hostUptime)}</dd></div>
      </dl></div>
    </section>
    <section class="box"><h3>Нагадування за 14 днів</h3>${bars(x.reminders.ok)}</section>
    <section class="box">
      <h3>Оновлення</h3>
      ${x.updates ? `<p class="small">${x.updates.last ? esc(x.updates.last) : 'Записів про оновлення ще немає.'}</p><pre class="logbox">${esc(x.updates.lines.join('\n'))}</pre>`
        : '<p class="muted small">Журнал автооновлень недоступний (на сервері — /var/log/mdmy-update.log).</p>'}
    </section>
  </div>`;
  $('[data-a="refresh"]', main).onclick = () => route();
}
