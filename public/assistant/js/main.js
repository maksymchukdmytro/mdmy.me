// mdmy · персональний асистент — точка входу.
// Оболонка (бічна панель, верхня смуга, нижня панель на телефоні), маршрути #/…, вхід, тема, командна палітра (Ctrl+K).
import { api, post, onUnauthorized, telegramInitData, telegramLogin, clearToken } from './api.js';
import { icon } from './icons.js';
import { $, $$, esc, pref, toast, isTyping, debounce, fmtDue } from './ui.js';
import { meta, refreshMeta, onMeta, openSpaces, space } from './store.js';
import { tasksPage } from './views/tasks.js';
import { openTask, closeTask, panelOpenId } from './views/panel.js';
import { notesPage } from './views/notes.js';
import { statePage } from './views/state.js';
import { recordPage } from './views/record.js';
import { settingsPage } from './views/settings.js';
import { parse, go, taskHref } from './nav.js';

const app = $('#app');
let account = null, current = null, currentKey = '';

// ---------- тема ----------
function applyTheme() {
  const t = pref.get('theme', 'system');
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}
applyTheme();
export const setTheme = t => { pref.set('theme', t); applyTheme(); };

// ---------- вхід ----------
function showLogin(err) {
  closeTask();
  app.innerHTML = `<main class="login">
    <form class="login-card" id="loginForm">
      <div class="login-logo"><span class="ws-logo lg">m</span></div>
      <h1>Вхід у mdmy</h1>
      <p class="muted">Задачі, нотатки й персональний асистент</p>
      <label class="field"><span>Логін</span><input name="login" autocomplete="username" autocapitalize="off" required></label>
      <label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
      <p class="err">${esc(err || '')}</p>
      <button class="btn primary wide" type="submit">Увійти</button>
    </form></main>`;
  const f = $('#loginForm');
  f.login.focus();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try { await post('login', { login: f.login.value, password: f.password.value }); await boot(); }
    catch (err) { f.querySelector('.err').textContent = err.message; btn.disabled = false; }
  });
}
onUnauthorized(() => { if (account) { account = null; clearToken(); showLogin('Сесія завершилась — увійдіть знову.'); } });

// ---------- оболонка ----------
function shell() {
  app.innerHTML = `<div class="app${pref.get('sideHidden', false) ? ' side-hidden' : ''}" id="shell">
    <aside class="side" id="side" aria-label="Навігація">
      <div class="side-top">
        <a class="ws" href="#/today"><span class="ws-logo">m</span><span class="ws-name">${esc(account.name || 'mdmy')}</span></a>
        <button class="icon-btn" data-act="side-toggle" title="Сховати панель">${icon('sidebar')}</button>
      </div>
      <button class="side-item" data-act="search">${icon('search')}<span>Пошук</span><kbd>Ctrl K</kbd></button>
      <a class="side-item" href="#/record" data-r="record">${icon('mic')}<span>Запис голосом</span></a>
      <div class="side-gap"></div>
      <a class="side-item" href="#/today" data-r="today">${icon('sun')}<span>Сьогодні</span><b class="n" data-n="today"></b></a>
      <a class="side-item" href="#/upcoming" data-r="upcoming">${icon('upcoming')}<span>Найближчі 7 днів</span></a>
      <a class="side-item" href="#/s/inbox" data-r="s/inbox">${icon('inbox')}<span>Вхідні</span><b class="n badge" data-n="inbox"></b></a>
      <a class="side-item" href="#/all" data-r="all">${icon('layers')}<span>Усі задачі</span><b class="n" data-n="all"></b></a>
      <div class="side-label"><span>Простори</span><button class="icon-btn xs" data-act="new-space" title="Новий простір">${icon('plus', 14)}</button></div>
      <div id="sideSpaces"></div>
      <div class="side-label"><span>Інше</span></div>
      <a class="side-item" href="#/notes" data-r="notes">${icon('note')}<span>Нотатки</span></a>
      <a class="side-item" href="#/state" data-r="state">${icon('activity')}<span>Стан і звички</span></a>
      <a class="side-item" href="#/settings" data-r="settings">${icon('settings')}<span>Налаштування</span></a>
      <div class="side-foot">
        <a class="side-item" href="/" title="Головна mdmy.me">${icon('home')}<span>mdmy.me</span></a>
      </div>
    </aside>
    <div class="side-scrim" data-act="side-close"></div>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn show-side" data-act="side-toggle" title="Показати панель">${icon('menu')}</button>
        <nav class="crumbs" id="crumbs"></nav>
        <div class="top-act" id="topAct"></div>
      </header>
      <div class="view" id="view"></div>
    </div>
    <nav class="tabbar" aria-label="Швидкі переходи">
      <a href="#/today" data-r="today">${icon('sun', 20)}<span>Сьогодні</span></a>
      <a href="#/s/inbox" data-r="s/inbox">${icon('inbox', 20)}<span>Вхідні</span><b class="n badge" data-n="inbox"></b></a>
      <a href="#/record" data-r="record" class="tab-mic">${icon('mic', 22)}</a>
      <button type="button" data-act="search">${icon('search', 20)}<span>Пошук</span></button>
      <button type="button" data-act="side-open">${icon('menu', 20)}<span>Меню</span></button>
    </nav>
  </div>`;
  renderSideSpaces();
  app.addEventListener('click', onShellClick);
}
function renderSideSpaces() {
  const box = $('#sideSpaces'); if (!box) return;
  box.innerHTML = openSpaces().filter(s => s.key !== 'inbox').map(s =>
    `<a class="side-item" href="#/s/${s.key}" data-r="s/${s.key}">${icon(s.icon)}<span>${esc(s.name)}</span><b class="n" data-n="s:${s.key}"></b></a>`).join('');
  renderCounts(); markActive();
}
function renderCounts() {
  const c = meta.counts || {};
  for (const el of $$('[data-n]')) {
    const k = el.dataset.n;
    const v = k === 'today' ? c.today : k === 'inbox' ? c.inbox : k === 'all' ? c.all : k.startsWith('s:') ? (c.spaces || {})[k.slice(2)] : 0;
    el.textContent = v ? (v > 999 ? '999+' : v) : '';
  }
}
function markActive() {
  const r = currentKey;
  for (const a of $$('[data-r]')) a.classList.toggle('on', a.dataset.r === r);
}
onMeta(() => { renderSideSpaces(); });

