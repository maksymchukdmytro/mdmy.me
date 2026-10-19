// Сторінка задач (простір, «Сьогодні», «Найближчі», «Усі»): режими «Список» і «Дошка» (канбан за статусами),
// пошук, фільтри, сортування, групування, швидке додавання, вибір і масові дії, розбір «Вхідних» по одній.
import { api, get, post } from '../api.js';
import { icon, STATUS_ICON } from '../icons.js';
import { $, $$, esc, pref, toast, fail, menu, confirmBox, debounce, fmtDue, dueBucket, BUCKETS, isTyping, spin, wait } from '../ui.js';
import { todayRituals } from './rituals.js';
import { meta, space, status, openSpaces, firstStatus, onMeta } from '../store.js';
import { go, taskHref } from '../nav.js';
import { datePicker } from './panel.js';
import { compose } from './composer.js';

const PAGE = 100;
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));
const VIEWS = [['open', 'Будь-коли'], ['today', 'Сьогодні й прострочене'], ['overdue', 'Прострочене'], ['week', 'Найближчі 7 днів'], ['nodate', 'Без строку']];
const SORTS = [['smart', 'За строком'], ['prio', 'За пріоритетом'], ['created', 'Спершу нові'], ['alpha', 'За алфавітом'], ['manual', 'Вручну (як на дошці)']];
const GROUPS = [['date', 'За строком'], ['status', 'За статусом'], ['space', 'За простором'], ['none', 'Без груп']];
const TOD = { late: 'Прострочене', morning: 'Зранку', day: 'Вдень', evening: 'Увечері', nodate: 'Без часу' };

