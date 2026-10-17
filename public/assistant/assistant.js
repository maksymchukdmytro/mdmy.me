// Асистент на сторінці /assistant: вкладки «Задачі», «Нотатки», «Стан», «Налаштування» і виконання команд.
// Дані на сервері: /api/assistant/* (lib/assistant.js). Спільний api() і вкладки — у recorder.js (window.MD).
(() => {
  const MD = window.MD, api = MD.api, $ = id => document.getElementById(id);
  let settings = null, linkPoll = 0, projectFilter = null;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = ms => new Date(ms).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const PRIO = [{ mark: '', title: 'Звичайна' }, { mark: '❗', title: 'Важлива' }, { mark: '‼️', title: 'Термінова' }];

  // ---------- команди з вкладки «Запис» ----------
  MD.assist = async text => {
    const r = await api('assistant/message', { method: 'POST', json: { text } });
    refreshCount();
    return r;
  };

  // ---------- задачі ----------
  async function loadTasks() {
    const box = $('taskList');
    let data;
    try { data = await api('assistant/items?kind=task' + (projectFilter ? '&project=' + projectFilter : '')); }
    catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    renderChips(data.projects);
    const list = data.list;
    if (!projectFilter) setCount(list.filter(x => !x.done).length);
    if (!list.length) { box.innerHTML = '<p class="st-empty muted">Поки порожньо. Скажіть або напишіть на вкладці «Запис»: «нагадай завтра о 10…», «треба купити…», «щопонеділка о 9…»</p>'; return; }
    const kids = {};
    for (const x of list) if (x.parent_id) (kids[x.parent_id] = kids[x.parent_id] || []).push(x);
    const top = list.filter(x => !x.parent_id || !list.some(p => p.id === x.parent_id));
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    const groups = [
      ['Прострочено', x => !x.done && x.overdue && !x.sent],
      ['Сьогодні', x => !x.done && x.due_at && !(x.overdue && !x.sent) && x.due_at <= endToday.getTime()],
      ['Далі', x => !x.done && x.due_at && x.due_at > endToday.getTime()],
      ['Без строку', x => !x.done && !x.due_at],
      ['Виконано за тиждень', x => x.done]
    ];
    box.innerHTML = '';
    for (const [title, test] of groups) {
      const rows = top.filter(test);
      if (!rows.length) continue;
      const sec = document.createElement('section'); sec.className = 'st-group';
      sec.innerHTML = `<h4>${title}</h4>`;
      for (const it of rows) {
        sec.append(taskRow(it));
        for (const c of kids[it.id] || []) sec.append(taskRow(c, true));
      }
      box.append(sec);
    }
  }
  function renderChips(projects) {
    const box = $('projectChips');
    box.hidden = !projects.length;
    if (!projects.length) return;
    box.innerHTML = `<button type="button" data-p="" aria-pressed="${!projectFilter}">Усі</button>` +
      projects.map(p => `<button type="button" data-p="${p.id}" aria-pressed="${projectFilter === p.id}">📁 ${esc(p.name)}${p.open ? ` <span>${p.open}</span>` : ''}</button>`).join('');
  }
  $('projectChips').addEventListener('click', e => { const b = e.target.closest('button[data-p]'); if (!b) return; projectFilter = +b.dataset.p || null; loadTasks(); });

  function taskRow(it, child) {
    const row = document.createElement('div'); row.className = 'st-task' + (it.done ? ' done' : '') + (child ? ' child' : '');
    const icon = it.kind === 'reminder' ? '⏰' : '☑️';
    const meta = [it.when ? icon + ' ' + esc(it.when) + (it.sent && !it.done ? ' · надіслано' : '') : '',
                  it.repeatText ? '🔁 ' + esc(it.repeatText) : '',
                  it.project && !projectFilter && !child ? '📁 ' + esc(it.project) : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<label><input type="checkbox" ${it.done ? 'checked' : ''}><span class="st-task-text">${child ? '↳ ' : ''}${esc(it.text)}</span></label>
      ${it.done ? '' : `<button type="button" class="st-prio p${it.priority}" title="Пріоритет: ${PRIO[it.priority].title}. Натисніть, щоб змінити">${PRIO[it.priority].mark || '·'}</button>`}
      <span class="st-when">${meta}</span>
      <button type="button" class="st-x" title="Видалити" aria-label="Видалити">×</button>`;
    row.querySelector('input').addEventListener('change', async e => {
      try {
        const r = await api('assistant/item', { method: 'POST', json: { id: it.id, action: e.target.checked ? 'done' : 'undo' } });
        if (r.next) flash(row, '🔁 Наступний раз: ' + r.when);
      } catch (err) { alert(err.message); }
      setTimeout(loadTasks, it.repeatText ? 900 : 0);
    });
    const pb = row.querySelector('.st-prio');
    if (pb) pb.addEventListener('click', async () => {
      try { await api('assistant/item', { method: 'POST', json: { id: it.id, action: 'priority', priority: (it.priority + 1) % 3 } }); } catch (err) { alert(err.message); }
      loadTasks();
    });
    row.querySelector('.st-x').addEventListener('click', async () => {
      if (!confirm(`Видалити «${it.text}»?`)) return;
      try { await api('assistant/item', { method: 'POST', json: { id: it.id, action: 'delete' } }); } catch (err) { alert(err.message); }
      loadTasks();
    });
    return row;
  }
  function flash(row, text) { const s = row.querySelector('.st-when'); if (s) { s.textContent = text; s.classList.add('flash'); } }
  function setCount(n) { const c = $('taskCount'); c.hidden = !n; c.textContent = n; }
  async function refreshCount() {
    try { setCount((await api('assistant/items?kind=task')).list.filter(x => !x.done).length); } catch (e) {}
  }

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

  // ---------- нотатки й пошук по всьому ----------
  let noteTimer = 0;
  async function loadNotes() {
    const box = $('noteList'), q = $('noteSearch').value.trim();
    const global = q && !q.startsWith('#');
    $('notesTitle').textContent = global ? 'Знайдено' : 'Нотатки';
    let list;
    try {
      list = global ? (await api('assistant/search?q=' + encodeURIComponent(q))).list
                    : (await api('assistant/items?kind=note' + (q ? '&q=' + encodeURIComponent(q) : ''))).list;
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (!list.length) { box.innerHTML = `<p class="st-empty muted">${q ? 'Нічого не знайдено.' : 'Нотаток ще немає. Надиктуйте думку чи ідею — асистент збереже її з тегами.'}</p>`; return; }
    box.innerHTML = '';
    for (const n of list) {
      const card = document.createElement('article'); card.className = 'st-item st-note';
      if (global) {
        const icon = n.type === 'msg' ? '🗣' : { note: '📝', task: '☑️', reminder: '⏰' }[n.kind];
        card.innerHTML = `<p>${icon} ${n.done ? '<s>' : ''}${esc(n.text)}${n.done ? '</s>' : ''}</p>
          <div class="st-meta"><span>${esc(n.when)} · ${n.type === 'msg' ? 'ви сказали' : { note: 'нотатка', task: 'задача', reminder: 'нагадування' }[n.kind]}${(n.tags || []).length ? ' · ' + n.tags.map(t => '#' + esc(t)).join(' ') : ''}</span></div>`;
        box.append(card); continue;
      }
      card.innerHTML = `<p>${esc(n.text)}</p><div class="st-meta"><span>${fmtDate(n.created)}${n.project ? ' · 📁 ' + esc(n.project) : ''}${n.tags.length ? ' · ' : ''}${n.tags.map(t => `<button type="button" class="st-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join(' ')}</span>
        <button type="button" class="st-x" title="Видалити" aria-label="Видалити">×</button></div>`;
      card.querySelector('.st-x').addEventListener('click', async () => {
        if (!confirm('Видалити нотатку?')) return;
        try { await api('assistant/item', { method: 'POST', json: { id: n.id, action: 'delete' } }); } catch (e) { alert(e.message); }
        loadNotes();
      });
      box.append(card);
    }
  }
  $('noteSearch').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(loadNotes, 300); });
  $('noteList').addEventListener('click', e => { const t = e.target.closest('.st-tag'); if (t) { $('noteSearch').value = '#' + t.dataset.tag; loadNotes(); } });

  // ---------- стан: графіки за 14 днів ----------
  const C = { mood: '#2a78d6', energy: '#eb6834', sleep: '#159068' };   // перевірено валідатором палітри (CVD, контраст)
  const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const dayLabel = d => { const dt = new Date(d + 'T12:00:00'); return `${WD[dt.getDay()]} ${dt.getDate()}`; };

  async function loadState() {
    const box = $('stateBox');
    let st;
    try { st = await api('assistant/state?days=14'); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const any = st.days.some(d => d.mood != null || d.energy != null || d.sleep != null || d.habits.length);
    if (!any) { box.innerHTML = '<p class="st-empty muted">Записів стану ще немає.</p>'; return; }
    const tile = (label, v, unit, color) => `<div class="st-tile"><span class="st-sw" style="background:${color}"></span><b>${v ?? '—'}</b>${v != null ? unit : ''}<small>${label}</small></div>`;
    box.innerHTML = `
      <div class="st-tiles">${tile('настрій, середнє', st.avg.mood, '/10', C.mood)}${tile('енергія, середнє', st.avg.energy, '/10', C.energy)}${tile('сон, середнє', st.avg.sleep, ' год', C.sleep)}</div>
      <section class="st-card st-chart"><h3>Настрій і енергія</h3>
        <div class="st-legend"><span><i style="background:${C.mood}"></i>Настрій</span><span><i style="background:${C.energy}"></i>Енергія</span></div>
        <div class="st-plot" id="plotMood"></div></section>
      <section class="st-card st-chart"><h3>Сон, годин</h3><div class="st-plot" id="plotSleep"></div></section>
      ${st.habits.length ? `<section class="st-card st-chart"><h3>Звички</h3><div id="habitGrid"></div></section>` : ''}
      <details class="st-table"><summary>Показати таблицею</summary><div id="stateTable"></div></details>`;
    drawLines($('plotMood'), st.days);
    drawBars($('plotSleep'), st.days, st.avg.sleep);
    if (st.habits.length) drawHabits($('habitGrid'), st);
    const names = Object.fromEntries(st.habits.map(h => [h.id, h.name]));
    $('stateTable').innerHTML = `<table><thead><tr><th>День</th><th>Настрій</th><th>Енергія</th><th>Сон</th><th>Звички</th></tr></thead><tbody>${
      st.days.slice().reverse().map(d => `<tr><td>${dayLabel(d.day)}</td><td>${d.mood ?? '—'}</td><td>${d.energy ?? '—'}</td><td>${d.sleep ?? '—'}</td><td>${d.habits.map(h => esc(names[h])).join(', ') || '—'}</td></tr>`).join('')}</tbody></table>`;
  }

  // спільна геометрія: ширина за контейнером, 14 колонок
  function frame(el, h) {
    const W = Math.max(280, el.clientWidth || 600), pad = { l: 26, r: 34, t: 10, b: 24 };
    const n = 14, cw = (W - pad.l - pad.r) / n;
    return { W, H: h, pad, n, cw, x: i => pad.l + cw * i + cw / 2 };
  }
  function tooltip(el) {
    const tip = document.createElement('div'); tip.className = 'st-tip'; tip.hidden = true; el.append(tip);
    return { show(x, html) { tip.innerHTML = html; tip.hidden = false; const w = tip.offsetWidth; tip.style.left = Math.max(0, Math.min(el.clientWidth - w, x - w / 2)) + 'px'; }, hide() { tip.hidden = true; } };
  }
  function xLabels(f, days) {
    return days.map((d, i) => i % 2 === (days.length - 1) % 2 ? `<text x="${f.x(i)}" y="${f.H - 6}" text-anchor="middle" class="st-ax">${dayLabel(d.day)}</text>` : '').join('');
  }
  function drawLines(el, days) {
    const f = frame(el, 190), y = v => f.pad.t + (10 - v) / 9 * (f.H - f.pad.t - f.pad.b);
    let svg = '';
    for (const g of [2, 4, 6, 8, 10]) svg += `<line x1="${f.pad.l}" x2="${f.W - f.pad.r}" y1="${y(g)}" y2="${y(g)}" class="st-grid"/><text x="${f.pad.l - 6}" y="${y(g) + 4}" text-anchor="end" class="st-ax">${g}</text>`;
    for (const k of ['mood', 'energy']) {
      // лінія розривається там, де немає даних
      let d = '', pen = false;
      days.forEach((day, i) => { const v = day[k]; if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${f.x(i)},${y(v)}`; pen = true; });
      svg += `<path d="${d}" fill="none" stroke="${C[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      days.forEach((day, i) => { if (day[k] != null) svg += `<circle cx="${f.x(i)}" cy="${y(day[k])}" r="4" fill="${C[k]}" stroke="var(--panel)" stroke-width="2"/>`; });
      const lastI = days.map(x => x[k]).findLastIndex(v => v != null);
      if (lastI >= 0) svg += `<text x="${f.x(lastI) + 8}" y="${y(days[lastI][k]) + (k === 'mood' ? -6 : 12)}" class="st-dl">${days[lastI][k]}</text>`;
    }
    svg += xLabels(f, days) + `<line class="st-cross" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="100%" height="${f.H}" role="img" aria-label="Настрій і енергія за 14 днів">${svg}</svg>`;
    hover(el, f, days, i => `<b>${dayLabel(days[i].day)}</b><br><span style="color:${C.mood}">●</span> настрій ${days[i].mood ?? '—'}<br><span style="color:${C.energy}">●</span> енергія ${days[i].energy ?? '—'}`, true);
  }
  function drawBars(el, days, avg) {
    const f = frame(el, 150), max = Math.max(9, ...days.map(d => d.sleep || 0)), base = f.H - f.pad.b, y = v => base - v / max * (base - f.pad.t);
    let svg = '';
    for (const g of [0, 3, 6, 9].filter(g => g <= max)) svg += `<line x1="${f.pad.l}" x2="${f.W - f.pad.r}" y1="${y(g)}" y2="${y(g)}" class="st-grid"/><text x="${f.pad.l - 6}" y="${y(g) + 4}" text-anchor="end" class="st-ax">${g}</text>`;
    const bw = Math.min(22, f.cw - 2);
    days.forEach((d, i) => {
      if (d.sleep == null || d.sleep <= 0) return;
      const top = y(d.sleep), h = base - top, r = Math.min(4, h / 2), x0 = f.x(i) - bw / 2;
      svg += `<path d="M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z" fill="${C.sleep}"/>`;
    });
    if (avg != null) svg += `<line x1="${f.pad.l}" x2="${f.W - f.pad.r}" y1="${y(avg)}" y2="${y(avg)}" class="st-avg"/><text x="${f.W - f.pad.r + 4}" y="${y(avg) + 4}" class="st-dl">⌀${avg}</text>`;
    svg += xLabels(f, days);
    el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="100%" height="${f.H}" role="img" aria-label="Сон за 14 днів">${svg}</svg>`;
    hover(el, f, days, i => `<b>${dayLabel(days[i].day)}</b><br>сон ${days[i].sleep != null ? days[i].sleep + ' год' : '—'}`);
  }
  function hover(el, f, days, html, cross) {
    const tip = tooltip(el), svg = el.querySelector('svg'), line = svg.querySelector('.st-cross');
    const pick = ev => {
      const r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * f.W;
      const i = Math.max(0, Math.min(f.n - 1, Math.floor((x - f.pad.l) / f.cw)));
      if (cross && line) { line.setAttribute('x1', f.x(i)); line.setAttribute('x2', f.x(i)); line.setAttribute('visibility', 'visible'); }
      tip.show(f.x(i) / f.W * r.width, html(i));
    };
    svg.addEventListener('pointermove', pick); svg.addEventListener('pointerdown', pick);
    svg.addEventListener('pointerleave', () => { tip.hide(); if (line) line.setAttribute('visibility', 'hidden'); });
  }
  function drawHabits(el, st) {
    el.innerHTML = `<div class="st-hgrid" style="grid-template-columns:minmax(80px,auto) repeat(14,1fr) auto">
      <span></span>${st.days.map((d, i) => `<span class="st-hd">${i % 2 === 1 ? new Date(d.day + 'T12:00').getDate() : ''}</span>`).join('')}<span></span>
      ${st.habits.map(h => `<span class="st-hn">${esc(h.name)}</span>${st.days.map(d => `<span class="st-hc${d.habits.includes(h.id) ? ' on' : ''}" title="${dayLabel(d.day)}: ${d.habits.includes(h.id) ? 'виконано' : 'ні'}"></span>`).join('')}<span class="st-hk">${h.count}/14</span>`).join('')}
    </div>`;
  }

  // ---------- налаштування ----------
  function fillSettings(s) {
    settings = s;
    $('setKey').value = ''; $('setBot').value = '';
    $('keyState').innerHTML = s.hasKey ? `✅ Ключ задано (${esc(s.keyHint)}) · <button type="button" class="btn small ghost" id="clearKey">Видалити</button>` : '<span class="muted">Ключ не задано.</span>';
    $('setModel').value = s.model;
    const bs = $('botState');
    if (!s.hasBot) bs.innerHTML = '<span class="muted small">Бот не підключено.</span>';
    else if (!s.linked) bs.innerHTML = `<p>Бот <b>@${esc(s.botName)}</b> підключено. Залишилось привʼязати ваш Telegram:</p>
        <a class="btn primary" href="${esc(s.linkUrl)}" target="_blank" rel="noopener">Відкрити бота й натиснути «Start»</a>
        <p class="muted small">Сторінка сама оновиться, щойно привʼязка спрацює.</p>`;
    else bs.innerHTML = `<p>✅ Привʼязано до <b>@${esc(s.botName)}</b>. Надішліть йому голосове — і все запрацює.</p>
        <button type="button" class="btn small ghost" id="unlinkBot">Відвʼязати чат</button> <button type="button" class="btn small ghost danger" id="clearBot">Видалити бота</button>`;
    if (s.botError) bs.insertAdjacentHTML('beforeend', `<p class="err small">${esc(s.botError)}</p>`);
    $('setTz').value = s.tz;
    if ($('setTz').value !== s.tz) { $('setTz').add(new Option(s.tz, s.tz)); $('setTz').value = s.tz; }
    $('setSumTime').value = s.summaryTime; $('setSumOn').checked = s.summaryOn;
    $('setMornTime').value = s.morningTime; $('setMornOn').checked = s.morningOn;
    $('setVoiceLang').value = s.voiceLang;
    $('assistHint').hidden = s.hasKey;
    clearInterval(linkPoll);
    if (s.hasBot && !s.linked) linkPoll = setInterval(async () => {
      if (document.querySelector('[data-panel="settings"]').hidden) return;
      try { const n = await api('assistant/settings'); if (n.linked) fillSettings(n); } catch (e) {}
    }, 3000);
  }
  async function loadSettings() {
    try { fillSettings(await api('assistant/settings')); } catch (e) { $('setErr').textContent = e.message; }
  }
  async function saveSettings(extra) {
    $('setErr').textContent = '';
    const body = extra || {
      model: $('setModel').value.trim() || 'claude-haiku-5-5', tz: $('setTz').value,
      summaryTime: $('setSumTime').value || '21:00', summaryOn: $('setSumOn').checked,
      morningTime: $('setMornTime').value || '08:00', morningOn: $('setMornOn').checked, voiceLang: $('setVoiceLang').value
    };
    if (!extra && $('setKey').value.trim()) body.anthropicKey = $('setKey').value.trim();
    if (!extra && $('setBot').value.trim()) body.botToken = $('setBot').value.trim();
    const btn = $('setSave'); btn.disabled = true; btn.textContent = 'Зберігаю…';
    try { fillSettings(await api('assistant/settings', { method: 'POST', json: body })); btn.textContent = 'Збережено ✓'; }
    catch (e) { $('setErr').textContent = e.message; btn.textContent = 'Зберегти'; }
    btn.disabled = false; setTimeout(() => { btn.textContent = 'Зберегти'; }, 1500);
  }
  $('setForm').addEventListener('submit', e => { e.preventDefault(); saveSettings(); });
  $('setForm').addEventListener('click', e => {
    if (e.target.id === 'clearKey' && confirm('Видалити ключ Claude API?')) saveSettings({ clearKey: true });
    if (e.target.id === 'unlinkBot' && confirm('Відвʼязати Telegram-чат? Нагадування перестануть приходити, доки не привʼяжете знову.')) saveSettings({ unlink: true });
    if (e.target.id === 'clearBot' && confirm('Видалити бота з налаштувань?')) saveSettings({ clearBot: true });
  });

  // ---------- старт і перемикання вкладок ----------
  document.addEventListener('md:tab', e => {
    if (e.detail === 'tasks') loadTasks();
    if (e.detail === 'notes') loadNotes();
    if (e.detail === 'state') loadState();
    if (e.detail === 'settings') loadSettings();
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!document.querySelector('[data-panel="state"]').hidden) loadState(); }, 250); });
  MD.hooks.push(async () => {
    try { const s = await api('assistant/settings'); settings = s; $('assistHint').hidden = s.hasKey; } catch (e) {}
    refreshCount();
  });
})();
