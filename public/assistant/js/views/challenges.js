// Челенджі (#/challenges, #/challenges/<id>): створити (отримує код), долучитися за кодом, щоденна відмітка,
// таблиця учасників. Автор вирішує: відмітки з підтвердженням чи без, і чи потрібен доказ (фото, файл, посилання).
// Сервер — lib/team.js (/api/challenges/*).
import { get, post, patch, del } from '../api.js';
import { icon } from '../icons.js';
import { $, esc, toast, fail, sheet, confirmBox } from '../ui.js';
import { go } from '../nav.js';
import { attachHtml, bindAttach, uploadFile } from './attach.js';

const dn = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
const MON = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const fmtDay = d => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`;
const TODAY = { ok: ['checkCircle', 'Сьогодні зараховано'], pending: ['clock', 'Чекає підтвердження'], rejected: ['x', 'Відхилено — можна надіслати ще раз'] };
const share = c => {
  const text = `Долучайся до челенджу «${c.title}» у mdmy: код ${c.code}`;
  if (navigator.share) navigator.share({ title: c.title, text, url: location.origin + '/#/challenges' }).catch(() => {});
  else navigator.clipboard.writeText(text).then(() => toast('Запрошення скопійовано'), () => {});
};

export function challengesPage(id) {
  return id ? detailPage(+id) : listPage();
}

// ---------- список ----------
function listPage() {
  let root, list = [];
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page ch-page"><div class="page-head"><h1 class="page-title">Челенджі</h1></div>
      <div class="ch-top"><button type="button" class="btn primary" data-a="new">${icon('plus', 16)}Створити</button><button type="button" class="btn" data-a="join">${icon('hash', 15)}Долучитися за кодом</button></div>
      <div class="ch-list"><span class="spin"></span></div></div>`;
    root.addEventListener('click', onClick);
    load();
  }
  async function load() {
    try { list = (await get('challenges')).list; } catch (e) { $('.ch-list', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const box = $('.ch-list', root);
    if (!list.length) { box.innerHTML = `<div class="empty">${icon('trophy', 30)}<p>Челендж — спільна ціль на кілька днів: «30 днів без цукру», «10 000 кроків щодня».<br>Створіть свій і поділіться кодом — або долучіться до чужого.</p></div>`; return; }
    box.innerHTML = list.map(c => {
      const p = Math.round(c.done / c.days * 100);
      return `<a class="ch-card${c.state === 'ended' ? ' ended' : ''}" href="#/challenges/${c.id}">
        <div class="ch-row"><b>${esc(c.title)}</b><span class="ch-code">${esc(c.code)}</span></div>
        <div class="ch-bar"><i style="width:${p}%"></i></div>
        <div class="ch-row small muted"><span>${c.state === 'soon' ? 'Старт ' + fmtDay(c.start_day) : c.state === 'ended' ? 'Завершено' : `День ${c.dayNo} з ${c.days}`} · ${c.done} ${dn(c.done, 'день', 'дні', 'днів')} зараховано</span>
          <span>${icon('users', 13)} ${c.members}${c.pending ? ` · <b class="ch-pend">${c.pending} на перевірку</b>` : ''}${c.todayStatus === 'ok' ? ' · ✓' : ''}</span></div></a>`;
    }).join('');
  }
  async function onClick(e) {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'new') createSheet(c => go('#/challenges/' + c.id));
    if (a.dataset.a === 'join') joinSheet(c => go('#/challenges/' + c.id));
  }
  return { render, refresh: load };
}