async function onShellClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) {
    // на телефоні після переходу ховаємо меню
    if (e.target.closest('.side a[href]') && innerWidth < 900) $('#shell').classList.remove('side-open');
    return;
  }
  const a = b.dataset.act, sh = $('#shell');
  if (a === 'side-toggle') {
    if (innerWidth < 900) sh.classList.toggle('side-open');
    else { sh.classList.toggle('side-hidden'); pref.set('sideHidden', sh.classList.contains('side-hidden')); }
  }
  if (a === 'side-open') sh.classList.add('side-open');
  if (a === 'side-close') sh.classList.remove('side-open');
  if (a === 'search') palette();
  if (a === 'new-space') location.hash = '#/settings/spaces';
}

// ---------- маршрути (nav.js) ----------
function pageFor(key, parts) {
  if (key === 'today') return tasksPage({ key, title: 'Сьогодні', icon: 'sun', area: 'all', view: 'today', group: 'space', desc: 'Прострочене й заплановане на сьогодні з усіх просторів' });
  if (key === 'upcoming') return tasksPage({ key, title: 'Найближчі 7 днів', icon: 'upcoming', area: 'all', view: 'week', group: 'date', desc: 'Усе, що має строк протягом тижня' });
  if (key === 'all') return tasksPage({ key, title: 'Усі задачі', icon: 'layers', area: 'all', view: 'open', group: 'space' });
  if (key.startsWith('s/')) {
    const sp = space(parts[1] || 'inbox');
    return tasksPage({ key, title: sp.name, icon: sp.icon, area: sp.key, view: 'open', group: 'date', desc: sp.key === 'inbox' ? 'Задачі, які асистент не зміг однозначно віднести до простору. Розкладіть їх.' : sp.description });
  }
  if (key === 'notes') return notesPage();
  if (key === 'state') return statePage();
  if (key === 'record') return recordPage();
  if (key === 'settings') return settingsPage(parts[1]);
  return tasksPage({ key: 'today', title: 'Сьогодні', icon: 'sun', area: 'all', view: 'today', group: 'space' });
}
const CRUMB = { today: ['sun', 'Сьогодні'], upcoming: ['upcoming', 'Найближчі 7 днів'], all: ['layers', 'Усі задачі'], notes: ['note', 'Нотатки'],
                state: ['activity', 'Стан і звички'], record: ['mic', 'Запис голосом'], settings: ['settings', 'Налаштування'] };
