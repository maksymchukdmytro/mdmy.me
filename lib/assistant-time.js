// Час у часовому поясі власника для помічника (без сторонніх бібліотек) і повтори нагадувань.
const WD = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'];
const WD_SHORT = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const pad = n => String(n).padStart(2, '0');

function parts(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second,
           wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const tzOffset = (ms, tz) => { const p = parts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };

// '2026-10-12T09:00' (місцевий час) → мс UTC з урахуванням переходу на літній/зимовий час
function localToUtc(s, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz);
  return Number.isFinite(ms) ? ms : null;
}
const dayKey = (ms, tz) => { const p = parts(ms, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const localIso = (ms, tz) => { const p = parts(ms, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; };
const hhmm = (ms, tz) => localIso(ms, tz).slice(11);
const dayStart = (ms, tz) => localToUtc(`${dayKey(ms, tz)}T00:00`, tz);
function addDays(key, n) {   // 'YYYY-MM-DD' + n днів (календарно, без часових поясів)
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const isoWeekday = key => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; };   // пн=1 … нд=7

function fmtWhen(ms, tz, now = Date.now()) {
  const p = parts(ms, tz), t = `${pad(p.h)}:${pad(p.mi)}`, d = dayKey(ms, tz);
  if (d === dayKey(now, tz)) return `сьогодні ${t}`;
  if (d === addDays(dayKey(now, tz), 1)) return `завтра ${t}`;
  if (d === addDays(dayKey(now, tz), -1)) return `вчора ${t}`;
  return `${WD_SHORT[p.wd]} ${pad(p.d)}.${pad(p.mo)} ${t}`;
}
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } };

// ---------- повтори ----------
// repeat: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval: 1.., days: [1..7] (для weekly, пн=1), dom: день місяця (для monthly) }
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
function cleanRepeat(r, firstDueMs, tz) {
  if (!r || typeof r !== 'object' || !FREQS.includes(r.freq)) return null;
  const out = { freq: r.freq, interval: Math.max(1, Math.min(365, Math.round(+r.interval || 1))) };
  if (r.freq === 'weekly' && Array.isArray(r.days)) {
    const days = [...new Set(r.days.map(Number).filter(d => d >= 1 && d <= 7))].sort();
    if (days.length) out.days = days;
  }
  if (r.freq === 'monthly') out.dom = firstDueMs ? parts(firstDueMs, tz).d : Math.min(31, Math.max(1, +r.dom || 1));
  return out;
}
// Наступне спрацювання після dueMs, але обовʼязково пізніше за now (пропущені повтори не надсилаємо пачкою)
function nextOccurrence(dueMs, rep, tz, now = Date.now()) {
  const time = hhmm(dueMs, tz);
  let key = dayKey(dueMs, tz);
  const n = rep.interval || 1;
  for (let guard = 0; guard < 2000; guard++) {
    if (rep.freq === 'daily') key = addDays(key, n);
    else if (rep.freq === 'weekly') {
      if (rep.days && rep.days.length) { do key = addDays(key, 1); while (!rep.days.includes(isoWeekday(key))); }
      else key = addDays(key, 7 * n);
    } else if (rep.freq === 'monthly') {
      let [y, m] = key.split('-').map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      key = `${y}-${pad(m)}-${pad(Math.min(rep.dom || 1, dim))}`;
    } else if (rep.freq === 'yearly') {
      const [y, m, d] = key.split('-').map(Number), dim = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
      key = `${y + n}-${pad(m)}-${pad(Math.min(d, dim))}`;
    } else return null;
    const ms = localToUtc(`${key}T${time}`, tz);
    if (ms > now) return ms;
  }
  return null;
}
function describeRepeat(rep) {
  if (!rep) return '';
  const n = rep.interval || 1;
  if (rep.freq === 'daily') return n === 1 ? 'щодня' : `кожні ${n} дн.`;
  if (rep.freq === 'weekly') {
    if (rep.days && rep.days.length) return rep.days.length === 7 ? 'щодня' : 'щотижня: ' + rep.days.map(d => WD_SHORT[d % 7]).join(', ');
    return n === 1 ? 'щотижня' : `кожні ${n} тиж.`;
  }
  if (rep.freq === 'monthly') return n === 1 ? `щомісяця ${rep.dom || ''}-го`.replace(' -го', '') : `кожні ${n} міс.`;
  if (rep.freq === 'yearly') return 'щороку';
  return '';
}

module.exports = { WD, WD_SHORT, pad, parts, localToUtc, dayKey, localIso, hhmm, dayStart, addDays, isoWeekday, fmtWhen, validTz,
                   cleanRepeat, nextOccurrence, describeRepeat };
