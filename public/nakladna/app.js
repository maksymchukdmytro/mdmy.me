// Сторінка /nakladna: пошук замовлення в LP-CRM → редагування → PDF.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let settings = null;

  async function api(path, opts = {}) {
    const r = await fetch('/api/' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-MDMY': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (r.status === 401 && path !== 'login') { showLogin(); throw new Error('Потрібно увійти.'); }
    if (!r.ok) throw Object.assign(new Error(data.error || 'Помилка ' + r.status), { data });
    return data;
  }

  // ---------- вхід ----------
  function showLogin() { $('appView').hidden = true; $('loginView').hidden = false; $('lgLogin').focus(); }
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault(); $('lgErr').textContent = '';
    try { await api('login', { method: 'POST', body: { login: $('lgLogin').value, password: $('lgPass').value } }); $('lgPass').value = ''; start(); }
    catch (err) { $('lgErr').textContent = err.message; }
  });
  $('btnLogout').addEventListener('click', async () => { try { await api('logout', { method: 'POST' }); } catch (e) {} showLogin(); });

  async function start() {
    try {
      const me = await api('me');
      settings = await api('nakladna/settings');
    } catch (e) { if (!$('appView').hidden) $('findErr').textContent = e.message; return; }
    $('loginView').hidden = true; $('appView').hidden = false;
    refreshBanner();
    $('orderIds').focus();
  }
  function refreshBanner() { $('setupBanner').hidden = !!(settings.domain && settings.hasKey && settings.seller.name); }

  // ---------- налаштування ----------
  const form = $('settingsForm');
  function openSettings() {
    for (const el of form.elements) {
      if (!el.name) continue;
      const [a, b] = el.name.split('.');
      el.value = el.name === 'apiKey' ? '' : (b ? (settings[a] || {})[b] : settings[a]) || '';
    }
    form.elements.apiKey.placeholder = settings.hasKey ? '•••••••• (ключ задано — залиште порожнім)' : 'вставте ключ з LP-CRM';
    $('keyState').textContent = settings.hasKey ? 'Ключ збережено на сервері. Сторінка його не показує.' : 'Ключ ще не задано. Його видно в LP-CRM: Налаштування → Система.';
    if (!form.elements['invoice.accent'].value) form.elements['invoice.accent'].value = '#C1D0E4';
    showLogo();
    $('setErr').textContent = ''; $('setOk').hidden = true;
    $('settings').hidden = false;
  }
  $('btnSettings').addEventListener('click', openSettings);
  $('bannerLink').addEventListener('click', e => { e.preventDefault(); openSettings(); });
  $('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', e => { if (e.target === $('settings')) $('settings').hidden = true; });
  form.addEventListener('submit', async e => {
    e.preventDefault(); $('setErr').textContent = '';
    const body = { seller: {}, invoice: {} };
    for (const el of form.elements) {
      if (!el.name) continue;
      const [a, b] = el.name.split('.');
      if (b) body[a][b] = el.value; else body[a] = el.value;
    }
    try {
      settings = await api('nakladna/settings', { method: 'POST', body });
      form.elements.apiKey.value = '';
      $('setOk').hidden = false; refreshBanner();
      setTimeout(() => { $('settings').hidden = true; }, 600);
    } catch (err) { $('setErr').textContent = err.message; }
  });

  // ---------- логотип ----------
  function showLogo() {
    $('logoImg').hidden = !settings.logo; $('logoEmpty').hidden = !!settings.logo; $('logoDel').hidden = !settings.logo;
    if (settings.logo) $('logoImg').src = settings.logo;
  }
  // будь-яку картинку (і SVG) перетворюємо на PNG до 800 px — так PDF-бібліотека її точно прочитає
  function toPng(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, 800 / Math.max(img.naturalWidth || 800, img.naturalHeight || 800));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.naturalWidth || 800) * k)); c.height = Math.max(1, Math.round((img.naturalHeight || 300) * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не вдалося прочитати картинку.')); };
      img.src = url;
    });
  }
  $('logoFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    $('setErr').textContent = '';
    try { settings = await api('nakladna/logo', { method: 'POST', body: { logo: await toPng(f) } }); showLogo(); }
    catch (err) { $('setErr').textContent = err.message; }
  });
  $('logoDel').addEventListener('click', async () => {
    try { settings = await api('nakladna/logo', { method: 'POST', body: { logo: '' } }); showLogo(); }
    catch (err) { $('setErr').textContent = err.message; }
  });

  // ---------- пошук замовлень ----------
  $('findForm').addEventListener('submit', async e => {
    e.preventDefault();
    const ids = $('orderIds').value.trim(); if (!ids) return;
    const debug = $('debug').checked;
    $('findErr').textContent = ''; $('rawOut').hidden = true; $('findBtn').disabled = true; $('findBtn').textContent = 'Шукаю в CRM…';
    $('orders').innerHTML = '';
    const slow = setTimeout(() => { $('findErr').textContent = ''; $('findHint').hidden = false; }, 2500);
    try {
      const r = await api('nakladna/orders?ids=' + encodeURIComponent(ids) + (debug ? '&debug=1' : ''));
      if (debug) { $('rawOut').textContent = JSON.stringify(r.raw, null, 2); $('rawOut').hidden = false; }
      $('orders').innerHTML = '';
      r.orders.forEach(renderOrder);
      if (r.notFound && r.notFound.length) {
        $('findErr').textContent = `CRM не знайшла: ${r.notFound.join(', ')}. ` +
          'Перевірте номер. Якщо замовлення старше року, введіть його довгий ідентифікатор з картки в CRM.';
      }
    } catch (err) {
      $('findErr').textContent = err.message;
      if (debug && err.data && err.data.raw) { $('rawOut').textContent = JSON.stringify(err.data.raw, null, 2); $('rawOut').hidden = false; }
    } finally { clearTimeout(slow); $('findHint').hidden = true; $('findBtn').disabled = false; $('findBtn').textContent = 'Знайти'; }
  });

  // ---------- картка замовлення ----------
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const parseNum = v => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };

  function renderOrder(src) {
    const node = $('orderTpl').content.firstElementChild.cloneNode(true);
    const o = {
      crmShort: src.short || '', crmId: src.short ? `${src.short} · ID ${src.id}` : src.id, number: (settings.invoice.prefix || '') + (src.short || src.id), date: today(),
      buyer: src.buyer, phone: src.phone, address: src.address, delivery: src.delivery || '', ttn: src.ttn || '',
      items: src.items.map(it => ({ ...it })), crmTotal: src.crmTotal
    };
    node.querySelector('h2').textContent = src.short ? `Замовлення №${src.short}` : `Замовлення ${src.id}`;
    node.querySelectorAll('[data-f]').forEach(inp => {
      inp.value = o[inp.dataset.f] || '';
      inp.addEventListener('input', () => { o[inp.dataset.f] = inp.value; stale(); });
    });
    // вибрану назву доставки запам'ятовуємо для цього способу доставки з CRM — наступного разу підставиться сама
    if (src.deliveryId) node.querySelector('[data-f="delivery"]').addEventListener('change', async e => {
      const name = e.target.value.trim();
      if ((settings.deliveryMap || {})[src.deliveryId] === name) return;
      try { const r = await api('nakladna/delivery', { method: 'POST', body: { id: src.deliveryId, name } }); settings.deliveryMap = r.deliveryMap; } catch (err) {}
    });
    const tbody = node.querySelector('tbody');

    function row(it) {
      const tr = document.createElement('tr');
      const cell = (cls, child) => { const td = document.createElement('td'); if (cls) td.className = cls; td.append(child); tr.append(td); return td; };
      const inp = (val, attrs) => { const i = document.createElement('input'); i.value = val; Object.assign(i, attrs); return i; };
      const name = inp(it.name, { 'aria-label': 'Найменування' });
      const qty = inp(NK.qtyStr(it.qty), { inputMode: 'decimal', className: 'r' }); qty.setAttribute('aria-label', 'Кількість');
      const price = inp(String(it.price).replace('.', ','), { inputMode: 'decimal', className: 'r' }); price.setAttribute('aria-label', 'Ціна');
      const sum = document.createElement('span');
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small danger'; del.textContent = '×'; del.title = 'Видалити рядок';
      cell('nk-name', name); cell('nk-num', qty); cell('nk-num', price); cell('r nk-sum', sum); cell('', del);
      const upd = () => { it.name = name.value; it.qty = parseNum(qty.value); it.price = parseNum(price.value); sum.textContent = NK.money(NK.lineSum(it)); totals(); stale(); };
      [name, qty, price].forEach(i => i.addEventListener('input', upd));
      del.addEventListener('click', () => { o.items.splice(o.items.indexOf(it), 1); tr.remove(); totals(); stale(); });
      sum.textContent = NK.money(NK.lineSum(it));
      tbody.append(tr);
      return name;
    }
    function totals() {
      const t = NK.total(o.items);
      node.querySelector('[data-out="total"]').textContent = NK.money(t) + ' грн';
      const w = node.querySelector('[data-out="warn"]');
      const diff = o.crmTotal && Math.abs(o.crmTotal - t) > 0.009;
      w.hidden = !diff;
      if (diff) w.textContent = `Сума в CRM — ${NK.money(o.crmTotal)} грн, а за товарами — ${NK.money(t)} грн. Можливо, є знижка чи доставка: додайте рядок або перевірте ціни.`;
    }
    o.items.forEach(row);
    if (!o.items.length) { o.items.push({ name: '', qty: 1, price: 0, sku: '' }); row(o.items[0]); }
    totals();

    node.querySelector('[data-act="add"]').addEventListener('click', () => {
      const it = { name: '', qty: 1, price: 0, sku: '' }; o.items.push(it); row(it).focus();
    });

    const prev = node.querySelector('.nk-preview'), frame = prev.querySelector('iframe');
    let blobUrl = null;
    function stale() { if (!prev.hidden) preview(); }
    let timer = null;
    function preview() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        pdfMake.createPdf(NK.docDefinition(o, settings)).getBlob(b => {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          blobUrl = URL.createObjectURL(b); frame.src = blobUrl; prev.hidden = false;
        });
      }, 250);
    }
    node.querySelector('[data-act="preview"]').addEventListener('click', () => {
      if (!prev.hidden) { prev.hidden = true; return; }
      if (window.matchMedia('(max-width: 700px)').matches) { pdfMake.createPdf(NK.docDefinition(o, settings)).open(); return; }
      preview();
    });
    node.querySelector('[data-act="download"]').addEventListener('click', () => {
      // ім'я файлу: «номер замовлення_ПІБ», напр. «353_Соломія Омелянюк.pdf»
      const clean = t => String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
      const num = clean(src.short || src.id || o.number);
      const file = [num, clean(o.buyer)].filter(Boolean).join('_').slice(0, 120) + '.pdf';
      pdfMake.createPdf(NK.docDefinition(o, settings)).download(file);
    });

    $('orders').append(node);
  }

  start();
})();
