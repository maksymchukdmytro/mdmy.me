// Запис голосом: мікрофон → розшифровка (Whisper на сервері) → асистент розкладає задачі, нагадування, нотатки.
// Історія розшифровок зберігається лише в цьому браузері.
import { get, post, api } from '../api.js';
import { icon } from '../icons.js';
import { $, esc, pref, fail, spin } from '../ui.js';

const MAX_SEC = 600, MAX_BYTES = 2.8 * 1024 * 1024;
const LANGS = [['uk', 'Українська'], ['ru', 'Русский'], ['auto', 'Авто']];
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

export function recordPage() {
  let root, recorder = null, stream = null, chunks = [], startedAt = 0, timer = 0, audioCtx = null, raf = 0;
  let history = pref.get('voice-history', []).map(x => ({ ...x, pending: false }));
  let lang = pref.get('voice-lang', 'uk'), assist = pref.get('voice-assist', true);
  const save = () => pref.set('voice-history', history.slice(0, 50));

  function render(el) {
    root = el;
    root.innerHTML = `<div class="page rec-page">
      <div class="page-head"><div class="page-icon">${icon('mic', 30)}</div><h1 class="page-title">Запис голосом</h1>
        <p class="page-desc">Говоріть як є: «нагадай завтра о 10 подзвонити постачальнику», «по роботі: підготувати звіт до пʼятниці», «настрій 7, спав 6 годин». Асистент сам розкладе.</p></div>
      <div class="rec">
        <button type="button" class="rec-btn" aria-label="Почати запис">${icon('mic', 34)}<span class="rec-stop"></span></button>
        <p class="rec-status">Натисніть і говоріть, ще раз — щоб завершити</p>
        <div class="seg" role="radiogroup" aria-label="Мова">${LANGS.map(([k, l]) => `<button type="button" role="radio" data-lang="${k}">${l}</button>`).join('')}</div>
        <label class="switch"><input type="checkbox" class="rec-assist"><span>Виконувати як команду</span></label>
        <span class="svc muted small"></span>
      </div>
      <form class="ask">${icon('sparkles', 16)}<input placeholder="…або напишіть асистенту" autocomplete="off"><button class="btn primary sm" type="submit">${icon('send', 14)}</button></form>
      <div class="hist-h"><h3>Історія</h3><button type="button" class="btn ghost sm" data-clear>Очистити</button></div>
      <div class="hist"></div></div>`;
    $('.rec-assist', root).checked = assist;
    $('.rec-assist', root).addEventListener('change', e => { assist = e.target.checked; pref.set('voice-assist', assist); });
    setLang(lang);
    root.addEventListener('click', onClick);
    $('.ask', root).addEventListener('submit', e => {
      e.preventDefault(); const i = $('.ask input', root), text = i.value.trim(); if (!text) return;
      i.value = ''; runAssist(addHistory({ text, typed: true, at: Date.now() }));
    });
    checkService(); drawHistory();
  }
  function setLang(l) { lang = l; pref.set('voice-lang', l); root.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.lang === l))); }
  async function checkService() {
    const s = $('.svc', root);
    try { const h = await get('stt/health'); s.textContent = 'Розпізнавання: Whisper ' + ({ 'large-v3-turbo': 'Turbo' }[h.model] || h.model); }
    catch (e) { s.textContent = 'Розпізнавання голосу зараз недоступне — можна писати текстом'; }
  }
  const status = (html, err) => { const s = $('.rec-status', root); s.innerHTML = html; s.classList.toggle('err', !!err); };
  const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  async function start() {
    const btn = $('.rec-btn', root);
    if (!navigator.mediaDevices || !window.MediaRecorder) return status('Цей браузер не вміє записувати звук.', true);
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return status('Немає доступу до мікрофона. Дозвольте його в налаштуваннях браузера.', true); }
    chunks = [];
    try { recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 }); } catch (e) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = upload;
    recorder.start(1000);
    try {
      audioCtx = new AudioContext(); const an = audioCtx.createAnalyser(); an.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.fftSize);
      const tick = () => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2;
        btn.style.setProperty('--lv', Math.min(1, Math.sqrt(s / buf.length) * 4).toFixed(2)); raf = requestAnimationFrame(tick); };
      tick();
    } catch (e) {}
    startedAt = Date.now(); btn.classList.add('on'); btn.setAttribute('aria-label', 'Зупинити запис');
    status('<span class="dot"></span>Запис 0:00');
    timer = setInterval(() => { const sec = (Date.now() - startedAt) / 1000; status(`<span class="dot"></span>Запис ${fmt(sec)}`); if (sec >= MAX_SEC) stop(); }, 250);
  }
  function stop() {
    clearInterval(timer); cancelAnimationFrame(raf);
    if (audioCtx) audioCtx.close().catch(() => {}); audioCtx = null;
    if (recorder && recorder.state === 'recording') recorder.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
    const btn = root && $('.rec-btn', root); if (btn) { btn.classList.remove('on'); btn.style.setProperty('--lv', 0); btn.setAttribute('aria-label', 'Почати запис'); }
  }
  async function upload() {
    const type = (recorder.mimeType || 'audio/webm').split(';')[0], blob = new Blob(chunks, { type });
    if (blob.size < 1000) return status('Запис надто короткий.', true);
    if (blob.size > MAX_BYTES) return status('Запис завеликий. До 10 хвилин за раз.', true);
    const btn = $('.rec-btn', root); btn.disabled = true; status(spin() + 'Розшифровую…');
    try {
      const r = await api('stt/transcribe?lang=' + lang, { method: 'POST', body: blob, headers: { 'Content-Type': type } });
      const item = addHistory({ text: r.text, duration: r.duration, elapsed: r.elapsed, at: Date.now() });
      status('Готово. Можна записувати ще.');
      if (r.text && assist) runAssist(item);
    } catch (e) { status(esc(e.message), true); }
    finally { btn.disabled = false; }
  }
  function addHistory(it) { history.unshift(it); save(); drawHistory(); return it; }
  async function runAssist(it) {
    it.pending = true; drawHistory();
    try { const r = await post('assistant/message', { text: it.text }); it.assist = { reply: r.reply, done: r.done, msgId: r.msgId, undoable: r.undoable }; changed(); }
    catch (e) { it.assist = { error: e.message }; }
    it.pending = false; save(); drawHistory();
  }
  function drawHistory() {
    const box = root && $('.hist', root); if (!box) return;
    $('[data-clear]', root).hidden = !history.length;
    if (!history.length) { box.innerHTML = '<p class="muted small center">Тут зʼявлятимуться розшифровки й відповіді асистента.</p>'; return; }
    box.innerHTML = history.map((it, i) => {
      const when = new Date(it.at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const a = it.pending ? `<div class="reply">${spin()}Асистент думає…</div>` : it.assist ? (it.assist.error ? `<div class="reply err">${esc(it.assist.error)}</div>`
        : `<div class="reply">${esc([it.assist.reply, ...(it.assist.done || [])].filter(Boolean).join('\n') || 'Записав')}${it.assist.undoable && !it.assist.undone ? `<button type="button" class="btn sm" data-undo="${i}">${icon('undo', 13)}Скасувати</button>` : ''}</div>`) : '';
      return `<article class="hitem"><p>${esc(it.text || '(нічого не розпізнано)')}</p>${a}
        <footer><span>${when}${it.typed ? ' · набрано' : it.duration ? ` · ${it.duration} с` : ''}</span><button type="button" class="icon-btn xs" data-copy="${i}" title="Копіювати">${icon('copy', 14)}</button></footer></article>`;
    }).join('');
  }
  async function onClick(e) {
    if (e.target.closest('.rec-btn')) return (recorder && recorder.state === 'recording') ? stop() : start();
    const l = e.target.closest('[data-lang]'); if (l) return setLang(l.dataset.lang);
    const c = e.target.closest('[data-copy]'); if (c) return navigator.clipboard.writeText(history[+c.dataset.copy].text).catch(() => {});
    const u = e.target.closest('[data-undo]');
    if (u) { const it = history[+u.dataset.undo]; try { const r = await post('assistant/undo', { msgId: it.assist.msgId }); it.assist.undone = true; it.assist.done = [...(it.assist.done || []), 'Скасовано' + (r.undone.length ? ': ' + r.undone.join('; ') : '')]; save(); drawHistory(); changed(); } catch (err) { fail(err); } }
    if (e.target.closest('[data-clear]')) { history = []; save(); drawHistory(); }
  }
  return { render, destroy: stop };
}
