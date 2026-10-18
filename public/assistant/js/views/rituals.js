// Ритуали дня: список (#/rituals), редактор (#/rituals/<id>) і смужка на «Сьогодні».
// Ритуал — коротка повторювана справа з фото / відео / анімацією й кроками з таймером; приходить сповіщенням за розкладом.
// Сервер — lib/routines.js, API /api/routines/*. Екран виконання — ritual-play.js (#/r/<id>).
import { api, get, post, patch, del, authHeaders } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, esc, toast, fail, confirmBox, debounce, sheet, menu } from '../ui.js';
import { go } from '../nav.js';
import { builtinName, mediaThumb } from './ritual-play.js';

const EMOJI = ['💧', '👁', '🤸', '🧘', '🌬', '🚶', '🍎', '💊', '🦷', '📖', '😴', '☀️', '🧠', '💪', '🫁', '✨'];
const EVERY = [[30, '30 хв'], [45, '45 хв'], [60, '1 год'], [90, '1,5 год'], [120, '2 год'], [180, '3 год'], [240, '4 год']];
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

export function ritualsPage(id) { return id ? editorPage(id) : listPage(); }

// ---------- прогрес за сьогодні: крапки ----------
function dots(r) {
  if (!r.total) return '';
  return `<span class="r-dots" aria-label="${r.done} з ${r.total} сьогодні">${r.today.slice(0, 16).map(x => `<i class="${x.status}"></i>`).join('')}</span>`;
}
function stateLine(r) {
  if (!r.active) return 'вимкнено';
  if (r.pending) return 'чекає на тебе';
  if (!r.total) return 'сьогодні вихідний';
  return `${r.done} з ${r.total}${r.next ? ' · далі о ' + r.next : r.done >= r.total ? ' · усе 🎉' : ''}`;
}

