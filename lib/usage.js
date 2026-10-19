// Знеособлена статистика для адмінки: лічильники за день (usage_daily) і хто заходив (activity).
// Жодного змісту — лише кількості. Модулі викликають usage.note(ws, kind, n, a, b) де завгодно;
// server.js підключає базу й часовий пояс сервісу через usage.init(db, tz).
const T = require('./assistant-time');

let db = null, tzOf = () => 'Europe/Kyiv', put = null, seenPut = null;
const seenToday = new Set();
let seenDay = '';

function init(mainDb, tz) {
  db = mainDb; if (tz) tzOf = tz;
  put = db.prepare(`INSERT INTO usage_daily (day, ws, kind, n, a, b) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(day, ws, kind) DO UPDATE SET n = n + excluded.n, a = a + excluded.a, b = b + excluded.b`);
  seenPut = db.prepare(`INSERT INTO activity (day, account_id) VALUES (?, ?) ON CONFLICT(day, account_id) DO UPDATE SET n = n + 1`);
}
const today = () => T.dayKey(Date.now(), tzOf());

// ws — 'main' (основна база) або 'u5'; kind — ai:<модель> | stt | remind_ok | remind_fail | upload
function note(ws, kind, n = 1, a = 0, b = 0) {
  if (!put) return;
  try { put.run(today(), ws || 'main', String(kind).slice(0, 60), Math.round(n) || 0, Math.round(a) || 0, Math.round(b) || 0); }
  catch (e) { console.error('[usage]', e.message); }
}
// людина щось робила сьогодні (рахуємо раз на день на процес, щоб не писати в базу на кожен запит)
function seen(accountId) {
  if (!seenPut || !accountId) return;
  const d = today();
  if (d !== seenDay) { seenDay = d; seenToday.clear(); }
  if (seenToday.has(accountId)) return;
  seenToday.add(accountId);
  try { seenPut.run(d, accountId); } catch (e) {}
}

module.exports = { init, note, seen, today, tz: () => tzOf() };
