// Центральна кнопка внизу (телефон): коротке натискання — сторінка «Запис голосом»,
// утримання — одразу запис; відпустити — надіслати асистенту, відвести палець убік чи вгору — скасувати.
import { icon } from './icons.js';
import { toast, pref } from './ui.js';
import { go } from './nav.js';
import { recorder, micError, transcribe, history, ask, MAX_SEC } from './voice.js';
import { post } from './api.js';

const HOLD_MS = 250, CANCEL_PX = 70;

export function holdToTalk(btn) {
  let skipClick = false;
  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('click', e => { e.preventDefault(); if (skipClick) { skipClick = false; return; } go('#/record'); });
  btn.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    const sx = e.clientX, sy = e.clientY;
    let s = null, timer = setTimeout(() => { timer = 0; skipClick = true; s = session(btn); }, HOLD_MS);
    try { btn.setPointerCapture(e.pointerId); } catch (err) {}
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (s) s.away(Math.abs(dx) > CANCEL_PX || dy < -CANCEL_PX * 1.6);
      else if (timer && Math.hypot(dx, dy) > 12) { clearTimeout(timer); timer = 0; skipClick = true; }
    };
    const up = ev => {
      btn.removeEventListener('pointermove', move); btn.removeEventListener('pointerup', up); btn.removeEventListener('pointercancel', up);
      if (timer) { clearTimeout(timer); return; }       // коротке натискання → click
      if (s) s.release(ev.type === 'pointercancel');
      setTimeout(() => { skipClick = false; }, 400);
    };
    btn.addEventListener('pointermove', move); btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
  });
}

function session(btn) {
  let away = false, released = false, tick = 0;
  const box = document.createElement('div'); box.className = 'ptt'; box.setAttribute('role', 'status');
  box.innerHTML = `<div class="ptt-dot">${icon('mic', 30)}</div><b class="ptt-t">Підключаю мікрофон…</b><span class="ptt-h">Відпустіть — надіслати · убік — скасувати</span>`;
  document.body.append(box); btn.classList.add('rec');
  const old = document.getElementById('toast'); if (old) old.hidden = true;   // попередня відповідь не накриває запис
  const t = box.querySelector('.ptt-t'), h = box.querySelector('.ptt-h');
  const rec = recorder({ onLevel: v => box.style.setProperty('--lv', v.toFixed(2)) });
  const close = () => { clearInterval(tick); btn.classList.remove('rec'); box.classList.add('out'); setTimeout(() => box.remove(), 160); };

  rec.start().then(ok => {
    if (!ok) return;
    if (released) {                       // палець відпустили, поки браузер питав дозвіл
      rec.cancel(); close(); toast('Мікрофон готовий — утримуйте кнопку, поки говорите'); return;
    }
    if (navigator.vibrate) navigator.vibrate(20);
    box.classList.add('live');
    tick = setInterval(() => {
      const sec = rec.elapsed();
      t.textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
      if (sec >= MAX_SEC) finish();
    }, 200);
    t.textContent = '0:00';
  }).catch(e => { close(); toast(micError(e)); });

  async function finish() {
    if (!rec.active()) return;
    clearInterval(tick);
    const short = rec.elapsed() < 0.7;
    const blob = await rec.stop(); close();
    if (short) return toast('Утримуйте кнопку, поки говорите');
    send(blob);
  }
  return {
    away(v) { if (v === away) return; away = v; box.classList.toggle('cancel', v); h.textContent = v ? 'Відпустіть — скасувати' : 'Відпустіть — надіслати · убік — скасувати'; },
    release(cancelled) {
      released = true;
      if (!rec.active()) { if (cancelled || away) { rec.cancel(); close(); } return; }   // ще чекаємо дозволу — рішення після start()
      if (cancelled || away) { rec.cancel(); close(); toast('Запис скасовано'); return; }
      finish();
    }
  };
}

async function send(blob) {
  toast('Розшифровую…', null, 60000);
  let item;
  try {
    const r = await transcribe(blob);
    if (!r.text) return toast('Нічого не розпізнано — спробуйте ще раз');
    item = history.add({ text: r.text, duration: r.duration, at: Date.now() });
  } catch (e) { return toast(e.message); }
  if (!pref.get('voice-assist', true)) return toast('«' + item.text + '»');
  toast('«' + item.text.slice(0, 120) + '»\nАсистент думає…', null, 60000);
  try {
    const a = await ask(item);
    toast([a.reply, ...(a.done || [])].filter(Boolean).join('\n') || 'Записав',
      a.undoable ? async () => { await post('assistant/undo', { msgId: a.msgId }); history.update(item.at, { assist: { ...a, undone: true } }); document.dispatchEvent(new CustomEvent('mdmy:changed')); } : null, 6000);
  } catch (e) { toast(e.message); }
}