export function tasksPage(cfg) {
  const K = k => `tasks:${cfg.key}:${k}`;
  const st = {
    mode: pref.get(K('mode'), 'list'), sort: pref.get(K('sort'), 'smart'), group: pref.get(K('group'), cfg.group || 'date'),
    view: cfg.view, q: '', tag: '', prio: 0, showDone: false,
    items: [], total: 0, columns: null, counts: null, sel: new Set(), selecting: false, sug: new Map(), loading: 0,
    collapsed: new Set(pref.get(K('collapsed'), cfg.key === 'today' ? ['donetoday'] : [])), rituals: []
  };
  const fixedView = cfg.view !== 'open';
  const isToday = cfg.key === 'today';
  const WDN = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота'];
  const MONG = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  function greeting() {
    const d = new Date(), h = d.getHours(), name = (cfg.name || '').split(' ')[0];
    const g = h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Добрий день' : 'Добрий вечір';
    return { date: `${WDN[d.getDay()]}, ${d.getDate()} ${MONG[d.getMonth()]}`, text: name ? `${g}, ${name}` : g };
  }
  const cross = cfg.area === 'all';
  let root, top;

  // ---------- каркас ----------
  function render(el, topAct) {
    root = el; top = topAct;
    root.innerHTML = `<div class="page tasks-page${isToday ? ' today-page' : ''}" data-layout="${st.mode}">
      <div class="page-head">
        ${isToday ? `<p class="overline">${esc(greeting().date)}</p><h1 class="page-title">${esc(greeting().text)}</h1>` : `<h1 class="page-title">${esc(cfg.title)}</h1>`}
      </div>
      ${isToday ? '<div class="day-card" hidden></div><div class="rt-strip" hidden></div>' : ''}
      <div class="inbox-bar" hidden></div>
      <div class="vbar">
        <div class="vtabs" role="tablist">
          <button type="button" data-mode="list" role="tab">${icon('list')}<span>Список</span></button>
          <button type="button" data-mode="board" role="tab">${icon('board')}<span>Дошка</span></button>
        </div>
        <div class="vtools">
          <label class="vsearch">${icon('search', 15)}<input type="search" placeholder="Пошук" aria-label="Пошук у задачах"></label>
          <button type="button" class="tbtn" data-t="filter" title="Фільтр">${icon('filter', 15)}<span>Фільтр</span></button>
          <button type="button" class="tbtn list-only" data-t="look" title="Сортування й групи">${icon('sort', 15)}<span>Вигляд</span></button>
          <button type="button" class="tbtn phone-only" data-t="layout" title="Список / дошка">${icon(st.mode === 'board' ? 'list' : 'board', 18)}</button>
          <button type="button" class="tbtn desk-only" data-t="select" title="Вибрати кілька (на телефоні — утримати задачу)">${icon('check', 15)}<span>Вибрати</span></button>
        </div>
      </div>
      <div class="fchips"></div>
      <div class="tcontent"></div>
      <button type="button" class="btn more" hidden></button>
      <div class="bulk" hidden></div>
      <button type="button" class="fab" data-t="compose" aria-label="Нова задача" title="Нова задача (N)">${icon('plus', 26)}</button>
    </div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyIn);
    longPress(); swipe();
    offMeta = onMeta(() => { drawDay(); drawInbox(); });
    const s = $('.vsearch input', root);
    s.addEventListener('input', debounce(() => { st.q = s.value.trim(); load(); }, 220));
    document.addEventListener('keydown', onKey);
    syncBar(); load();
  }
  let offMeta = null;
  function destroy() { document.removeEventListener('keydown', onKey); document.body.classList.remove('bulk-on'); if (offMeta) offMeta(); }

  function syncBar() {
    const page = $('.tasks-page', root); page.dataset.layout = st.mode;
    $$('.vtabs button', root).forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === st.mode)));
    const chips = [];
    if (!fixedView && st.view !== 'open') chips.push(['view', 'Строк: ' + VIEWS.find(v => v[0] === st.view)[1]]);
    if (st.prio) chips.push(['prio', st.prio === 2 ? 'Лише термінові' : 'Важливі й термінові']);
    if (st.tag) chips.push(['tag', '#' + st.tag]);
    if (st.showDone && st.mode === 'list') chips.push(['done', 'Виконані']);
    $('.fchips', root).innerHTML = chips.map(([k, l]) => `<button type="button" class="fchip" data-clear="${k}">${esc(l)}${icon('x', 12)}</button>`).join('');
    $('[data-t="filter"]', root).classList.toggle('on', chips.length > 0);
    $('[data-t="select"]', root).classList.toggle('on', st.selecting);
    $('[data-t="layout"]', root).innerHTML = icon(st.mode === 'board' ? 'list' : 'board', 18);
  }

  // ---------- завантаження ----------
  function params(extra) {
    const p = new URLSearchParams({ area: cfg.area, view: st.showDone ? 'done' : st.view, sort: st.group === 'status' && st.sort === 'smart' ? 'smart' : st.sort, ...extra });
    if (st.q) p.set('q', st.q); if (st.tag) p.set('tag', st.tag); if (st.prio) p.set('prio', st.prio);
    return p;
  }
  async function load(more) {
    const strip = $('.rt-strip', root); if (strip && !more) todayRituals(strip).then(l => { st.rituals = l || []; drawDay(); });
    const my = ++st.loading, box = $('.tcontent', root);
    if (!more) box.classList.add('busy');
    try {
      if (st.mode === 'board') {
        const p = params({}); p.set('view', st.view); p.delete('sort');
        const d = await get('assistant/board?' + p);
        if (my !== st.loading) return;
        st.columns = d.columns; st.counts = d.counts;
      } else {
        const [d, done] = await Promise.all([get('assistant/tasks?' + params({ offset: more ? st.items.length : 0, limit: PAGE })),
          // «Сьогодні»: виконане за день лишається внизу закресленим — видно, що вже зроблено
          isToday && !more && !st.q && !st.showDone ? get('assistant/tasks?area=all&view=done&limit=40') : null]);
        if (my !== st.loading) return;
        st.items = more ? st.items.concat(d.list) : d.list; st.total = d.total; st.counts = d.counts;
        if (done) { const t0 = new Date(); t0.setHours(0, 0, 0, 0); st.doneToday = done.list.filter(x => x.done_at >= t0.getTime()); }
        else if (!more) st.doneToday = [];
      }
    } catch (e) { if (my === st.loading) box.innerHTML = `<p class="err">${esc(e.message)}</p>`; box.classList.remove('busy'); return; }
    box.classList.remove('busy');
    draw();
  }
  function draw() {
    syncBar(); drawInbox(); drawDay();
    if (st.mode === 'board') drawBoard(); else drawList();
    drawBulk();
  }
  const refresh = () => load();

  // ---------- «Сьогодні»: картка дня — скільки зроблено, що далі ----------
  function drawDay() {
    const box = $('.day-card', root); if (!box || st.mode !== 'list') { if (box) box.hidden = true; return; }
    const now = Date.now(), hm = d => { const x = new Date(d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
    const open = st.items.length, doneT = (st.doneToday || []).length;
    const rDone = st.rituals.reduce((s, r) => s + (r.active ? r.done : 0), 0), rTotal = st.rituals.reduce((s, r) => s + (r.active ? r.total : 0), 0);
    const done = doneT + rDone, total = done + open + Math.max(0, rTotal - rDone);
    const late = st.items.filter(it => it.overdue).length;
    // що далі: найближча задача з часом (строк чи нагадування — що раніше) або раз ритуалу
    const soon = it => Math.min(...[it.due_at, it.remind_at].filter(x => x && x >= now));
    const nextTask = st.items.filter(it => isFinite(soon(it))).map(it => ({ ...it, due_at: soon(it) })).sort((a, b) => a.due_at - b.due_at)[0];
    const nextRit = st.rituals.filter(r => r.active && (r.pending || r.next)).map(r => ({ r, at: r.pending ? now : (() => { const d = new Date(); d.setHours(+r.next.slice(0, 2), +r.next.slice(3), 0, 0); return d.getTime(); })() }))
      .sort((a, b) => a.at - b.at)[0];
    let next = '';
    if (nextRit && (!nextTask || nextRit.at <= nextTask.due_at)) next = `<a class="dc-next" href="#/r/${nextRit.r.id}"><small>${nextRit.r.pending ? 'Зараз' : 'Далі о ' + nextRit.r.next}</small><span>${esc(nextRit.r.icon + ' ' + nextRit.r.title)}</span></a>`;
    else if (nextTask) next = `<a class="dc-next" href="${taskHref(nextTask.id)}"><small>Далі о ${hm(nextTask.due_at)}</small><span>${esc(nextTask.text)}</span></a>`;
    else if (open) next = `<span class="dc-next"><small>Ще ${open} ${open === 1 ? 'задача' : open < 5 ? 'задачі' : 'задач'}</small><span>без точного часу</span></span>`;
    const p = total ? done / total : 0, R = 26, C = 2 * Math.PI * R;
    box.hidden = !total;
    box.innerHTML = `<div class="dc-ring"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${R}" class="dc-bg"/><circle cx="32" cy="32" r="${R}" class="dc-fg" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - p)}"/></svg><b>${done}<small>/${total}</small></b></div>
      <div class="dc-txt"><b>${!total ? '' : done >= total ? 'Усе на сьогодні зроблено' : done ? `Зроблено ${done} з ${total}` : `На сьогодні ${total}`}</b>
        ${late ? `<span class="dc-late">Прострочено: ${late}</span>` : ''}${done >= total ? '<span class="dc-sub">Можна видихнути 🌿</span>' : next}</div>`;
  }

  // ---------- «Вхідні» ----------
  function drawInbox() {
    const bar = $('.inbox-bar', root), n = (meta.counts || {}).inbox || 0;
    const show = cfg.area === 'inbox' && n > 0 && !st.showDone;
    if (!show) {
      // усе розкладено — смужка плавно згортається, а не зникає ривком
      if (!bar.hidden && cfg.area === 'inbox' && !st.showDone && !bar.classList.contains('bye')) {
        bar.style.height = bar.offsetHeight + 'px'; bar.offsetHeight; bar.classList.add('bye');
        setTimeout(() => { bar.hidden = true; bar.classList.remove('bye'); bar.style.height = ''; }, 420);
      } else if (!bar.classList.contains('bye')) bar.hidden = true;
      return;
    }
    bar.hidden = false; bar.classList.remove('bye'); bar.style.height = '';
    bar.innerHTML = `<span>Асистент не зміг розкласти <b>${n}</b> ${n === 1 ? 'задачу' : n < 5 ? 'задачі' : 'задач'}</span>
      <button type="button" class="btn primary sm" data-t="triage">Розкласти по одній</button>
      <button type="button" class="btn sm" data-t="suggest">${icon('sparkles', 14)}Підказати</button>
      ${st.sug.size ? `<button type="button" class="btn sm" data-t="accept">${icon('check', 14)}Прийняти підказки (${st.sug.size})</button>` : ''}`;
  }

  // ---------- список ----------
  function groupOf(it) {
    if (st.showDone) return ['done', 'Виконані'];
    if (st.group === 'status') return [it.status, status(it.status).name];
    if (st.group === 'space') return [it.area, space(it.area).name];
    if (st.group === 'date') { const b = dueBucket(it); return [b, BUCKETS[b]]; }
    if (st.group === 'tod') {
      if (it.overdue) return ['late', TOD.late];
      if (!it.due_at) return ['nodate', TOD.nodate];
      const h = new Date(it.due_at).getHours(), k = h < 12 ? 'morning' : h < 17 ? 'day' : 'evening';
      return [k, TOD[k]];
    }
    return ['all', ''];
  }
  const ORDER = {
    date: Object.keys(BUCKETS),
    tod: Object.keys(TOD),
    status: () => meta.statuses.map(s => s.key),
    space: () => meta.spaces.map(s => s.key)
  };
  function drawList() {
    const box = $('.tcontent', root);
    const add = `<div class="qadd">${icon('plus', 16)}<input class="qadd-in" placeholder="Нова задача" maxlength="2000" enterkeyhint="done">
      <button type="button" class="icon-btn" data-t="ai-add" title="Через асистента: сам розбере дату, повтор, простір («завтра о 10 подзвонити…»)">${icon('sparkles')}</button></div>`;
    if (!st.items.length) {
      if (cfg.area === 'inbox' && !st.q && !st.tag && !st.prio && !st.showDone)
        box.innerHTML = add + `<div class="empty zero"><svg class="zero-ic" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><path d="M20 33.5l8.5 8.5L45 24.5"/></svg><b>Вхідні порожні</b><p>Усе розкладено по просторах</p></div>`;
      else box.innerHTML = add + `<div class="empty">${icon(st.q ? 'search' : cfg.area === 'inbox' ? 'inbox' : 'checkCircle', 28)}<p>${
        st.q || st.tag || st.prio ? 'Нічого не знайдено.' : st.showDone ? 'Виконаних задач тут ще немає.' : cfg.area === 'inbox' ? 'У вхідних порожньо. Усе розкладено.' : 'Задач немає. Додайте першу або скажіть асистенту.'}</p></div>`;
    } else {
      const groups = new Map();
      for (const it of st.items) { const [k, l] = groupOf(it); if (!groups.has(k)) groups.set(k, { l, list: [] }); groups.get(k).list.push(it); }
      let keys = [...groups.keys()];
      const ord = typeof ORDER[st.group] === 'function' ? ORDER[st.group]() : ORDER[st.group];
      if (ord && !st.showDone && st.sort === 'smart') keys.sort((a, b) => ord.indexOf(a) - ord.indexOf(b));
      let n = 0;
      box.classList.toggle('stagger', !st.drawn); st.drawn = true;
      const rowN = () => n < 14 ? n++ : 14;
      box.innerHTML = add + keys.map(k => {
        const g = groups.get(k), hid = st.collapsed.has(k);
        const head = g.l ? `<button type="button" class="grp-h${k === 'overdue' || k === 'late' ? ' late' : ''}" data-grp="${esc(k)}">${icon(hid ? 'chevronRight' : 'chevronDown', 14)}${
          st.group === 'space' && !st.showDone ? icon(space(k).icon, 14) : st.group === 'status' && !st.showDone ? icon(STATUS_ICON[k] || 'circle', 14) : ''}<span>${esc(g.l)}</span><b>${g.list.length}</b></button>` : '';
        return `<section class="grp${hid ? ' hid' : ''}">${head}<div class="rows">${g.list.map(it => rowHtml(it, false, rowN()) + it.children.map(c => rowHtml(c, true, rowN())).join('')).join('')}</div></section>`;
      }).join('');
    }
    if (isToday && (st.doneToday || []).length && st.mode === 'list') {
      const hid = st.collapsed.has('donetoday');
      box.insertAdjacentHTML('beforeend', `<section class="grp grp-done${hid ? ' hid' : ''}"><button type="button" class="grp-h" data-grp="donetoday">${icon(hid ? 'chevronRight' : 'chevronDown', 14)}<span>Зроблено сьогодні</span><b>${st.doneToday.length}</b></button>
        <div class="rows">${st.doneToday.map(it => rowHtml({ ...it, children: [] }, false, 14)).join('')}</div></section>`);
    }
    if (st.flash) { const r = $(`.row[data-id="${st.flash}"]`, box); if (r) { r.classList.add('flash'); r.scrollIntoView({ block: 'nearest' }); } st.flash = null; }
    const more = $('.more', root), rest = st.total - st.items.length;
    more.hidden = rest <= 0 || st.mode !== 'list';
    more.textContent = `Показати ще ${Math.min(rest, PAGE)} з ${rest}`;
  }
  function props(it, child) {
    const out = [];
    if (!child && !it.done && it.area === 'inbox') {
      const sug = st.sug.get(it.id);
      out.push(`<span class="quick">${sug ? `<button type="button" class="qchip sug" data-a="area" data-v="${sug}" title="Підказка асистента">${icon('sparkles', 12)}${esc(space(sug).name)}</button>` : ''}${
        openSpaces().filter(s => s.key !== 'inbox' && s.key !== sug).slice(0, 3).map(s => `<button type="button" class="qchip" data-a="area" data-v="${s.key}" title="Перенести в «${esc(s.name)}»">${icon(s.icon, 12)}<span>${esc(s.name)}</span></button>`).join('')}${
        openSpaces().length > 4 ? `<button type="button" class="qchip" data-a="area-menu" title="Інший простір">${icon('more', 12)}</button>` : ''}</span>`);
    }
    if (it.status !== firstStatus() && !it.done) out.push(`<span class="prop st-${it.status}">${icon(STATUS_ICON[it.status] || 'circle', 13)}${esc(status(it.status).name)}</span>`);
    out.push(whenProps(it, 13, isToday && st.group === 'tod'));
    if (it.priority) out.push(`<span class="prop prio p${it.priority}" title="${it.priority === 2 ? 'Термінова' : 'Важлива'}">${icon('flag', 13)}</span>`);
    if (it.tags && it.tags.length && !child) out.push(`<span class="prop tags">${it.tags.slice(0, 3).map(t => '#' + esc(t)).join(' ')}</span>`);
    if (cross && !child && it.area !== 'inbox' && st.group !== 'space') out.push(`<span class="prop sp">${icon(space(it.area).icon, 13)}${esc(space(it.area).name)}</span>`);
    return out.join('');
  }
  // строк і нагадування: «🔔 17:00» (нагадування в час строку), або «📅 22:00 · 🔔 17:00»; сьогоднішній час на «Сьогодні» — без слова «Сьогодні»
  function whenProps(it, sz, short) {
    const f = ms => short && new Date(ms).toDateString() === new Date().toDateString() ? fmtDue(ms).replace('Сьогодні ', '') : fmtDue(ms);
    const ping = it.remind_at && it.remind_at === it.due_at, late = it.overdue && !it.done ? ' late' : '';
    let h = '';
    if (it.due_at) h += `<span class="prop${late}">${icon(ping ? 'bell' : 'calendar', sz)}${esc(f(it.due_at))}${it.repeatText ? icon('repeat', sz - 1) : ''}</span>`;
    if (it.remind_at && !ping && !it.done) h += `<span class="prop${it.sent ? ' muted' : ''}" title="Нагадування">${icon('bell', sz)}${esc(f(it.remind_at))}</span>`;
    return h;
  }
  function rowHtml(it, child, i = 0) {
    const kids = it.children || [], kd = kids.filter(k => k.done).length;
    return `<div class="row${child ? ' child' : ''}${it.done ? ' done' : ''}${st.sel.has(it.id) ? ' sel' : ''}" data-id="${it.id}"${child ? ` data-parent="${it.parent_id}"` : ''} style="--i:${i}">
      <label class="row-sel"><input type="checkbox" data-a="sel" ${st.sel.has(it.id) ? 'checked' : ''} aria-label="Вибрати"></label>
      <button type="button" class="chk${it.done ? ' on' : ''}" data-a="done" aria-label="${it.done ? 'Повернути' : 'Виконано'}">${icon('check', 12)}</button>
      <a class="row-main" href="${taskHref(it.id)}" data-a="open">
        <span class="row-title">${esc(it.text)}</span>
        ${!child && kids.length ? `<span class="row-meta">${icon('subtasks', 13)}${kd}/${kids.length}</span>` : ''}${it.att ? `<span class="row-meta">${icon('paperclip', 13)}${it.att}</span>` : ''}
        ${it.description ? `<span class="row-meta" title="Є опис">${icon('text', 13)}</span>` : ''}
      </a>
      <div class="row-props">${props(it, child)}</div>
    </div>`;
  }

  // ---------- дошка ----------
  function cardHtml(it) {
    const kids = it.children || [], kd = kids.filter(k => k.done).length;
    const bits = [];
    bits.push(whenProps(it, 12, false));
    if (it.priority) bits.push(`<span class="prop prio p${it.priority}">${icon('flag', 12)}${it.priority === 2 ? 'Термінова' : 'Важлива'}</span>`);
    if (kids.length) bits.push(`<span class="prop">${icon('subtasks', 12)}${kd}/${kids.length}</span>`);
    if (it.att) bits.push(`<span class="prop">${icon('paperclip', 12)}${it.att}</span>`);
    if (it.tags && it.tags.length) bits.push(`<span class="prop tags">${it.tags.slice(0, 3).map(t => '#' + esc(t)).join(' ')}</span>`);
    if (cross) bits.push(`<span class="prop sp">${icon(space(it.area).icon, 12)}${esc(space(it.area).name)}</span>`);
    return `<div class="card${it.done ? ' done' : ''}${st.sel.has(it.id) ? ' sel' : ''}" data-id="${it.id}" tabindex="0">
      <div class="card-title">${it.done ? icon('checkCircle', 14) : ''}${esc(it.text)}</div>
      ${it.description ? `<div class="card-desc">${esc(it.description.slice(0, 140))}</div>` : ''}
      ${bits.length ? `<div class="card-props">${bits.join('')}</div>` : ''}
    </div>`;
  }
  function drawBoard() {
    const box = $('.tcontent', root);
    $('.more', root).hidden = true;
    box.innerHTML = `<div class="board">${st.columns.map(c => `
      <section class="col" data-status="${c.status}">
        <header class="col-h"><span class="col-t st-${c.status}">${icon(STATUS_ICON[c.status] || 'circle', 14)}${esc(c.name)}</span><b>${c.total}</b></header>
        <div class="col-body">${c.items.map(cardHtml).join('')}
          ${c.done ? (c.total > c.items.length ? `<p class="col-note">ще ${c.total - c.items.length}</p>` : '') + '<p class="col-note">за останні 14 днів</p>'
                   : `<button type="button" class="col-add" data-a="col-add">${icon('plus', 14)}Нова</button>`}
        </div>
      </section>`).join('')}</div>`;
    dnd($('.board', box));
  }

  // Перетягування карток: миша — одразу, палець — після короткого утримання (щоб не заважати прокрутці).
  function dnd(board) {
    let drag = null;
    board.addEventListener('pointerdown', e => {
      const card = e.target.closest('.card'); if (!card || e.button > 0 || st.selecting) return;
      const sx = e.clientX, sy = e.clientY, touch = e.pointerType !== 'mouse';
      let timer = touch ? setTimeout(() => begin(e), 280) : 0, started = false;
      const move = ev => {
        if (!started) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) { if (touch) { clearTimeout(timer); cleanup(); } else begin(ev); }
          return;
        }
        ev.preventDefault(); follow(ev);
      };
      const up = ev => { clearTimeout(timer); if (started) finish(ev); cleanup(); };
      const cleanup = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); removeEventListener('touchmove', block); };
      const block = ev => { if (started) ev.preventDefault(); };
      addEventListener('pointermove', move, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      addEventListener('touchmove', block, { passive: false });
      function begin(ev) {
        started = true;
        const r = card.getBoundingClientRect();
        const ghost = card.cloneNode(true); ghost.classList.add('ghost'); ghost.style.width = r.width + 'px';
        document.body.append(ghost);
        const ph = document.createElement('div'); ph.className = 'card-ph'; ph.style.height = r.height + 'px';
        card.after(ph); card.classList.add('dragging');
        drag = { card, ghost, ph, dx: sx - r.left, dy: sy - r.top, from: card.closest('.col').dataset.status, dock: openDock(card.closest('.col').dataset.status), target: null };
        if (navigator.vibrate && touch) navigator.vibrate(15);
        follow(ev);
      }
    });
    // Під час перетягування знизу виїжджає панель: усі колонки (кинути — перенести в кінець колонки) і смітник.
    // На телефоні так не треба тягнути картку через усю дошку.
    function openDock(from) {
      const dock = document.createElement('div'); dock.className = 'dnd-dock';
      dock.innerHTML = `<div class="dock-cols">${st.columns.map(c => `<div class="dock-t${c.status === from ? ' cur' : ''}" data-status="${c.status}">${icon(STATUS_ICON[c.status] || 'circle', 16)}<span>${esc(c.name)}</span></div>`).join('')}</div>
        <div class="dock-trash" data-trash>${icon('trash', 20)}<span>Видалити</span></div>`;
      document.body.append(dock); document.body.classList.add('dnd-on');
      requestAnimationFrame(() => dock.classList.add('in'));
      return dock;
    }
    function closeDock(d) { const k = d.dock; k.classList.remove('in'); document.body.classList.remove('dnd-on'); setTimeout(() => k.remove(), 220); }
    function follow(ev) {
      const d = drag; if (!d) return;
      d.ghost.style.transform = `translate(${ev.clientX - d.dx}px, ${ev.clientY - d.dy}px) rotate(1.5deg)`;
      d.ghost.style.display = 'none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      d.ghost.style.display = '';
      // ціль у панелі знизу
      const t = under && under.closest('.dock-t, [data-trash]');
      if (t !== d.target) {
        if (d.target) d.target.classList.remove('hot');
        d.target = t; if (t) { t.classList.add('hot'); if (navigator.vibrate) navigator.vibrate(8); }
        d.ghost.classList.toggle('to-trash', !!(t && t.hasAttribute('data-trash')));
        d.ghost.classList.toggle('over', !!t);                // над панеллю картка зменшується — видно, куди кидаєш
      }
      if (t) return;
      const col = under && under.closest('.col');
      if (col) {
        const body = col.querySelector('.col-body');
        const cards = [...body.querySelectorAll('.card:not(.dragging)')];
        const after = cards.find(c => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (after) body.insertBefore(d.ph, after); else body.insertBefore(d.ph, body.querySelector('.col-add, .col-note') || null);
      }
      // автопрокрутка біля країв
      const r = board.getBoundingClientRect();
      if (ev.clientX > r.right - 40) board.scrollLeft += 14; else if (ev.clientX < r.left + 40) board.scrollLeft -= 14;
      if (ev.clientY > innerHeight - 50) scrollBy(0, 14); else if (ev.clientY < 60) scrollBy(0, -14);
    }
    async function finish() {
      const d = drag; drag = null; if (!d) return;
      closeDock(d);
      const t = d.target;
      if (t && t.hasAttribute('data-trash')) {
        // у смітник: картка зникає одразу, видалення — коли сховається підказка «Скасувати» (7 с)
        d.ph.replaceWith(d.card); d.card.classList.remove('dragging'); d.ghost.classList.add('drop'); setTimeout(() => d.ghost.remove(), 250);
        const id = +d.card.dataset.id; d.card.hidden = true;
        let undone = false;
        toast('Задачу видалено', () => { undone = true; d.card.hidden = false; }, 7000);
        await wait(7100);
        if (undone) return;
        try { await api('assistant/items/' + id, { method: 'DELETE' }); changed(); } catch (e) { fail(e); d.card.hidden = false; }
        return;
      }
      if (t) {                                            // кинули на колонку в панелі — у кінець цієї колонки
        const body = t.closest('.dnd-dock') && document.querySelector(`.board .col[data-status="${t.dataset.status}"] .col-body`);
        if (body) body.insertBefore(d.ph, body.querySelector('.col-add, .col-note') || null);
      }
      const col = d.ph.closest('.col'), statusKey = col.dataset.status;
      const prev = d.ph.previousElementSibling && d.ph.previousElementSibling.closest('.card:not(.dragging)');
      const next = d.ph.nextElementSibling && d.ph.nextElementSibling.closest('.card:not(.dragging)');
      d.ph.replaceWith(d.card); d.card.classList.remove('dragging'); d.ghost.remove();
      const id = +d.card.dataset.id, body = {};
      if (statusKey !== d.from) body.status = statusKey;
      if (prev) body.after = +prev.dataset.id; else if (next) body.before = +next.dataset.id;
      try {
        const r = await post(`assistant/items/${id}/move`, body);
        if (body.status && r.status !== statusKey) toast('Повторювана задача — перенесено на наступний раз: ' + fmtDue(r.due_at));
        else if (body.status) toast(`→ ${status(statusKey).name}`);
        changed();
      } catch (e) { fail(e); load(); }
    }
    // клік по картці (без перетягування) — відкрити
    board.addEventListener('click', e => {
      const card = e.target.closest('.card'); if (!card || e.target.closest('[data-a]')) return;
      if (st.selecting) { toggleSel(+card.dataset.id); return; }
      go(taskHref(+card.dataset.id));
    });
    board.addEventListener('keydown', e => { const card = e.target.closest('.card'); if (card && e.key === 'Enter') go(taskHref(+card.dataset.id)); });
  }

  // ---------- додавання ----------
  function newTask() {
    if (st.mode === 'board') { const b = $('.col:not([data-status="done"]) .col-add', root); if (b) b.click(); }
    else { const i = $('.qadd-in', root); if (i) { i.focus(); i.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }
  }
  async function quickAdd(text, extra = {}) {
    const area = cfg.area === 'all' ? 'inbox' : cfg.area;
    const due = cfg.view === 'today' ? (() => { const d = new Date(); d.setHours(Math.min(23, Math.max(18, d.getHours() + 1)), 0, 0, 0); return d; })() : null;
    const body = { text, area, ...extra };
    if (due && !extra.status) { const p = n => String(n).padStart(2, '0'); body.due = `${due.getFullYear()}-${p(due.getMonth() + 1)}-${p(due.getDate())}T${p(due.getHours())}:00`; }
    const it = await post('assistant/items', body);
    changed();
    return it;
  }
  async function aiAdd(input) {
    const text = input.value.trim(); if (!text) return input.focus();
    const hint = cfg.area !== 'all' && cfg.area !== 'inbox' ? ` (простір: ${space(cfg.area).name})` : '';
    input.disabled = true;
    try {
      const r = await post('assistant/message', { text: text + hint });
      input.value = '';
      toast([r.reply, ...(r.done || [])].filter(Boolean).join('\n') || 'Записав', r.undoable ? async () => { await post('assistant/undo', { msgId: r.msgId }); changed(); } : null, 6000);
      changed();
    } catch (e) { fail(e); }
    input.disabled = false; input.focus();
  }

  // ---------- свайпи (телефон): вправо — виконано, вліво — видалити з «Повернути» на місці ----------
  let swiped = false;
  function swipe() {
    root.addEventListener('pointerdown', e => {
      const row = e.target.closest('.row');
      if (!row || e.pointerType === 'mouse' || st.selecting || row.classList.contains('done') || e.target.closest('.chk, .qchip, .row-sel')) return;
      const sx = e.clientX, sy = e.clientY; let dx = 0, on = false;
      const off = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
      const mv = ev => {
        const x = ev.clientX - sx, y = ev.clientY - sy;
        if (!on) {
          if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return off();
          if (Math.abs(x) < 14) return;
          on = true; row.classList.add('swiping');
        }
        dx = Math.max(-160, Math.min(160, x));
        row.style.setProperty('--dx', dx + 'px');
        const ready = Math.abs(dx) > 90;
        if (ready !== row.classList.contains('sw-ready') && navigator.vibrate) navigator.vibrate(8);
        row.classList.toggle('sw-ready', ready);
      };
      const up = () => {
        off(); if (!on) return;
        swiped = true; setTimeout(() => { swiped = false; }, 400);
        row.classList.remove('swiping', 'sw-ready');
        row.style.setProperty('--dx', '0px');
        if (dx > 90) { const c = row.querySelector('.chk'); if (c) c.click(); }
        else if (dx < -90) softDelete(row);
      };
      addEventListener('pointermove', mv, { passive: true }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });
  }
  async function softDelete(row) {
    const id = +row.dataset.id, kids = $$(`.row[data-parent="${id}"]`, root);
    const u = document.createElement('div'); u.className = 'row-undo';
    u.innerHTML = `${icon('trash', 15)}<span>Задачу видалено</span><button type="button">Повернути</button>`;
    row.replaceWith(u); kids.forEach(k => k.remove());
    let undone = false;
    u.querySelector('button').addEventListener('click', () => {
      undone = true; u.replaceWith(row); let prev = row; kids.forEach(k => { prev.after(k); prev = k; });
    });
    await wait(4500);
    if (undone || !u.isConnected) return;
    try { await api('assistant/items/' + id, { method: 'DELETE' }); } catch (e) { fail(e); }
    u.style.height = u.offsetHeight + 'px'; u.classList.add('collapse'); await wait(240);
    changed();
  }

  // ---------- вибір і масові дії ----------
  // Телефон: утримати задачу — вибрати (далі — дотиками); без окремої кнопки «Вибрати»
  let pressed = false;
  function longPress() {
    root.addEventListener('contextmenu', e => { if (e.target.closest('.row') && matchMedia('(hover: none)').matches) e.preventDefault(); });
    root.addEventListener('pointerdown', e => {
      const row = e.target.closest('.row'); if (!row || e.pointerType === 'mouse' || e.target.closest('.chk, [data-a="area"], [data-a="area-menu"]')) return;
      const sx = e.clientX, sy = e.clientY;
      const t = setTimeout(() => { pressed = true; setTimeout(() => { pressed = false; }, 700); toggleSel(+row.dataset.id, true); if (navigator.vibrate) navigator.vibrate(18); }, 450);
      const off = () => { clearTimeout(t); removeEventListener('pointermove', mv); removeEventListener('pointerup', off); removeEventListener('pointercancel', off); };
      const mv = ev => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) off(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', off); addEventListener('pointercancel', off);
    });
  }
  function toggleSel(id, on) {
    if (on === undefined) on = !st.sel.has(id);
    if (on) st.sel.add(id); else st.sel.delete(id);
    if (st.sel.size && !st.selecting) st.selecting = true;
    $$(`[data-id="${id}"]`, root).forEach(el => { el.classList.toggle('sel', on); const c = el.querySelector('[data-a="sel"]'); if (c) c.checked = on; });
    drawBulk(); syncBar();
  }
  function allIds() { return st.mode === 'board' ? st.columns.flatMap(c => c.items.map(i => i.id)) : st.items.flatMap(i => [i.id, ...i.children.map(c => c.id)]); }
  function findItem(id) {
    const all = st.mode === 'board' ? st.columns.flatMap(c => c.items) : [...st.items.flatMap(i => [i, ...i.children]), ...(st.doneToday || [])];
    return all.find(x => x.id === id);
  }
  function drawBulk() {
    const b = $('.bulk', root);
    $('.tasks-page', root).classList.toggle('selecting', st.selecting);
    b.hidden = !st.selecting;
    document.body.classList.toggle('bulk-on', st.selecting);
    if (b.hidden) return;
    const n = st.sel.size;
    b.innerHTML = `<b>${n ? `Вибрано: ${n}` : 'Позначте задачі'}</b>
      <button type="button" class="bbtn" data-b="area" ${n ? '' : 'disabled'}>${icon('layers', 15)}<span>Простір</span></button>
      <button type="button" class="bbtn" data-b="status" ${n ? '' : 'disabled'}>${icon('status', 15)}<span>Статус</span></button>
      <button type="button" class="bbtn" data-b="due" ${n ? '' : 'disabled'}>${icon('calendar', 15)}<span>Строк</span></button>
      <button type="button" class="bbtn" data-b="priority" ${n ? '' : 'disabled'}>${icon('flag', 15)}<span>Пріоритет</span></button>
      <button type="button" class="bbtn" data-b="done" ${n ? '' : 'disabled'}>${icon('checkCircle', 15)}<span>Виконано</span></button>
      <button type="button" class="bbtn danger" data-b="delete" ${n ? '' : 'disabled'}>${icon('trash', 15)}</button>
      <span class="bulk-r"><button type="button" class="bbtn" data-b="all">Усі</button><button type="button" class="bbtn" data-b="close" title="Готово">${icon('x', 15)}</button></span>`;
  }
  async function bulk(action, value) {
    const ids = [...st.sel]; if (!ids.length) return;
    const prev = ids.map(findItem).filter(Boolean);
    if (action === 'delete' && !await confirmBox(`Видалити ${ids.length} ${ids.length === 1 ? 'задачу' : 'задач'} разом із підзадачами?`)) return;
    let r; try { r = await post('assistant/bulk', { ids, action, value }); } catch (e) { return fail(e); }
    let undo = null, msg = `Готово: ${r.changed}`;
    if (action === 'area') {
      msg = `→ ${space(value).name}: ${r.changed}`;
      undo = async () => { for (const s of meta.spaces) { const g = prev.filter(x => x.area === s.key).map(x => x.id); if (g.length) await post('assistant/bulk', { ids: g, action: 'area', value: s.key }); } changed(); };
    } else if (action === 'status') {
      msg = `→ ${status(value).name}: ${r.changed}`;
      undo = async () => { for (const s of meta.statuses) { const g = prev.filter(x => x.status === s.key && !x.repeat).map(x => x.id); if (g.length) await post('assistant/bulk', { ids: g, action: 'status', value: s.key }); } changed(); };
    } else if (action === 'done') {
      msg = `Виконано: ${r.changed}`;
      const g = prev.filter(x => !x.done && !x.repeat).map(x => x.id);
      if (g.length) undo = async () => { await post('assistant/bulk', { ids: g, action: 'reopen' }); changed(); };
    } else if (action === 'delete') msg = `Видалено: ${r.changed}`;
    st.sel.clear(); st.selecting = false;
    toast(msg, undo); changed();
  }

  // ---------- розбір «Вхідних» по одній ----------
  async function triage() {
    let d; try { d = await get('assistant/tasks?area=inbox&view=open&sort=created&limit=200'); } catch (e) { return fail(e); }
    if (!d.list.length) return toast('У вхідних порожньо');
    const list = d.list, hist = [], spaces = openSpaces().filter(s => s.key !== 'inbox').slice(0, 9);
    let i = 0;
    const w = document.createElement('div'); w.className = 'modal-wrap tri';
    document.body.append(w);
    const show = () => {
      const it = list[i];
      if (!it) return finale();
      const sug = st.sug.get(it.id);
      w.innerHTML = `<div class="tri-card${i || hist.length ? ' swap' : ''}" role="dialog" aria-modal="true" aria-label="Розкласти вхідні">
        <header><span>${i + 1} з ${list.length}</span><button type="button" class="icon-btn" data-x>${icon('x')}</button></header>
        <div class="tri-bar"><i style="width:${i / list.length * 100}%"></i></div>
        <h2>${esc(it.text)}</h2>
        <div class="tri-meta">${props({ ...it, area: '' }, false)}</div>
        ${it.description ? `<p class="tri-desc">${esc(it.description.slice(0, 300))}</p>` : ''}
        ${sug ? `<p class="tri-sug">${icon('sparkles', 14)}Асистент радить: <b>${esc(space(sug).name)}</b></p>` : ''}
        <div class="tri-spaces">${spaces.map((s, n) => `<button type="button" class="tri-sp${s.key === sug ? ' sug' : ''}" data-s="${s.key}">${icon(s.icon, 20)}<span>${esc(s.name)}</span><kbd>${n + 1}</kbd></button>`).join('')}</div>
        <footer>
          <button type="button" class="btn sm ghost" data-t="back" ${hist.length ? '' : 'disabled'}>${icon('chevronLeft', 14)}Назад</button>
          <button type="button" class="btn sm ghost" data-t="done">${icon('checkCircle', 14)}Вже зроблено <kbd>D</kbd></button>
          <button type="button" class="btn sm ghost" data-t="delete">${icon('trash', 14)}Видалити</button>
          <button type="button" class="btn sm ghost" data-t="skip">Пропустити <kbd>→</kbd></button>
        </footer></div>`;
    };
    // фінал: галочка малюється, навколо — розліт крапок; закривається сам або дотиком
    let finT = 0;
    const finale = () => {
      const n = hist.filter(h => h.a !== 'skip').length, skipped = hist.filter(h => h.a === 'skip').length;
      w.classList.add('fin');
      w.innerHTML = `<div class="tri-card tri-fin" role="status">
        <div class="fin-mark"><span class="fin-burst">${Array.from({ length: 14 }, (_, k) => `<i style="--a:${k * 360 / 14}deg;--d:${60 + (k % 3) * 18}px"></i>`).join('')}</span>
          <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><path d="M20 33.5l8.5 8.5L45 24.5"/></svg></div>
        <h2>${skipped ? 'Готово' : 'Вхідні порожні'}</h2>
        <p>${n ? `Розкладено: ${n}` : ''}${skipped ? `${n ? ' · ' : ''}пропущено: ${skipped}` : ''}</p></div>`;
      if (navigator.vibrate) navigator.vibrate([18, 60, 28]);
      finT = setTimeout(close, 1900);
    };
    const act = async a => {
      if (w.classList.contains('fin')) return close();
      const it = list[i];
      if (a === 'back') {
        const h = hist.pop(); if (!h) return;
        try { if (h.a === 'area') await post('assistant/bulk', { ids: [h.id], action: 'area', value: 'inbox' }); if (h.a === 'done') await post(`assistant/items/${h.id}/reopen`); } catch (e) {}
        i = h.i; return show();
      }
      if (!it) return;
      try {
        if (a.startsWith('s:')) { await post('assistant/bulk', { ids: [it.id], action: 'area', value: a.slice(2) }); st.sug.delete(it.id); a = 'area'; }
        else if (a === 'done') await post(`assistant/items/${it.id}/complete`);
        else if (a === 'delete') { if (!await confirmBox(`Видалити «${it.text}»?`)) return; await api('assistant/items/' + it.id, { method: 'DELETE' }); }
      } catch (e) { return fail(e); }
      hist.push({ id: it.id, a, i }); i++; show();
    };
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
      if (document.querySelector('.modal-wrap:not(.tri)')) return;
      const n = +e.key;
      if (n >= 1 && n <= spaces.length) { e.preventDefault(); act('s:' + spaces[n - 1].key); }
      else if (e.key === 'd' || e.key === 'в') act('done');
      else if (e.key === 'ArrowRight') act('skip');
      else if (e.key === 'ArrowLeft') act('back');
    };
    let closed = false;
    const close = () => {
      if (closed) return; closed = true; clearTimeout(finT);
      document.removeEventListener('keydown', key, true);
      w.classList.add('out'); setTimeout(() => w.remove(), 260); changed();
    };
    document.addEventListener('keydown', key, true);
    w.addEventListener('click', e => {
      if (e.target === w || e.target.closest('[data-x]') || w.classList.contains('fin')) return close();
      const s = e.target.closest('[data-s]'); if (s) return act('s:' + s.dataset.s);
      const t = e.target.closest('[data-t]'); if (t) act(t.dataset.t);
    });
    show();
  }
  async function suggest(btn) {
    btn.disabled = true; btn.innerHTML = spin() + 'Думаю…';
    try {
      const r = await post('assistant/triage');
      st.sug = new Map(r.suggestions.map(s => [s.id, s.area]));
      toast(r.suggestions.length ? `Підказки для ${r.suggestions.length} задач — вони позначені ✦ у списку` : 'Асистент не впевнений щодо жодної — розкладіть вручну');
      draw();
    } catch (e) { fail(e); btn.disabled = false; drawInbox(); }
  }
  async function acceptAll() {
    const groups = {};
    for (const [id, a] of st.sug) (groups[a] = groups[a] || []).push(id);
    const all = [...st.sug.keys()];
    try { for (const [a, ids] of Object.entries(groups)) await post('assistant/bulk', { ids, action: 'area', value: a }); } catch (e) { return fail(e); }
    st.sug.clear();
    toast(`Розкладено: ${all.length}`, async () => { await post('assistant/bulk', { ids: all, action: 'area', value: 'inbox' }); changed(); });
    changed();
  }

  // ---------- події ----------
  async function onClick(e) {
    const t = e.target.closest('[data-t]'), a = e.target.closest('[data-a]'), m = e.target.closest('button[data-mode]');
    const clr = e.target.closest('[data-clear]'), grp = e.target.closest('[data-grp]'), bb = e.target.closest('[data-b]');
    if (m) { st.mode = m.dataset.mode; pref.set(K('mode'), st.mode); st.sel.clear(); load(); return; }
    if (clr) { const k = clr.dataset.clear; if (k === 'view') st.view = cfg.view; if (k === 'prio') st.prio = 0; if (k === 'tag') st.tag = ''; if (k === 'done') st.showDone = false; load(); return; }
    if (grp) { const k = grp.dataset.grp; st.collapsed.has(k) ? st.collapsed.delete(k) : st.collapsed.add(k); pref.set(K('collapsed'), [...st.collapsed]); drawList(); return; }
    if (e.target.classList.contains('more')) return load(true);
    if (bb) {
      const b = bb.dataset.b;
      if (b === 'close') { st.selecting = false; st.sel.clear(); return draw(); }
      if (b === 'all') { const ids = allIds(), on = !ids.every(id => st.sel.has(id)); ids.forEach(id => on ? st.sel.add(id) : st.sel.delete(id)); return draw(); }
      if (b === 'area') { const v = await menu(bb, openSpaces().map(s => ({ value: s.key, label: s.name, icon: s.icon }))); if (v) bulk('area', v); }
      if (b === 'status') { const v = await menu(bb, meta.statuses.map(s => ({ value: s.key, label: s.name, icon: STATUS_ICON[s.key] || 'circle' }))); if (v) bulk('status', v); }
      if (b === 'due') { const v = await menu(bb, [{ value: 'today', label: 'Сьогодні', icon: 'sun' }, { value: 'tomorrow', label: 'Завтра', icon: 'arrowRight' }, { value: 'week', label: 'Наступний понеділок', icon: 'calendar' }, { value: 'none', label: 'Без строку', icon: 'x' }]); if (v) bulk('due', v); }
      if (b === 'priority') { const v = await menu(bb, [{ value: '0', label: 'Без пріоритету', icon: 'circle' }, { value: '1', label: 'Важлива', icon: 'flag' }, { value: '2', label: 'Термінова', icon: 'flag' }]); if (v != null) bulk('priority', v); }
      if (b === 'done') bulk('done');
      if (b === 'delete') bulk('delete');
      return;
    }
    if (t) {
      const k = t.dataset.t;
      if (k === 'select') { st.selecting = !st.selecting; if (!st.selecting) st.sel.clear(); draw(); }
      if (k === 'compose') {
        const due = isToday ? (() => { const d = new Date(); d.setHours(Math.min(23, Math.max(18, d.getHours() + 1)), 0, 0, 0); return d.getTime(); })() : null;
        const id = await compose({ area: cfg.area, due });
        if (id) st.flash = id;
        return;
      }
      if (k === 'layout') { st.mode = st.mode === 'board' ? 'list' : 'board'; pref.set(K('mode'), st.mode); st.sel.clear(); load(); }
      if (k === 'triage') triage();
      if (k === 'suggest') suggest(t);
      if (k === 'accept') acceptAll();
      if (k === 'ai-add') aiAdd($('.qadd-in', root));
      if (k === 'look') {
        const groups = isToday ? [['tod', 'За часом дня'], ...GROUPS] : GROUPS;
        const v = await menu(t, [{ head: 'Сортування' }, ...SORTS.map(([v, l]) => ({ value: 's:' + v, label: l, checked: st.sort === v })),
                                 { head: 'Групи' }, ...groups.map(([v, l]) => ({ value: 'g:' + v, label: l, checked: st.group === v }))], { width: 230 });
        if (v && v[0] === 's') { st.sort = v.slice(2); pref.set(K('sort'), st.sort); load(); }
        if (v && v[0] === 'g') { st.group = v.slice(2); pref.set(K('group'), st.group); drawList(); }
      }
      if (k === 'filter') {
        const items = [];
        if (!fixedView) items.push({ head: 'Строк' }, ...VIEWS.map(([v, l]) => ({ value: 'view:' + v, label: l, icon: 'calendar', checked: st.view === v })));
        items.push({ head: 'Пріоритет' }, { value: 'prio:0', label: 'Будь-який пріоритет', icon: 'circle', checked: !st.prio }, { value: 'prio:1', label: 'Важливі й термінові', icon: 'flag', checked: st.prio === 1 },
                   { value: 'prio:2', label: 'Лише термінові', icon: 'flag', checked: st.prio === 2 });
        const tags = meta.tags.filter(t => t.open || t.name === st.tag);
        if (tags.length) items.push({ head: 'Теги' }, { value: 'tag:', label: 'Будь-який тег', icon: 'tag', checked: !st.tag },
          ...tags.slice(0, 30).map(t => ({ value: 'tag:' + t.name, label: '#' + t.name, icon: 'tag', checked: st.tag === t.name, hint: t.open ? String(t.open) : '' })));
        if (st.mode === 'list') items.push({ head: 'Виконані' }, { value: 'done', label: st.showDone ? 'Сховати виконані' : 'Показати виконані', icon: 'checkCircle', checked: st.showDone });
        const v = await menu(t, items, { width: 240 });
        if (!v) return;
        if (v.startsWith('view:')) st.view = v.slice(5);
        else if (v.startsWith('prio:')) st.prio = +v.slice(5);
        else if (v.startsWith('tag:')) st.tag = v.slice(4);
        else if (v === 'done') st.showDone = !st.showDone;
        load();
      }
      return;
    }
    if (!a) return;
    const row = a.closest('[data-id]'), id = row && +row.dataset.id, act = a.dataset.a;
    if (act === 'open') {
      if (pressed || swiped) { e.preventDefault(); pressed = false; return; }
      if (st.selecting) { e.preventDefault(); toggleSel(id); }
      return;   // інакше — звичайне посилання на задачу
    }
    if (act === 'sel') { toggleSel(id, a.checked); return; }
    if (act === 'done') {
      const it = findItem(id); if (!it || row.classList.contains('completing')) return;
      // виконано: кружечок заповнюється й галочка малюється → лінія закреслює назву → рядок спокійно згортається
      if (!it.done) { a.classList.add('on', 'bump'); row.classList.add('completing'); if (navigator.vibrate) navigator.vibrate(12); }
      else a.classList.remove('on');
      try {
        const [r] = await Promise.all([post(`assistant/items/${id}/${it.done ? 'reopen' : 'complete'}`), wait(it.done ? 0 : 700)]);
        if (r.next) toast('Наступний раз: ' + fmtDue(r.next));
        else if (!it.done) toast('Виконано', async () => { await post(`assistant/items/${id}/reopen`); changed(); });
        if (!it.done && !r.next) {
          const rows = [row, ...$$(`.row[data-parent="${id}"]`, root)];
          rows.forEach(x => { x.style.height = x.offsetHeight + 'px'; });
          row.offsetHeight;                                   // зафіксувати висоту перед згортанням
          rows.forEach(x => x.classList.add('collapse'));
          await wait(320);
        }
        changed();
      } catch (err) { fail(err); a.classList.toggle('on', it.done); a.classList.remove('bump'); row.classList.remove('completing'); }
      return;
    }
    if (act === 'area' || act === 'area-menu') {
      let v = a.dataset.v;
      if (act === 'area-menu') v = await menu(a, openSpaces().filter(s => s.key !== 'inbox').map(s => ({ value: s.key, label: s.name, icon: s.icon })));
      if (!v) return;
      try {
        await post('assistant/bulk', { ids: [id], action: 'area', value: v }); st.sug.delete(id);
        row.classList.add('leaving');
        toast(`→ ${space(v).name}`, async () => { await post('assistant/bulk', { ids: [id], action: 'area', value: 'inbox' }); changed(); });
        changed();
      } catch (err) { fail(err); }
      return;
    }
    if (act === 'col-add') {
      const col = a.closest('.col'), body = col.querySelector('.col-body');
      if (body.querySelector('.card-new')) return body.querySelector('.card-new textarea').focus();
      const f = document.createElement('div'); f.className = 'card card-new';
      f.innerHTML = '<textarea rows="2" placeholder="Назва задачі… Enter — додати, Esc — скасувати"></textarea>';
      body.prepend(f); const ta = f.querySelector('textarea'); ta.focus();
      ta.addEventListener('keydown', async ev => {
        if (ev.key === 'Escape') { f.remove(); }
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault(); const text = ta.value.trim(); if (!text) return f.remove();
          ta.disabled = true;
          try { await quickAdd(text, { status: col.dataset.status }); } catch (err) { fail(err); }
        }
      });
      ta.addEventListener('blur', () => { if (!ta.value.trim()) setTimeout(() => f.remove(), 150); });
    }
  }
  async function onKeyIn(e) {
    if (e.target.classList.contains('qadd-in') && e.key === 'Enter') {
      e.preventDefault();
      const text = e.target.value.trim(); if (!text) return;
      if (e.ctrlKey || e.metaKey) return aiAdd(e.target);
      e.target.value = '';
      try { await quickAdd(text); toast(cfg.area === 'all' ? 'Додано у «Вхідні»' : 'Додано'); } catch (err) { fail(err); e.target.value = text; }
    }
  }
  function onKey(e) {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-wrap, .pal-wrap, .panel-wrap')) return;
    if (e.key === 'n' || e.key === 'т' || e.key === 'c' || e.key === 'с') { e.preventDefault(); newTask(); }
    if (e.key === 'b' || e.key === 'и') { st.mode = st.mode === 'board' ? 'list' : 'board'; pref.set(K('mode'), st.mode); load(); }
    if (e.key === 'Escape' && st.selecting) { st.selecting = false; st.sel.clear(); draw(); }
  }

  return { render, destroy, refresh };
}
