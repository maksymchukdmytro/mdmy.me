// Загальний стан застосунку: довідники (простори, статуси, теги) і лічильники для бічної панелі.
import { get } from './api.js';
import { icon } from './icons.js';

export const meta = { spaces: [], statuses: [], tags: [], counts: { spaces: {}, today: 0, inbox: 0, all: 0 }, icons: [] };
const subs = new Set();
export const onMeta = f => { subs.add(f); return () => subs.delete(f); };

let pending = null;
export async function refreshMeta() {
  if (pending) return pending;
  // лічильник «Доручень»: мені зробити + мені перевірити (доручення й відмітки челенджів)
  pending = Promise.all([get('assistant/meta'), get('team').catch(() => null)]).then(([d, t]) => {
    Object.assign(meta, d); meta.teamN = t ? t.counts.todo + t.counts.review + t.counts.checks : 0;
    subs.forEach(f => f(meta)); return meta;
  }).finally(() => { pending = null; });
  return pending;
}
export const space = key => meta.spaces.find(s => s.key === key) || { key, name: key, icon: 'folder' };
export const status = key => meta.statuses.find(s => s.key === key) || { key, name: key };
export const openSpaces = () => meta.spaces.filter(s => !s.archived);
// колір простору (палітра в app.css: --c-blue …) і значок у цьому кольорі
export const COLORS = [['gray', 'Сірий'], ['blue', 'Синій'], ['green', 'Зелений'], ['orange', 'Помаранчевий'], ['purple', 'Фіолетовий'], ['pink', 'Рожевий'], ['teal', 'Бірюзовий'], ['amber', 'Гірчичний']];
export const spIcon = (key, size = 16) => { const sp = typeof key === 'string' ? space(key) : key; return `<span class="spi sc-${sp.color || 'gray'}">${icon(sp.icon, size)}</span>`; };
export const doneStatus = () => (meta.statuses.find(s => s.done) || { key: 'done' }).key;
export const firstStatus = () => (meta.statuses.find(s => !s.done) || { key: 'todo' }).key;
