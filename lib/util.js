// Спільне для API: відповіді, читання тіла запиту, cookies, обмеження спроб.
function send(res, code, obj, headers) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise(resolve => {
    let size = 0, dead = false; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { dead = true; req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { if (dead) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// Не більше max спроб за вікно з однієї адреси
function limiter(max, windowMs) {
  const map = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of map) if (!v.some(t => now - t < windowMs)) map.delete(k); }, windowMs).unref();
  return {
    blocked(key) { const now = Date.now(); const l = (map.get(key) || []).filter(t => now - t < windowMs); map.set(key, l); return l.length >= max; },
    note(key) { (map.get(key) || map.set(key, []).get(key)).push(Date.now()); }
  };
}

module.exports = { send, readBody, cookies, clientIp, limiter };
