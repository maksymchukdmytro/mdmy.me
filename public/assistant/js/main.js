// mdmy · персональний асистент — точка входу.
// Оболонка (бічна панель, верхня смуга, нижня панель на телефоні), маршрути #/…, вхід, тема, командна палітра (Ctrl+K).
import { api, post, onUnauthorized, telegramInitData, telegramLogin, clearToken } from './api.js';
import { icon } from './icons.js';
import { $, $$, esc, pref, toast, isTyping, debounce, fmtDue, sheet } from './ui.js';
import { meta, refreshMeta, onMeta, openSpaces, space } from './store.js';
import { tasksPage } from './views/tasks.js';
import { openTask, closeTask, panelOpenId } from './views/panel.js';
import { notesPage } from './views/notes.js';
import { ritualsPage } from './views/rituals.js';
import { openRitual, closeRitual, ritualOpenId } from './views/ritual-play.js';
import { recordPage } from './views/record.js';
import { settingsPage } from './views/settings.js';
import { parse, go, taskHref } from './nav.js';
import * as push from './push.js';
import { holdToTalk } from './hold.js';

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
      <a class="side-item desk-only" href="#/record" data-r="record">${icon('mic')}<span>Запис голосом</span></a>
      <div class="side-gap"></div>
      <a class="side-item" href="#/today" data-r="today">${icon('sun')}<span>Сьогодні</span><b class="n" data-n="today"></b></a>
      <a class="side-item" href="#/upcoming" data-r="upcoming">${icon('upcoming')}<span>Найближчі 7 днів</span></a>
      <a class="side-item" href="#/s/inbox" data-r="s/inbox">${icon('inbox')}<span>Вхідні</span><b class="n badge" data-n="inbox"></b></a>
      <a class="side-item" href="#/rituals" data-r="rituals">${icon('ritual')}<span>Ритуали</span></a>
      <a class="side-item" href="#/all" data-r="all">${icon('layers')}<span>Усі задачі</span><b class="n" data-n="all"></b></a>
      <div class="side-label"><span>Простори</span><button class="icon-btn xs" data-act="new-space" title="Новий простір">${icon('plus', 14)}</button></div>
      <div id="sideSpaces"></div>
      <div class="side-label"><span>Інше</span></div>
      <a class="side-item" href="#/notes" data-r="notes">${icon('note')}<span>Нотатки</span></a>
      <a class="side-item" href="#/settings" data-r="settings">${icon('settings')}<span>Налаштування</span></a>
      <div class="side-stats" data-act="stats"></div>
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
      <button type="button" data-r="record" class="tab-mic" aria-label="Запис голосом: натисніть — відкрити, утримуйте — говорити">${icon('mic', 22)}</button>
      <a href="#/rituals" data-r="rituals">${icon('ritual', 20)}<span>Ритуали</span></a>
      <button type="button" data-act="side-open">${icon('menu', 20)}<span>Меню</span></button>
    </nav>
  </div>`;
  renderSideSpaces(); renderStats();
  app.addEventListener('click', onShellClick);
  holdToTalk($('.tab-mic', app));
}
function renderSideSpaces() {
  const box = $('#sideSpaces'); if (!box) return;
  box.innerHTML = openSpaces().filter(s => s.key !== 'inbox').map(s =>
    `<a class="side-item" href="#/s/${s.key}" data-r="s/${s.key}">${icon(s.icon)}<span>${esc(s.name)}</span><b class="n" data-n="s:${s.key}"></b></a>`).join('');
  renderCounts(); markActive();
}
// «Стабільність»: зроблено за 14 днів (задачі й ритуали) — плавна лінія
function renderStats() {
  const box = $('.side-stats'); if (!box) return;
  const a = meta.activity || []; if (!a.length) { box.innerHTML = ''; return; }
  const max = Math.max(1, ...a.map(x => x.n)), W = 180, H = 46;
  const pts = a.map((x, i) => [i * W / (a.length - 1), H - 4 - (x.n / max) * (H - 10)]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2; d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`; }
  const total = a.reduce((s, x) => s + x.n, 0), half = a.length / 2;
  const recent = a.slice(half).reduce((s, x) => s + x.n, 0), before = a.slice(0, half).reduce((s, x) => s + x.n, 0);
  const word = !total ? 'Почнімо' : recent > before * 1.15 ? 'Краще, ніж тиждень тому' : recent < before * 0.85 ? 'Трохи менше, ніж тиждень тому' : 'Рівно й стабільно';
  box.innerHTML = `<svg viewBox="-2 0 ${W + 4} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true"><path class="spark" d="${d}"/></svg>
    <small>${word}</small><b>Стабільність · ${total} за 2 тижні</b>`;
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
onMeta(() => { renderSideSpaces(); renderStats(); });

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
  if (a === 'side-open') phoneMenu();
  if (a === 'side-close') sh.classList.remove('side-open');
  if (a === 'search') palette();
  if (a === 'new-space') location.hash = '#/settings/spaces';
}

