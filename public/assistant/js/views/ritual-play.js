// Екран виконання ритуалу (#/r/<id>): медіа на весь екран, кроки з таймером, «Зроблено / +15 хв / Пропустити».
// Відкривається з push-сповіщення, з Telegram («Відкрити з таймером»), зі смужки на «Сьогодні» і зі списку ритуалів.
// Вбудовані анімації: eyes — крапка, за якою стежать очі; water — склянка, що наповнюється; breath — дихання 4-7-8.
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, fail, wait } from '../ui.js';

const NAMES = { eyes: 'Крапка для очей', water: 'Склянка води', breath: 'Дихання 4-7-8' };
export const builtinName = k => NAMES[k] || k;
const ytId = u => { const m = /(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/.exec(u || ''); return m ? m[1] : null; };
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

// Мініатюра в редакторі
export function mediaThumb(m) {
  if (m.type === 'image') return `<img src="${esc(m.url)}" alt="" loading="lazy">`;
  if (m.type === 'video') return `<video src="${esc(m.url)}#t=0.5" muted playsinline preload="metadata"></video><span class="r-badge">${icon('video', 14)}</span>`;
  if (m.type === 'youtube') { const id = ytId(m.url); return id ? `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy"><span class="r-badge">${icon('play', 14)}</span>` : `<span class="r-ph">${icon('video', 22)}</span>`; }
  if (m.type === 'link') return `<span class="r-ph">${icon('link', 22)}<small>${esc(new URL(m.url).hostname)}</small></span>`;
  return `<span class="r-ph builtin">${anim(m.type, true)}<small>${esc(builtinName(m.type))}</small></span>`;
}
// Велике медіа на екрані виконання
function mediaFull(m) {
  if (m.type === 'image') return `<img src="${esc(m.url)}" alt="">`;
  if (m.type === 'video') return `<video src="${esc(m.url)}" autoplay muted loop playsinline controls></video>`;
  if (m.type === 'youtube') { const id = ytId(m.url); return id ? `<iframe src="https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&modestbranding=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="Відео"></iframe>` : ''; }
  if (m.type === 'link') return `<a class="rp-link" href="${esc(m.url)}" target="_blank" rel="noopener">${icon('open', 18)}Відкрити: ${esc(new URL(m.url).hostname)}</a>`;
  return anim(m.type);
}
function anim(type, small) {
  if (type === 'eyes') return `<div class="an-eyes${small ? ' sm' : ''}"><i></i></div>`;
  if (type === 'water') return `<div class="an-water${small ? ' sm' : ''}"><svg viewBox="0 0 120 160" aria-hidden="true">
      <defs><clipPath id="glassIn"><path d="M17 10h86l-9.5 138a8 8 0 0 1-8 7.5h-51a8 8 0 0 1-8-7.5z"/></clipPath></defs>
      <g clip-path="url(#glassIn)"><rect class="w" x="0" y="0" width="120" height="170"/><circle class="bb" cx="45" cy="150" r="4"/><circle class="bb" cx="70" cy="150" r="3"/><circle class="bb" cx="82" cy="150" r="3.5"/></g>
      <path d="M14 8h92l-9.8 140.5a10 10 0 0 1-10 9.3H33.8a10 10 0 0 1-10-9.3z" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/></svg></div>`;
  if (type === 'breath') return `<div class="an-breath${small ? ' sm' : ''}"><i></i>${small ? '' : '<span class="br-t">Вдих</span>'}</div>`;
  return '';
}

let cur = null;
export const ritualOpenId = () => cur && cur.id;
export function closeRitual() {
  if (!cur) return;
  const c = cur; cur = null;
  clearInterval(c.timer); clearInterval(c.breath);
  document.removeEventListener('keydown', c.key, true);
  c.el.classList.remove('in');
  setTimeout(() => c.el.remove(), 300);
}

export async function openRitual(id, onClose) {
  closeRitual();
  const el = document.createElement('div'); el.className = 'rp-wrap';
  el.innerHTML = '<div class="rp" role="dialog" aria-modal="true" aria-label="Щоденне завдання"><div class="rp-load"><span class="spin"></span></div></div>';
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  const c = cur = { id, el, onClose, step: -1, left: 0, timer: 0, breath: 0, running: false };
  c.key = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
  document.addEventListener('keydown', c.key, true);
  let r;
  try { r = await get('routines/' + id); } catch (e) { fail(e); return onClose(); }
  if (cur !== c) return;
  c.r = r;
  draw(c);
}

function draw(c) {
  const r = c.r, rp = c.el.querySelector('.rp');
  const media = r.media.length ? r.media : [];
  rp.innerHTML = `
    <header class="rp-top"><button type="button" class="icon-btn" data-x aria-label="Закрити">${icon('x', 20)}</button>
      <span class="rp-prog">${r.total ? `${r.done} з ${r.total} сьогодні` : ''}</span></header>
    ${media.length ? `<div class="rp-media${media.length > 1 ? ' multi' : ''}">${media.map(m => `<div class="rp-slide">${mediaFull(m)}</div>`).join('')}</div>` : `<div class="rp-hero"><span>${esc(r.icon)}</span></div>`}
    <div class="rp-body">
      <h1>${media.length ? esc(r.icon) + ' ' : ''}${esc(r.title)}</h1>
      ${r.body ? `<p class="rp-desc">${esc(r.body)}</p>` : ''}
      ${r.steps.length ? `<ol class="rp-steps">${r.steps.map((s, i) => `<li data-i="${i}"><span class="rp-n">${i + 1}</span><span class="rp-st">${esc(s.text)}</span>${s.sec ? `<span class="rp-sec">${fmt(s.sec)}</span>` : ''}<i class="rp-bar"></i></li>`).join('')}</ol>` : ''}
    </div>
    <footer class="rp-act">
      <div class="rp-minor"><button type="button" data-a="later">${icon('clock', 15)}Через 15 хв</button><button type="button" data-a="skip">Пропустити</button></div>
      <div class="rp-major">
        ${r.steps.some(s => s.sec) ? `<button type="button" class="btn rp-timer" data-a="timer">${icon('play', 16)}<span>Почати</span></button>` : ''}
        <button type="button" class="btn primary rp-done" data-a="done">${icon('check', 18)}Зроблено</button>
      </div>
    </footer>`;
  rp.addEventListener('click', e => onClick(c, e));
  if (media.some(m => m.type === 'breath')) breathLabels(c);
}
const fmt = s => s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`;

// підписи «Вдих / Затримка / Видих» у такт CSS-анімації (4 + 7 + 8 с)
function breathLabels(c) {
  const t = c.el.querySelector('.br-t'); if (!t) return;
  const start = Date.now();
  c.breath = setInterval(() => {
    const s = ((Date.now() - start) / 1000) % 19;
    t.textContent = s < 4 ? 'Вдих' : s < 11 ? 'Затримка' : 'Видих';
  }, 200);
}

async function onClick(c, e) {
  if (e.target.closest('[data-x]')) return c.onClose();
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a;
  if (a === 'timer') return c.running ? pause(c) : run(c);
  b.disabled = true;
  try {
    const res = await post(`routines/${c.id}/${a}`);
    changed();
    if (a === 'done') {
      c.el.classList.add('celebrate');
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      await wait(700);
    }
    toast(res.text);
    c.onClose();
  } catch (err) { fail(err); b.disabled = false; }
}

// Таймер: крок за кроком, між кроками — вібрація й короткий сигнал. Крок без секунд чекає на «Далі».
function run(c) {
  const steps = c.r.steps;
  if (c.step < 0 || c.step >= steps.length) { c.step = 0; c.left = steps[0].sec || 0; }
  else if (!steps[c.step].sec) { if (!advance(c)) return; }
  c.running = true; setTimerBtn(c); highlight(c);
  if (!steps[c.step].sec) { c.running = false; setTimerBtn(c); return; }
  c.timer = setInterval(() => {
    const s = steps[c.step], li = c.el.querySelector(`.rp-steps li[data-i="${c.step}"]`);
    c.left -= 0.25;
    if (li) { li.style.setProperty('--p', 1 - Math.max(0, c.left) / s.sec); li.querySelector('.rp-sec').textContent = fmt(Math.ceil(Math.max(0, c.left))); }
    if (c.left > 0) return;
    clearInterval(c.timer);
    if (!advance(c)) return;
    beep(660, 0.12); if (navigator.vibrate) navigator.vibrate(40);
    c.running = false; run(c);
  }, 250);
}
// позначити поточний крок виконаним і перейти до наступного; false — кроки скінчились
function advance(c) {
  const li = c.el.querySelector(`.rp-steps li[data-i="${c.step}"]`); if (li) li.classList.add('ok');
  c.step++;
  if (c.step >= c.r.steps.length) {
    pause(c); highlight(c); beep(880, 0.25); if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
    c.el.querySelector('.rp-done').classList.add('ready');
    return false;
  }
  c.left = c.r.steps[c.step].sec || 0;
  return true;
}
function pause(c) { clearInterval(c.timer); c.running = false; setTimerBtn(c); }
function setTimerBtn(c) {
  const b = c.el.querySelector('.rp-timer'); if (!b) return;
  b.innerHTML = c.running ? `${icon('pause', 16)}<span>Пауза</span>` : `${icon('play', 16)}<span>${c.step >= 0 && c.step < c.r.steps.length ? 'Далі' : 'Почати'}</span>`;
}
function highlight(c) {
  c.el.querySelectorAll('.rp-steps li').forEach(li => li.classList.toggle('now', +li.dataset.i === c.step));
  const li = c.el.querySelector(`.rp-steps li[data-i="${c.step}"]`);
  if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
let actx = null;
function beep(freq, dur) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, actx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + dur + 0.05);
  } catch (e) {}
}
