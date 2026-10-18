// Нотатки: думки й ідеї, які асистент зберіг із голосу чи тексту. Пошук по всьому, теги.
// Тап по нотатці — редактор (аркуш): текст, теги, автозбереження, «зробити задачею», видалення.
import { get, post, patch, del } from '../api.js';
import { icon } from '../icons.js';
import { $, esc, fmtDue, fmtDate, debounce, confirmBox, fail, toast, sheet, menu, autosize } from '../ui.js';
import { meta } from '../store.js';

const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));

export function notesPage() {
  let root, q = '', list = [];
  function render(el) {
    root = el;
    root.innerHTML = `<div class="page notes-page">
      <div class="page-head"><h1 class="page-title">Нотатки</h1></div>
      <div class="vbar"><div class="vtools wide">
        <label class="vsearch grow">${icon('search', 15)}<input type="search" placeholder="Пошук або #тег"></label>
      </div></div>
      <button type="button" class="note-new desk-only" data-new>${icon('plus', 16)}<span>Нова нотатка</span></button>
      <div class="notes"></div>
      <button type="button" class="fab" data-new aria-label="Нова нотатка" title="Нова нотатка">${icon('plus', 26)}</button></div>`;
    const s = $('.vsearch input', root);
    s.addEventListener('input', debounce(() => { q = s.value.trim(); load(); }, 250));
    root.addEventListener('click', e => {
      const t = e.target.closest('[data-tag]'); if (t) { e.stopPropagation(); s.value = '#' + t.dataset.tag; q = s.value; return load(); }
      if (e.target.closest('[data-new]')) return editNote(null, e.target.closest('[data-new]'));
      const n = e.target.closest('[data-note]'); if (n) editNote(list.find(x => x.id === +n.dataset.note));
    });
    load();
  }
  async function load() {
    const box = $('.notes', root), global = q && !q.startsWith('#');
    try { list = global ? (await get('assistant/search?q=' + encodeURIComponent(q))).list : (await get('assistant/notes' + (q ? '?q=' + encodeURIComponent(q) : ''))).list; }
    catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (!list.length) { box.innerHTML = `<div class="empty">${icon('note', 28)}<p>${q ? 'Нічого не знайдено.' : 'Нотаток ще немає. Надиктуй думку або натисни «+».'}</p></div>`; return; }
    box.innerHTML = list.map((n, i) => {
      if (global) {
        const kind = n.type === 'msg' ? 'ви сказали' : { note: 'нотатка', task: 'задача', reminder: 'нагадування' }[n.kind];
        const editable = n.type !== 'msg' && n.kind === 'note';
        return `<article class="note" style="--i:${Math.min(i, 12)}" ${editable ? `data-note="${n.id}" tabindex="0"` : ''}><p>${n.done ? '<s>' : ''}${esc(n.text)}${n.done ? '</s>' : ''}</p>
          <footer>${icon(n.type === 'msg' ? 'mic' : n.kind === 'note' ? 'note' : 'checkCircle', 13)}<span>${esc(n.when || '')} · ${kind}</span>${(n.tags || []).map(t => `<button type="button" class="tagp" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</footer></article>`;
      }
      return `<article class="note" style="--i:${Math.min(i, 12)}" data-note="${n.id}" tabindex="0"><p>${esc(n.text)}</p>
        <footer><span title="${esc(fmtDate(n.created))}">${esc(fmtDue(n.created, false))}</span>
          ${n.tags.map(t => `<button type="button" class="tagp" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</footer></article>`;
    }).join('');
  }
  return { render, refresh: () => load() };
}

// Редактор нотатки. n — нотатка або null (нова). Зберігає сам: створює при першому тексті, далі змінює.
export function editNote(n) {
  let id = n ? n.id : null, tags = n ? [...(n.tags || [])] : [], saving = Promise.resolve(), dirty = false;
  const s = sheet(`
    <div class="sheet-head note-head">
      <span class="muted small">${n ? esc(fmtDate(n.created)) : 'Нова нотатка'}</span>
      <span class="note-acts">
        <span class="note-state muted small" aria-live="polite"></span>
        ${n ? `<button type="button" class="icon-btn" data-more aria-label="Ще">${icon('more', 18)}</button>` : ''}
        <button type="button" class="icon-btn" data-close aria-label="Готово">${icon('check', 18)}</button>
      </span>
    </div>
    <textarea class="note-text" placeholder="Думка, ідея, запис…" maxlength="20000">${esc(n ? n.text : '')}</textarea>
    <div class="tagbox note-tags"></div>
    <datalist id="noteTags">${(meta.tags || []).map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>`,
    { cls: 'note-sheet', label: 'Нотатка', onClose: () => { flush(); } });
  const ta = $('.note-text', s.el), state = $('.note-state', s.el);
  const drawTags = () => {
    $('.note-tags', s.el).innerHTML = tags.map(t => `<span class="tchip">#${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Прибрати тег">${icon('x', 12)}</button></span>`).join('') +
      `<input class="tag-in" list="noteTags" placeholder="${tags.length ? '' : 'Додати тег'}" enterkeyhint="done" autocapitalize="off" maxlength="30">`;
  };
  drawTags(); autosize(ta);
  setTimeout(() => { if (!n) ta.focus(); }, 280);

  function save() {
    const text = ta.value.trim();
    if (!text) return saving;
    dirty = false;
    saving = saving.then(async () => {
      state.textContent = 'Зберігаю…';
      try {
        if (id) await patch('assistant/items/' + id, { text, tags });
        else id = (await post('assistant/items', { kind: 'note', text, tags })).id;
        state.textContent = 'Збережено'; changed();
      } catch (e) { state.textContent = ''; fail(e); }
    });
    return saving;
  }
  const saveSoon = debounce(save, 700);
  const flush = () => { if (dirty) save(); };
  ta.addEventListener('input', () => { autosize(ta); dirty = true; state.textContent = ''; saveSoon(); });
  const addTag = inp => {
    const t = inp.value.trim().replace(/^#/, '').toLowerCase(); inp.value = '';
    if (t && !tags.includes(t)) { tags.push(t); drawTags(); dirty = true; save(); $('.tag-in', s.el).focus(); }
  };
  s.el.addEventListener('keydown', e => {
    if (!e.target.classList.contains('tag-in')) return;
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(e.target); }
    else if (e.key === 'Backspace' && !e.target.value && tags.length) { tags.pop(); drawTags(); dirty = true; save(); $('.tag-in', s.el).focus(); }
  });
  s.el.addEventListener('change', e => { if (e.target.classList.contains('tag-in') && e.target.value.trim()) addTag(e.target); });
  s.el.addEventListener('click', async e => {
    const u = e.target.closest('[data-untag]'); if (u) { tags = tags.filter(t => t !== u.dataset.untag); drawTags(); dirty = true; return save(); }
    if (e.target.closest('[data-close]')) return s.close();
    const m = e.target.closest('[data-more]'); if (!m) return;
    const v = await menu(m, [{ value: 'task', label: 'Зробити задачею', icon: 'checkCircle' }, { value: 'copy', label: 'Копіювати текст', icon: 'copy' },
                             { sep: true }, { value: 'delete', label: 'Видалити', icon: 'trash', danger: true }]);
    if (v === 'copy') navigator.clipboard.writeText(ta.value).then(() => toast('Скопійовано'), () => {});
    if (v === 'task') { await save(); try { await patch('assistant/items/' + id, { kind: 'task' }); dirty = false; s.close(); changed(); toast('Тепер це задача у «Вхідних»'); } catch (err) { fail(err); } }
    if (v === 'delete' && await confirmBox('Видалити нотатку?')) {
      try { await saving; await del('assistant/items/' + id); dirty = false; s.close(); changed(); toast('Видалено'); } catch (err) { fail(err); }
    }
  });
  return s;
}
