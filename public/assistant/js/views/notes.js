// Нотатки: думки й ідеї, які асистент зберіг із голосу чи тексту. Пошук по всьому, теги, швидке додавання.
import { get, post, del } from '../api.js';
import { icon } from '../icons.js';
import { $, esc, fmtDue, fmtDate, debounce, confirmBox, fail, toast } from '../ui.js';

export function notesPage() {
  let root, q = '';
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page">
      <div class="page-head"><h1 class="page-title">Нотатки</h1></div>
      <div class="vbar"><div class="vtools wide">
        <label class="vsearch grow">${icon('search', 15)}<input type="search" placeholder="Пошук або #тег"></label>
      </div></div>
      <div class="note-add"><textarea rows="2" placeholder="Нова нотатка…"></textarea><button type="button" class="btn primary sm">Зберегти</button></div>
      <div class="notes"></div></div>`;
    const s = $('.vsearch input', root), ta = $('.note-add textarea', root);
    s.addEventListener('input', debounce(() => { q = s.value.trim(); load(); }, 250));
    const add = async () => {
      const text = ta.value.trim(); if (!text) return;
      const tags = [...text.matchAll(/#([\p{L}\d_-]+)/gu)].map(m => m[1]);
      try { await post('assistant/items', { kind: 'note', text: text.replace(/\s*#[\p{L}\d_-]+/gu, '').trim() || text, tags }); ta.value = ''; toast('Збережено'); load(); }
      catch (e) { fail(e); }
    };
    $('.note-add button', root).addEventListener('click', add);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } });
    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-tag]'); if (t) { s.value = '#' + t.dataset.tag; q = s.value; return load(); }
      const d = e.target.closest('[data-del]');
      if (d && await confirmBox('Видалити нотатку?')) { try { await del('assistant/items/' + d.dataset.del); load(); } catch (err) { fail(err); } }
    });
    load();
  }
  async function load() {
    const box = $('.notes', root), global = q && !q.startsWith('#');
    let list;
    try { list = global ? (await get('assistant/search?q=' + encodeURIComponent(q))).list : (await get('assistant/notes' + (q ? '?q=' + encodeURIComponent(q) : ''))).list; }
    catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (!list.length) { box.innerHTML = `<div class="empty">${icon('note', 28)}<p>${q ? 'Нічого не знайдено.' : 'Нотаток ще немає.'}</p></div>`; return; }
    box.innerHTML = list.map(n => {
      if (global) {
        const kind = n.type === 'msg' ? 'ви сказали' : { note: 'нотатка', task: 'задача', reminder: 'нагадування' }[n.kind];
        return `<article class="note"><p>${n.done ? '<s>' : ''}${esc(n.text)}${n.done ? '</s>' : ''}</p>
          <footer>${icon(n.type === 'msg' ? 'mic' : n.kind === 'note' ? 'note' : 'checkCircle', 13)}<span>${esc(n.when || '')} · ${kind}</span>${(n.tags || []).map(t => `<button type="button" class="tagp" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</footer></article>`;
      }
      return `<article class="note"><p>${esc(n.text)}</p>
        <footer>${icon('clock', 13)}<span title="${esc(fmtDate(n.created))}">${esc(fmtDue(n.created, false))}</span>${n.project ? `<span>· ${esc(n.project)}</span>` : ''}
          ${n.tags.map(t => `<button type="button" class="tagp" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
          <button type="button" class="icon-btn xs note-del" data-del="${n.id}" title="Видалити">${icon('trash', 14)}</button></footer></article>`;
    }).join('');
  }
  return { render, refresh: () => load() };
}
