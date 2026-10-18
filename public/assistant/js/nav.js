// Маршрути застосунку (#/…). Окремий модуль, щоб сторінки могли переходити без циклічних імпортів.
// #/today  #/upcoming  #/all  #/s/<простір>  #/notes  #/state  #/record  #/settings[/розділ]  …/t/<id> — відкрита задача
export function parse() {
  const h = location.hash.replace(/^#\/?/, '');
  if (/tgWebAppData=/.test(h)) return { key: 'today', parts: ['today'], task: null };
  const m = /^(.*?)(?:\/t\/(\d+))?$/.exec(h.split('?')[0]);
  const parts = (m[1] || 'today').split('/').filter(Boolean);
  const key = parts[0] === 's' ? 's/' + (parts[1] || 'inbox') : (parts[0] || 'today');
  return { key, parts, task: m[2] ? +m[2] : null };
}
export const go = h => { location.hash = h; };
export function taskHref(id) { const p = parse(); return '#/' + (p.parts.join('/') || 'today') + '/t/' + id; }
export function pageHref() { const p = parse(); return '#/' + (p.parts.join('/') || 'today'); }