// ---------- список ----------
function listPage() {
  let root, data = null;
  async function render(el) {
    root = el;
    root.innerHTML = `<div class="page rituals-page"><div class="page-head"><h1 class="page-title">Ритуали</h1></div><div class="r-list"><span class="spin"></span></div></div>`;
    root.addEventListener('click', onClick);
    load();
  }
  async function load() {
    try { data = await get('routines'); } catch (e) { $('.r-list', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    const box = $('.r-list', root);
    box.innerHTML = (data.list.length ? data.list.map(r => `
      <article class="r-card${r.active ? '' : ' off'}${r.pending ? ' pending' : ''}" data-id="${r.id}">
        <a class="r-main" href="#/rituals/${r.id}">
          <span class="r-emoji">${esc(r.icon)}</span>
          <span class="r-txt"><b>${esc(r.title)}</b><small>${esc(r.schedule)}</small><small class="r-state">${dots(r)}${esc(stateLine(r))}</small></span>
        </a>
        <button type="button" class="r-play" data-play="${r.id}" aria-label="Виконати зараз">${icon('play', 18)}</button>
      </article>`).join('')
      : `<div class="empty r-empty"><p>Короткі справи, які повторюються щодня: вода, зарядка, очі.<br>Приходять сповіщенням — з фото, відео й таймером.</p></div>`) +
      `<button type="button" class="btn primary r-new" data-new>${icon('plus', 16)}Новий ритуал</button>`;
  }
  async function onClick(e) {
    const p = e.target.closest('[data-play]'); if (p) return go('#/r/' + p.dataset.play);
    if (e.target.closest('[data-new]')) return pickTemplate(data && data.templates || []);
  }
  return { render, refresh: load };
}

// Новий: готовий шаблон або свій
function pickTemplate(templates) {
  const s = sheet(`<div class="sheet-head"><b>Новий ритуал</b></div>
    <div class="tpl-list">${templates.map(t => `<button type="button" class="tpl" data-t="${t.key}"><span class="r-emoji">${esc(t.icon)}</span><span><b>${esc(t.title)}</b><small>${esc(t.body)}</small></span></button>`).join('')}
      <button type="button" class="tpl" data-t=""><span class="r-emoji">✨</span><span><b>Свій ритуал</b><small>Назва, фото чи відео, кроки й час — як тобі треба</small></span></button></div>`,
    { cls: 'tpl-sheet', label: 'Новий ритуал' });
  s.el.addEventListener('click', async e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    b.disabled = true;
    try {
      const r = await post('routines', b.dataset.t ? { template: b.dataset.t } : { title: 'Новий ритуал', icon: '✨', times: ['09:00'] });
      s.close(); changed(); go('#/rituals/' + r.id);
    } catch (err) { fail(err); b.disabled = false; }
  });
}

// ---------- редактор ----------
function editorPage(id) {
  let root, r = null, mode = 'times';
  const saveSoon = debounce(() => save(collect()), 600);

  async function render(el) {
    root = el;
    root.innerHTML = `<div class="page r-edit"><a class="back" href="#/rituals">${icon('chevronLeft', 18)}Ритуали</a><div class="r-form"><span class="spin"></span></div></div>`;
    try { r = await get('routines/' + id); } catch (e) { $('.r-form', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    mode = r.times.length ? 'times' : 'every';
    draw();
    root.addEventListener('click', onClick);
    root.addEventListener('input', e => { if (e.target.closest('[data-f]')) { saveSoon(); if (e.target.matches('textarea')) grow(e.target); } });
    root.addEventListener('change', e => { if (e.target.closest('[data-f]')) saveSoon(); });
  }
  const grow = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };

  function draw() {
    const f = $('.r-form', root);
    f.innerHTML = `
      <div class="r-title">
        <button type="button" class="r-emoji big" data-a="emoji" aria-label="Значок">${esc(r.icon)}</button>
        <textarea data-f="title" rows="1" maxlength="80" placeholder="Назва">${esc(r.title)}</textarea>
      </div>
      <textarea class="r-body" data-f="body" rows="2" maxlength="1000" placeholder="Що зробити — коротко">${esc(r.body)}</textarea>

      <section class="r-sec"><h3>Медіа</h3>
        <div class="r-media">${r.media.map((m, i) => `<div class="r-thumb">${mediaThumb(m)}<button type="button" class="r-x" data-del-media="${i}" aria-label="Прибрати">${icon('x', 14)}</button></div>`).join('')}
          <label class="r-add-media">${icon('image', 20)}<span>Фото чи відео</span><input type="file" accept="image/*,video/*" data-a="file" hidden></label>
          <button type="button" class="r-add-media" data-a="link">${icon('link', 20)}<span>Посилання</span></button>
          <button type="button" class="r-add-media" data-a="builtin">${icon('sparkles', 20)}<span>Анімація</span></button>
        </div>
        <div class="r-upload" hidden><i></i></div>
      </section>

      <section class="r-sec"><h3>Кроки <small>з таймером</small></h3>
        <div class="r-steps">${r.steps.map((s, i) => stepRow(s, i)).join('')}</div>
        <button type="button" class="link-btn" data-a="add-step">${icon('plus', 15)}Додати крок</button>
      </section>

      <section class="r-sec"><h3>Коли</h3>
        <div class="seg r-mode" role="radiogroup"><button type="button" role="radio" data-mode="times" aria-checked="${mode === 'times'}">У певний час</button><button type="button" role="radio" data-mode="every" aria-checked="${mode === 'every'}">Через проміжки</button></div>
        <div class="r-when" data-when="times" ${mode === 'times' ? '' : 'hidden'}>
          <div class="r-times">${(r.times.length ? r.times : ['09:00']).map(t => timeChip(t)).join('')}<button type="button" class="chip-add" data-a="add-time">${icon('plus', 15)}час</button></div>
        </div>
        <div class="r-when" data-when="every" ${mode === 'every' ? '' : 'hidden'}>
          <label class="r-row">Кожні <select data-f="every">${EVERY.map(([v, l]) => `<option value="${v}"${(r.every || 120) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="r-row">з <input type="time" data-f="from" value="${r.from || '09:00'}"> до <input type="time" data-f="to" value="${r.to || '21:00'}"></label>
        </div>
        <div class="r-days" role="group" aria-label="Дні">${DAYS.map((d, i) => `<button type="button" class="day${!r.days || r.days.includes(i + 1) ? ' on' : ''}" data-day="${i + 1}" aria-pressed="${!r.days || r.days.includes(i + 1)}">${d}</button>`).join('')}</div>
      </section>

      <section class="r-sec r-foot">
        <label class="switch big"><input type="checkbox" data-f="active" ${r.active ? 'checked' : ''}><span>Нагадувати</span></label>
        <div class="r-acts">
          <button type="button" class="btn" data-a="play">${icon('play', 15)}Спробувати</button>
          <button type="button" class="btn" data-a="send">${icon('bell', 15)}Надіслати зараз</button>
          <button type="button" class="btn ghost danger" data-a="delete">${icon('trash', 15)}Видалити</button>
        </div>
        <p class="r-saved muted small" aria-live="polite"></p>
      </section>`;
    $$('textarea', f).forEach(grow);
  }
  const stepRow = (s, i) => `<div class="r-step" data-i="${i}"><span class="r-n">${i + 1}</span><input data-f="step" value="${esc(s.text)}" placeholder="Що робити" maxlength="200">
    <label class="r-sec-in"><input data-f="sec" type="number" inputmode="numeric" min="0" max="3600" value="${s.sec || ''}" placeholder="0"><span>с</span></label>
    <button type="button" class="icon-btn" data-del-step aria-label="Прибрати крок">${icon('x', 15)}</button></div>`;
  const timeChip = t => `<span class="tchip time"><input type="time" data-f="time" value="${t}"><button type="button" data-del-time aria-label="Прибрати">${icon('x', 12)}</button></span>`;

  // поля форми → зміни для сервера
  function collect() {
    const v = {
      title: $('[data-f="title"]', root).value.trim() || 'Без назви',
      body: $('[data-f="body"]', root).value,
      steps: $$('.r-step', root).map(x => ({ text: $('[data-f="step"]', x).value.trim(), sec: +$('[data-f="sec"]', x).value || 0 })).filter(x => x.text),
      active: $('[data-f="active"]', root).checked,
      days: $$('.day.on', root).map(b => +b.dataset.day)
    };
    if (mode === 'times') { v.times = $$('[data-f="time"]', root).map(i => i.value).filter(Boolean); if (!v.times.length) v.times = ['09:00']; }
    else Object.assign(v, { times: [], every: +$('[data-f="every"]', root).value, from: $('[data-f="from"]', root).value, to: $('[data-f="to"]', root).value });
    return v;
  }
  async function save(v) {
    const note = $('.r-saved', root);
    try { r = await patch('routines/' + id, v); if (note) note.textContent = 'Збережено'; changed(); }
    catch (e) { if (note) note.textContent = ''; fail(e); }
  }
  const saveMedia = media => save({ media }).then(() => redrawMedia());
  function redrawMedia() {
    const box = $('.r-media', root);
    $$('.r-thumb', box).forEach(x => x.remove());
    box.insertAdjacentHTML('afterbegin', r.media.map((m, i) => `<div class="r-thumb">${mediaThumb(m)}<button type="button" class="r-x" data-del-media="${i}" aria-label="Прибрати">${icon('x', 14)}</button></div>`).join(''));
  }

  async function onClick(e) {
    const t = e.target.closest('[data-a], [data-mode], [data-day], [data-del-step], [data-del-time], [data-del-media]'); if (!t) return;
    const a = t.dataset.a;
    if (t.dataset.mode) {
      mode = t.dataset.mode;
      $$('[data-mode]', root).forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
      $$('[data-when]', root).forEach(x => { x.hidden = x.dataset.when !== mode; });
      return saveSoon();
    }
    if (t.dataset.day) {
      const on = !t.classList.contains('on');
      if (!on && $$('.day.on', root).length === 1) return toast('Хоча б один день');
      t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on)); return saveSoon();
    }
    if (t.hasAttribute('data-del-step')) { t.closest('.r-step').remove(); $$('.r-step .r-n', root).forEach((n, i) => { n.textContent = i + 1; }); return saveSoon(); }
    if (t.hasAttribute('data-del-time')) { if ($$('[data-f="time"]', root).length > 1) { t.closest('.tchip').remove(); saveSoon(); } return; }
    if (t.dataset.delMedia != null) return saveMedia(r.media.filter((_, i) => i !== +t.dataset.delMedia));
    if (a === 'add-step') {
      const box = $('.r-steps', root), n = $$('.r-step', box).length;
      box.insertAdjacentHTML('beforeend', stepRow({ text: '', sec: 30 }, n));
      return $('.r-step:last-child [data-f="step"]', box).focus();
    }
    if (a === 'add-time') {
      const last = $$('[data-f="time"]', root).map(i => i.value).sort().pop() || '08:00';
      const h = Math.min(23, +last.slice(0, 2) + 3);
      t.insertAdjacentHTML('beforebegin', timeChip(`${String(h).padStart(2, '0')}:${last.slice(3)}`));
      return saveSoon();
    }
    if (a === 'emoji') {
      const v = await menu(t, EMOJI.map(x => ({ value: x, label: x, checked: x === r.icon })), { title: 'Значок' });
      if (v) { t.textContent = v; save({ icon: v }); }
      return;
    }
    if (a === 'builtin') {
      const v = await menu(t, ['eyes', 'water', 'breath'].map(k => ({ value: k, label: builtinName(k), icon: 'sparkles' })), { title: 'Анімація в застосунку' });
      if (v) saveMedia([...r.media, { type: v }]);
      return;
    }
    if (a === 'link') return addLink();
    if (a === 'play') return go('#/r/' + id);
    if (a === 'send') { try { const x = await post(`routines/${id}/send`); toast(x.text); } catch (err) { fail(err); } return; }
    if (a === 'delete') {
      if (!await confirmBox(`Видалити ритуал «${r.title}»?`)) return;
      try { await del('routines/' + id); changed(); toast('Видалено'); go('#/rituals'); } catch (err) { fail(err); }
    }
  }
  root = null;
  // файл із телефона: фото стискаємо в браузері, відео — як є (до 60 МБ)
  document.addEventListener('change', onFile);
  async function onFile(e) {
    if (!root || !e.target.matches('[data-a="file"]') || !root.contains(e.target)) return;
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const blob = file.type.startsWith('image/') && file.type !== 'image/gif' ? await shrink(file) : file;
      if (blob.size > 60 * 1024 * 1024) return toast('Файл завеликий — до 60 МБ. Відео краще коротке або посиланням на YouTube.');
      const up = await upload(blob, p => { const bar = $('.r-upload', root); bar.hidden = p >= 1; $('i', bar).style.width = Math.round(p * 100) + '%'; });
      await saveMedia([...r.media, { type: up.type, url: up.url, name: file.name }]);
    } catch (err) { fail(err); $('.r-upload', root).hidden = true; }
  }
  async function addLink() {
    const s = sheet(`<div class="sheet-head"><b>Посилання</b></div><form class="link-form">
      <input type="url" placeholder="https://youtu.be/… або адреса фото" required autocomplete="off" inputmode="url">
      <button class="btn primary" type="submit">Додати</button></form>`, { label: 'Посилання' });
    const inp = $('input', s.el); setTimeout(() => inp.focus(), 250);
    $('form', s.el).addEventListener('submit', ev => {
      ev.preventDefault();
      const url = inp.value.trim();
      if (!/^https:\/\//.test(url)) return toast('Посилання має починатися з https://');
      const type = /youtu\.?be/.test(url) ? 'youtube' : /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) ? 'image' : 'link';
      s.close(); saveMedia([...r.media, { type, url }]);
    });
  }
  function destroy() { document.removeEventListener('change', onFile); }
  return { render, destroy, refresh: () => {} };
}

// Фото до 1600 px, JPEG — швидко вантажиться й гарно виглядає у сповіщенні
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    return out && out.size < file.size ? out : file;
  } catch (e) { return file; }
}
function upload(blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/routines/media');
    for (const [k, v] of Object.entries(authHeaders())) x.setRequestHeader(k, v);
    x.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { onProgress(1); let d = null; try { d = JSON.parse(x.responseText); } catch (e) {}
      x.status === 200 && d ? resolve(d) : reject(new Error((d && d.error) || (x.status === 413 ? 'Файл завеликий.' : 'Не вдалося завантажити.'))); };
    x.onerror = () => { onProgress(1); reject(new Error('Немає звʼязку з сервером.')); };
    onProgress(0.01); x.send(blob);
  });
}

// ---------- смужка на «Сьогодні» ----------
export async function todayRituals(box) {
  let d; try { d = await get('routines'); } catch (e) { box.hidden = true; return; }
  const list = d.list.filter(r => r.active && r.total);
  box.hidden = !list.length;
  box.innerHTML = list.map(r => `<a class="rt-chip${r.pending ? ' pending' : ''}${r.done >= r.total ? ' full' : ''}" href="#/r/${r.id}" style="--p:${r.total ? r.done / r.total : 0}">
    <span class="rt-ring"><span>${esc(r.icon)}</span></span><span class="rt-t"><b>${esc(r.title)}</b><small>${r.pending ? 'зараз' : `${r.done}/${r.total}${r.next ? ' · ' + r.next : ''}`}</small></span></a>`).join('');
}
