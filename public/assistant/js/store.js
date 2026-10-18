// Загальний стан застосунку: довідники (простори, статуси, теги) і лічильники для бічної панелі.
import { get } from './api.js';

export const meta = { spaces: [], statuses: [], tags: [], counts: { spaces: {}, today: 0, inbox: 0, all: 0 }, icons: [] };
const subs = new Set();
export const onMeta = f => { subs.add(f); return () => subs.delete(f); };

let pending = null;
export async function refreshMeta() {
  if (pending) return pending;
  pending = get('assistant/meta').then(d => { Object.assign(meta, d); subs.forEach(f => f(meta)); return meta; }).finally(() => { pending = null; });
  return pending;
}
export const space = key => meta.spaces.find(s => s.key === key) || { key, name: key, icon: 'folder' };
export const status = key => meta.statuses.find(s => s.key === key) || { key, name: key };
export const openSpaces = () => meta.spaces.filter(s => !s.archived);
export const doneStatus = () => (meta.statuses.find(s => s.done) || { key: 'done' }).key;
export const firstStatus = () => (meta.statuses.find(s => !s.done) || { key: 'todo' }).key;
