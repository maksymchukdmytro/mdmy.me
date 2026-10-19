// Розшифровка голосу для сторінки /assistant (лише після входу, перевірка — в lib/auth.js).
// Аудіо з браузера пересилається локальному сервісу Whisper (services/stt, служба dm-stt, 127.0.0.1:8010).
// Записи й тексти ніде не зберігаються й не пишуться в журнали.
const http = require('http');
const { send } = require('./util');
const usage = require('./usage');

const STT_URL = new URL(process.env.STT_URL || 'http://127.0.0.1:8010');
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20 * 60e3; // велика модель на CPU: до ~1× тривалості запису
const LANGS = new Set(['uk', 'ru', 'en', 'auto']);   // ?lang= зі сторінки; без нього — мова служби (uk)

function readRaw(req, limit) {
  return new Promise(resolve => {
    let size = 0, dead = false; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { dead = true; req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { if (!dead) resolve(Buffer.concat(chunks)); });
    req.on('error', () => resolve(null));
  });
}

function callStt(method, pathname, body) {
  return new Promise(resolve => {
    const r = http.request({ hostname: STT_URL.hostname, port: STT_URL.port, path: pathname, method,
      headers: body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {} }, resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        let data = null; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        resolve({ status: resp.statusCode, data });
      });
    });
    r.setTimeout(TIMEOUT_MS, () => r.destroy(new Error('timeout')));
    r.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    if (body) r.write(body);
    r.end();
  });
}

// Для інших модулів (Telegram-бот): аудіо → текст. Кидає Error з людським повідомленням.
// ws — чия база (для лічильника хвилин в адмінці)
async function transcribe(audio, lang, ws) {
  if (lang && !LANGS.has(lang)) lang = '';
  const r = await callStt('POST', '/transcribe' + (lang ? '?lang=' + lang : ''), audio);
  if (r.status === 200 && r.data) { usage.note(ws, 'stt', 1, r.data.duration || 0); return r.data; }
  if (r.status === 0) throw new Error(r.error === 'timeout' ? 'Розшифровка триває задовго.' : 'Сервіс розшифровки зараз недоступний.');
  throw new Error(r.data && typeof r.data.detail === 'string' ? r.data.detail : 'Не вдалося розшифрувати запис.');
}

module.exports = function makeStt() {
  async function handle(req, res, url, ws) {
    if (url === '/api/stt/health' && req.method === 'GET') {
      const r = await callStt('GET', '/health');
      return r.status === 200 ? send(res, 200, r.data) : send(res, 503, { error: 'Сервіс розшифровки не запущено.' });
    }
    if (url === '/api/stt/transcribe' && req.method === 'POST') {
      if (+req.headers['content-length'] > MAX_BYTES) return send(res, 413, { error: 'Запис завеликий.' });
      const audio = await readRaw(req, MAX_BYTES);
      if (!audio) return send(res, 413, { error: 'Запис завеликий.' });
      if (audio.length < 500) return send(res, 400, { error: 'Запис надто короткий.' });
      const lang = new URL(req.url, 'http://x').searchParams.get('lang') || '';
      if (lang && !LANGS.has(lang)) return send(res, 400, { error: 'Невідома мова.' });
      const r = await callStt('POST', '/transcribe' + (lang ? '?lang=' + lang : ''), audio);
      if (r.status === 200 && r.data) { usage.note(ws, 'stt', 1, r.data.duration || 0); return send(res, 200, r.data); }
      if (r.status === 0) {
        if (r.error === 'timeout') return send(res, 504, { error: 'Розшифровка триває задовго. Спробуйте коротший запис.' });
        return send(res, 503, { error: 'Сервіс розшифровки зараз недоступний (можливо, ще встановлюється).' });
      }
      const msg = r.data && typeof r.data.detail === 'string' ? r.data.detail : 'Не вдалося розшифрувати запис.';
      return send(res, r.status >= 400 && r.status < 500 ? r.status : 502, { error: msg });
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }
  return { handle };
};

module.exports.transcribe = transcribe;
// для адмінки: { ok, model, language } або false
module.exports.health = async () => { const r = await callStt('GET', '/health'); return r.status === 200 && r.data ? r.data : false; };
