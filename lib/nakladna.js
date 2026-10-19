// Видаткові накладні для інтернет-магазину (сторінка /nakladna).
// Доступ лише після входу на mdmy.me (lib/auth.js).
// API-ключ LP-CRM і реквізити зберігаються в базі (таблиця meta), а не в коді чи git.
// Ключ ніколи не віддається назад у браузер — сторінка бачить лише «ключ задано».
const { send, readBody } = require('./util');

const KEY = 'nakladna_settings';
const keys = require('./keys');
const DEFAULTS = {
  domain: 'vegacargo.lp-crm.biz', apiKey: '',
  seller: { name: '', codeLabel: 'ІПН', code: '', address: '', iban: '', bank: '', phone: '', vatNote: 'Без ПДВ', signer: '' },
  invoice: { prefix: 'РН-', unit: 'шт.', accent: '#C1D0E4', site: 'antony.com.ua', note: '' },
  logo: '',
  deliveryMap: {}            // id способу доставки в LP-CRM → назва («Нова Пошта», «Укрпошта»…)
};
const str = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

module.exports = function makeNakladna(db, log) {
  function load() {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
    let s = {}; try { s = row ? JSON.parse(row.value) : {}; } catch (e) {}
    if (keys.hasPlain(s, ['apiKey'])) save(s);                       // старий відкритий ключ CRM → зашифрувати
    s = keys.unsealFields(s, ['apiKey']);
    const invoice = { ...DEFAULTS.invoice, ...(s.invoice || {}) };
    if (String(invoice.accent).toUpperCase() === '#1E5AA8') invoice.accent = DEFAULTS.invoice.accent;   // старий синій за замовчуванням → фірмовий antony
    return { ...DEFAULTS, ...s, seller: { ...DEFAULTS.seller, ...(s.seller || {}) }, invoice };
  }
  function save(s) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(keys.sealFields(s, ['apiKey'])));
  }
  const publicView = s => ({ domain: s.domain, hasKey: !!s.apiKey, seller: s.seller, invoice: s.invoice, logo: s.logo || '', deliveryMap: s.deliveryMap || {} });
  const cleanDomain = d => str(d, 120).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

  // ---------- LP-CRM ----------
  // Документація LP-CRM (розділ API у кабінеті):
  //   getOrdersByID.html      key, order_id (довгий ідентифікатор, до 100 через кому)
  //   getOrdersIdByStatus.html key, status, date_start, date_end → data: [довгі ідентифікатори]
  //   getStatuses.html        key → усі статуси
  //   getProduct.html         key, product_id (кілька через кому) → назви товарів
  // LP-CRM обмежує частоту запитів (HTTP 429), тому всі виклики йдуть по черзі з паузою,
  // а після 429 сервер чекає й повторює.
  const GAP_MS = 700;
  let queue = Promise.resolve(), lastAt = 0;
  const stats = { calls: 0, r429: 0 };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function call(s, method, params) {
    const run = queue.then(() => callNow(s, method, params));
    queue = run.catch(() => {});
    return run;
  }
  async function callNow(s, method, params) {
    if (!s.domain || !s.apiKey) throw new Error('Спершу вкажіть адресу LP-CRM і API-ключ у налаштуваннях.');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s.domain)) throw new Error('Адреса LP-CRM виглядає неправильно (приклад: shop.lp-crm.biz).');
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      stats.calls++;
      let r;
      try {
        r = await fetch(`https://${s.domain}/api/${method}.html`, {
          method: 'POST', body: new URLSearchParams({ key: s.apiKey, ...params }), signal: AbortSignal.timeout(25000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } catch (e) { throw new Error('Не вдалося з’єднатися з LP-CRM. Перевірте адресу CRM.'); }
      if (r.status === 429 || r.status === 503) {
        stats.r429++;
        if (attempt >= 5) throw new Error('LP-CRM тимчасово обмежує кількість запитів. Спробуйте ще раз за хвилину.');
        const ra = parseFloat(r.headers.get('retry-after'));
        await sleep(isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch (e) {
        throw new Error(`LP-CRM (${method}) відповіла не JSON (код ${r.status}).`);
      }
      if (json && json.status && String(json.status).toLowerCase() !== 'ok') {
        throw Object.assign(new Error('LP-CRM: ' + str(json.message || json.error || JSON.stringify(json), 300)), { raw: json });
      }
      return json;
    }
  }

  // Замовлення за довгими ідентифікаторами. Відповідь: {"data": {"<код>": {...}}}, не знайдено — {"<код>": []}
  async function ordersByLongId(s, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const json = await call(s, 'getOrdersByID', { order_id: ids.slice(i, i + 100).join(',') });
      const data = json && json.data != null ? json.data : json;
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data && typeof data === 'object') {
        const one = 'products' in data || 'bayer_name' in data;
        list = one ? [data] : Object.entries(data).map(([k, v]) => {
          const o = Array.isArray(v) ? v[0] : v;
          return o && typeof o === 'object' && Object.keys(o).length ? { order_id: k, ...o } : null;
        });
      }
      out.push(...list.filter(o => o && typeof o === 'object' && Object.keys(o).length));
      out.raw = json;
    }
    return out;
  }

  // ----- короткий номер (353) → довгий ідентифікатор -----
  // API не шукає за коротким номером, тому сервер переглядає замовлення за датами
  // (getOrdersIdByStatus по кожному статусу) і запам'ятовує відповідність у meta.
  const IDX = 'nakladna_index';
  const SHORT_KEYS = ['id', 'order_number', 'number', 'num', 'order_num', 'crm_id', 'local_id', 'order_local_id'];
  const NOT_SHORT = new Set(['order_id', 'status', 'attribute_status_id', 'office', 'payment', 'delivery_id', 'total', 'phone',
    'user', 'localization', 'site', 'ip', 'ttn', 'ttn_status', 'products', 'comment']);
  function loadIdx() {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(IDX);
    try { const v = row ? JSON.parse(row.value) : {}; return { map: v.map || {}, field: v.field || '' }; } catch (e) { return { map: {}, field: '' }; }
  }
  function saveIdx(idx) {
    const keys = Object.keys(idx.map);
    if (keys.length > 20000) for (const k of keys.sort((a, b) => a - b).slice(0, keys.length - 20000)) delete idx.map[k];
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(IDX, JSON.stringify(idx));
  }
  const shortOf = (o, field) => {
    const v = o[field]; return v != null && /^\d{1,9}$/.test(String(v)) ? String(+v) : null;
  };
  // Яке поле містить короткий номер: шукаємо поле, що дорівнює введеному номеру
  // (спершу точний збіг, потім типові назви полів на зразок id)
  function detectField(orders, want) {
    for (const o of orders) for (const k of SHORT_KEYS) if (shortOf(o, k) === want) return k;
    for (const o of orders) for (const k of Object.keys(o)) if (!NOT_SHORT.has(k) && shortOf(o, k) === want) return k;
    for (const k of SHORT_KEYS) if (orders.length && orders.every(o => shortOf(o, k))) return k;
    return '';
  }

  let statusCache = null;
  async function statuses(s) {
    if (statusCache && Date.now() - statusCache.at < 3600e3) return statusCache.ids;
    const json = await call(s, 'getStatuses', {});
    const data = json && json.data != null ? json.data : json;
    const ids = new Set();
    const walk = v => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const id = v.id != null ? v.id : v.status_id;
        if (id != null && /^\d+$/.test(String(id))) ids.add(String(id));
        else for (const [k, x] of Object.entries(v)) { if (/^\d+$/.test(k)) ids.add(k); else walk(x); }
      }
    };
    walk(data);
    if (!ids.size) throw new Error('Не вдалося отримати список статусів з LP-CRM.');
    statusCache = { at: Date.now(), ids: [...ids] };
    return statusCache.ids;
  }
  const ymd = d => d.toISOString().slice(0, 10);

  async function findLongId(s, short) {
    const idx = loadIdx();
    if (idx.map[short]) return idx.map[short];
    const known = new Set(Object.values(idx.map));
    const t0 = Date.now(); stats.calls = 0; stats.r429 = 0;
    const sts = await statuses(s);
    const info = () => `статусів ${sts.length}, запитів ${stats.calls}, відмов «забагато запитів» ${stats.r429}, ${Math.round((Date.now() - t0) / 1000)} с`;
    const deadline = t0 + 100e3;
    // спершу сьогоднішні замовлення, далі дедалі ширші проміжки назад (менше запитів до CRM)
    const WINDOWS = [[0, 1], [2, 4], [5, 11], [12, 31], [32, 92], [93, 183], [184, 366]];
    let sawShort = false, empty = 0;
    for (const [from, to] of WINDOWS) {
      const end = new Date(Date.now() - from * 864e5 + 864e5), start = new Date(Date.now() - to * 864e5);
      const ids = new Set();
      for (const st of sts) {
        if (Date.now() > deadline) {
          console.log(`nakladna: пошук №${short} перервано — ${info()}`);
          throw Object.assign(new Error(`LP-CRM відповідає надто повільно, пошук перервано (${info()}). Спробуйте ще раз за кілька хвилин — уже переглянуті замовлення запам'ятовуються.`),
            { raw: { statuses: sts, ...stats } });
        }
        const json = await call(s, 'getOrdersIdByStatus', { status: st, date_start: ymd(start), date_end: ymd(end) });
        const d = json && json.data;
        (Array.isArray(d) ? d : d && typeof d === 'object' ? Object.values(d) : []).forEach(x => { if (/^\d+$/.test(String(x))) ids.add(String(x)); });
      }
      // після знайдених замовлень два порожні проміжки поспіль — далі історії немає
      if (!ids.size) { if (++empty >= 2 && (sawShort || known.size)) return null; continue; }
      empty = 0;
      const fresh = [...ids].filter(x => !known.has(x));
      if (!fresh.length) continue;
      const orders = await ordersByLongId(s, fresh);
      if (!orders.length) continue;
      if (!idx.field) idx.field = detectField(orders, short);
      if (!idx.field) {
        throw Object.assign(new Error('LP-CRM не повертає короткий номер замовлення через API. Поки шукайте за довгим ідентифікатором.'),
          { raw: { fields: Object.keys(orders[0]) } });
      }
      let found = null, maxShort = -1;
      for (const o of orders) {
        const sh = shortOf(o, idx.field);
        if (!sh) continue;
        sawShort = true;
        idx.map[sh] = String(o.order_id); known.add(String(o.order_id));
        maxShort = Math.max(maxShort, +sh);
        if (sh === short) found = String(o.order_id);
      }
      saveIdx(idx);
      if (found) { console.log(`nakladna: №${short} знайдено — ${info()}`); return found; }
      // номери зростають з часом: якщо в цьому (старшому) вікні всі номери менші, далі шукати марно
      if (sawShort && maxShort >= 0 && maxShort < +short) return null;
    }
    return null;
  }

  // ----- назви товарів -----
  async function productNames(s, ids) {
    const names = {};
    if (!ids.length) return names;
    try {
      const json = await call(s, 'getProduct', { product_id: ids.join(','), status_ignore: 1 });
      const data = json && json.data != null ? json.data : json;
      const list = Array.isArray(data) ? data : data && typeof data === 'object' ? ('id' in data ? [data] : Object.values(data)) : [];
      for (const p of list) if (p && typeof p === 'object' && p.id != null) {
        names[String(p.id)] = { name: str(p.name || p.title, 300), sku: str(p.vendor_code || p.sku || p.article || '', 60), subs: p.subs };
      }
    } catch (e) { /* без назв накладна все одно сформується */ }
    return names;
  }

  async function crmOrders(s, inputs) {
    const lookups = [], notFound = [];
    for (const x of inputs) {
      if (/^\d{10,}$/.test(x)) lookups.push({ long: x, short: null });
      else {
        const long = await findLongId(s, String(+x));
        if (long) lookups.push({ long, short: String(+x) }); else notFound.push(x);
      }
    }
    const raw = lookups.length ? await ordersByLongId(s, lookups.map(l => l.long)) : [];
    const idx = loadIdx();
    const byLong = new Map(raw.map(o => [String(o.order_id), o]));
    const pids = new Set();
    raw.forEach(o => (Array.isArray(o.products) ? o.products : Object.values(o.products || {})).forEach(p => p && p.product_id != null && pids.add(String(p.product_id))));
    const names = await productNames(s, [...pids]);
    const orders = [];
    for (const l of lookups) {
      const o = byLong.get(l.long);
      if (!o) { notFound.push(l.short || l.long); continue; }
      const short = l.short || (idx.field && shortOf(o, idx.field)) || '';
      orders.push({ ...normalize(o, names, s.deliveryMap || {}), short });
    }
    return { orders, notFound, raw: raw.raw };
  }

  const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };
  const num = v => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
  // Спосіб доставки: LP-CRM віддає delivery_id (число) — назву беремо з налаштувань (сторінка запам'ятовує її
  // після першого вибору); якщо назви ще немає, вгадуємо за форматом ТТН.
  function delivery(o, map) {
    const raw = pick(o, 'delivery_id', 'delivery', 'delivery_name');
    const id = /^\d+$/.test(String(raw)) ? String(raw) : '';
    const ttn = str(pick(o, 'ttn', 'ttn_number'), 40);
    let name = id ? (map[id] || '') : str(raw, 60);
    if (!name && ttn) {
      const t = ttn.replace(/\s/g, '');
      if (/^(20|59|1)\d{12,13}$/.test(t)) name = 'Нова Пошта';
      else if (/^0\d{12}$/.test(t) || /^[A-Z]{2}\d{9}UA$/.test(t)) name = 'Укрпошта';
    }
    return { deliveryId: id, delivery: name, ttn };
  }
  function normalize(o, names = {}, map = {}) {
    let products = o.products || o.goods || [];
    if (products && !Array.isArray(products)) products = Object.values(products);
    const items = products.filter(p => p && typeof p === 'object').map(p => {
      const info = names[String(p.product_id)] || {};
      let name = str(pick(p, 'name', 'title', 'product_name', 'product_title') || info.name, 300);
      const sub = p.sub_id != null && Array.isArray(info.subs) && info.subs.find(x => String(x.sub_id) === String(p.sub_id) || String(x.id) === String(p.sub_id));
      if (sub && sub.name) name += `, ${str(sub.name, 60)}`;
      return {
      name: name || `Товар #${pick(p, 'product_id', 'id') || '?'}`,
      sku: str(info.sku || pick(p, 'sku', 'article'), 60),
      qty: num(pick(p, 'quantity', 'count', 'amount') || 1),
      price: num(pick(p, 'price', 'product_price'))
    }; });
    const rawDate = str(pick(o, 'order_time', 'date', 'created_at', 'datetime'), 40);
    return {
      id: str(pick(o, 'order_id', 'id'), 40),
      date: /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : '',
      buyer: str(pick(o, 'bayer_name', 'buyer_name', 'fio', 'name'), 150),
      phone: str(pick(o, 'phone'), 40),
      address: str(pick(o, 'delivery_adress', 'delivery_address', 'address'), 300),
      ...delivery(o, map),
      comment: str(pick(o, 'comment'), 500),
      crmTotal: num(pick(o, 'total', 'total_price', 'sum', 'order_sum')),
      items
    };
  }

  // ---------- маршрути /api/nakladna/* ----------
  async function handle(req, res, url, a) {
    const m = req.method;
    if (url === '/api/nakladna/settings' && m === 'GET') return send(res, 200, publicView(load()));
    if (url === '/api/nakladna/settings' && m === 'POST') {
      const b = await readBody(req, 16384);
      if (!b) return send(res, 400, { error: 'Неправильні дані.' });
      const s = load();
      if (b.domain != null) s.domain = cleanDomain(b.domain);
      if (b.apiKey) s.apiKey = str(b.apiKey, 200);          // порожнє поле = залишити старий ключ
      if (b.clearKey) s.apiKey = '';
      if (b.seller) for (const k of Object.keys(DEFAULTS.seller)) if (b.seller[k] != null) s.seller[k] = str(b.seller[k], 300);
      if (b.invoice) for (const k of Object.keys(DEFAULTS.invoice)) if (b.invoice[k] != null) s.invoice[k] = str(b.invoice[k], k === 'note' || k === 'site' ? 120 : 20);
      if (!/^#[0-9a-f]{6}$/i.test(s.invoice.accent)) s.invoice.accent = DEFAULTS.invoice.accent;
      s.invoice.accent = s.invoice.accent.toUpperCase();
      save(s);
      log(a, 'nakladna:settings', null, { domain: s.domain, key: b.apiKey ? 'змінено' : undefined });
      return send(res, 200, publicView(s));
    }
    // логотип: PNG/JPEG як data URL (сторінка сама зменшує картинку перед завантаженням)
    if (url === '/api/nakladna/logo' && m === 'POST') {
      const b = await readBody(req, 1200000);
      const logo = b && String(b.logo || '');
      if (logo && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo)) return send(res, 400, { error: 'Потрібна картинка PNG або JPEG.' });
      if (logo.length > 1100000) return send(res, 400, { error: 'Логотип завеликий.' });
      const s = load(); s.logo = logo; save(s);
      log(a, 'nakladna:logo', null, { removed: !logo || undefined });
      return send(res, 200, publicView(s));
    }
    // запам'ятати назву способу доставки для id з LP-CRM
    if (url === '/api/nakladna/delivery' && m === 'POST') {
      const b = await readBody(req, 2048);
      const id = b && String(b.id || '');
      if (!/^\d{1,10}$/.test(id)) return send(res, 400, { error: 'Неправильний id доставки.' });
      const s = load(); s.deliveryMap = { ...(s.deliveryMap || {}) };
      const name = str(b.name, 60);
      if (name) s.deliveryMap[id] = name; else delete s.deliveryMap[id];
      save(s);
      return send(res, 200, { deliveryMap: s.deliveryMap });
    }
    if (url === '/api/nakladna/orders' && m === 'GET') {
      const qs = new URL(req.url, 'http://x').searchParams;
      const ids = String(qs.get('ids') || '').replace(/[№#]/g, '').split(/[\s,;]+/).map(x => x.trim()).filter(x => /^\d{1,25}$/.test(x)).slice(0, 30);
      if (!ids.length) return send(res, 400, { error: 'Вкажіть номер замовлення.' });
      try {
        const { orders, notFound, raw } = await crmOrders(load(), ids);
        log(a, 'nakladna:orders', ids.join(','));
        return send(res, 200, { orders, notFound, raw: qs.get('debug') ? raw : undefined });
      } catch (e) {
        return send(res, 502, { error: e.message, raw: qs.get('debug') ? e.raw : undefined });
      }
    }
    return send(res, 404, { error: 'Не знайдено.' });
  }
  return { handle };
};
