// Нова задача на телефоні: кнопка «+» розкривається на весь екран — велике поле й поруч строк, простір,
// пріоритет, нагадування, «через асистента». Без зайвого: одна дія — одна кнопка «Додати».
import { post } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, fail, menu, localInput, fmtDue } from '../ui.js';
import { space, openSpaces } from '../store.js';
import { datePicker } from './panel.js';

const PRIO = ['Без пріоритету', 'Важлива', 'Термінова'];
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

// opts: { area, due (мс або null), from (кнопка, з якої розкривається) } → Promise<id нової задачі | null>
export function compose({ area = 'inbox', due = null, from } = {}) {
  return new Promise(resolve => {
    const st = { area: area === 'all' ? 'inbox' : area, due, prio: 0, remind: false, ai: false };
    const w = document.createElement('div'); w.className = 'cmp-wrap';
    const r = from ? from.getBoundingClientRect() : { left: innerWidth - 60, top: innerHeight - 140, width: 56, height: 56 };
    w.style.setProperty('--ox', `${r.left + r.width / 2}px`); w.style.setProperty('--oy', `${r.top + r.height / 2}px`);
    w.innerHTML = `<form class="cmp" role="dialog" aria-modal="true" aria-label="Нова задача">
      <button type="button" class="cmp-x" data-x aria-label="Закрити">${icon('x', 20)}</button>
      <div class="cmp-mid">
        <textarea class="cmp-in" rows="1" placeholder="Нова задача" maxlength="2000" enterkeyhint="send"></textarea>
        <div class="cmp-chips"></div>
        <div class="cmp-subs" hidden></div>
      </div>
      <div class="cmp-bottom">
        <button type="button" class="cmp-ai" data-c="ai" aria-pressed="false">${icon('sparkles', 18)}<span>Асистент розбере</span></button>
        <button type="submit" class="cmp-go">Додати${icon('arrowRight', 16)}</button>
      </div></form>`;
    document.body.append(w);
    // клавіатура телефона не має ховати кнопку «Додати»: висота — за видимою частиною екрана
    const vv = window.visualViewport, fit = () => w.style.setProperty('--vh', vv.height + 'px');
    if (vv) { fit(); vv.addEventListener('resize', fit); }
    requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add('in')));
    const f = w.querySelector('form'), ta = w.querySelector('.cmp-in'), chips = w.querySelector('.cmp-chips'), subsBox = w.querySelector('.cmp-subs');
    // підзадачі: кожен рядок — окрема; Enter — наступний рядок
    const subLine = () => `<label class="cmp-sub">${icon('circle', 16)}<input placeholder="Підзадача" maxlength="2000" enterkeyhint="next"></label>`;
    subsBox.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.target.matches('input')) return;
      e.preventDefault();
      const line = e.target.closest('.cmp-sub');
      if (!e.target.value.trim()) return f.requestSubmit();
      if (!line.nextElementSibling) subsBox.insertAdjacentHTML('beforeend', subLine());
      line.nextElementSibling.querySelector('input').focus();
    });
    setTimeout(() => ta.focus(), 120);

    function drawChips() {
      const sp = space(st.area);
      chips.innerHTML = st.ai ? '<span class="cmp-hint">Скажи як є: «завтра о 10 подзвонити постачальнику» — строк, простір і повтор розбере асистент</span>' : `
        <button type="button" class="cmp-chip${st.due ? ' on' : ''}" data-c="due">${icon('calendar', 16)}<span>${st.due ? esc(fmtDue(st.due)) : 'Строк'}</span></button>
        <button type="button" class="cmp-chip" data-c="area">${icon(sp.icon, 16)}<span>${esc(sp.name)}</span></button>
        <button type="button" class="cmp-chip icon${st.prio ? ' on p' + st.prio : ''}" data-c="prio" aria-label="${PRIO[st.prio]}">${icon('flag', 16)}</button>
        ${st.due ? `<button type="button" class="cmp-chip icon${st.remind ? ' on' : ''}" data-c="remind" aria-pressed="${st.remind}" aria-label="Нагадати">${icon('bell', 16)}</button>` : ''}
        <button type="button" class="cmp-chip icon${subsBox.hidden ? '' : ' on'}" data-c="subs" aria-label="Підзадачі">${icon('subtasks', 16)}</button>`;
      subsBox.hidden = subsBox.hidden || st.ai;
      w.querySelector('.cmp-ai').setAttribute('aria-pressed', String(st.ai));
    }
    drawChips();
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });

    let result = null;
    const close = () => {
      document.removeEventListener('keydown', key, true);
      w.classList.remove('in'); w.classList.add('out');
      if (vv) vv.removeEventListener('resize', fit);
      setTimeout(() => w.remove(), 360); resolve(result);
    };
    const key = e => { if (e.key === 'Escape' && !document.querySelector('.sheet-wrap, .pop')) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', key, true);

    w.addEventListener('click', async e => {
      if (e.target.closest('[data-x]')) return close();
      const c = e.target.closest('[data-c]'); if (!c) return;
      const k = c.dataset.c;
      if (k === 'ai') st.ai = !st.ai;
      if (k === 'prio') st.prio = (st.prio + 1) % 3;
      if (k === 'remind') st.remind = !st.remind;
      if (k === 'subs') {
        subsBox.hidden = !subsBox.hidden;
        if (!subsBox.hidden) { if (!subsBox.children.length) subsBox.innerHTML = subLine(); drawChips(); return subsBox.querySelector('input').focus(); }
      }
      if (k === 'area') { const v = await menu(c, openSpaces().map(s => ({ value: s.key, label: s.name, icon: s.icon, checked: s.key === st.area })), { title: 'Простір' }); if (v) st.area = v; }
      if (k === 'due') { const v = await datePicker(c, st.due); if (v !== undefined) { st.due = v ? new Date(v).getTime() : null; if (!st.due) st.remind = false; } }
      drawChips(); ta.focus();
    });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const text = ta.value.trim(); if (!text) return ta.focus();
      const btn = f.querySelector('.cmp-go'); btn.disabled = true;
      try {
        if (st.ai) {
          const sp = st.area !== 'inbox' ? ` (простір: ${space(st.area).name})` : '';
          const r = await post('assistant/message', { text: text + sp });
          toast([r.reply, ...(r.done || [])].filter(Boolean).join('\n') || 'Записав', r.undoable ? async () => { await post('assistant/undo', { msgId: r.msgId }); changed(); } : null, 6000);
          result = r.items && r.items[0] ? r.items[0].id : null;
        } else {
          const it = await post('assistant/items', { text, area: st.area, priority: st.prio, due: st.due ? localInput(st.due) : undefined, kind: st.remind ? 'reminder' : 'task' });
          const subs = subsBox.hidden ? [] : [...subsBox.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
          for (const t of subs) await post('assistant/items', { text: t, parent_id: it.id });
          result = it.id; toast(subs.length ? `Додано з підзадачами: ${subs.length}` : 'Додано');
        }
        if (navigator.vibrate) navigator.vibrate(12);
        changed(); close();
      } catch (err) { fail(err); btn.disabled = false; }
    });
  });
}
