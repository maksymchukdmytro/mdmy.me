// Звернення до API mdmy.me. У браузері — cookie-сесія + заголовок X-MDMY;
// у Telegram Web App (там cookie можуть не жити в iframe) — токен Bearer у sessionStorage.
let token = null;
try { token = sessionStorage.getItem('mdmy-token'); } catch (e) {}
const listeners = new Set();
export const onUnauthorized = f => listeners.add(f);

export async function api(path, opts = {}) {
  const headers = { 'X-MDMY': '1', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  let r;
  try { r = await fetch('/api/' + path, { method: opts.method || (body ? 'POST' : 'GET'), credentials: 'same-origin', headers, body }); }
  catch (e) { throw new Error('Немає звʼязку з сервером.'); }
  let data = null; try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && !/^(login|auth\/)/.test(path)) { listeners.forEach(f => f()); throw Object.assign(new Error('Потрібно увійти.'), { status: 401 }); }
  if (r.status === 413) throw new Error('Запис завеликий. Спробуйте коротший.');
  if (!r.ok) throw Object.assign(new Error((data && data.error) || `Помилка ${r.status}`), { status: r.status, data });
  return data;
}
export const get = path => api(path);
export const post = (path, json) => api(path, { method: 'POST', json: json || {} });
export const patch = (path, json) => api(path, { method: 'PATCH', json });
export const del = path => api(path, { method: 'DELETE' });

// Telegram Web App: initData приходить у фрагменті адреси (#tgWebAppData=…)
export function telegramInitData() {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    const d = h.get('tgWebAppData');
    if (d) { sessionStorage.setItem('mdmy-tg', d); return d; }
    return sessionStorage.getItem('mdmy-tg');
  } catch (e) { return null; }
}
export async function telegramLogin() {
  const initData = telegramInitData(); if (!initData) return false;
  try {
    const r = await post('auth/telegram', { initData });
    token = r.token; try { sessionStorage.setItem('mdmy-token', token); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
export function clearToken() { token = null; try { sessionStorage.removeItem('mdmy-token'); } catch (e) {} }