function createSheet(done) {
  const today = new Date(), iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const s = sheet(`<div class="sheet-head"><b>Новий челендж</b></div>
    <form class="tm-form">
      <input name="title" placeholder="Назва: 30 днів без цукру" maxlength="120" required autocomplete="off">
      <textarea name="description" rows="2" placeholder="Правила: що вважається виконанням дня" maxlength="3000"></textarea>
      <div class="field"><span>Тривалість</span><div class="ch-days">${[7, 21, 30, 66, 100].map(d => `<button type="button" class="chip${d === 30 ? ' on' : ''}" data-d="${d}">${d}</button>`).join('')}<input name="days" type="number" min="1" max="365" value="30" inputmode="numeric"><span class="muted small">днів</span></div></div>
      <label class="field"><span>Старт</span><input type="date" name="start" value="${iso}"></label>
      <label class="switch"><input type="checkbox" name="confirm"><span>Я підтверджую кожну відмітку учасників</span></label>
      <label class="switch"><input type="checkbox" name="proof"><span>Відмітка лише з доказом — фото, файл або посилання</span></label>
      <button class="btn primary" type="submit">Створити й отримати код</button>
    </form>`, { label: 'Новий челендж' });
  const f = $('form', s.el); setTimeout(() => f.title.focus(), 250);
  s.el.addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (!b) return; f.days.value = b.dataset.d; s.el.querySelectorAll('[data-d]').forEach(x => x.classList.toggle('on', x === b)); });
  f.addEventListener('submit', async e => {
    e.preventDefault(); const btn = $('button[type=submit]', f); btn.disabled = true;
    try { const c = await post('challenges', { title: f.title.value, description: f.description.value, days: +f.days.value, start_day: f.start.value, confirm: f.confirm.checked, need_proof: f.proof.checked }); s.close(); toast('Код челенджу: ' + c.code); done(c); }
    catch (err) { fail(err); btn.disabled = false; }
  });
}
function joinSheet(done) {
  const s = sheet(`<div class="sheet-head"><b>Долучитися за кодом</b></div><form class="link-form"><input placeholder="Код, напр. K7Q2XP" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false" required>
    <button class="btn primary" type="submit">Долучитися</button></form>`, { label: 'Долучитися' });
  const inp = $('input', s.el); setTimeout(() => inp.focus(), 250);
  $('form', s.el).addEventListener('submit', async e => {
    e.preventDefault();
    try { const c = await post('challenges/join', { code: inp.value }); s.close(); toast('Ви в челенджі «' + c.title + '»'); done(c); } catch (err) { fail(err); }
  });
}

