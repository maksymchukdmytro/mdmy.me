// Ключі шифрування mdmy.
//  • Головний ключ (32 байти hex) — у файлі поза базою й поза резервними копіями: /etc/mdmy/secret.key (створює deploy.sh,
//    root:mdmy 640) або MDMY_KEY_FILE; для розробки — DATA_DIR/.mdmy-key (створюється сам).
//  • З головного ключа виводяться окремі ключі (HMAC-SHA256): для кожної бази ('db:main', 'db:u5'…) і для секретів у налаштуваннях ('secrets').
//  • DATA_DIR/.key-id — відбиток ключа, яким зашифровано бази: якщо ключ підмінили або загубили, сервер не стартує
//    замість того, щоб створити нові бази з іншим ключем.
// Втрата головного ключа = втрата всіх даних: зберігайте його копію окремо від сервера.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let master = null;
const root = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const fp = k => crypto.createHmac('sha256', Buffer.from(k, 'hex')).update('mdmy-key-id').digest('hex').slice(0, 16);
const readKey = f => { try { const v = fs.readFileSync(f, 'utf8').trim(); return /^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : null; } catch (e) { return null; } };

function load() {
  if (master) return master;
  const dir = root(), marker = path.join(dir, '.key-id'), devFile = path.join(dir, '.mdmy-key');
  const files = [process.env.MDMY_KEY_FILE, '/etc/mdmy/secret.key', devFile].filter(Boolean);
  const found = files.map(f => ({ f, k: readKey(f) })).filter(x => x.k);
  let want = null; try { want = fs.readFileSync(marker, 'utf8').trim(); } catch (e) {}
  let pick = want ? found.find(x => fp(x.k) === want) : found[0];
  if (want && !pick) throw new Error(`Не знайдено ключа шифрування, яким зашифровано бази (відбиток ${want}). Поверніть файл /etc/mdmy/secret.key.`);
  if (!pick) {
    fs.mkdirSync(dir, { recursive: true });
    const k = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(devFile, k + '\n', { mode: 0o600 });
    console.warn(`[keys] ключ шифрування створено в ${devFile} — на сервері його має створити deploy.sh у /etc/mdmy/secret.key`);
    pick = { f: devFile, k };
  }
  if (!want) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, fp(pick.k) + '\n'); } catch (e) {} }
  master = pick.k;
  return master;
}
const derive = label => crypto.createHmac('sha256', Buffer.from(load(), 'hex')).update(label).digest();

// Секрети в налаштуваннях (ключ Claude, токен бота, секрет Google, ключ CRM…): AES-256-GCM, формат «enc1:<base64url>».
const PREFIX = 'enc1:';
function seal(text) {
  if (text == null || text === '' || String(text).startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', derive('secrets'), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function unseal(v) {
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return v;            // ще не зашифроване (старі налаштування)
  try {
    const b = Buffer.from(v.slice(PREFIX.length), 'base64url'), d = crypto.createDecipheriv('aes-256-gcm', derive('secrets'), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { console.error('[keys] не вдалося розшифрувати секрет'); return ''; }
}
const isSealed = v => typeof v === 'string' && v.startsWith(PREFIX);
// пароль бази для SQLite3 Multiple Ciphers
// поля-секрети в обʼєкті налаштувань: при збереженні шифруються, при читанні — розшифровуються
const sealFields = (o, fields) => { const r = { ...o }; fields.forEach(f => { if (r[f]) r[f] = seal(r[f]); }); return r; };
const unsealFields = (o, fields) => { const r = { ...o }; fields.forEach(f => { if (r[f]) r[f] = unseal(r[f]); }); return r; };
const hasPlain = (o, fields) => fields.some(f => o && o[f] && !isSealed(o[f]));
const dbPass = label => derive('db:' + label).toString('hex');

module.exports = { load, derive, seal, unseal, isSealed, sealFields, unsealFields, hasPlain, dbPass, fingerprint: () => fp(load()) };
