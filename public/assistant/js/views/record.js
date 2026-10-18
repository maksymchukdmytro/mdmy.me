// Запис голосом: мікрофон → розшифровка (Whisper на сервері) → асистент розкладає задачі, нагадування, нотатки.
// Те саме вміє центральна кнопка внизу: утримати — говорити, відпустити — надіслати (js/hold.js).
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { $, esc, pref, fail, spin } from '../ui.js';
import { recorder, micError, transcribe, history, ask, MAX_SEC } from '../voice.js';

const LANGS = [['uk', 'Українська'], ['ru', 'Русский'], ['auto', 'Авто']];

export function recordPage() {
  let root, rec = null, timer = 0;
  let assist = pref.get('voice-assist', true);
  // «думає…», що лишилось від закритої сторінки, — давно не актуальне
  history.save(history.list().map(x => x.pending && Date.now() - x.at > 120e3 ? { ...x, pending: false } : x));

  function render(el) {
    root = el;
    root.innerHTML = `<div class="page rec-page">
      <div class="page-head"><h1 class="page-title">Запис голосом</h1></div>
      <div class="rec">
        <button type="button" class="rec-btn" aria-label="Почати запис">${icon('mic', 34)}<span class="rec-stop"></span></button>
        <p class="rec-status">Натисніть і говоріть: «завтра о 10 подзвонити постачальнику»</p>
        <div class="rec-opts">
          <div class="seg" role="radiogroup" aria-label="Мова">${LANGS.map(([k, l]) => `<button type="button" role="radio" data-lang="${k}">${l}</button>`).join('')}</div>
          <label class="switch"><input type="checkbox" class="rec-assist"><span>Виконувати як команду</span></label>
        </div>
      </div>
      <form class="ask">${icon('sparkles', 16)}<input placeholder="…або напишіть асистенту" autocomplete="off"><button class="btn primary sm" type="submit" aria-label="Надіслати">${icon('send', 14)}</button></form>
      <div class="hist-h"><h3>Історія</h3><button type="button" class="btn ghost sm" data-clear>Очистити</button></div>
      <div class="hist"></div></div>`;
    $('.rec-assist', root).checked = assist;
    $('.rec-assist', root).addEventListener('change', e => { assist = e.target.checked; pref.set('voice-assist', assist); });
    setLang(pref.get('voice-lang', 'uk'));
    root.addEventListener('click', onClick);
    $('.ask', root).addEventListener('submit', e => {
      e.preventDefault(); const i = $('.ask input', root), text = i.value.trim(); if (!text) return;
      i.value = ''; ask(history.add({ text, typed: true, at: Date.now() })).catch(() => {});
    });
    document.addEventListener('mdmy:voice', drawHistory);
    checkService(); drawHistory();
  }
  function destroy() { document.removeEventListener('mdmy:voice', drawHistory); if (rec) rec.cancel(); clearInterval(timer); }
  function setLang(l) { pref.set('voice-lang', l); root.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.lang === l))); }
  // назва моделі користувачу не потрібна — показуємо лише, якщо розпізнавання не працює
  async function checkService() {
    try { await get('stt/health'); } catch (e) { status('Розпізнавання голосу зараз недоступне — можна писати текстом.', true); }
  }
  const status = (html, err) => { const s = $('.rec-status', root); if (!s) return; s.innerHTML = html; s.classList.toggle('err', !!err); };
  const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const btn = () => $('.rec-btn', root);

  async function start() {
    const b = btn();
    rec = recorder({ onLevel: v => b.style.setProperty('--lv', v.toFixed(2)) });
    try { await rec.start(); } catch (e) { rec = null; return status(micError(e), true); }
    b.classList.add('on'); b.setAttribute('aria-label', 'Зупинити запис');
    status('<span class="dot"></span>Запис 0:00');
    timer = setInterval(() => { const sec = rec.elapsed(); status(`<span class="dot"></span>Запис ${fmt(sec)}`); if (sec >= MAX_SEC) stop(); }, 250);
  }
  async function stop() {
    clearInterval(timer);
    const r = rec; rec = null;
    const b = btn(); b.classList.remove('on'); b.style.setProperty('--lv', 0); b.setAttribute('aria-label', 'Почати запис');
    const blob = await r.stop();
    b.disabled = true; status(spin() + 'Розшифровую…');
    try {
      const t = await transcribe(blob);
      const item = history.add({ text: t.text, duration: t.duration, at: Date.now() });
      status('Готово. Можна записувати ще.');
      if (t.text && assist) ask(item).catch(() => {});
    } catch (e) { status(esc(e.message), true); }
    finally { b.disabled = false; }
  }
  function drawHistory() {
    const box = root && $('.hist', root); if (!box) return;
    const list = history.list();
    $('[data-clear]', root).hidden = !list.length;
    if (!list.length) { box.innerHTML = '<p class="muted small center">Тут зʼявлятимуться розшифровки й відповіді асистента.</p>'; return; }
    box.innerHTML = list.map((it, i) => {
      const when = new Date(it.at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const a = it.pending ? `<div class="reply">${spin()}Асистент думає…</div>` : it.assist ? (it.assist.error ? `<div class="reply err">${esc(it.assist.error)}</div>`
        : `<div class="reply">${esc([it.assist.reply, ...(it.assist.done || [])].filter(Boolean).join('\n') || 'Записав')}${it.assist.undoable && !it.assist.undone ? `<button type="button" class="btn sm" data-undo="${i}">${icon('undo', 13)}Скасувати</button>` : ''}</div>`) : '';
      return `<article class="hitem"><p>${esc(it.text || '(нічого не розпізнано)')}</p>${a}
        <footer><span>${when}${it.typed ? ' · набрано' : it.duration ? ` · ${it.duration} с` : ''}</span><button type="button" class="icon-btn xs" data-copy="${i}" title="Копіювати">${icon('copy', 14)}</button></footer></article>`;
    }).join('');
  }
  async function onClick(e) {
    if (e.target.closest('.rec-btn')) return rec ? stop() : start();
    const l = e.target.closest('[data-lang]'); if (l) return setLang(l.dataset.lang);
    const list = history.list();
    const c = e.target.closest('[data-copy]'); if (c) return navigator.clipboard.writeText(list[+c.dataset.copy].text).catch(() => {});
    const u = e.target.closest('[data-undo]');
    if (u) {
      const it = list[+u.dataset.undo];
      try {
        const r = await post('assistant/undo', { msgId: it.assist.msgId });
        history.update(it.at, { assist: { ...it.assist, undone: true, done: [...(it.assist.done || []), 'Скасовано' + (r.undone.length ? ': ' + r.undone.join('; ') : '')] } });
        document.dispatchEvent(new CustomEvent('mdmy:changed'));
      } catch (err) { fail(err); }
    }
    if (e.target.closest('[data-clear]')) history.save([]);
  }
  return { render, destroy };
}
