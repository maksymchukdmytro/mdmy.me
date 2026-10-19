// Бічна картка задачі (як сторінка в Notion): назва, властивості, підзадачі, опис. Усе зберігається одразу.
import { get, patch, del, post } from '../api.js';
import { attachHtml, bindAttach, uploadFile } from './attach.js';
import { icon, STATUS_ICON } from '../icons.js';
import { $, esc, fmtDate, fmtDue, localInput, menu, confirmBox, toast, fail, autosize, debounce, isPhone, sheet, dragToClose } from '../ui.js';
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
    pnl.addEventListener('click', onClick); pnl.addEventListener('change', onChange); pnl.addEventListener('keydown', onPanelKey); pnl.addEventListener('beforeinput', onBeforeInput);
    dragToClose(pnl, () => go(pageHref()), '.sheet-grab, .panel-top', true);   // телефон: картка — аркуш, тягни вниз, щоб закрити
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
    <button type="button" class="pv${value ? '' : ' none'}" data-p="${p}">${value || esc(empty || 'Порожньо')}</button></div>`;
}
const subHtml = k => `<div class="sub${k.done ? ' done' : ''}" data-id="${k.id}">
    <button type="button" class="chk sm${k.done ? ' on' : ''}" data-a="sub-done" aria-label="${k.done ? 'Повернути' : 'Виконано'}">${icon('check', 11)}</button>
    <input value="${esc(k.text)}" data-a="sub-text" aria-label="Підзадача" enterkeyhint="done">
    <button type="button" class="icon-btn xs" data-a="sub-open" title="Відкрити">${icon('open', 14)}</button>
    <button type="button" class="icon-btn xs" data-a="sub-del" title="Видалити">${icon('x', 14)}</button></div>`;
// лічильник і смужка підзадач — без перемальовування картки (фокус і клавіатура лишаються)
function subsCount() {
  if (!cur || !cur.el) return;
  const kids = cur.it.children || [], done = kids.filter(k => k.done).length;
  const n = cur.el.querySelector('.subs-n'), bar = cur.el.querySelector('.subs-sec .p-bar');
  if (n) n.textContent = kids.length ? `${done}/${kids.length}` : '';
  if (bar) { bar.hidden = !kids.length; bar.querySelector('i').style.width = (kids.length ? done / kids.length * 100 : 0) + '%'; }
}
let adding = false;
async function addSub(input, keepBlur) {
  const text = input.value.trim(); if (!text || adding || !cur) return;
  adding = true; input.value = '';
  const parent = cur.it.id;
  try {
    const k = await post('assistant/items', { text, parent_id: parent });
    if (cur && cur.it.id === parent) {
      cur.it.children = [...(cur.it.children || []), k];
      cur.el.querySelector('.subs').insertAdjacentHTML('beforeend', subHtml(k));
      cur.el.querySelector('.subs .sub:last-child').classList.add('enter');
      subsCount();
      if (!keepBlur) input.focus();
    }
    changed();
  } catch (err) { fail(err); input.value = text; }
  adding = false;
}

function render() {
  const it = cur.it, sp = space(it.area), st = status(it.status);
  const kids = it.children || [], doneKids = kids.filter(k => k.done).length;
  const panel = cur.el.querySelector('.panel');
  panel.innerHTML = `
    <div class="sheet-grab phone-only" aria-hidden="true"></div>
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
          <button type="button" class="pv${it.due_at ? '' : ' none'}" data-p="due">${it.due_at ? `<span class="${it.overdue && !it.done ? 'late' : ''}">${esc(fmtDue(it.due_at))}</span>` : 'Без строку'}</button>
        </div>
        <div class="prop-row"><span class="pk">${icon('bell')}<span>Нагадати</span></span>
          <button type="button" class="pv${it.remind_at ? '' : ' none'}" data-p="remind">${it.remind_at ? `<span class="${it.sent && !it.done ? 'muted' : ''}">${esc(remindLabel(it))}</span>` : 'Не нагадувати'}</button></div>
        ${propBtn('prio', 'flag', 'Пріоритет', it.priority ? `<span class="prio p${it.priority}">${icon('flag', 14)}${PRIO[it.priority].label}</span>` : '', 'Без пріоритету')}
        <div class="prop-row"><span class="pk">${icon('tag')}<span>Теги</span></span>
          <div class="tagbox">${(it.tags || []).map(t => `<span class="tchip">#${esc(t)}<button type="button" data-a="tag-del" data-tag="${esc(t)}" aria-label="Прибрати тег">${icon('x', 12)}</button></span>`).join('')}<input class="tag-in" data-a="tag-add" list="tagList" placeholder="${(it.tags || []).length ? '' : 'Додати тег'}" enterkeyhint="done" autocapitalize="off" maxlength="30"></div></div>
        ${it.repeatText ? `<div class="prop-row"><span class="pk">${icon('repeat')}<span>Повтор</span></span><span class="pv static">${esc(it.repeatText)}</span></div>` : ''}
      </div>
      <datalist id="tagList">${meta.tags.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>

      ${it.parent ? '' : `<section class="p-sec subs-sec">
        <h3>${icon('subtasks', 15)}Підзадачі <span class="subs-n"></span></h3>
        <div class="p-bar"${kids.length ? '' : ' hidden'}><i></i></div>
        <div class="subs">${kids.map(subHtml).join('')}</div>
        <form class="sub-add">${icon('plus', 16)}<input placeholder="Додати підзадачу" data-a="sub-add" enterkeyhint="enter" autocomplete="off" maxlength="2000"><button type="submit" class="sub-go" aria-label="Додати підзадачу">${icon('arrowRight', 16)}</button></form>
      </section>`}

      <section class="p-sec">
        <h3>${icon('text', 15)}Опис</h3>
        <textarea class="p-desc" placeholder="Деталі, кроки, контакти, посилання…">${esc(it.description || '')}</textarea>
      </section>
      <section class="p-sec p-att-sec">
        <h3>${icon('paperclip', 15)}Вкладення</h3>
        <div class="p-att">${attachHtml(it.attachments)}</div>
      </section>
      <p class="p-meta">Створено ${esc(fmtDate(it.created))}${it.updated ? ` · змінено ${esc(fmtDate(it.updated))}` : ''}${it.done && it.done_at ? ` · виконано ${esc(fmtDate(it.done_at))}` : ''}</p>
    </div>`;
  subsCount();
  const sf = panel.querySelector('.sub-add');
  if (sf) {
    sf.addEventListener('submit', e => { e.preventDefault(); addSub(sf.querySelector('input')); });
    // написав і перейшов деінде — не губимо текст
    sf.querySelector('input').addEventListener('blur', e => { if (e.target.value.trim() && !(e.relatedTarget && e.relatedTarget.classList.contains('sub-go'))) addSub(e.target, true); });
  }
  // вкладення: фото, файли, посилання (для звітів)
  const attBox = panel.querySelector('.p-att'), itemId = it.id;
  const reAtt = async () => { const f = await get('assistant/items/' + itemId); if (cur && cur.it.id === itemId) { cur.it.attachments = f.attachments; attBox.innerHTML = attachHtml(f.attachments); changed(); } };
  bindAttach(attBox, {
    upload: f => uploadFile(`assistant/items/${itemId}/attachments`, f),
    link: url => post(`assistant/items/${itemId}/attachments`, { url }),
    remove: id => del('assistant/attachments/' + id),
    after: reAtt
  });
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
  if (p === 'remind') {
    const before = m => localInput(it.due_at - m * 60e3), items = [];
    if (it.due_at) items.push({ value: 'due', label: 'У час строку', icon: 'bell', checked: it.remind_at === it.due_at },
                              { value: before(15), label: 'За 15 хв до строку', icon: 'clock' }, { value: before(60), label: 'За годину до строку', icon: 'clock' });
    items.push({ value: 'pick', label: 'Вибрати час…', icon: 'calendar' });
    if (it.remind_at) items.push({ value: 'none', label: 'Не нагадувати', icon: 'x' });
    const v = await menu(b, items);
    if (v === 'due') save({ remind: true });
    else if (v === 'none') save({ remind: null });
    else if (v === 'pick') { const t = await datePicker(b, it.remind_at || it.due_at, { title: 'Нагадати', none: 'Не нагадувати' }); if (t !== undefined) save({ remind: t || null }); }
    else if (v) save({ remind: v });
  }
  if (p === 'due') {
    const v = await datePicker(b, it.due_at);
    if (v !== undefined) save({ due: v });
  }
  const row = e.target.closest('.sub');
  if (a === 'sub-done' && row) {
    const k = it.children.find(x => x.id === +row.dataset.id); if (!k) return;
    k.done = !k.done; row.classList.toggle('done', k.done); b.classList.toggle('on', k.done); b.classList.remove('bump'); b.offsetWidth; if (k.done) b.classList.add('bump'); subsCount();
    try { await post(`assistant/items/${k.id}/${k.done ? 'complete' : 'reopen'}`); changed(); }
    catch (err) { fail(err); k.done = !k.done; row.classList.toggle('done', k.done); b.classList.toggle('on', k.done); subsCount(); }
  }
  if (a === 'sub-del' && row) {
    try {
      await del('assistant/items/' + row.dataset.id);
      it.children = it.children.filter(x => x.id !== +row.dataset.id); row.remove(); subsCount(); changed();
    } catch (err) { fail(err); }
  }
  if (a === 'sub-open' && row) go(taskHref(+row.dataset.id));
  if (a === 'tag-del') save({ tags: (it.tags || []).filter(t => t !== b.dataset.tag) });
}
async function onChange(e) {
  const el = e.target; if (!cur) return;
  if (el.dataset.a === 'tag-add') addTag(el);
  if (el.dataset.a === 'sub-text') {
    const id = +el.closest('.sub').dataset.id;
    const k = (cur.it.children || []).find(x => x.id === id);
    if (!el.value.trim()) { if (k) el.value = k.text; return; }        // порожнє — повертаємо назву (видалити — Backspace у порожньому полі або ×)
    try { await patch('assistant/items/' + id, { text: el.value.trim() }); if (k) k.text = el.value.trim(); changed(); } catch (err) { fail(err); }
  }
}
function addTag(el) {
  const t = el.value.trim().replace(/^#/, '').toLowerCase(); el.value = '';
  if (t && cur && !(cur.it.tags || []).includes(t)) save({ tags: [...(cur.it.tags || []), t] }).then(() => { const i = cur && cur.el.querySelector('.tag-in'); if (i) i.focus(); });
}
// Backspace у порожньому полі: у «Додати підзадачу» — перейти в кінець останньої підзадачі,
// у підзадачі — видалити її й перейти на попередню (як у Notion). Телефонні клавіатури інколи не шлють keydown
// з key=Backspace, тому ловимо й beforeinput (якщо keydown уже скасовано, beforeinput не приходить).
function backspace(e) {
  const el = e.target; if (!cur || el.value !== '') return false;
  if (el.dataset.a !== 'sub-add' && el.dataset.a !== 'sub-text') return false;
  e.preventDefault();
  const focusEnd = i => { if (!i) return; i.focus(); const n = i.value.length; try { i.setSelectionRange(n, n); } catch (x) {} };
  if (el.dataset.a === 'sub-add') { const last = cur.el.querySelector('.subs .sub:last-child input'); focusEnd(last); return true; }
  const row = el.closest('.sub'), prev = row.previousElementSibling, id = +row.dataset.id, it = cur.it;
  focusEnd(prev ? prev.querySelector('input') : cur.el.querySelector('[data-a="sub-add"]'));
  row.classList.add('leave');
  setTimeout(() => row.remove(), 180);
  it.children = (it.children || []).filter(x => x.id !== id); subsCount();
  del('assistant/items/' + id).then(changed, err => { fail(err); });
  return true;
}
function onBeforeInput(e) { if (e.inputType === 'deleteContentBackward') backspace(e); }
async function onPanelKey(e) {
  const el = e.target;
  if (e.key === 'Backspace' && backspace(e)) return;
  if (el.dataset.a === 'tag-add' && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); return addTag(el); }
  if (el.dataset.a === 'tag-add' && e.key === 'Backspace' && !el.value && cur && (cur.it.tags || []).length) return save({ tags: cur.it.tags.slice(0, -1) });
  if (e.key !== 'Enter') return;
  if (el.dataset.a === 'sub-add') return;   // додає форма (submit) — так працює й клавіатура телефона
  if (el.dataset.a === 'sub-text') {
    // Enter у підзадачі — перейти до поля «Додати підзадачу»
    e.preventDefault(); el.blur(); const i = cur && cur.el.querySelector('[data-a="sub-add"]'); if (i) i.focus();
  } else if (el.classList.contains('pv-in')) { e.preventDefault(); el.blur(); }
}

// ---------- вибір дати й часу ----------
// Нагадування в картці: «сьогодні 17:00», «у час строку» — коротко, без дублю строку
function remindLabel(it) {
  if (it.remind_at === it.due_at) return 'У час строку';
  const d = it.due_at && it.due_at - it.remind_at;
  if (d === 15 * 60e3) return 'За 15 хв до строку';
  if (d === 60 * 60e3) return 'За годину до строку';
  return fmtDue(it.remind_at);
}
export function datePicker(anchor, ms, { title = 'Строк', none = 'Без строку' } = {}) {
  return new Promise(resolve => {
    document.querySelectorAll('.pop').forEach(x => x.remove());
    const d0 = new Date(); d0.setSeconds(0, 0);
    const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return localInput(d.getTime()); };
    const toMon = (8 - (d0.getDay() || 7)) % 7 || 7;
    const inner = `
      <button type="button" class="pop-item" data-v="${at(0, Math.max(d0.getHours() + 1, 18) > 23 ? 23 : Math.max(18, d0.getHours() + 1))}">${icon('sun')}<span class="pop-l">Сьогодні</span></button>
      <button type="button" class="pop-item" data-v="${at(1, 9)}">${icon('arrowRight')}<span class="pop-l">Завтра</span><span class="pop-h">9:00</span></button>
      <button type="button" class="pop-item" data-v="${at(toMon, 9)}">${icon('calendar')}<span class="pop-l">Наступний понеділок</span><span class="pop-h">9:00</span></button>
      <div class="pop-sep"></div>
      <label class="date-in"><input type="datetime-local" value="${ms ? localInput(ms) : ''}"></label>
      <div class="date-act"><button type="button" class="btn sm" data-v="">${none}</button><button type="button" class="btn primary sm" data-ok>Готово</button></div>`;
    let box, closeBox, result;
    if (isPhone()) {
      // телефон: нижній аркуш
      const sh = sheet(`<div class="sheet-head"><b>${title}</b></div><div class="date-sheet">${inner}</div>`, { label: title, onClose: () => resolve(result) });
      box = sh.el; closeBox = sh.close;
    } else {
      box = document.createElement('div'); box.className = 'pop date-pop'; box.innerHTML = inner;
      document.body.append(box);
      const r = anchor.getBoundingClientRect(), bh = box.offsetHeight;
      box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + 'px';
      box.style.top = (r.bottom + bh + 8 > innerHeight ? Math.max(8, r.top - bh - 4) : r.bottom + 4) + 'px';
      const away = e => { if (!box.contains(e.target) && !anchor.contains(e.target)) done(undefined); };
      const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(undefined); } };
      setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); });
      closeBox = () => { box.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); resolve(result); };
    }
    const inp = box.querySelector('input');
    let finished = false;
    function done(v) { if (finished) return; finished = true; result = v; closeBox(); }
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-v], [data-ok]'); if (!b) return;
      if (b.hasAttribute('data-ok')) return done(inp.value || (ms ? '' : undefined));
      done(b.dataset.v);
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value || undefined); } });
  });
}