// ---------- челендж ----------
function detailPage(id) {
  let root, c = null;
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page ch-detail"><a class="back" href="#/challenges">${icon('chevronLeft', 18)}Челенджі</a><div class="ch-body"><span class="spin"></span></div></div>`;
    root.addEventListener('click', onClick);
    load();
  }
  async function load() {
    try { c = await get('challenges/' + id); } catch (e) { $('.ch-body', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    const p = Math.round(c.done / c.days * 100), ts = c.todayStatus, active = c.state === 'active';
    $('.ch-body', root).innerHTML = `
      <h1 class="ch-title">${esc(c.title)}</h1>
      <div class="ch-meta"><button type="button" class="ch-code big" data-a="share" title="Поділитися кодом">${icon('hash', 14)}${esc(c.code)}</button>
        <span class="muted small">${c.state === 'soon' ? 'Старт ' + fmtDay(c.start_day) : c.state === 'ended' ? 'Завершено' : `День ${c.dayNo} з ${c.days}`} · до ${fmtDay(c.end_day)} · автор ${esc(c.owner.name)}</span></div>
      ${c.description ? `<p class="tm-desc">${esc(c.description)}</p>` : ''}
      <div class="ch-rules">${c.confirm ? `<span>${icon('checkCircle', 13)}Відмітки підтверджує автор</span>` : ''}${c.need_proof ? `<span>${icon('paperclip', 13)}Потрібен доказ</span>` : ''}</div>
      <div class="ch-me">
        <div class="ch-ring"><b>${c.done}</b><small>з ${c.days}</small></div>
        <div class="ch-bar big"><i style="width:${p}%"></i></div>
        ${active ? (ts === 'ok' ? `<p class="ch-ok">${icon('checkCircle', 18)}${TODAY.ok[1]}</p>`
          : `<button type="button" class="btn primary wide ch-go" data-a="check">${icon('check', 18)}${ts === 'pending' ? 'Доповнити відмітку' : 'Відмітити сьогодні'}</button>
             ${ts ? `<p class="small muted ch-ts">${icon(TODAY[ts][0], 14)}${TODAY[ts][1]}</p>` : ''}`) : ''}
      </div>
      <section class="ch-sec"><h3>Мої дні</h3><div class="ch-grid">${c.myDays.map((d, i) => `<span class="ch-d ${d.status || ''}${d.future ? ' fut' : ''}${d.day === c.today ? ' today' : ''}" title="${fmtDay(d.day)}">${d.status === 'ok' ? icon('check', 12) : d.status === 'rejected' ? icon('x', 11) : i + 1}</span>`).join('')}</div></section>
      ${c.isOwner && c.queue && c.queue.length ? `<section class="ch-sec"><h3>На підтвердження <span class="tm-n">${c.queue.length}</span></h3>${c.queue.map(q => `
        <div class="ch-q" data-q="${q.id}"><div><b>${esc(q.name)}</b> <span class="muted small">${fmtDay(q.day)}</span>${q.note ? `<p>${esc(q.note)}</p>` : ''}${q.files.length ? attachHtml(q.files, { edit: false }) : ''}</div>
          <div class="ch-qa"><button type="button" class="icon-btn ok" data-rv="1" aria-label="Зарахувати">${icon('check', 18)}</button><button type="button" class="icon-btn" data-rv="0" aria-label="Відхилити">${icon('x', 18)}</button></div></div>`).join('')}</section>` : ''}
      <section class="ch-sec"><h3>Учасники · ${c.board.length}</h3>${c.board.map((m, i) => `<div class="ch-m${m.me ? ' me' : ''}"><span class="ch-place">${i + 1}</span><span class="ch-mn">${esc(m.name)}${m.me ? ' (ви)' : ''}</span>
        <span class="ch-bar"><i style="width:${Math.round(m.done / c.days * 100)}%"></i></span><b>${m.done}</b></div>`).join('')}
        <button type="button" class="btn sm ghost" data-a="share">${icon('users', 14)}Запросити — поділитися кодом</button></section>
      <section class="ch-sec ch-foot">${c.isOwner ? `
        <label class="switch"><input type="checkbox" data-set="confirm" ${c.confirm ? 'checked' : ''}><span>Підтверджувати відмітки</span></label>
        <label class="switch"><input type="checkbox" data-set="need_proof" ${c.need_proof ? 'checked' : ''}><span>Лише з доказом</span></label>
        <div class="row-act">${c.closed ? '' : '<button type="button" class="btn sm" data-a="close">Завершити челендж</button>'}<button type="button" class="btn sm ghost danger" data-a="delete">${icon('trash', 14)}Видалити</button></div>`
        : `<button type="button" class="btn sm ghost danger" data-a="leave">Вийти з челенджу</button>`}</section>`;
  }
  // відмітка: без підтвердження й доказу — одним дотиком; інакше — аркуш із коментарем і доказами
  async function check() {
    if (!c.confirm && !c.need_proof) {
      try { c = await post(`challenges/${id}/check`, { final: true }); draw(); toast('Зараховано ✓', async () => { c = await post(`challenges/${id}/check`, { undo: true }); draw(); }); if (navigator.vibrate) navigator.vibrate([15, 50, 25]); }
      catch (err) { fail(err); }
      return;
    }
    const tc = c.todayCheck;
    const s = sheet(`<div class="sheet-head"><b>${esc(c.title)} — сьогодні</b></div>
      <form class="tm-form"><textarea name="note" rows="2" placeholder="Коментар (необовʼязково)" maxlength="2000">${esc(tc ? tc.note : '')}</textarea>
        <div class="ch-files">${attachHtml(tc ? tc.files : [])}</div>
        ${c.need_proof ? '<p class="muted small">Потрібен доказ: фото, файл або посилання.</p>' : ''}
        <button class="btn primary" type="submit">${c.confirm ? 'Надіслати на підтвердження' : 'Зарахувати день'}</button></form>`, { label: 'Відмітка' });
    const box = $('.ch-files', s.el);
    bindAttach(box, {
      upload: f => uploadFile(`challenges/${id}/files`, f), link: url => post(`challenges/${id}/files`, { url }),
      remove: async fid => { await del('shared/files/' + fid); return get('challenges/' + id); },
      after: r => { if (r && r.todayCheck) { c = r; box.innerHTML = attachHtml(r.todayCheck.files); } }
    });
    $('form', s.el).addEventListener('submit', async e => {
      e.preventDefault();
      try { c = await post(`challenges/${id}/check`, { note: e.target.note.value, final: true }); s.close(); draw(); toast(c.confirm ? 'Надіслано автору челенджу' : 'Зараховано ✓'); }
      catch (err) { fail(err); }
    });
  }
  async function onClick(e) {
    const rv = e.target.closest('[data-rv]');
    if (rv) { const q = rv.closest('[data-q]'); try { c = await post(`challenges/${id}/review/${q.dataset.q}`, { ok: rv.dataset.rv === '1' }); draw(); } catch (err) { fail(err); } return; }
    const set = e.target.closest('[data-set]');
    if (set) { try { c = await patch('challenges/' + id, { [set.dataset.set]: set.checked }); draw(); } catch (err) { fail(err); } return; }
    const a = e.target.closest('[data-a]'); if (!a) return;
    const k = a.dataset.a;
    if (k === 'share') share(c);
    if (k === 'check') check();
    if (k === 'close' && await confirmBox('Завершити челендж? Відмітки більше не прийматимуться.', { ok: 'Завершити', danger: false })) { try { c = await patch('challenges/' + id, { closed: true }); draw(); } catch (err) { fail(err); } }
    if (k === 'delete' && await confirmBox(`Видалити челендж «${c.title}» для всіх учасників?`)) { try { await del('challenges/' + id); toast('Видалено'); go('#/challenges'); } catch (err) { fail(err); } }
    if (k === 'leave' && await confirmBox('Вийти з челенджу?', { ok: 'Вийти' })) { try { await post(`challenges/${id}/leave`); go('#/challenges'); } catch (err) { fail(err); } }
  }
  return { render, refresh: load };
}
