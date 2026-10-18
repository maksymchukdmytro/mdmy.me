// Стан і звички за 14 днів: настрій, енергія, сон, звички. Монохромні графіки.
import { get } from '../api.js';
import { icon } from '../icons.js';
import { $, esc } from '../ui.js';

const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayLabel = d => { const dt = new Date(d + 'T12:00:00'); return `${WD[dt.getDay()]} ${dt.getDate()}`; };

export function statePage() {
  let root, st = null;
  const onResize = () => { if (st) draw(); };
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page">
      <div class="page-head"><div class="page-icon">${icon('activity', 30)}</div><h1 class="page-title">Стан і звички</h1>
        <p class="page-desc">Скажіть асистенту: «настрій 7, енергія 6, спав 7 годин, зробив зарядку» — і тут зʼявиться картина за два тижні.</p></div>
      <div class="state"></div></div>`;
    addEventListener('resize', onResize);
    load();
  }
  async function load() {
    try { st = await get('assistant/state?days=14'); } catch (e) { $('.state', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    const box = $('.state', root);
    const any = st.days.some(d => d.mood != null || d.energy != null || d.sleep != null || d.habits.length);
    if (!any) { box.innerHTML = `<div class="empty">${icon('activity', 28)}<p>Записів стану ще немає.</p></div>`; return; }
    const tile = (label, v, unit) => `<div class="tile"><b>${v ?? '—'}</b><span>${v != null ? unit : ''}</span><small>${label}</small></div>`;
    box.innerHTML = `<div class="tiles">${tile('настрій, середнє', st.avg.mood, '/10')}${tile('енергія, середнє', st.avg.energy, '/10')}${tile('сон, середнє', st.avg.sleep, ' год')}</div>
      <section class="chart"><h3>Настрій і енергія</h3><div class="legend"><span><i class="l-mood"></i>Настрій</span><span><i class="l-energy"></i>Енергія</span></div><div class="plot" data-p="mood"></div></section>
      <section class="chart"><h3>Сон, годин</h3><div class="plot" data-p="sleep"></div></section>
      ${st.habits.length ? `<section class="chart"><h3>Звички</h3><div class="habits"></div></section>` : ''}`;
    lines($('[data-p="mood"]', box)); bars($('[data-p="sleep"]', box));
    if (st.habits.length) habits($('.habits', box));
  }
  const frame = (el, h) => { const W = Math.max(280, el.clientWidth || 600), pad = { l: 24, r: 30, t: 10, b: 24 }, n = 14, cw = (W - pad.l - pad.r) / n; return { W, H: h, pad, cw, x: i => pad.l + cw * i + cw / 2 }; };
  const xl = (f, days) => days.map((d, i) => i % 2 === (days.length - 1) % 2 ? `<text x="${f.x(i)}" y="${f.H - 6}" text-anchor="middle" class="ax">${dayLabel(d.day)}</text>` : '').join('');
  function lines(el) {
    const days = st.days, f = frame(el, 190), y = v => f.pad.t + (10 - v) / 9 * (f.H - f.pad.t - f.pad.b);
    let s = '';
    for (const g of [2, 4, 6, 8, 10]) s += `<line x1="${f.pad.l}" x2="${f.W - f.pad.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${f.pad.l - 6}" y="${y(g) + 4}" text-anchor="end" class="ax">${g}</text>`;
    for (const k of ['mood', 'energy']) {
      let d = '', pen = false;
      days.forEach((day, i) => { const v = day[k]; if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${f.x(i)},${y(v)}`; pen = true; });
      s += `<path d="${d}" class="ln ${k}"/>`;
      days.forEach((day, i) => { if (day[k] != null) s += `<circle cx="${f.x(i)}" cy="${y(day[k])}" r="3.5" class="pt ${k}"><title>${dayLabel(day.day)}: ${day[k]}</title></circle>`; });
    }
    el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="100%" height="${f.H}" role="img" aria-label="Настрій і енергія за 14 днів">${s}${xl(f, days)}</svg>`;
  }
  function bars(el) {
    const days = st.days, f = frame(el, 150), max = Math.max(9, ...days.map(d => d.sleep || 0)), base = f.H - f.pad.b, y = v => base - v / max * (base - f.pad.t);
    let s = '';
    for (const g of [0, 3, 6, 9].filter(g => g <= max)) s += `<line x1="${f.pad.l}" x2="${f.W - f.pad.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${f.pad.l - 6}" y="${y(g) + 4}" text-anchor="end" class="ax">${g}</text>`;
    const bw = Math.min(20, f.cw - 4);
    days.forEach((d, i) => { if (d.sleep > 0) s += `<rect x="${f.x(i) - bw / 2}" y="${y(d.sleep)}" width="${bw}" height="${base - y(d.sleep)}" rx="3" class="bar"><title>${dayLabel(d.day)}: ${d.sleep} год</title></rect>`; });
    if (st.avg.sleep != null) s += `<line x1="${f.pad.l}" x2="${f.W - f.pad.r}" y1="${y(st.avg.sleep)}" y2="${y(st.avg.sleep)}" class="avg"/><text x="${f.W - f.pad.r + 4}" y="${y(st.avg.sleep) + 4}" class="ax">⌀${st.avg.sleep}</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="100%" height="${f.H}" role="img" aria-label="Сон за 14 днів">${s}${xl(f, days)}</svg>`;
  }
  function habits(el) {
    el.innerHTML = `<div class="hgrid" style="grid-template-columns:minmax(90px,auto) repeat(14,1fr) auto"><span></span>${st.days.map((d, i) => `<span class="hd">${i % 2 ? new Date(d.day + 'T12:00').getDate() : ''}</span>`).join('')}<span></span>
      ${st.habits.map(h => `<span class="hn">${esc(h.name)}</span>${st.days.map(d => `<span class="hc${d.habits.includes(h.id) ? ' on' : ''}" title="${dayLabel(d.day)}"></span>`).join('')}<span class="hk">${h.count}/14</span>`).join('')}</div>`;
  }
  return { render, refresh: load, destroy: () => removeEventListener('resize', onResize) };
}
