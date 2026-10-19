// Голос у фоні: щойно запис зупинено, вікно згортається, а розшифровка й розбір асистентом ідуть тут —
// у маленькій плашці над нижньою панеллю. Готово — плашка показує, що додано: «Переглянути» відкриває задачу, «Скасувати» — відміняє.
// Спільне для вікна нової задачі (composer.js) і утримання центральної кнопки (hold.js). Кілька записів поспіль — кілька плашок.
import { post } from './api.js';
import { icon } from './icons.js';
import { esc } from './ui.js';
import { transcribe, history } from './voice.js';
import { go, taskHref } from './nav.js';

const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));
function box() {
  let b = document.getElementById('vjobs');
  if (!b) { b = document.createElement('div'); b.id = 'vjobs'; b.className = 'vjobs'; b.setAttribute('aria-live', 'polite'); document.body.append(b); }
  return b;
}

// prefix — текст, уже набраний у вікні; hint — підказка асистенту (простір, строк, вибрані вручну)
export function runVoice(blob, { prefix = '', hint = '' } = {}) {
  const el = document.createElement('div'); el.className = 'vjob';
  box().append(el); document.body.classList.add('vjobs-on');
  requestAnimationFrame(() => el.classList.add('in'));
  let text = '', timer = 0, hideT = 0;
  const t0 = Date.now();
  const close = () => {
    clearInterval(timer); clearTimeout(hideT); el.classList.remove('in'); el.classList.add('out');
    setTimeout(() => { el.remove(); if (!box().children.length) document.body.classList.remove('vjobs-on'); }, 260);
  };
  const busy = (label, sub = '') => {
    clearInterval(timer);
    const draw = () => { el.innerHTML = `<span class="spin"></span><span class="vj-t"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="vj-s">${Math.round((Date.now() - t0) / 1000)} с</span>`; };
    draw(); timer = setInterval(draw, 1000);
  };
  const fail = (msg, retry) => {
    clearInterval(timer);
    el.className = 'vjob in err';
    el.innerHTML = `${icon('x', 16)}<span class="vj-t"><b>${esc(msg)}</b></span>${retry ? '<button type="button" data-v="retry">Ще раз</button>' : ''}<button type="button" class="vj-x" data-v="close" aria-label="Закрити">${icon('x', 14)}</button>`;
    el.onclick = e => { const v = e.target.closest('[data-v]'); if (!v) return; if (v.dataset.v === 'retry') { el.className = 'vjob in'; retry(); } else close(); };
  };

  async function stt() {
    busy('Розшифровую запис…');
    try {
      const r = await transcribe(blob);
      const heard = (r.text || '').trim();
      if (!heard) return fail('Нічого не почув — спробуйте ще раз');
      history.add({ text: heard, duration: r.duration, at: Date.now() });
      text = (prefix ? prefix + ' ' : '') + heard;
      return assist();
    } catch (e) { return fail(e.message, stt); }
  }
  async function assist() {
    busy('Асистент розбирає…', '«' + text.slice(0, 90) + (text.length > 90 ? '…' : '') + '»');
    try {
      const r = await post('assistant/message', { text: text + hint });
      clearInterval(timer); changed();
      // головне — що саме додано: назва задачі й коли; інакше — перший рядок дій або відповідь асистента
      const it = r.items && r.items[0], n = (r.done || []).length;
      const title = it ? it.text : ((r.done || [])[0] || r.reply || 'Записав').replace(/^•\s*/, '');
      const when = it && it.kind !== 'note' ? [it.remindWhen ? '🔔 ' + it.remindWhen : it.when ? '📅 ' + it.when : '', n > 1 ? `і ще ${n - 1}` : ''].filter(Boolean).join(' · ')
        : it ? 'Нотатка' : n ? '' : '';
      const id = it && it.kind !== 'note' ? it.id : null;
      el.className = 'vjob in ok';
      el.innerHTML = `<div class="vj-row">${icon('checkCircle', 18)}<span class="vj-t"><b>${esc(title)}</b>${when ? `<small>${esc(when)}</small>` : ''}</span>
          <button type="button" class="vj-x" data-v="close" aria-label="Закрити">${icon('x', 14)}</button></div>
        ${id || r.undoable ? `<div class="vj-acts">${id ? '<button type="button" data-v="open">Переглянути</button>' : ''}${r.undoable ? '<button type="button" data-v="undo">Скасувати</button>' : ''}</div>` : ''}`;
      el.onclick = async e => {
        const v = e.target.closest('[data-v]'); if (!v) return;
        if (v.dataset.v === 'open') { go(taskHref(id)); close(); }
        if (v.dataset.v === 'undo') { v.disabled = true; try { await post('assistant/undo', { msgId: r.msgId }); changed(); } catch (er) {} close(); }
        if (v.dataset.v === 'close') close();
      };
      // сама зникає за 12 с; поки палець чи миша на плашці — чекає
      const arm = () => { clearTimeout(hideT); hideT = setTimeout(close, 12000); };
      el.addEventListener('pointerenter', () => clearTimeout(hideT)); el.addEventListener('pointerleave', arm);
      arm();
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (e) { fail(e.message, assist); }
  }
  stt();
}
