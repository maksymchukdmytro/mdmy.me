// Доручення між акаунтами (#/team): «Мені» — що доручили мені; «Я доручив» — кому доручив я, і що чекає підтвердження.
// Деталі — аркуш поверх списку (#/team/a/<id>): виконавець пише звіт і додає докази (фото, файл, посилання) → «Надіслати на перевірку»;
// той, хто доручив, підтверджує, повертає на доопрацювання з коментарем або ставить «не виконано».
// Хто може давати задачі — Налаштування → Команда (публічний ID). Сервер — lib/team.js.
import { get, post, patch, del } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, esc, toast, fail, sheet, menu, confirmBox, fmtDue, pref, localInput } from '../ui.js';
import { go } from '../nav.js';
import { attachHtml, bindAttach, uploadFile } from './attach.js';

const ST = { open: 'До виконання', submitted: 'На перевірці', rework: 'На доопрацюванні', approved: 'Виконано', failed: 'Не виконано' };
const ST_IC = { open: 'circle', submitted: 'clock', rework: 'undo', approved: 'checkCircle', failed: 'x' };
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

export function teamPage(parts) {
  let root, tab = pref.get('team-tab', 'me'), info = null, list = [], showDone = false, openId = null, sh = null;
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page team-page"><div class="page-head"><h1 class="page-title">Доручення</h1></div>
      <div class="seg daily-tabs tm-tabs"><button type="button" data-tab="me">Мені</button><button type="button" data-tab="boss">Я доручив</button></div>
      <div class="tm-body"><span class="spin"></span></div></div>`;
    root.addEventListener('click', onClick);
    load();
    route(parts);
  }
  async function load() {
    try { [info, list] = await Promise.all([get('team'), get('team/tasks?role=' + (tab === 'boss' ? 'boss' : 'member')).then(r => r.list)]); }
    catch (e) { $('.tm-body', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    $$('.tm-tabs [data-tab]', root).forEach(b => {
      const n = b.dataset.tab === 'me' ? info.counts.todo : info.counts.review;
      b.setAttribute('aria-checked', String(b.dataset.tab === tab));
      b.innerHTML = (b.dataset.tab === 'me' ? 'Мені' : 'Я доручив') + (n ? ` <b class="tm-n">${n}</b>` : '');
    });
    const box = $('.tm-body', root);
    const people = tab === 'me' ? info.bosses : info.members;
    if (!people.length && !list.length) {
      box.innerHTML = `<div class="empty tm-empty">${icon('users', 30)}<p>${tab === 'me'
        ? 'Тут зʼявляться задачі від інших людей. Щоб хтось міг давати вам задачі, дозвольте йому в налаштуваннях — за його ID.'
        : 'Щоб доручати задачі, попросіть людину вписати ваш ID у її налаштуваннях: Команда → «Отримувати задачі від».'}</p>
        <p class="tm-myid">Ваш ID: <b>${esc(info.me.pub_id)}</b> <button type="button" class="link" data-copy="${esc(info.me.pub_id)}">копіювати</button></p>
        <a class="btn sm" href="#/settings/team">${icon('settings', 14)}Налаштування команди</a></div>`;
      return;
    }
    const groups = tab === 'me'
      ? [['Зробити', list.filter(x => x.status === 'open' || x.status === 'rework')], ['На перевірці', list.filter(x => x.status === 'submitted')]]
      : [['Чекає підтвердження', list.filter(x => x.status === 'submitted')], ['В роботі', list.filter(x => x.status === 'open' || x.status === 'rework')]];
    const closed = list.filter(x => x.status === 'approved' || x.status === 'failed');
    box.innerHTML = (tab === 'boss' && info.members.length ? `<button type="button" class="btn primary tm-new" data-new>${icon('plus', 16)}Доручити задачу</button>` : '') +
      groups.filter(([, l]) => l.length).map(([t, l]) => `<p class="m-label tm-g">${t} <span>${l.length}</span></p>${l.map(card).join('')}`).join('') +
      (closed.length ? `<button type="button" class="tm-more" data-done>${icon(showDone ? 'chevronDown' : 'chevronRight', 14)}Завершені <span>${closed.length}</span></button>${showDone ? closed.map(card).join('') : ''}` : '') +
      (!groups.some(([, l]) => l.length) && !closed.length ? `<p class="muted tm-none">${tab === 'me' ? 'Нових доручень немає 🙂' : 'Ви ще нічого не доручали.'}</p>` : '');
  }
  function card(x) {
    const other = tab === 'me' ? x.boss : x.member;
    return `<a class="tm-card st-${x.status}" href="#/team/a/${x.id}">
      <span class="tm-ic">${icon(ST_IC[x.status], 16)}</span>
      <span class="tm-txt"><b>${esc(x.text)}</b>
        <small>${esc(other ? (tab === 'me' ? 'від ' : 'для ') + other.name : '')}${x.due_at ? ' · ' + esc(fmtDue(x.due_at)) : ''}${x.files.length ? ` · ${icon('paperclip', 12)}${x.files.length}` : ''}</small>
        ${x.status === 'rework' && x.review_note ? `<small class="tm-note">${esc(x.review_note)}</small>` : ''}</span>
      <span class="tm-st">${ST[x.status]}</span></a>`;
  }
  async function onClick(e) {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; pref.set('team-tab', tab); return load(); }
    const c = e.target.closest('[data-copy]'); if (c) return navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Скопійовано'), () => {});
    if (e.target.closest('[data-done]')) { showDone = !showDone; return draw(); }
    if (e.target.closest('[data-new]')) return newTask();
  }

  // ---------- нове доручення ----------
  function newTask() {
    const ms = info.members;
    const s = sheet(`<div class="sheet-head"><b>Доручити задачу</b></div>
      <form class="tm-form">
        <label class="field"><span>Кому</span><select name="member">${ms.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
        <input name="text" placeholder="Що зробити" maxlength="500" required autocomplete="off">
        <textarea name="description" rows="3" placeholder="Деталі, що саме показати у звіті…" maxlength="5000"></textarea>
        <label class="field"><span>Строк</span><input type="datetime-local" name="due"></label>
        <label class="switch"><input type="checkbox" name="proof" checked><span>Потрібен доказ — фото, файл або посилання</span></label>
        <button class="btn primary" type="submit">Доручити</button>
      </form>`, { label: 'Доручити задачу' });
    const f = $('form', s.el); setTimeout(() => f.text.focus(), 250);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('button[type=submit]', f); btn.disabled = true;
      try {
        await post('team/tasks', { member_id: +f.member.value, text: f.text.value, description: f.description.value, due_at: f.due.value ? new Date(f.due.value).getTime() : null, need_proof: f.proof.checked });
        s.close(); toast('Доручено — людина отримає сповіщення'); tab = 'boss'; pref.set('team-tab', tab); load();
      } catch (err) { fail(err); btn.disabled = false; }
    });
  }

  // ---------- деталі (#/team/a/<id>) ----------
  async function open(id) {
    if (openId === id && sh) return;
    openId = id;
    let x; try { x = await get('team/tasks/' + id); } catch (e) { fail(e); return go('#/team'); }
    if (openId !== id) return;
    if (sh) { const old = sh; sh = null; old.close(); }
    sh = sheet('<div class="tm-detail"></div>', { cls: 'tm-sheet', label: 'Доручення', onClose: () => { sh = null; openId = null; if (/^#\/team\/a\//.test(location.hash)) go('#/team'); } });
    drawDetail(x);
  }
  function drawDetail(x) {
    if (!sh) return;
    const box = $('.tm-detail', sh.el), member = x.mine, live = ['open', 'rework', 'submitted'].includes(x.status);
    box.innerHTML = `
      <div class="tm-dh"><span class="tm-chip st-${x.status}">${icon(ST_IC[x.status], 14)}${ST[x.status]}</span>
        ${!member ? `<button type="button" class="icon-btn" data-more aria-label="Ще">${icon('more', 18)}</button>` : ''}</div>
      <h2>${esc(x.text)}</h2>
      <p class="muted small">${member ? 'Доручив(ла) ' + esc(x.boss.name) : 'Виконує ' + esc(x.member.name)}${x.due_at ? ' · строк ' + esc(fmtDue(x.due_at)) : ''}${x.need_proof ? ' · потрібен доказ' : ''}</p>
      ${x.description ? `<p class="tm-desc">${esc(x.description)}</p>` : ''}
      ${x.review_note && (x.status === 'rework' || x.status === 'failed' || x.status === 'approved') ? `<div class="tm-callout">${icon(x.status === 'approved' ? 'checkCircle' : 'undo', 15)}<span>${esc(x.review_note)}</span></div>` : ''}
      <section class="tm-rep"><h3>Звіт</h3>
        ${member && live ? `<textarea class="tm-report" rows="3" placeholder="Що зроблено, коментар…" maxlength="5000">${esc(x.report)}</textarea>`
                         : x.report ? `<p class="tm-desc">${esc(x.report)}</p>` : `<p class="muted small">${x.status === 'open' ? 'Ще не здано.' : 'Без коментаря.'}</p>`}
        <div class="tm-files">${x.files.length || (member && live) ? attachHtml(x.files.map(f => ({ ...f, canDelete: member && live })), { edit: member && live }) : ''}</div>
      </section>
      <div class="tm-acts">${member && live ? `<button type="button" class="btn primary wide" data-a="submit">${icon('send', 16)}${x.status === 'submitted' ? 'Оновити звіт' : 'Готово — надіслати на перевірку'}</button>` : ''}
        ${!member && x.status === 'submitted' ? `<button type="button" class="btn primary wide tm-ok" data-a="approve">${icon('check', 16)}Підтвердити виконання</button>
          <div class="tm-two"><button type="button" class="btn" data-a="rework">${icon('undo', 15)}На доопрацювання</button><button type="button" class="btn ghost danger" data-a="fail">Не виконано</button></div>` : ''}
        ${!member && (x.status === 'open' || x.status === 'rework') ? `<p class="muted small tm-wait">Чекаємо, поки ${esc(x.member.name)} здасть звіт.</p>` : ''}</div>`;
    const fb = $('.tm-files', box);
    if (member && live) bindAttach(fb, {
      upload: f => uploadFile(`team/tasks/${x.id}/files`, f), link: url => post(`team/tasks/${x.id}/files`, { url }),
      remove: async id => { await del('shared/files/' + id); return get('team/tasks/' + x.id); }, after: r => { if (r && r.id === x.id) { x.files = r.files; drawDetail({ ...x, report: $('.tm-report', box) ? $('.tm-report', box).value : x.report }); } }
    });
    box.onclick = async e => {
      const b = e.target.closest('[data-a], [data-more]'); if (!b) return;
      if (b.hasAttribute('data-more')) {
        const v = await menu(b, [{ value: 'del', label: 'Видалити доручення', icon: 'trash', danger: true }]);
        if (v === 'del' && await confirmBox('Видалити доручення разом зі звітом?')) { try { await del('team/tasks/' + x.id); sh.close(); toast('Видалено'); load(); } catch (err) { fail(err); } }
        return;
      }
      const a = b.dataset.a;
      try {
        if (a === 'submit') { const r = await post(`team/tasks/${x.id}/submit`, { report: $('.tm-report', box).value }); toast('Надіслано на перевірку'); drawDetail(r); }
        if (a === 'approve') { drawDetail(await post(`team/tasks/${x.id}/review`, { verdict: 'approve' })); toast('Підтверджено'); }
        if (a === 'fail' && await confirmBox('Позначити як не виконано?', { ok: 'Не виконано' })) drawDetail(await post(`team/tasks/${x.id}/review`, { verdict: 'fail' }));
        if (a === 'rework') { const note = await askNote(); if (note) { drawDetail(await post(`team/tasks/${x.id}/review`, { verdict: 'rework', note })); toast('Повернуто на доопрацювання'); } }
        load(); changed();
      } catch (err) { fail(err); }
    };
  }
  function askNote() {
    return new Promise(resolve => {
      let done = false;
      const s = sheet(`<div class="sheet-head"><b>Що доопрацювати?</b></div><form class="link-form col"><textarea rows="3" placeholder="Наприклад: додай фото другої полиці" maxlength="2000" required></textarea>
        <button class="btn primary" type="submit">Повернути</button></form>`, { label: 'Доопрацювання', onClose: () => { if (!done) resolve(null); } });
      const ta = $('textarea', s.el); setTimeout(() => ta.focus(), 250);
      $('form', s.el).addEventListener('submit', e => { e.preventDefault(); if (!ta.value.trim()) return; done = true; s.close(); resolve(ta.value.trim()); });
    });
  }
  function route(p) {
    if (p && p[1] === 'a' && +p[2]) open(+p[2]);
    else if (sh) { const old = sh; sh = null; openId = null; old.close(); }
  }
  return { render, refresh: load, route, destroy: () => { if (sh) { const o = sh; sh = null; o.close(); } } };
}
