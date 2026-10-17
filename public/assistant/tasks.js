// Вкладка «Задачі»: сфери (📥 несортовані / 💼 робочі / 🏠 особисті), види (сьогодні, прострочені…), пошук, сортування,
// сторінки по 100, масові дії, швидке редагування й режим «Розібрати по одній» для несортованих.
// Дані: /api/assistant/tasks (фільтри на сервері), /api/assistant/item, /api/assistant/bulk, /api/assistant/triage.
(() => {
  const MD = window.MD, api = MD.api, $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const AREA = { inbox: { icon: '📥', name: 'Несортовані', one: 'несортовані' }, work: { icon: '💼', name: 'Робочі', one: 'робочі' }, personal: { icon: '🏠', name: 'Особисті', one: 'особисті' } };
  const PRIO = [{ mark: '', title: 'Звичайна' }, { mark: '❗', title: 'Важлива' }, { mark: '‼️', title: 'Термінова' }];
  const PAGE = 100, PREF = 'mdmy-tasks';

  const st = { area: 'inbox', view: 'open', sort: 'smart', q: '', project: '', prio: '', items: [], total: 0, counts: null,
               select: false, selected: new Set(), open: null, sug: new Map(), loading: 0 };
  try { Object.assign(st, JSON.parse(localStorage.getItem(PREF) || '{}')); } catch (e) {}
  st.q = ''; st.project = ''; st.prio = '';
  const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify({ area: st.area, view: st.view, sort: st.sort })); } catch (e) {} };
  const byId = id => { for (const it of st.items) { if (it.id === id) return it; for (const c of it.children) if (c.id === id) return c; } return null; };

  // ---------- завантаження ----------
  function query(offset) {
    const p = new URLSearchParams({ area: st.area, view: st.view, sort: st.sort, offset, limit: PAGE });
    if (st.q) p.set('q', st.q); if (st.project) p.set('project', st.project); if (st.prio) p.set('prio', st.prio);
    return 'assistant/tasks?' + p;
  }
  async function load(more) {
    const my = ++st.loading;
    if (!more) $('taskList').classList.add('tk-busy');
    let d;
    try { d = await api(query(more ? st.items.length : 0)); }
    catch (e) { $('taskList').classList.remove('tk-busy'); $('taskList').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (my !== st.loading) return;          // встигли змінити фільтр — ця відповідь уже не потрібна
    st.items = more ? st.items.concat(d.list) : d.list;
    st.total = d.total; st.counts = d.counts;
    renderCounts(); renderProjects(d.projects); render();
    $('taskList').classList.remove('tk-busy');
  }
  const reload = () => load(false);
  MD.refreshTasks = async () => {
    try { const d = await api('assistant/tasks?limit=1'); st.counts = d.counts; renderCounts(); } catch (e) {}
  };

  // ---------- шапка: сфери, види, лічильники ----------
  function renderCounts() {
    const c = st.counts; if (!c) return;
    for (const b of $('tkAreas').querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.area === st.area));
      b.querySelector('span').textContent = c.areas[b.dataset.area] || '';
    }
    for (const b of $('tkViews').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.view === st.view));
      const n = c.views[b.dataset.view] || 0;
      b.querySelector('span').textContent = n || '';
      b.classList.toggle('warn', b.dataset.view === 'overdue' && n > 0);
    }
    const inbox = c.areas.inbox || 0;
    $('tkInboxBar').hidden = !(st.area === 'inbox' && inbox > 0 && st.view !== 'done');
    $('tkInboxN').textContent = inbox;
    const tc = $('taskCount'); tc.hidden = !c.areas.all; tc.textContent = c.areas.all;
    tc.title = inbox ? `Відкритих: ${c.areas.all}, з них несортованих: ${inbox}` : `Відкритих: ${c.areas.all}`;
    tc.classList.toggle('tk-has-inbox', inbox > 0);
    $('tkAddArea').value = st.area === 'all' ? 'inbox' : st.area;
    $('tkSort').value = st.sort;
    const accept = [...st.sug.values()].length;
    $('tkAcceptAll').hidden = !accept || st.area !== 'inbox';
    $('tkAcceptAll').querySelector('span').textContent = accept;
  }
  function renderProjects(list) {
    const sel = $('tkProject'), cur = st.project;
    sel.innerHTML = '<option value="">Усі проєкти</option>' + list.map(p => `<option value="${p.id}">📁 ${esc(p.name)}${p.open ? ` (${p.open})` : ''}</option>`).join('');
    sel.value = list.some(p => String(p.id) === String(cur)) ? cur : '';
    sel.hidden = !list.length;
    $('tkProjList').innerHTML = list.map(p => `<option value="${esc(p.name)}">`).join('');
  }

  // ---------- список ----------
  const DAY = 864e5;
  function bucket(it) {
    if (st.view === 'done') return 'Виконані';
    if (st.sort !== 'smart') return '';
    if (!it.due_at) return 'Без строку';
    const now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const t0 = d0.getTime(), t1 = t0 + DAY, t2 = t1 + DAY, t7 = t0 + 7 * DAY;
    if (it.overdue && !(it.kind === 'reminder' && it.sent)) return 'Прострочено';
    if (it.due_at < t1) return 'Сьогодні';
    if (it.due_at < t2) return 'Завтра';
    if (it.due_at < t7) return 'Найближчі 7 днів';
    return now && 'Пізніше';
  }
  function render() {
    const box = $('taskList');
    if (!st.items.length) {
      const empty = st.q || st.project || st.prio ? 'Нічого не знайдено. Змініть пошук чи фільтри.'
        : st.view === 'done' ? 'Тут зʼявляться виконані задачі.'
        : st.area === 'inbox' ? 'Несортованих задач немає 🎉 Нові без явної сфери потраплятимуть сюди.'
        : 'Поки порожньо. Додайте задачу вище або скажіть на вкладці «Запис»: «робоче: підготувати звіт до пʼятниці».';
      box.innerHTML = `<p class="st-empty muted">${empty}</p>`;
    } else {
      let html = '', last = null;
      for (const it of st.items) {
        const b = bucket(it);
        if (b !== last) { if (b) html += `<h4 class="tk-group">${b}</h4>`; last = b; }
        html += rowHtml(it, false);
        for (const c of it.children) html += rowHtml(c, true);
      }
      box.innerHTML = html;
    }
    const rest = st.total - st.items.length;
    $('tkMore').hidden = rest <= 0;
    $('tkMore').textContent = `Показати ще ${Math.min(rest, PAGE)} (усього ${st.total})`;
    renderBulk();
  }
  function metaHtml(it, child) {
    const bits = [];
    if (st.area === 'all' && !child) bits.push(`<span class="tk-badge a-${it.area}">${AREA[it.area].icon} ${AREA[it.area].one}</span>`);
    if (it.when) bits.push(`<span class="${it.overdue && !it.done && !(it.kind === 'reminder' && it.sent) ? 'tk-late' : ''}">${it.kind === 'reminder' ? '⏰' : '📅'} ${esc(it.when)}${it.sent && !it.done ? ' · надіслано' : ''}</span>`);
    if (it.repeatText) bits.push(`🔁 ${esc(it.repeatText)}`);
    if (it.project && !child) bits.push(`📁 ${esc(it.project)}`);
    if (it.tags && it.tags.length) bits.push(it.tags.map(t => '#' + esc(t)).join(' '));
    if (!child && it.children && it.children.length) bits.push(`↳ ${it.children.filter(c => !c.done).length}/${it.children.length}`);
    if (it.done && it.done_at) bits.push('✓ ' + new Date(it.done_at).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }));
    return bits.join('<i>·</i>');
  }
  function rowHtml(it, child) {
    const sel = st.selected.has(it.id), sug = st.sug.get(it.id);
    const quick = !child && !it.done && it.area === 'inbox'
      ? `<span class="tk-quick">${sug ? `<button type="button" class="tk-sug" data-act="sug" title="Підказка асистента — натисніть, щоб прийняти">🪄 ${AREA[sug].icon}</button>` : ''}
         <button type="button" data-act="area" data-v="work" title="У робочі">💼</button><button type="button" data-act="area" data-v="personal" title="В особисті">🏠</button></span>` : '';
    return `<div class="tk-row${child ? ' child' : ''}${it.done ? ' done' : ''}${sel ? ' sel' : ''}${it.priority ? ' p' + it.priority : ''}" data-id="${it.id}">
      ${st.select ? `<input type="checkbox" class="tk-sel" data-act="select" ${sel ? 'checked' : ''} aria-label="Вибрати">` : ''}
      <button type="button" class="tk-done" data-act="done" aria-label="${it.done ? 'Повернути у відкриті' : 'Виконано'}" title="${it.done ? 'Повернути у відкриті' : 'Виконано'}"></button>
      <div class="tk-body" data-act="open"><div class="tk-text">${esc(it.text)}</div><div class="tk-meta">${metaHtml(it, child)}</div></div>
      ${quick}
      ${it.done ? '' : `<button type="button" class="tk-prio" data-act="prio" title="Пріоритет: ${PRIO[it.priority].title}">${PRIO[it.priority].mark || '·'}</button>`}
    </div>${st.open === it.id ? editorHtml(it, child) : ''}`;
  }
  function editorHtml(it, child) {
    const due = it.due_at ? localInput(it.due_at) : '';
    return `<form class="tk-editor" data-id="${it.id}">
      <textarea name="text" rows="2" required>${esc(it.text)}</textarea>
      <div class="tk-erow">
        ${child ? '' : `<div class="tk-seg" role="radiogroup" aria-label="Сфера">${Object.entries(AREA).map(([k, a]) =>
          `<label><input type="radio" name="area" value="${k}" ${it.area === k ? 'checked' : ''}><span>${a.icon} ${a.one}</span></label>`).join('')}</div>`}
      </div>
      <div class="tk-erow">
        <label class="fld"><span>Строк / час</span><input type="datetime-local" name="due" value="${due}"></label>
        <label class="fld"><span>Тип</span><select name="kind"><option value="task" ${it.kind === 'task' ? 'selected' : ''}>☑️ Задача</option><option value="reminder" ${it.kind === 'reminder' ? 'selected' : ''}>⏰ Нагадування</option></select></label>
        <label class="fld"><span>Пріоритет</span><select name="priority">${PRIO.map((p, i) => `<option value="${i}" ${it.priority === i ? 'selected' : ''}>${p.mark ? p.mark + ' ' : ''}${p.title}</option>`).join('')}</select></label>
        ${child ? '' : `<label class="fld"><span>Проєкт</span><input name="project" list="tkProjList" value="${esc(it.project || '')}" placeholder="без проєкту"></label>`}
      </div>
      ${it.repeatText ? `<p class="muted small">🔁 ${esc(it.repeatText)}. Якщо прибрати строк, повтор теж прибереться.</p>` : ''}
      ${child ? '' : `<div class="tk-erow"><input name="sub" placeholder="+ підзадача (Enter)" class="tk-subin"></div>`}
      <div class="tk-eact">
        <button class="btn primary small" type="submit">Зберегти</button>
        <button class="btn small ghost" type="button" data-act="close">Скасувати</button>
        <button class="btn small ghost danger" type="button" data-act="delete">🗑 Видалити</button>
      </div>
    </form>`;
  }
  function localInput(ms) {
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- дії в рядку ----------
  async function act(path, json) {
    try { return await api(path, { method: 'POST', json }); } catch (e) { toast('⚠️ ' + e.message); throw e; }
  }
  async function setArea(id, area, quiet) {
    const it = byId(id), prev = it ? it.area : 'inbox';
    await act('assistant/item', { id, action: 'area', area });
    st.sug.delete(id);
    if (!quiet) toast(`${AREA[area].icon} Перенесено в «${AREA[area].name}»`, async () => { await act('assistant/item', { id, action: 'area', area: prev }); reload(); });
  }
  $('taskList').addEventListener('click', async e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const row = el.closest('[data-id]'), id = row && +row.dataset.id, it = id && byId(id), a = el.dataset.act;
    if (!it) return;
    if (st.select && (a === 'open' || a === 'select')) { toggleSel(id, a === 'select' ? el.checked : !st.selected.has(id)); return; }
    if (a === 'done') {
      el.disabled = true;
      const r = await act('assistant/item', { id, action: it.done ? 'undo' : 'done' }).catch(() => null);
      if (r && r.next) toast('🔁 Наступний раз: ' + r.when);
      else if (r && !it.done) toast('✅ Виконано', async () => { await act('assistant/item', { id, action: 'undo' }); reload(); });
      reload();
    } else if (a === 'area') { await setArea(id, el.dataset.v).catch(() => {}); reload(); }
    else if (a === 'sug') { await setArea(id, st.sug.get(id)).catch(() => {}); reload(); }
    else if (a === 'prio') { await act('assistant/item', { id, action: 'priority', priority: (it.priority + 1) % 3 }).catch(() => {}); reload(); }
    else if (a === 'open') { st.open = st.open === id ? null : id; render(); const ta = document.querySelector('.tk-editor textarea'); if (ta) ta.focus(); }
    else if (a === 'close') { st.open = null; render(); }
    else if (a === 'delete') {
      if (!confirm(`Видалити «${it.text}»${it.children && it.children.length ? ' разом із підзадачами' : ''}?`)) return;
      await act('assistant/item', { id, action: 'delete' }).catch(() => {}); st.open = null; reload();
    }
  });
  $('taskList').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, id = +f.dataset.id, d = new FormData(f);
    const body = { id, action: 'edit', text: d.get('text'), due: d.get('due') || '', kind: d.get('kind'), priority: +d.get('priority') };
    if (d.get('area')) body.area = d.get('area');
    if (d.has('project')) body.project = d.get('project');
    try { await act('assistant/item', body); st.open = null; toast('✏️ Збережено'); reload(); } catch (err) {}
  });
  $('taskList').addEventListener('keydown', async e => {
    if (e.key === 'Escape' && e.target.closest('.tk-editor')) { st.open = null; render(); return; }
    if (e.key === 'Enter' && e.target.classList.contains('tk-subin')) {
      e.preventDefault();
      const text = e.target.value.trim(), id = +e.target.closest('.tk-editor').dataset.id; if (!text) return;
      try { await act('assistant/item', { action: 'create', text, parent_id: id }); e.target.value = ''; await load(false); const i = document.querySelector('.tk-subin'); if (i) i.focus(); } catch (err) {}
    }
    if (e.key === 'Enter' && e.target.name === 'text' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); }
  });
  $('tkMore').addEventListener('click', () => load(true));

  // ---------- фільтри ----------
  $('tkAreas').addEventListener('click', e => {
    const b = e.target.closest('button[data-area]'); if (!b) return;
    st.area = b.dataset.area; st.open = null; clearSel(); savePrefs(); reload();
  });
  $('tkViews').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]'); if (!b) return;
    st.view = b.dataset.view; st.open = null; savePrefs(); reload();
  });
  let qTimer = 0;
  $('tkSearch').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = $('tkSearch').value.trim(); reload(); }, 250); });
  $('tkSort').addEventListener('change', () => { st.sort = $('tkSort').value; savePrefs(); reload(); });
  $('tkProject').addEventListener('change', () => { st.project = $('tkProject').value; reload(); });
  $('tkPrio').addEventListener('change', () => { st.prio = $('tkPrio').value; reload(); });

  // ---------- швидке додавання ----------
  $('tkAdd').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('tkAddText').value.trim(); if (!text) return;
    const area = $('tkAddArea').value;
    try { await act('assistant/item', { action: 'create', text, area }); $('tkAddText').value = ''; toast(`➕ Додано в «${AREA[area].name}»`); reload(); } catch (err) {}
  });
  // «🪄» — через асистента: розбере дату, повтор, проєкт («завтра о 10 подзвонити…»)
  $('tkAddAi').addEventListener('click', async () => {
    const text = $('tkAddText').value.trim(); if (!text) return $('tkAddText').focus();
    const area = $('tkAddArea').value, btn = $('tkAddAi');
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await MD.assist(area === 'inbox' ? text : `${text} (${area === 'work' ? 'робоче' : 'особисте'})`);
      $('tkAddText').value = '';
      toast([r.reply, ...(r.done || [])].filter(Boolean).join('\n') || 'Записав', r.undoable ? async () => { await act('assistant/undo', { msgId: r.msgId }); reload(); } : null, 6000);
      reload();
    } catch (err) { toast('⚠️ ' + err.message); }
    btn.disabled = false; btn.textContent = '🪄';
  });

  // ---------- вибір і масові дії ----------
  function toggleSel(id, on) { if (on) st.selected.add(id); else st.selected.delete(id); render(); }
  function clearSel() { st.selected.clear(); }
  function renderBulk() {
    $('tkSelectMode').setAttribute('aria-pressed', String(st.select));
    $('tkSelectMode').textContent = st.select ? '✕ Готово' : '☑ Вибрати';
    $('tkBulk').hidden = !st.select;
    $('tkBulkN').textContent = st.selected.size;
    for (const b of $('tkBulk').querySelectorAll('button[data-bulk]:not([data-bulk="all"]):not([data-bulk="cancel"]), select')) b.disabled = !st.selected.size;
  }
  $('tkSelectMode').addEventListener('click', () => { st.select = !st.select; if (!st.select) clearSel(); st.open = null; render(); });
  async function bulk(action, value) {
    const ids = [...st.selected]; if (!ids.length) return;
    const prev = ids.map(id => byId(id)).filter(Boolean);
    if (action === 'delete' && !confirm(`Видалити ${ids.length} ${ids.length === 1 ? 'задачу' : 'задач(і)'} разом із підзадачами?`)) return;
    let r; try { r = await act('assistant/bulk', { ids, action, value }); } catch (e) { return; }
    const n = r.changed;
    let undo = null, msg = `Готово: ${n}`;
    if (action === 'area') {
      msg = `${AREA[value].icon} ${n} → «${AREA[value].name}»`;
      undo = async () => { for (const a of Object.keys(AREA)) { const g = prev.filter(x => x.area === a).map(x => x.id); if (g.length) await act('assistant/bulk', { ids: g, action: 'area', value: a }); } reload(); };
    } else if (action === 'done') {
      msg = `✅ Виконано: ${n}`;
      const g = prev.filter(x => !x.done && !x.repeat).map(x => x.id);
      if (g.length) undo = async () => { await act('assistant/bulk', { ids: g, action: 'reopen' }); reload(); };
    } else if (action === 'delete') msg = `🗑 Видалено: ${n}`;
    else if (action === 'due') msg = `📅 Строк змінено: ${n}`;
    else if (action === 'priority') msg = `Пріоритет змінено: ${n}`;
    clearSel(); toast(msg, undo); reload();
  }
  $('tkBulk').addEventListener('click', e => {
    const b = e.target.closest('button[data-bulk]'); if (!b) return;
    const [action, value] = b.dataset.bulk.split(':');
    if (action === 'cancel') { st.select = false; clearSel(); render(); return; }
    if (action === 'all') {
      const all = st.items.flatMap(it => [it, ...it.children]).map(x => x.id);
      const allOn = all.every(id => st.selected.has(id));
      all.forEach(id => allOn ? st.selected.delete(id) : st.selected.add(id)); render(); return;
    }
    bulk(action, value);
  });
  $('tkBulk').addEventListener('change', e => {
    const s = e.target.closest('select[data-bulk-select]'); if (!s || s.value === '') return;
    bulk(s.dataset.bulkSelect, s.value); s.value = '';
  });

  // ---------- підказки асистента для несортованих ----------
  $('tkSuggest').addEventListener('click', async () => {
    const btn = $('tkSuggest'); btn.disabled = true; btn.innerHTML = '<span class="st-spin"></span>Думаю…';
    try {
      const r = await api('assistant/triage', { method: 'POST' });
      st.sug = new Map(r.suggestions.map(s => [s.id, s.area]));
      toast(r.suggestions.length ? `🪄 Підказки для ${r.suggestions.length} задач — натисніть 🪄 біля задачі або «Прийняти підказки»` : '🪄 Асистент не впевнений щодо жодної — розсортуйте вручну');
      render(); renderCounts();
    } catch (e) { toast('⚠️ ' + e.message); }
    btn.disabled = false; btn.textContent = '🪄 Підказати сфери';
  });
  $('tkAcceptAll').addEventListener('click', async () => {
    const groups = { work: [], personal: [] };
    for (const [id, a] of st.sug) groups[a].push(id);
    for (const a of ['work', 'personal']) if (groups[a].length) await act('assistant/bulk', { ids: groups[a], action: 'area', value: a }).catch(() => {});
    const n = groups.work.length + groups.personal.length;
    st.sug.clear();
    toast(`🪄 Розсортовано ${n}: 💼 ${groups.work.length}, 🏠 ${groups.personal.length}`, async () => {
      await act('assistant/bulk', { ids: [...groups.work, ...groups.personal], action: 'area', value: 'inbox' }); reload();
    });
    reload();
  });

  // ---------- режим «Розібрати по одній» ----------
  const tri = { list: [], i: 0, history: [] };
  $('tkTriage').addEventListener('click', async () => {
    let d; try { d = await api('assistant/tasks?area=inbox&view=open&sort=created&limit=200'); } catch (e) { return toast('⚠️ ' + e.message); }
    tri.list = d.list; tri.i = 0; tri.history = [];
    if (!tri.list.length) return toast('Несортованих немає 🎉');
    $('tkTriageBox').hidden = false; document.body.classList.add('tk-modal'); showTri();
  });
  function showTri() {
    const it = tri.list[tri.i];
    if (!it) { closeTri(); toast(`🎉 Розібрано! ${tri.history.filter(h => h.a !== 'skip').length} задач`); return; }
    $('tkTPos').textContent = `Задача ${tri.i + 1} з ${tri.list.length}`;
    $('tkTProg').style.width = (tri.i / tri.list.length * 100) + '%';
    $('tkTText').textContent = it.text;
    $('tkTMeta').innerHTML = metaHtml({ ...it, area: 'inbox' }, false) + (it.children.length ? `<br>${it.children.map(c => '↳ ' + esc(c.text)).join('<br>')}` : '');
    const sug = st.sug.get(it.id);
    for (const b of $('tkTriageBox').querySelectorAll('.tk-big')) b.classList.toggle('suggested', b.dataset.t === sug);
    $('tkTSug').hidden = !sug; if (sug) $('tkTSug').textContent = `🪄 Асистент радить: ${AREA[sug].icon} ${AREA[sug].one}`;
    $('tkTBack').disabled = !tri.history.length;
  }
  function closeTri() { $('tkTriageBox').hidden = true; document.body.classList.remove('tk-modal'); reload(); }
  async function triAct(a) {
    const it = tri.list[tri.i];
    if (a === 'back') {
      const h = tri.history.pop(); if (!h) return;
      if (h.a === 'work' || h.a === 'personal') await act('assistant/item', { id: h.id, action: 'area', area: 'inbox' }).catch(() => {});
      if (h.a === 'done') await act('assistant/item', { id: h.id, action: 'undo' }).catch(() => {});
      tri.i = h.i; return showTri();
    }
    if (!it) return;
    try {
      if (a === 'work' || a === 'personal') await setArea(it.id, a, true);
      else if (a === 'done') await act('assistant/item', { id: it.id, action: 'done' });
      else if (a === 'delete') { if (!confirm(`Видалити «${it.text}»?`)) return; await act('assistant/item', { id: it.id, action: 'delete' }); }
    } catch (e) { return; }
    tri.history.push({ id: it.id, a, i: tri.i }); tri.i++; showTri();
  }
  $('tkTriageBox').addEventListener('click', e => {
    if (e.target === $('tkTriageBox')) return closeTri();
    const b = e.target.closest('[data-t]'); if (b) triAct(b.dataset.t);
  });
  $('tkTClose').addEventListener('click', closeTri);

  // ---------- клавіатура ----------
  document.addEventListener('keydown', e => {
    if (document.querySelector('[data-panel="tasks"]').hidden) return;
    if (!$('tkTriageBox').hidden) {
      const k = { '1': 'work', '2': 'personal', d: 'done', 'в': 'done', x: 'delete', 'ч': 'delete', ArrowRight: 'skip', s: 'skip', 'і': 'skip', ArrowLeft: 'back', Backspace: 'back' }[e.key];
      if (e.key === 'Escape') { e.preventDefault(); closeTri(); }
      else if (k) { e.preventDefault(); triAct(k); }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === '/') { e.preventDefault(); $('tkSearch').focus(); }
    else if (e.key === 'n' || e.key === 'т') { e.preventDefault(); $('tkAddText').focus(); }
    else if (e.key === 'Escape' && st.select) { st.select = false; clearSel(); render(); }
  });

  // ---------- сповіщення з «Скасувати» ----------
  let toastTimer = 0;
  function toast(text, undo, ms = 4500) {
    const t = $('tkToast');
    t.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button" class="btn small">↩️ Скасувати</button>' : ''}`;
    t.hidden = false; clearTimeout(toastTimer);
    if (undo) t.querySelector('button').onclick = async () => { t.hidden = true; await undo(); };
    toastTimer = setTimeout(() => { t.hidden = true; }, undo ? Math.max(ms, 7000) : ms);
  }
  MD.toast = toast;

  // ---------- план і підсумок ----------
  async function showDigest(kind) {
    const box = $('summaryBox'), btns = [$('summaryBtn'), $('planBtn')];
    box.hidden = false; box.innerHTML = `<span class="st-spin"></span>${kind === 'plan' ? 'Складаю план…' : 'Складаю підсумок…'}`;
    btns.forEach(b => b.disabled = true);
    try {
      const r = await api('assistant/' + kind, { method: 'POST' });
      box.textContent = r.text + (r.sent ? '\n\n✈️ Надіслано в Telegram' : '');
    } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    btns.forEach(b => b.disabled = false);
  }
  $('summaryBtn').addEventListener('click', () => showDigest('summary'));
  $('planBtn').addEventListener('click', () => showDigest('plan'));

  document.addEventListener('md:tab', e => { if (e.detail === 'tasks') reload(); });
  MD.hooks.push(async () => {
    // перший вхід: якщо є несортовані — одразу показати їх
    await MD.refreshTasks();
    try { if (!localStorage.getItem(PREF) && st.counts && st.counts.areas.inbox) st.area = 'inbox'; else if (!localStorage.getItem(PREF)) st.area = 'all'; } catch (e) {}
  });
})();
