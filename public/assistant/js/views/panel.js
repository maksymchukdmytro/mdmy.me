// Бічна картка задачі (як сторінка в Notion): назва, властивості, підзадачі, опис. Усе зберігається одразу.
import { get, patch, del, post } from '../api.js';
import { icon, STATUS_ICON } from '../icons.js';
import { $, esc, fmtDate, fmtDue, localInput, menu, confirmBox, toast, fail, autosize, debounce } from '../ui.js';
import { meta, space, status, openSpaces } from '../store.js';
import { go, pageHref, taskHref } from '../nav.js';

let cur = null;            // { id, it, el }
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));
export const panelOpenId = () => cur && cur.id;
const PRIO = [{ v: 0, label: 'Без пріоритету' }, { v: 1, label: 'Важлива' }, { v: 2, label: 'Термінова' }];

export async function openTask(id) {
  if (!cur) {
    const w = document.createElement('div'); w.className = 'panel-wrap';
    w.innerHTML = '<div class="panel-scrim"></div><aside class="panel" role="dialog" aria-modal="true" aria-label="Задача"><div class="panel-load">' + '<span class="spin"></span></div></aside>';
    document.body.append(w); document.body.classList.add('has-panel');
    requestAnimationFrame(() => w.classList.add('in'));
    w.querySelector('.panel-scrim').addEventListener('click', () => go(pageHref()));
    const pnl = w.querySelector('.panel');
    pnl.addEventListener('click', onClick); pnl.addEventListener('change', onChange); pnl.addEventListener('keydown', onPanelKey);
    cur = { id, el: w, it: null };
    document.addEventListener('keydown', onKey, true);
  }
  cur.id = id;
  try { cur.it = await get('assistant/items/' + id); }
  catch (e) { fail(e); return go(pageHref()); }
  if (!cur || cur.id !== id) return;
  render();
}
export function closeTask() {
  if (!cur) return;
  flush();
  const w = cur.el; cur = null;
  document.removeEventListener('keydown', onKey, true);
  document.body.classList.remove('has-panel');
  w.classList.remove('in'); setTimeout(() => w.remove(), 180);
}
function onKey(e) {
  if (e.key === 'Escape' && !document.querySelector('.pop, .modal-wrap, .pal-wrap')) { e.preventDefault(); go(pageHref()); }
}

// ---------- збереження ----------
let pendingSave = null;
async function save(fields, quiet) {
  if (!cur) return;
  const id = cur.id;
  try {
    const it = await patch('assistant/items/' + id, fields);
    if (cur && cur.id === id) { cur.it = it; if (!quiet) render(); }
    changed();
    return it;
  } catch (e) { fail(e); }
}
const saveTitle = debounce(v => save({ text: v }, true), 600);
const saveDesc = debounce(v => save({ description: v }, true), 700);
function flush() {
  if (!cur) return;
  const t = cur.el.querySelector('.p-title textarea'), d = cur.el.querySelector('.p-desc');
  if (t && t.value.trim() && t.value.trim() !== cur.it.text) save({ text: t.value.trim() }, true);
  if (d && d.value !== (cur.it.description || '')) save({ description: d.value }, true);
}

