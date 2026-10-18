// Спільний запис голосу: сторінка «Запис голосом» і утримання центральної кнопки внизу.
// Мікрофон → розшифровка (Whisper на сервері) → асистент. Історія розшифровок — лише в цьому браузері.
import { api, post } from './api.js';
import { pref } from './ui.js';

export const MAX_SEC = 600;
const MAX_BYTES = 2.8 * 1024 * 1024;
export const supported = () => !!(navigator.mediaDevices && window.MediaRecorder);

// Один запис. onLevel(0…1) — гучність для анімації.
export function recorder({ onLevel } = {}) {
  let stream = null, rec = null, chunks = [], ctx = null, raf = 0, startedAt = 0, cancelled = false;
  const release = () => {
    cancelAnimationFrame(raf);
    if (ctx) ctx.close().catch(() => {}); ctx = null;
    if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  };
  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (cancelled) { release(); return false; }
    chunks = [];
    try { rec = new MediaRecorder(stream, { audioBitsPerSecond: 32000 }); } catch (e) { rec = new MediaRecorder(stream); }
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.start(1000); startedAt = Date.now();
    if (onLevel) try {
      ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2;
        onLevel(Math.min(1, Math.sqrt(s / buf.length) * 4)); raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {}
    return true;
  }
  // Завершити й отримати аудіо (Blob) або null
  function stop() {
    return new Promise(res => {
      if (!rec || rec.state !== 'recording') { release(); return res(null); }
      rec.onstop = () => { release(); res(new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] })); };
      rec.stop();
    });
  }
  function cancel() {
    cancelled = true;
    if (rec && rec.state === 'recording') { rec.onstop = null; rec.stop(); }
    release();
  }
  return { start, stop, cancel, elapsed: () => startedAt ? (Date.now() - startedAt) / 1000 : 0, active: () => !!rec && rec.state === 'recording' };
}

export function micError(e) {
  if (!supported()) return 'Цей браузер не вміє записувати звук.';
  return e && e.name === 'NotAllowedError' ? 'Немає доступу до мікрофона. Дозвольте його в налаштуваннях браузера.' : 'Мікрофон недоступний.';
}

export async function transcribe(blob) {
  if (!blob || blob.size < 1000) throw new Error('Запис надто короткий.');
  if (blob.size > MAX_BYTES) throw new Error('Запис завеликий. До 10 хвилин за раз.');
  return api('stt/transcribe?lang=' + pref.get('voice-lang', 'uk'), { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
}

// ---------- історія (спільна для сторінки й кнопки) ----------
export const history = {
  list: () => pref.get('voice-history', []),
  save(list) { pref.set('voice-history', list.slice(0, 50)); document.dispatchEvent(new CustomEvent('mdmy:voice')); },
  add(it) { const l = history.list(); l.unshift(it); history.save(l); return it; },
  update(at, patch) { const l = history.list(), it = l.find(x => x.at === at); if (it) { Object.assign(it, patch); history.save(l); } }
};

// Текст → асистент; результат записується в історію
export async function ask(it) {
  history.update(it.at, { pending: true });
  try {
    const r = await post('assistant/message', { text: it.text });
    const assist = { reply: r.reply, done: r.done, msgId: r.msgId, undoable: r.undoable };
    history.update(it.at, { pending: false, assist });
    document.dispatchEvent(new CustomEvent('mdmy:changed'));
    return assist;
  } catch (e) {
    history.update(it.at, { pending: false, assist: { error: e.message } });
    throw e;
  }
}
