// Файли-вкладення: збереження завантаження (сирий body запиту) і віддача з безпечними заголовками.
// Імʼя на диску — випадкові 32 hex + розширення; справжня назва — у базі. Віддаються лише через API з перевіркою доступу.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { send } = require('./util');

const MAX = 25 * 1024 * 1024;
// дозволені типи → розширення
const TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/zip': 'zip',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg'
};
const INLINE = /^(image\/(jpeg|png|webp|gif)|application\/pdf|video\/(mp4|webm|quicktime)|audio\/)/;

const cleanName = s => String(s || '').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 120) || 'файл';
const fileName = (dir, fkey, mime) => path.join(dir, fkey + '.' + (TYPES[mime] || 'bin'));

// Зберегти тіло запиту як файл у dir. Повертає { kind, name, mime, size, fkey } або надсилає помилку й повертає null.
function save(req, res, dir) {
  return new Promise(resolve => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!TYPES[mime]) { send(res, 415, { error: 'Такий тип файлу не підтримується. Фото, PDF, документи, таблиці, відео до 25 МБ.' }); return resolve(null); }
    if (+req.headers['content-length'] > MAX) { send(res, 413, { error: 'Файл завеликий — до 25 МБ.' }); return resolve(null); }
    let name = 'файл'; try { name = cleanName(decodeURIComponent(req.headers['x-name'] || '')); } catch (e) {}
    fs.mkdirSync(dir, { recursive: true });
    const fkey = crypto.randomBytes(16).toString('hex'), file = fileName(dir, fkey, mime), tmp = file + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (code, error) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, () => {}); if (!res.headersSent) send(res, code, { error }); resolve(null); };
    req.on('data', c => { size += c.length; if (size > MAX) { fail(413, 'Файл завеликий — до 25 МБ.'); req.destroy(); } });
    req.on('error', () => fail(400, 'Завантаження перервано.'));
    out.on('error', () => fail(500, 'Не вдалося зберегти файл.'));
    out.on('finish', () => {
      if (failed) return;
      if (!size) return fail(400, 'Порожній файл.');
      fs.rename(tmp, file, e => e ? fail(500, 'Не вдалося зберегти файл.') : resolve({ kind: mime.startsWith('image/') ? 'image' : 'file', name, mime, size, fkey }));
    });
    req.pipe(out);
  });
}
// Посилання: лише http(s)
function link(b) {
  let u; try { u = new URL(String(b && b.url || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return { kind: 'link', url: u.href.slice(0, 2000), name: cleanName(b.name || u.hostname) };
}
// Віддати файл: картинки, PDF, відео — у браузері; решта — завантаженням. Sandbox і nosniff — щоб файл не виконав код на сайті.
function serve(req, res, dir, row) {
  const file = fileName(dir, row.fkey, row.mime);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const inline = INLINE.test(row.mime);
    res.writeHead(200, {
      'Content-Type': row.mime, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=86400', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name || 'file')}`
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
const remove = (dir, row) => { if (row && row.fkey) fs.rm(fileName(dir, row.fkey, row.mime), () => {}); };
const view = (row, base) => ({ id: row.id, kind: row.kind, name: row.name, size: row.size, mime: row.mime, url: row.kind === 'link' ? row.url : base + row.fkey, created: row.created, by: row.by_account });

module.exports = { save, link, serve, remove, view, MAX };