// ---------- відмальовка ----------
function propBtn(p, ic, label, value, empty) {
  return `<div class="prop-row"><span class="pk">${icon(ic)}<span>${label}</span></span>
    <button type="button" class="pv${value ? '' : ' empty'}" data-p="${p}">${value || esc(empty || 'Порожньо')}</button></div>`;
}
function render() {
  const it = cur.it, sp = space(it.area), st = status(it.status);
  const kids = it.children || [], doneKids = kids.filter(k => k.done).length;
  const panel = cur.el.querySelector('.panel');
  panel.innerHTML = `
    <header class="panel-top">
      <div class="crumb">${icon(sp.icon, 14)}<span>${esc(sp.name)}</span>${it.parent ? `<span class="sep">/</span><a href="${taskHref(it.parent.id)}">${esc(it.parent.text)}</a>` : ''}</div>
      <div class="panel-act">
        <button type="button" class="icon-btn" data-a="more" title="Ще">${icon('more')}</button>
        <button type="button" class="icon-btn" data-a="close" title="Закрити (Esc)">${icon('x')}</button>
      </div>
    </header>
    <div class="panel-body">
      <div class="p-title">
        <button type="button" class="chk lg${it.done ? ' on' : ''}" data-a="done" title="${it.done ? 'Повернути у відкриті' : 'Позначити виконаним'}">${icon('check', 14)}</button>
        <textarea rows="1" maxlength="2000" placeholder="Без назви">${esc(it.text)}</textarea>
      </div>
      <div class="props">
        ${propBtn('status', 'status', 'Статус', `${icon(STATUS_ICON[it.status] || 'circle', 14)}<span>${esc(st.name)}</span>`)}
        ${propBtn('area', 'layers', 'Простір', `${icon(sp.icon, 14)}<span>${esc(sp.name)}</span>`)}
        <div class="prop-row"><span class="pk">${icon('calendar')}<span>Строк</span></span>
          <button type="button" class="pv${it.due_at ? '' : ' empty'}" data-p="due">${it.due_at ? `<span class="${it.overdue && !it.done ? 'late' : ''}">${esc(fmtDue(it.due_at))}</span>` : 'Без строку'}</button>
          ${it.due_at && it.kind !== 'note' ? `<button type="button" class="pv-bell${it.kind === 'reminder' ? ' on' : ''}" data-p="kind" aria-pressed="${it.kind === 'reminder'}" title="${it.kind === 'reminder' ? 'Нагадаю в цей час — натисніть, щоб вимкнути' : 'Нагадати в цей час'}">${icon('bell', 15)}<span>${it.kind === 'reminder' ? 'Нагадаю' : 'Нагадати'}</span></button>` : ''}</div>
        ${propBtn('prio', 'flag', 'Пріоритет', it.priority ? `<span class="prio p${it.priority}">${icon('flag', 14)}${PRIO[it.priority].label}</span>` : '', 'Без пріоритету')}
        <div class="prop-row"><span class="pk">${icon('folder')}<span>Проєкт</span></span>
          <input class="pv-in" data-p="project" list="projList" value="${esc(it.project || '')}" placeholder="Порожньо"></div>
        <div class="prop-row"><span class="pk">${icon('tag')}<span>Теги</span></span>
          <input class="pv-in" data-p="tags" value="${esc((it.tags || []).join(', '))}" placeholder="Порожньо"></div>
        ${it.repeatText ? `<div class="prop-row"><span class="pk">${icon('repeat')}<span>Повтор</span></span><span class="pv static">${esc(it.repeatText)}</span></div>` : ''}
      </div>
      <datalist id="projList">${meta.projects.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>

      ${it.parent ? '' : `<section class="p-sec">
        <h3>${icon('subtasks', 15)}Підзадачі${kids.length ? ` <span>${doneKids}/${kids.length}</span>` : ''}</h3>
        ${kids.length ? `<div class="p-bar"><i style="width:${kids.length ? doneKids / kids.length * 100 : 0}%"></i></div>` : ''}
        <div class="subs">${kids.map(k => `<div class="sub${k.done ? ' done' : ''}" data-id="${k.id}">
            <button type="button" class="chk sm${k.done ? ' on' : ''}" data-a="sub-done">${icon('check', 11)}</button>
            <input value="${esc(k.text)}" data-a="sub-text" aria-label="Підзадача">
            <button type="button" class="icon-btn xs" data-a="sub-open" title="Відкрити">${icon('open', 14)}</button>
            <button type="button" class="icon-btn xs" data-a="sub-del" title="Видалити">${icon('x', 14)}</button></div>`).join('')}</div>
        <label class="sub-add">${icon('plus', 15)}<input placeholder="Додати підзадачу" data-a="sub-add"></label>
      </section>`}

      <section class="p-sec">
        <h3>${icon('text', 15)}Опис</h3>
        <textarea class="p-desc" placeholder="Деталі, кроки, контакти, посилання…">${esc(it.description || '')}</textarea>
      </section>
      <p class="p-meta">Створено ${esc(fmtDate(it.created))}${it.updated ? ` · змінено ${esc(fmtDate(it.updated))}` : ''}${it.done && it.done_at ? ` · виконано ${esc(fmtDate(it.done_at))}` : ''}</p>
    </div>`;
  const ta = panel.querySelector('.p-title textarea'), desc = panel.querySelector('.p-desc');
  autosize(ta); autosize(desc);
  ta.addEventListener('input', () => { autosize(ta); if (ta.value.trim()) saveTitle(ta.value.trim()); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); desc.focus(); } });
  desc.addEventListener('input', () => { autosize(desc); saveDesc(desc.value); });
}

