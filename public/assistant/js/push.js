// Push-сповіщення на цьому пристрої: реєстрація сервіс-воркера, дозвіл, підписка й відписка.
import { get, post } from './api.js';

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let reg = null;
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (e) { reg = null; }
  if (reg) moveOldSub().catch(() => {});
  return reg;
}
// Застосунок переїхав з /assistant/ у корінь сайту: підписку старого сервіс-воркера переносимо на новий, старий прибираємо
async function moveOldSub() {
  const old = await navigator.serviceWorker.getRegistration('/assistant/');
  if (!old || old.scope === reg.scope) return;
  const sub = await old.pushManager.getSubscription().catch(() => null);
  if (sub && Notification.permission === 'granted') {
    await navigator.serviceWorker.ready;
    const { publicKey } = await get('push/key');
    const fresh = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
    await post('push/subscribe', { subscription: fresh.toJSON() });
    await post('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  await old.unregister();
}
async function registration() { return reg || (reg = await navigator.serviceWorker.ready); }
async function currentSub() { try { return await (await registration()).pushManager.getSubscription(); } catch (e) { return null; } }

// { supported, permission: default|granted|denied, subscribed, needsInstall }
export async function status() {
  if (!supported()) return { supported: false, needsInstall: isIOS() && !standalone(), permission: 'unsupported', subscribed: false };
  return { supported: true, permission: Notification.permission, subscribed: !!(await currentSub()), needsInstall: false };
}

const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };

export async function enable() {
  if (!supported()) throw new Error(isIOS() ? 'На iPhone сповіщення працюють лише після «Поділитися → На початковий екран».' : 'Цей браузер не підтримує сповіщення.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Сповіщення заборонено в налаштуваннях браузера для mdmy.me — дозвольте їх там.' : 'Дозвіл не надано.');
  const r = await registration();
  const { publicKey } = await get('push/key');
  let sub = await r.pushManager.getSubscription();
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
  return post('push/subscribe', { subscription: sub.toJSON() });
}
export async function disable() {
  const sub = await currentSub();
  if (sub) { await post('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
}
export const test = () => post('push/test');
