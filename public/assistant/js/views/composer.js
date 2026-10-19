// Нова задача. Відкривається вручну: текст, строк, простір, пріоритет, нагадування, підзадачі — і «Надіслати» створює задачу як є.
// Велика кнопка мікрофона внизу по центру: натиснув — говориш, натиснув ще раз — асистент сам розбере строк, простір, повтор
// і створить задачу (у тості — «Скасувати»). Кнопка «Асистент» угорі — щоб і набраний текст розбирав асистент.
// opts.voice — одразу слухати (центральна кнопка нижньої панелі), інакше — клавіатура (кнопка «+»).
import { post } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, menu, localInput, fmtDue } from '../ui.js';
import { space, openSpaces } from '../store.js';
import { datePicker } from './panel.js';
import { recorder, micError } from '../voice.js';
import { runVoice } from '../bgvoice.js';

const PRIO = ['Без пріоритету', 'Важлива', 'Термінова'];
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

export function compose({ area = 'inbox', due = null, voice = false } = {}) {
  return new Promise(resolve => {
    const st = { area: area === 'all' ? 'inbox' : area, due, prio: 0, remind: false, ai: false };
    const w = document.createElement('div'); w.className = 'cmp-wrap';
    w.innerHTML = `<form class="cmp" role="dialog" aria-modal="true" aria-label="Нова задача">
      <header class="cmp-top"><button type="button" class="cmp-mode" data-c="mode"></button>
        <button type="button" class="cmp-x" data-x aria-label="Закрити">${icon('x', 20)}</button></header>
      <div class="cmp-mid">
        <textarea class="cmp-in" rows="1" placeholder="Що треба зробити?" maxlength="2000" enterkeyhint="send"></textarea>
        <p class="cmp-status"></p>
        <div class="cmp-subs" hidden></div>
      </div>
      <div class="cmp-chips" hidden></div>
      <div class="cmp-bottom">
        <span class="cmp-side"></span>
        <button type="button" class="cmp-mic" data-c="mic" aria-label="Говорити">${icon('mic', 30)}<i class="cmp-stop"></i></button>
        <button type="submit" class="cmp-go" aria-label="Надіслати">${icon('send', 22)}</button>
      </div></form>`;
    document.body.append(w);
    // висота — за видимою частиною екрана (над клавіатурою), щоб кнопки не ховались
    // і зсув видимої частини: у браузері (не в застосунку) з клавіатурою сторінка може бути прокручена під нею
    const vv = window.visualViewport, fit = () => { w.style.setProperty('--vh', vv.height + 'px'); w.style.setProperty('--vt', vv.offsetTop + 'px'); };
    if (vv) { fit(); vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
    requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add('in')));
    const f = w.querySelector('form'), ta = w.querySelector('.cmp-in'), chips = w.querySelector('.cmp-chips'), subsBox = w.querySelector('.cmp-subs');
    const statusEl = w.querySelector('.cmp-status'), mic = w.querySelector('.cmp-mic'), modeBtn = w.querySelector('.cmp-mode');
    const status = (html, cls = '') => { statusEl.innerHTML = html; statusEl.className = 'cmp-status ' + cls; };
    const HINT_AI = 'Асистент сам розбере строк, простір і повтор: «завтра о 10 подзвонити постачальнику»';
    const HINT = () => st.ai ? HINT_AI : 'Або голосом — асистент сам розставить строк, простір і повтор';

    // підзадачі (лише вручну): Enter — наступний рядок
    const subLine = () => `<label class="cmp-sub">${icon('circle', 16)}<input placeholder="Підзадача" maxlength="2000" enterkeyhint="next"></label>`;
    // Backspace у порожньому рядку — прибрати рядок і повернутись на попередній
    const back = e => {
      const i = e.target; if (!i.matches('input') || i.value !== '') return;
      e.preventDefault();
      const line = i.closest('.cmp-sub'), prev = line.previousElementSibling;
      if (!prev) { if (line.nextElementSibling) return; subsBox.hidden = true; subsBox.innerHTML = ''; drawChips(); ta.focus(); return; }
      const pi = prev.querySelector('input'); pi.focus(); pi.setSelectionRange(pi.value.length, pi.value.length); line.remove();
    };
    subsBox.addEventListener('beforeinput', e => { if (e.inputType === 'deleteContentBackward') back(e); });
    subsBox.addEventListener('keydown', e => {
      if (e.key === 'Backspace') return back(e);
      if (e.key !== 'Enter' || !e.target.matches('input')) return;
      e.preventDefault();
      const line = e.target.closest('.cmp-sub');
      if (!e.target.value.trim()) return f.requestSubmit();
      if (!line.nextElementSibling) subsBox.insertAdjacentHTML('beforeend', subLine());
      line.nextElementSibling.querySelector('input').focus();
    });

    // ---------- голос ----------
    let rec = null, recTimer = 0, busy = false;

    function drawMode() {
      modeBtn.innerHTML = st.ai ? `${icon('list', 16)}<span>Вручну</span>` : `${icon('sparkles', 16)}<span>Асистент</span>`;
      modeBtn.setAttribute('aria-pressed', String(st.ai));
      chips.hidden = st.ai;
      if (st.ai) subsBox.hidden = true;
      if (!rec && !busy) status(HINT(), 'hint');
      if (!st.ai) drawChips();
    }
    function drawChips() {
      const sp = space(st.area);
      chips.innerHTML = `
        <button type="button" class="cmp-chip${st.due ? ' on' : ''}" data-c="due">${icon('calendar', 16)}<span>${st.due ? esc(fmtDue(st.due)) : 'Строк'}</span></button>
        <button type="button" class="cmp-chip" data-c="area">${icon(sp.icon, 16)}<span>${esc(sp.name)}</span></button>
        <button type="button" class="cmp-chip icon${st.prio ? ' on p' + st.prio : ''}" data-c="prio" aria-label="${PRIO[st.prio]}">${icon('flag', 16)}</button>
        ${st.due ? `<button type="button" class="cmp-chip icon${st.remind ? ' on' : ''}" data-c="remind" aria-pressed="${st.remind}" aria-label="Нагадати">${icon('bell', 16)}</button>` : ''}
        <button type="button" class="cmp-chip icon${subsBox.hidden ? '' : ' on'}" data-c="subs" aria-label="Підзадачі">${icon('subtasks', 16)}</button>`;
    }
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.35) + 'px'; };
    const syncGo = () => w.querySelector('.cmp-go').classList.toggle('ready', !!ta.value.trim());
    ta.addEventListener('input', () => { grow(); syncGo(); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });
    // почав писати, поки слухаю, — значить, вирішив текстом
    ta.addEventListener('focus', () => { if (rec) cancelRec(); });

    function cancelRec() {
      if (rec) { rec.cancel(); rec = null; }
      clearInterval(recTimer); mic.classList.remove('on'); mic.style.setProperty('--lv', 0);
      if (!busy) status(HINT(), 'hint');
    }
    async function listen() {
      if (busy) return;
      if (rec) return finish();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // ховаємо клавіатуру
      const r = rec = recorder({ onLevel: v => mic.style.setProperty('--lv', v.toFixed(2)) });
      try { await r.start(); } catch (err) { if (rec === r) rec = null; status(esc(micError(err)), 'err'); return; }
      if (rec !== r) return;                                   // поки чекали дозволу, вже скасували
      mic.classList.add('on');
      const t0 = Date.now();
      const show = () => { const s = Math.floor((Date.now() - t0) / 1000); status(`<i class="dot"></i>Слухаю ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · натисни, коли закінчиш`, 'live'); };
      show(); recTimer = setInterval(show, 500);
      if (navigator.vibrate) navigator.vibrate(15);
    }
    // Запис зупинено: вікно одразу згортається, розшифровка й розбір асистентом ідуть у фоні (bgvoice.js) —
    // плашка внизу покаже результат з «Переглянути» і «Скасувати»
    async function finish() {
      const r = rec; rec = null; clearInterval(recTimer);
      mic.classList.remove('on'); mic.style.setProperty('--lv', 0);
      let blob; try { blob = await r.stop(); } catch (err) { status(esc(err.message), 'err'); return; }
      runVoice(blob, { prefix: ta.value.trim(), hint: hintText() });
      close();
    }

    // що вибрано вручну — підказкою асистенту
    function hintText() {
      const hint = [st.area !== 'inbox' ? 'простір: ' + space(st.area).name : '', !st.ai && st.due ? 'строк: ' + fmtDue(st.due) : '', !st.ai && st.prio ? PRIO[st.prio].toLowerCase() : ''].filter(Boolean);
      return hint.length ? ` (${hint.join(', ')})` : '';
    }
    let result = null;
    const close = () => {
      cancelRec();
      document.removeEventListener('keydown', key, true);
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
      w.classList.remove('in'); w.classList.add('out');
      setTimeout(() => w.remove(), 320); resolve(result);
    };
    const key = e => { if (e.key === 'Escape' && !document.querySelector('.sheet-wrap, .pop')) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', key, true);

    w.addEventListener('click', async e => {
      if (e.target.closest('[data-x]')) return close();
      const c = e.target.closest('[data-c]'); if (!c) return;
      const k = c.dataset.c;
      if (k === 'mic') return listen();
      if (k === 'mode') { st.ai = !st.ai; drawMode(); return; }
      if (k === 'prio') st.prio = (st.prio + 1) % 3;
      if (k === 'remind') st.remind = !st.remind;
      if (k === 'subs') {
        subsBox.hidden = !subsBox.hidden; drawChips();
        if (!subsBox.hidden) { if (!subsBox.children.length) subsBox.innerHTML = subLine(); subsBox.querySelector('input').focus(); }
        return;
      }
      if (k === 'area') { const v = await menu(c, openSpaces().map(s => ({ value: s.key, label: s.name, icon: s.icon, checked: s.key === st.area })), { title: 'Простір' }); if (v) st.area = v; }
      if (k === 'due') { const v = await datePicker(c, st.due); if (v !== undefined) { st.due = v ? new Date(v).getTime() : null; if (!st.due) st.remind = false; } }
      drawChips();
    });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (rec) return finish();
      const text = ta.value.trim(); if (!text) return listen();
      const btn = f.querySelector('.cmp-go'); btn.disabled = true;
      try {
        if (st.ai) {
          status('<span class="spin"></span>Асистент розбирає…', 'live');
          const sp = hintText();
          const r = await post('assistant/message', { text: text + sp });
          toast([r.reply, ...(r.done || [])].filter(Boolean).join('\n') || 'Записав', r.undoable ? async () => { await post('assistant/undo', { msgId: r.msgId }); changed(); } : null, 6000);
          result = r.items && r.items[0] ? r.items[0].id : null;
        } else {
          const it = await post('assistant/items', { text, area: st.area, priority: st.prio, due: st.due ? localInput(st.due) : undefined, remind: st.due && st.remind ? true : undefined });
          const subs = subsBox.hidden ? [] : [...subsBox.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
          for (const t of subs) await post('assistant/items', { text: t, parent_id: it.id });
          result = it.id; toast(subs.length ? `Додано з підзадачами: ${subs.length}` : 'Додано');
        }
        if (navigator.vibrate) navigator.vibrate(12);
        changed(); close();
      } catch (err) { status(esc(err.message), 'err'); btn.disabled = false; }
    });

    drawMode(); syncGo();
    if (voice) setTimeout(listen, 280); else setTimeout(() => ta.focus(), 120);
  });
}