// ---------- меню телефона: легкий нижній аркуш ----------
// Сьогодні, Вхідні й Ритуали — на нижній панелі, тут лише решта: пошук, простори, інші розділи.
function phoneMenu() {
  const c = meta.counts || {}, cur = currentKey;
  const item = (href, ic, label, n, key) => `<a class="m-item${key === cur ? ' on' : ''}" href="${href}">${icon(ic, 20)}<span>${esc(label)}</span>${n ? `<b>${n}</b>` : ''}</a>`;
  const s = sheet(`<div class="m-sheet">
      <button type="button" class="m-search" data-m="search">${icon('search', 18)}Пошук задач і нотаток</button>
      <p class="m-label">Простори</p>
      ${openSpaces().filter(x => x.key !== 'inbox').map(x => item('#/s/' + x.key, x.icon, x.name, (c.spaces || {})[x.key], 's/' + x.key)).join('')}
      <a class="m-item add" href="#/settings/spaces">${icon('plus', 20)}<span>Новий простір</span></a>
      <p class="m-label">Ще</p>
      ${item('#/upcoming', 'upcoming', 'Найближчі 7 днів', 0, 'upcoming')}
      ${item('#/all', 'layers', 'Усі задачі', c.all, 'all')}
      ${item('#/notes', 'note', 'Нотатки', 0, 'notes')}
      ${item('#/record', 'mic', 'Запис голосом', 0, 'record')}
      ${item('#/settings', 'settings', 'Налаштування', 0, 'settings')}
    </div>`, { label: 'Меню' });
  s.el.addEventListener('click', e => {
    if (e.target.closest('[data-m="search"]')) { s.close(); return setTimeout(palette, 200); }
    if (e.target.closest('a[href]')) s.close();
  });
}

// ---------- маршрути (nav.js) ----------
function pageFor(key, parts) {
  if (key === 'today') return tasksPage({ key, title: 'Сьогодні', icon: 'sun', area: 'all', view: 'today', group: 'tod', name: account.name });
  if (key === 'upcoming') return tasksPage({ key, title: 'Найближчі 7 днів', icon: 'upcoming', area: 'all', view: 'week', group: 'date' });
  if (key === 'all') return tasksPage({ key, title: 'Усі задачі', icon: 'layers', area: 'all', view: 'open', group: 'space' });
  if (key.startsWith('s/')) {
    const sp = space(parts[1] || 'inbox');
    return tasksPage({ key, title: sp.name, icon: sp.icon, area: sp.key, view: 'open', group: 'date' });
  }
  if (key === 'notes') return notesPage();
  if (key === 'rituals') return ritualsPage(parts[1]);
  if (key === 'record') return recordPage();
  if (key === 'settings') return settingsPage(parts[1]);
  return tasksPage({ key: 'today', title: 'Сьогодні', icon: 'sun', area: 'all', view: 'today', group: 'tod', name: account.name });
}
const CRUMB = { today: ['sun', 'Сьогодні'], upcoming: ['upcoming', 'Найближчі 7 днів'], all: ['layers', 'Усі задачі'], notes: ['note', 'Нотатки'],
                rituals: ['ritual', 'Ритуали'], record: ['mic', 'Запис голосом'], settings: ['settings', 'Налаштування'] };
let currentPage = '', lastPage = '';
// показати сторінку без зміни адреси (під екраном ритуалу, якщо застосунок відкрили зі сповіщення)
function mount(key, parts) {
  const old = $('#view'), view = old.cloneNode(false); old.replaceWith(view);
  current = pageFor(key, parts); current.render(view, $('#topAct')); markActive();
}
function route() {
  if (!account) return;
  const { key, parts, task } = parse();
  // #/r/<id> — екран виконання ритуалу поверх сторінки (з ним відкривається сповіщення)
  if (key === 'r') {
    const id = +parts[1];
    if (!current) { currentPage = 'today'; currentKey = 'today'; mount('today', ['today']); }
    if (id && ritualOpenId() !== id) openRitual(id, () => go(lastPage || '#/today'));
    return;
  }
  if (ritualOpenId()) closeRitual();
  lastPage = location.hash;
  // розділи налаштувань — одна сторінка з якорями; редактор ритуалу — окрема
  const pageKey = key === 'settings' ? 'settings' : key === 'rituals' ? parts.slice(0, 2).join('/') : key;
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
    view.classList.add('enter');
    markActive();
    document.title = `${name} · mdmy`;
  } else if (key === 'settings' && parts[1]) {
    const t = document.getElementById('set-' + parts[1]); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (task && panelOpenId() !== task) openTask(task);
  if (!task && panelOpenId()) closeTask();
}
addEventListener('hashchange', route);
// назва сторінки у верхній смузі зʼявляється, лише коли великий заголовок прокручено
addEventListener('scroll', () => { const sh = $('#shell'); if (sh) sh.classList.toggle('scrolled', scrollY > 56); }, { passive: true });

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
    ...['rituals', 'notes', 'record', 'settings'].map(k => ({ type: 'nav', icon: CRUMB[k][0], label: CRUMB[k][1], href: '#/' + k }))
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
  push.registerSW().then(() => setTimeout(offerPush, 2500));
}

// Один раз на пристрої пропонуємо увімкнути сповіщення (нагадування приходитимуть, навіть коли сайт закритий)
async function offerPush() {
  if (pref.get('pushAsked', false) || !account) return;
  const s = await push.status();
  if (!s.supported || s.permission !== 'default' || s.subscribed) return;
  const box = document.createElement('div'); box.className = 'offer';
  box.innerHTML = `<div class="offer-ic">${icon('bell', 20)}</div><div class="offer-t"><b>Сповіщення на цьому пристрої</b><span>Нагадування, ранковий план і підсумок дня — навіть коли mdmy закрито.</span></div>
    <div class="offer-a"><button type="button" class="btn sm ghost" data-v="0">Не зараз</button><button type="button" class="btn sm primary" data-v="1">Увімкнути</button></div>`;
  document.body.append(box);
  box.addEventListener('click', async e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    pref.set('pushAsked', true); box.remove();
    if (b.dataset.v === '1') { try { await push.enable(); toast('Сповіщення увімкнено'); } catch (err) { toast(err.message); } }
  });
}
export async function logout() {
  try { await post('logout'); } catch (e) {}
  account = null; clearToken(); showLogin();
}
export const getAccount = () => account;
// для статистичних сторінок і налаштувань
window.MDMY = { go, logout, setTheme, refreshMeta };
boot();
