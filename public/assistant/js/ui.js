// Спільні дрібниці інтерфейсу: екранування, дати, сповіщення, спливаючі меню, діалоги, сховище налаштувань.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const debounce = (f, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
export const pref = {
  get(k, d) { try { const v = localStorage.getItem('mdmy:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('mdmy:' + k, JSON.stringify(v)); } catch (e) {} }
};

// ---------- дати ----------
const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const DAY = 864e5;
const start = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
export function fmtDue(ms, withTime = true) {
  if (!ms) return '';
  const d = new Date(ms), diff = Math.round((start(ms) - start(Date.now())) / DAY);
  const hm = d.getHours() || d.getMinutes() ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  const t = withTime ? hm : '';
  if (diff === 0) return 'Сьогодні' + t;
  if (diff === 1) return 'Завтра' + t;
  if (diff === -1) return 'Вчора' + t;
  if (diff > 1 && diff < 7) return WD[d.getDay()] + t;
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}${t}`;
}
export const fmtDate = ms => { const d = new Date(ms); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export function localInput(ms) {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function dueBucket(it) {
  if (!it.due_at) return 'nodate';
  const diff = Math.round((start(it.due_at) - start(Date.now())) / DAY);
  if (it.overdue && !(it.kind === 'reminder' && it.sent)) return 'overdue';
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'week';
  return 'later';
}
export const BUCKETS = { overdue: 'Прострочено', today: 'Сьогодні', tomorrow: 'Завтра', week: 'Найближчі 7 днів', later: 'Пізніше', nodate: 'Без строку' };

// ---------- сповіщення ----------
let toastTimer = 0;
export function toast(text, undo, ms = 4000) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.innerHTML = `<span>${esc(text)}</span>${undo ? `<button type="button">${icon('undo', 14)} Скасувати</button>` : ''}`;
  t.hidden = false; t.classList.remove('out');
  clearTimeout(toastTimer);
  if (undo) t.querySelector('button').onclick = async () => { t.hidden = true; await undo(); };
  toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => { t.hidden = true; }, 200); }, undo ? Math.max(ms, 7000) : ms);
}
export const fail = e => toast(e && e.message ? e.message : String(e));

// ---------- спливаюче меню ----------
// items: [{ value, label, icon, checked, danger, hint, sep, head }]; повертає Promise з вибраним value (або undefined)
let openMenu = null;
export function menu(anchor, items, { width, filter } = {}) {
  closeMenu();
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'pop'; box.setAttribute('role', 'menu');
    if (width) box.style.minWidth = width + 'px';
    const render = q => {
      const list = items.filter(it => it.sep || it.head || !q || String(it.label).toLowerCase().includes(q));
      box.querySelector('.pop-list').innerHTML = list.map((it, i) => it.sep ? '<div class="pop-sep"></div>' : it.head ? `<div class="pop-head">${esc(it.head)}</div>` :
        `<button type="button" class="pop-item${it.danger ? ' danger' : ''}${it.checked ? ' on' : ''}" data-i="${items.indexOf(it)}" role="menuitem">
          ${it.icon ? `<span class="pop-ic">${it.icon.startsWith('<') ? it.icon : icon(it.icon, 16)}</span>` : ''}<span class="pop-l">${esc(it.label)}</span>
          ${it.hint ? `<span class="pop-h">${esc(it.hint)}</span>` : ''}${it.checked ? icon('check', 14, 'pop-ck') : ''}</button>`).join('') || '<div class="pop-empty">Нічого</div>';
    };
    box.innerHTML = (filter ? `<input class="pop-q" placeholder="${esc(filter)}">` : '') + '<div class="pop-list"></div>';
    document.body.append(box); render('');
    const r = anchor.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    let left = Math.min(r.left, innerWidth - bw - 8), top = r.bottom + 4;
    if (top + bh > innerHeight - 8) top = Math.max(8, r.top - bh - 4);
    box.style.left = Math.max(8, left) + 'px'; box.style.top = top + 'px';
    const done = v => { closeMenu(); resolve(v); };
    box.addEventListener('click', e => { const b = e.target.closest('.pop-item'); if (b) done(items[+b.dataset.i].value); });
    const q = box.querySelector('.pop-q');
    if (q) { q.focus(); q.addEventListener('input', () => render(q.value.trim().toLowerCase()));
             q.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = box.querySelector('.pop-item'); if (b) b.click(); } }); }
    const away = e => { if (!box.contains(e.target) && !anchor.contains(e.target)) done(undefined); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(undefined); } };
    setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); });
    openMenu = { box, off() { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); } };
  });
}
export function closeMenu() { if (openMenu) { openMenu.off(); openMenu.box.remove(); openMenu = null; } }

// ---------- діалог підтвердження ----------
export function confirmBox(text, { ok = 'Видалити', danger = true } = {}) {
  return new Promise(resolve => {
    const w = document.createElement('div'); w.className = 'modal-wrap';
    w.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true"><p>${esc(text)}</p>
      <div class="modal-act"><button type="button" class="btn" data-v="0">Скасувати</button><button type="button" class="btn ${danger ? 'danger-solid' : 'primary'}" data-v="1">${esc(ok)}</button></div></div>`;
    document.body.append(w);
    const done = v => { w.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    document.addEventListener('keydown', key, true);
    w.addEventListener('click', e => { if (e.target === w) done(false); const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1'); });
    w.querySelector('[data-v="1"]').focus();
  });
}

export function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
export const isTyping = e => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
export const spin = () => '<span class="spin"></span>';