async function onClick(e) {
  const b = e.target.closest('[data-a], [data-p]'); if (!b || !cur) return;
  const it = cur.it, a = b.dataset.a, p = b.dataset.p;
  if (a === 'close') return go(pageHref());
  if (a === 'done') {
    try { const r = await post(`assistant/items/${it.id}/${it.done ? 'reopen' : 'complete'}`); cur.it = r; render(); changed();
          if (r.next) toast('Наступний раз: ' + fmtDue(r.next)); }
    catch (err) { fail(err); }
    return;
  }
  if (a === 'more') {
    const v = await menu(b, [{ value: 'copy', label: 'Копіювати назву', icon: 'copy' }, { value: 'link', label: 'Копіювати посилання', icon: 'open' },
                             { sep: true }, { value: 'delete', label: 'Видалити', icon: 'trash', danger: true }]);
    if (v === 'copy') navigator.clipboard.writeText(it.text).then(() => toast('Скопійовано'), () => {});
    if (v === 'link') navigator.clipboard.writeText(location.origin + location.pathname + taskHref(it.id)).then(() => toast('Посилання скопійовано'), () => {});
    if (v === 'delete' && await confirmBox(`Видалити «${it.text}»${(it.children || []).length ? ' разом із підзадачами' : ''}?`)) {
      try { await del('assistant/items/' + it.id); changed(); toast('Видалено'); go(pageHref()); } catch (err) { fail(err); }
    }
    return;
  }
  if (p === 'status') {
    const v = await menu(b, meta.statuses.map(s => ({ value: s.key, label: s.name, icon: STATUS_ICON[s.key] || 'circle', checked: s.key === it.status })));
    if (v && v !== it.status) { const r = await save({ status: v }); if (r && r.status !== v) toast('Повторювана задача — перенесено на наступний раз'); }
  }
  if (p === 'area') {
    const v = await menu(b, openSpaces().map(s => ({ value: s.key, label: s.name, icon: s.icon, checked: s.key === it.area })));
    if (v && v !== it.area) save({ area: v });
  }
  if (p === 'prio') {
    const v = await menu(b, PRIO.map(x => ({ value: String(x.v), label: x.label, icon: x.v ? 'flag' : 'circle', checked: x.v === it.priority })));
    if (v != null && +v !== it.priority) save({ priority: +v });
  }
  if (p === 'kind' && it.due_at && it.kind !== 'note') save({ kind: it.kind === 'reminder' ? 'task' : 'reminder' });
  if (p === 'due') {
    const v = await datePicker(b, it.due_at);
    if (v !== undefined) save({ due: v });
  }
  const row = e.target.closest('.sub');
  if (a === 'sub-done' && row) {
    const k = it.children.find(x => x.id === +row.dataset.id);
    try { await post(`assistant/items/${k.id}/${k.done ? 'reopen' : 'complete'}`); openTask(it.id); changed(); } catch (err) { fail(err); }
  }
  if (a === 'sub-del' && row) { try { await del('assistant/items/' + row.dataset.id); openTask(it.id); changed(); } catch (err) { fail(err); } }
  if (a === 'sub-open' && row) go(taskHref(+row.dataset.id));
}
async function onChange(e) {
  const el = e.target; if (!cur) return;
  if (el.dataset.p === 'project' && el.value.trim() !== (cur.it.project || '')) save({ project: el.value.trim() });
  if (el.dataset.p === 'tags') save({ tags: el.value });
  if (el.dataset.a === 'sub-text') {
    const id = +el.closest('.sub').dataset.id;
    if (el.value.trim()) { try { await patch('assistant/items/' + id, { text: el.value.trim() }); changed(); } catch (err) { fail(err); } }
  }
}
async function onPanelKey(e) {
  if (e.key !== 'Enter') return;
  const el = e.target;
  if (el.dataset.a === 'sub-add' && el.value.trim()) {
    e.preventDefault();
    const text = el.value.trim(); el.value = '';
    try { await post('assistant/items', { text, parent_id: cur.it.id }); await openTask(cur.it.id); changed(); const i = cur && cur.el.querySelector('[data-a="sub-add"]'); if (i) i.focus(); }
    catch (err) { fail(err); }
  } else if (el.dataset.a === 'sub-text' || el.classList.contains('pv-in')) { e.preventDefault(); el.blur(); }
}

// ---------- вибір дати й часу ----------
export function datePicker(anchor, ms) {
  return new Promise(resolve => {
    document.querySelectorAll('.pop').forEach(x => x.remove());
    const box = document.createElement('div'); box.className = 'pop date-pop';
    const d0 = new Date(); d0.setSeconds(0, 0);
    const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return localInput(d.getTime()); };
    const toMon = (8 - (d0.getDay() || 7)) % 7 || 7;
    box.innerHTML = `
      <button type="button" class="pop-item" data-v="${at(0, Math.max(d0.getHours() + 1, 18) > 23 ? 23 : Math.max(18, d0.getHours() + 1))}">${icon('sun')}<span class="pop-l">Сьогодні</span></button>
      <button type="button" class="pop-item" data-v="${at(1, 9)}">${icon('arrowRight')}<span class="pop-l">Завтра</span><span class="pop-h">9:00</span></button>
      <button type="button" class="pop-item" data-v="${at(toMon, 9)}">${icon('calendar')}<span class="pop-l">Наступний понеділок</span><span class="pop-h">9:00</span></button>
      <div class="pop-sep"></div>
      <label class="date-in"><input type="datetime-local" value="${ms ? localInput(ms) : ''}"></label>
      <div class="date-act"><button type="button" class="btn sm" data-v="">Без строку</button><button type="button" class="btn primary sm" data-ok>Готово</button></div>`;
    document.body.append(box);
    const r = anchor.getBoundingClientRect(), bh = box.offsetHeight;
    box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + 'px';
    box.style.top = (r.bottom + bh + 8 > innerHeight ? Math.max(8, r.top - bh - 4) : r.bottom + 4) + 'px';
    const inp = box.querySelector('input');
    const done = v => { box.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); resolve(v); };
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-v], [data-ok]'); if (!b) return;
      if (b.hasAttribute('data-ok')) return done(inp.value || (ms ? '' : undefined));
      done(b.dataset.v);
    });
    const away = e => { if (!box.contains(e.target) && !anchor.contains(e.target)) done(undefined); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(undefined); } if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); done(inp.value || undefined); } };
    setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); });
  });
}