let currentPage = '';
function route() {
  if (!account) return;
  const { key, parts, task } = parse();
  const pageKey = key === 'settings' ? 'settings' : key;     // розділи налаштувань — одна сторінка з якорями
  if (pageKey !== currentPage || !current) {
    if (current && current.destroy) current.destroy();
    currentPage = pageKey; currentKey = key;
    // новий контейнер для кожної сторінки — обробники попередньої не лишаються
    const old = $('#view'), view = old.cloneNode(false); old.replaceWith(view); scrollTo(0, 0);
    $('#topAct').innerHTML = '';
    const [ic, name] = key.startsWith('s/') ? [space(parts[1] || 'inbox').icon, space(parts[1] || 'inbox').name] : (CRUMB[key] || CRUMB.today);
    $('#crumbs').innerHTML = `${icon(ic)}<span>${esc(name)}</span>`;
    current = pageFor(key, parts);
    current.render(view, $('#topAct'));
    markActive();
    document.title = `${name} · mdmy`;
  } else if (key === 'settings' && parts[1]) {
    const t = document.getElementById('set-' + parts[1]); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (task && panelOpenId() !== task) openTask(task);
  if (!task && panelOpenId()) closeTask();
}
addEventListener('hashchange', route);

// зміни даних (з будь-якого місця) → оновити поточну сторінку й лічильники
const changed = debounce(() => { refreshMeta().catch(() => {}); if (current && current.refresh) current.refresh(); }, 120);
document.addEventListener('mdmy:changed', changed);
// повернулись на вкладку — підтягнути свіже (могли змінити з телефона чи Telegram)
document.addEventListener('visibilitychange', () => { if (!document.hidden && account) changed(); });

// ---------- командна палітра ----------
function palette() {
  if ($('.pal-wrap')) return;
  const w = document.createElement('div'); w.className = 'pal-wrap';
  w.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="Пошук">
    <div class="pal-in">${icon('search', 18)}<input placeholder="Пошук задач, нотаток або перехід…" autocomplete="off"></div>
    <div class="pal-list"></div></div>`;
  document.body.append(w);
  const input = w.querySelector('input'), list = w.querySelector('.pal-list');
  let items = [], sel = 0;
  const nav = [
    ...['today', 'upcoming', 'all'].map(k => ({ type: 'nav', icon: CRUMB[k][0], label: CRUMB[k][1], href: '#/' + k })),
    ...openSpaces().map(s => ({ type: 'nav', icon: s.icon, label: s.name, href: '#/s/' + s.key })),
    ...['notes', 'state', 'record', 'settings'].map(k => ({ type: 'nav', icon: CRUMB[k][0], label: CRUMB[k][1], href: '#/' + k }))
  ];
  const draw = () => {
    list.innerHTML = items.length ? items.map((it, i) => `<button type="button" class="pal-item${i === sel ? ' on' : ''}" data-i="${i}">
        <span class="pal-ic">${icon(it.icon)}</span><span class="pal-l">${esc(it.label)}</span>${it.hint ? `<span class="pal-h">${esc(it.hint)}</span>` : ''}</button>`).join('')
      : '<div class="pal-empty">Нічого не знайдено</div>';
  };
  const search = debounce(async q => {
    const n = nav.filter(x => !q || x.label.toLowerCase().includes(q.toLowerCase()));
    if (!q) { items = n; sel = 0; return draw(); }
    try {
      const [t, notes] = await Promise.all([api('assistant/tasks?area=all&view=any&sort=smart&limit=15&q=' + encodeURIComponent(q)), api('assistant/notes?q=' + encodeURIComponent(q))]);
      items = [...t.list.map(x => ({ type: 'task', icon: x.done ? 'checkCircle' : 'circle', label: x.text, hint: [space(x.area).name, x.due_at ? fmtDue(x.due_at) : ''].filter(Boolean).join(' · '), id: x.id })),
               ...notes.list.slice(0, 6).map(x => ({ type: 'note', icon: 'note', label: x.text.slice(0, 90), hint: 'нотатка', href: '#/notes' })), ...n];
    } catch (e) { items = n; }
    sel = 0; draw();
  }, 160);
  const pick = it => { close(); if (!it) return; if (it.type === 'task') go(taskHref(it.id)); else go(it.href); };
  const close = () => { w.remove(); document.removeEventListener('keydown', key, true); };
  const key = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[sel]); }
  };
  document.addEventListener('keydown', key, true);
  input.addEventListener('input', () => search(input.value.trim()));
  w.addEventListener('click', e => { if (e.target === w) return close(); const b = e.target.closest('.pal-item'); if (b) pick(items[+b.dataset.i]); });
  items = nav; draw(); input.focus();
}

// ---------- клавіатура ----------
document.addEventListener('keydown', e => {
  if (!account) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'л')) { e.preventDefault(); palette(); return; }
  if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); palette(); }
});

// ---------- старт ----------
async function boot() {
  try { account = (await api('me')).account; }
  catch (e) {
    if (telegramInitData() && await telegramLogin()) { try { account = (await api('me')).account; } catch (e2) {} }
    if (!account) return showLogin();
  }
  try { await refreshMeta(); } catch (e) { toast(e.message); }
  if (/tgWebAppData=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/today');
  current = null; currentKey = ''; currentPage = '';
  shell();
  route();
}
export async function logout() {
  try { await post('logout'); } catch (e) {}
  account = null; clearToken(); showLogin();
}
export const getAccount = () => account;
// для статистичних сторінок і налаштувань
window.MDMY = { go, logout, setTheme, refreshMeta };
boot();
