// Сервіс-воркер mdmy: push-сповіщення (нагадування, ритуали дня, ранковий план, підсумок дня) і кнопки в них.
// Нічого не кешує — інтерфейс завжди свіжий із сервера.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'mdmy', body: e.data ? e.data.text() : '' }; }
  const opts = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: d.kind === 'reminder' || d.kind === 'routine',      // висить, доки не відреагуєш
    image: d.image || undefined,                    // ритуал: фото вправи великим планом (Android)
    icon: '/assistant/icon-192.png',
    badge: '/assistant/badge-96.png',
    vibrate: d.kind === 'reminder' ? [200, 100, 200, 100, 400] : d.kind === 'routine' ? [120, 80, 120] : [120],
    timestamp: Date.now(),
    actions: (d.actions || []).slice(0, 2),
    data: { url: d.url || '/assistant/#/today', token: d.token || null, id: d.id || null }
  };
  e.waitUntil(self.registration.showNotification(d.title || 'mdmy', opts));
});

self.addEventListener('notificationclick', e => {
  const n = e.notification, data = n.data || {};
  n.close();
  if (e.action && data.token) {
    // «Готово» / «+1 год» — без відкриття застосунку
    e.waitUntil(fetch('/api/push/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: data.token, action: e.action }) })
      .then(r => r.json()).then(r => self.registration.showNotification('mdmy', { body: r.text || r.error || 'Готово', tag: 'ack', silent: true, icon: '/assistant/icon-192.png', badge: '/assistant/badge-96.png' }))
      .then(() => new Promise(res => setTimeout(res, 2500))).then(() => self.registration.getNotifications({ tag: 'ack' })).then(list => list.forEach(x => x.close()))
      .catch(() => {}));
    return;
  }
  const url = new URL(data.url || '/assistant/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.includes('/assistant/'));
    if (w) { w.navigate(url).catch(() => {}); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
