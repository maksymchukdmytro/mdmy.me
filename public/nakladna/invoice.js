// Шаблон видаткової накладної (pdfmake) і сума прописом українською.
// Працює і в браузері (window.NK), і в Node (для перевірки).
(function (root) {
  'use strict';

  // ---------- сума прописом ----------
  const ONES_M = ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
  const ONES_F = ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
  const TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
  const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
  const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];
  const SCALES = [[['', '', ''], true], [['тисяча', 'тисячі', 'тисяч'], true],
                  [['мільйон', 'мільйони', 'мільйонів'], false], [['мільярд', 'мільярди', 'мільярдів'], false]];

  function plural(n, f) {
    n = n % 100; if (n >= 11 && n <= 19) return f[2];
    n = n % 10; return n === 1 ? f[0] : n >= 2 && n <= 4 ? f[1] : f[2];
  }
  function triad(n, fem) {
    const w = [], h = Math.floor(n / 100), r = n % 100;
    if (h) w.push(HUNDREDS[h]);
    if (r >= 10 && r <= 19) w.push(TEENS[r - 10]);
    else { const t = Math.floor(r / 10), o = r % 10; if (t) w.push(TENS[t]); if (o) w.push((fem ? ONES_F : ONES_M)[o]); }
    return w;
  }
  function amountInWords(sum) {
    const cents = Math.round(sum * 100), hr = Math.floor(cents / 100), kop = cents % 100;
    let words = [];
    if (!hr) words = ['нуль'];
    else for (let n = hr, i = 0; n; n = Math.floor(n / 1000), i++) {
      const part = n % 1000; if (!part) continue;
      const [forms, fem] = SCALES[i], chunk = triad(part, fem);
      if (i) chunk.push(plural(part, forms));
      words = chunk.concat(words);
    }
    const t = words.join(' ');
    return `${t[0].toUpperCase()}${t.slice(1)} ${plural(hr, ['гривня', 'гривні', 'гривень'])} ` +
           `${String(kop).padStart(2, '0')} ${plural(kop, ['копійка', 'копійки', 'копійок'])}`;
  }

  // ---------- форматування ----------
  const round2 = n => Math.round((+n || 0) * 100) / 100;
  const money = n => round2(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace('.', ',');
  const qtyStr = n => (Number.isInteger(+n) ? String(+n) : String(round2(n)).replace('.', ','));
  const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  function dateLong(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return '';
    return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]} р.`;
  }
  const lineSum = it => round2((+it.qty || 0) * (+it.price || 0));
  const total = items => round2(items.reduce((s, it) => s + lineSum(it), 0));

  // ---------- документ ----------
  // Сучасний мінімалістичний шаблон: шрифт Inter, багато повітря, заокруглені блоки,
  // фірмовий колір лише в акцентах.
  const INK = '#111318', TEXT = '#2B2F36', MUTED = '#7A808A', FAINT = '#A9AEB6', HAIR = '#ECEEF1';
  const hex = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#C1D0E4');
  function tint(c, k) {
    const n = parseInt(hex(c).slice(1), 16), mix = v => Math.round(v + (255 - v) * k);
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => mix(v).toString(16).padStart(2, '0')).join('');
  }
  const NUM = { fontFeatures: ['tnum'] };

  // Заокруглений блок фіксованої висоти: малюємо фон, а вміст кладемо поверх
  function rounded(width, height, color, content, pad) {
    pad = pad || [16, 14];
    return { width, stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: width, h: height, r: 12, color }], relativePosition: { x: 0, y: 0 } },
      { table: { widths: ['*'], heights: [height], body: [[{ stack: [].concat(content) }]] },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => pad[0], paddingRight: () => pad[0], paddingTop: () => pad[1], paddingBottom: () => 0 } }
    ] };
  }
  // приблизна кількість рядків тексту (для висоти заокруглених карток)
  const linesOf = (t, perLine) => Math.max(1, Math.ceil(String(t || '').length / perLine));

  function docDefinition(o, settings) {
    const s = settings.seller || {}, inv = settings.invoice || {};
    const ACCENT = hex(inv.accent);
    // світлий фірмовий колір (як у antony) — текст на ньому темний, а картки — його світліший відтінок
    const n = parseInt(ACCENT.slice(1), 16), lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    const LIGHT = lum > 0.62, ON = LIGHT ? INK : '#FFFFFF', SOFT = tint(ACCENT, LIGHT ? 0.62 : 0.94);
    const unit = inv.unit || 'шт.';
    const items = (o.items || []).filter(it => String(it.name || '').trim() || +it.price);
    const sum = total(items);
    const vat = (s.vatNote || 'Без ПДВ').trim();
    const noVat = /^без/i.test(vat);
    const M = 44, W = 595.28 - 2 * M;

    const small = (t, extra) => ({ text: t, fontSize: 8, color: MUTED, ...extra });
    // підписи полів (Товар, Постачальник, Разом…) — помітні: щільніший шрифт і темніший колір
    const LABEL = '#4B515B';
    const lbl = (t, extra) => ({ text: t, font: 'InterM', fontSize: 8.5, color: LABEL, ...extra });

    // ----- шапка -----
    const brand = settings.logo ? { image: settings.logo, fit: [150, 46] }
                                : { text: s.name || '', font: 'Display', fontSize: 15, color: INK };
    const head = { columns: [
      { width: '*', stack: [brand] },
      { width: 'auto', stack: [
        lbl('Видаткова накладна', { alignment: 'right' }),
        { text: o.number || '', font: 'Display', fontSize: 24, color: INK, alignment: 'right', margin: [0, 2, 0, 4] },
        small([o.date ? dateLong(o.date) : '', o.crmShort ? `замовлення № ${o.crmShort}` : ''].filter(Boolean).join('  ·  '), { alignment: 'right' })
      ] }
    ], margin: [0, 0, 0, 30] };

    // ----- сторони: дві заокруглені картки однакової висоти -----
    const cw = (W - 12) / 2, PER = 44;
    const sellerRows = [s.code ? `${s.codeLabel || 'ІПН'} ${s.code}` : '', s.address, s.iban ? `IBAN ${s.iban}` : '', s.bank, s.phone].filter(Boolean);
    const deliv = [o.delivery, o.ttn ? `ТТН ${o.ttn}` : ''].filter(Boolean).join(' · ');
    const buyerRows = [o.phone, deliv, o.address].filter(Boolean);
    const rowsH = rows => rows.reduce((h, r) => h + linesOf(r, PER) * 13.8, 0);
    const nameH = t => linesOf(t, 30) * 16.5;
    const cardH = Math.max(rowsH(sellerRows) + nameH(s.name), rowsH(buyerRows) + nameH(o.buyer)) + 56;
    const card = (label, name, rows) => rounded(cw, cardH, SOFT, [
      lbl(label, { margin: [0, 0, 0, 7] }),
      { text: name || '—', font: 'InterM', fontSize: 11, color: INK, margin: [0, 0, 0, 4] },
      ...rows.map(r => ({ text: r, fontSize: 8.5, color: TEXT, lineHeight: 1.3 }))
    ]);
    const parties = { columns: [card('Постачальник', s.name, sellerRows), card('Одержувач', o.buyer, buyerRows)], columnGap: 12, margin: [0, 0, 0, 26] };

    // ----- товари: без заливок, лише тонкі лінії -----
    const th = (t, al) => ({ text: t, font: 'InterM', fontSize: 8.5, color: LABEL, alignment: al || 'left' });
    const body = [[th('Товар'), th('К-сть', 'right'), th('Ціна', 'right'), th('Сума', 'right')]];
    items.forEach(it => body.push([
      { stack: [{ text: it.name || '', font: 'InterM', fontSize: 9.5, color: INK }]
          .concat(it.sku ? [{ text: it.sku, fontSize: 7.5, color: MUTED, margin: [0, 2, 0, 0] }] : []) },
      { text: `${qtyStr(it.qty)} ${unit}`, alignment: 'right', color: TEXT, ...NUM },
      { text: money(it.price), alignment: 'right', color: TEXT, ...NUM },
      { text: money(lineSum(it)), alignment: 'right', font: 'InterM', color: INK, ...NUM }
    ]));
    const table = { table: { headerRows: 1, widths: ['*', 56, 70, 78], body },
      layout: { hLineWidth: (i, node) => (i === 0 ? 0 : i === node.table.body.length ? 0 : i === 1 ? 1 : 0.6),
                hLineColor: (i) => (i === 1 ? '#C9CDD3' : HAIR),
                vLineWidth: () => 0, paddingLeft: (i) => (i === 0 ? 0 : 8), paddingRight: (i, node) => (i === node.table.widths.length - 1 ? 0 : 8),
                paddingTop: r => (r === 0 ? 0 : 11), paddingBottom: r => (r === 0 ? 8 : 11) } };

    // ----- підсумок: заокруглена «пігулка» у фірмовому кольорі -----
    const TW = 230;
    const totals = { width: TW, stack: [
      { columns: [lbl('Разом'), { text: money(sum) + ' грн', alignment: 'right', fontSize: 9, color: TEXT, ...NUM }], margin: [16, 0, 16, 5] },
      { columns: [lbl('ПДВ'), small(noVat ? 'без ПДВ' : vat, { alignment: 'right' })], margin: [16, 0, 16, 10] },
      rounded(TW, 50, ACCENT, [{ columns: [
        { text: 'До сплати', width: 'auto', fontSize: 9, color: ON, margin: [0, 6, 0, 0] },
        { text: money(sum) + ' грн', width: '*', font: 'Display', fontSize: 18, color: ON, alignment: 'right', ...NUM }
      ] }], [16, 13])
    ] };
    const words = { width: '*', stack: [
      lbl('Сума прописом', { margin: [0, 0, 0, 4] }),
      { text: amountInWords(sum), font: 'InterM', fontSize: 9.5, color: INK },
      small(`${vat.charAt(0).toUpperCase() + vat.slice(1)} · ${items.length} ${plural(items.length, ['позиція', 'позиції', 'позицій'])}`, { margin: [0, 4, 0, 0] })
    ] };

    // ----- підписи -----
    const sig = (label, name) => ({ width: '*', stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: (W - 40) / 2, y2: 0, lineWidth: 0.8, lineColor: '#D5D8DD' }], margin: [0, 34, 0, 6] },
      lbl(label), { text: name || ' ', fontSize: 8.5, color: TEXT, margin: [0, 2, 0, 0] }
    ] });

    const footLeft = [inv.site, inv.note].filter(Boolean).join('  ·  ');
    return {
      pageSize: 'A4', pageMargins: [M, 46, M, 56],
      info: { title: `Видаткова накладна ${o.number || ''}`, author: s.name || '' },
      defaultStyle: { font: 'Inter', fontSize: 9, color: TEXT, lineHeight: 1.2 },
      footer: (page, pages) => ({ margin: [M, 18, M, 0], columns: [
        small(footLeft, { fontSize: 7.5, color: FAINT }),
        small(pages > 1 ? `${page} / ${pages}` : '', { fontSize: 7.5, color: FAINT, alignment: 'right' })
      ] }),
      content: [
        head,
        parties,
        table,
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.6, lineColor: HAIR }], margin: [0, 0, 0, 18] },
        { columns: [words, totals], columnGap: 30, margin: [0, 0, 0, 34] },
        { columns: [sig('Відвантажив(ла)', s.signer), sig('Отримав(ла)', o.buyer)], columnGap: 40, unbreakable: true }
      ]
    };
  }

  const NK = { amountInWords, money, qtyStr, lineSum, total, round2, docDefinition };
  if (typeof module !== 'undefined' && module.exports) module.exports = NK; else root.NK = NK;
})(typeof window !== 'undefined' ? window : globalThis);
