// Формування звичок (вкладка «Звички» розділу «Щоденні завдання»).
// #/habits — список: серія, тиждень звички (перший кружечок — перший день), кнопка «сьогодні»; #/habits/<id> — звичка: календар ✓/✗, серії, налаштування;
// #/habits/check — вечірня відмітка (з неї відкривається сповіщення): «Так / Ні» під кожною звичкою.
// Сервер — lib/habits.js, API /api/habits/*.
import { get, post, patch, del } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, esc, toast, fail, confirmBox, debounce, sheet, pref } from '../ui.js';
import { go } from '../nav.js';
import { dailyTabs } from './rituals.js';

// 5 стандартних значків + шоста плитка — будь-яке своє емоджі з клавіатури
const EMOJI = ['💪', '📖', '💧', '🧘', '😴'];
const isEmoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const lastEmoji = v => {
  const parts = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('uk', { granularity: 'grapheme' }).segment(v)].map(x => x.segment) : [...v];
  return parts.reverse().find(g => isEmoji.test(g)) || '';
};
function iconRow(cur) {
  const own = cur && !EMOJI.includes(cur) ? cur : '';
  return `<div class="h-emojis">${EMOJI.map(x => `<button type="button" class="h-emo${x === cur ? ' on' : ''}" data-emo="${x}" aria-label="${x}">${x}</button>`).join('')}
    <label class="h-emo own${own ? ' on' : ''}" title="Своє емоджі"><input class="h-own" value="${esc(own)}" placeholder=" " aria-label="Своє емоджі" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done"><span class="h-own-ph">${icon('plus', 18)}<small>своє</small></span></label></div>
    <p class="h-own-hint" hidden>Виберіть будь-яке емоджі на клавіатурі${navigator.platform && /Win/.test(navigator.platform) ? ' (Win + .)' : /Mac/.test(navigator.platform || '') ? ' (Ctrl + Cmd + Пробіл)' : ''}</p>`;
}
// onPick(emoji) — щоразу, коли вибрано значок
function bindIconRow(box, onPick) {
  const own = $('.h-own', box), hint = $('.h-own-hint', box);
  const set = (el, v) => { $$('.h-emo', box).forEach(x => x.classList.toggle('on', x === el)); onPick(v); };
  box.addEventListener('click', e => { const b = e.target.closest('[data-emo]'); if (b) { own.value = ''; set(b, b.dataset.emo); } });
  own.addEventListener('focus', () => { hint.hidden = false; });
  own.addEventListener('blur', () => { hint.hidden = true; });
  own.addEventListener('input', () => {
    const v = lastEmoji(own.value); own.value = v;
    if (v) { set(own.closest('.h-emo'), v); own.blur(); }
  });
  own.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); own.blur(); } });
}
const daysRow = days => `<div class="r-days">${DAYS.map((d, i) => `<button type="button" class="day${!days || days.includes(i + 1) ? ' on' : ''}" data-wd="${i + 1}">${d}</button>`).join('')}</div>`;
const remindRow = (on, time) => `<div class="h-rem-row"><label class="switch"><input type="checkbox" class="h-rem-on" ${on ? 'checked' : ''}><span>${icon('bell', 15)}Нагадувати о</span></label>
  <input type="time" class="h-rem" value="${esc(time || '09:00')}" aria-label="Час нагадування" ${on ? '' : 'disabled'}></div>`;
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const changed = () => document.dispatchEvent(new CustomEvent('mdmy:changed'));
const dn = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
const MARK = { 1: icon('check', 14), 0: icon('x', 13) };

export function habitsPage(id) {
  if (id === 'check') return checkPage();
  return id ? habitPage(+id) : listPage();
}

// ---------- список ----------
function listPage() {
  let root, data = null;
  function render(el) {
    root = el; pref.set('daily-tab', 'habits');
    root.innerHTML = `<div class="page habits-page"><div class="page-head"><h1 class="page-title">Щоденні завдання</h1></div>${dailyTabs('habits')}
      <div class="h-list"><span class="spin"></span></div></div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    load();
  }
  async function load() {
    try { data = await get('habits'); } catch (e) { $('.h-list', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    const box = $('.h-list', root);
    box.innerHTML = (data.list.length ? data.list.map(h => `
      <article class="h-card${h.active ? '' : ' off'}" data-id="${h.id}">
        <a class="h-main" href="#/habits/${h.id}">
          <span class="r-emoji">${esc(h.icon)}</span>
          <span class="h-txt"><b>${esc(h.title)}</b>
            <small>${h.streak ? `🔥 ${h.streak} ${dn(h.streak, 'день', 'дні', 'днів')} поспіль` : h.best ? `Найкраща серія — ${h.best}` : h.dayNo > 1 ? `День ${h.dayNo}` : 'Перший день'}${h.remind ? `<span class="h-rt">${icon('bell', 12)}${esc(h.remind)}</span>` : ''}</small>
            <span class="h-week">${h.week.map(d => `<i class="${[!d.planned && !d.future ? 'np' : '', d.mark === 1 ? 'ok' : d.mark === 0 ? 'no' : '', d.future ? 'fut' : '', d.today ? 'td' : ''].filter(Boolean).join(' ')}" title="${d.day}">${d.mark != null ? MARK[d.mark] : ''}</i>`).join('')}</span>
          </span>
        </a>
        ${h.todayPlanned ? `<button type="button" class="h-today ${h.today === 1 ? 'ok' : h.today === 0 ? 'no' : ''}" data-today="${h.id}" aria-label="Сьогодні: ${h.today === 1 ? 'виконано' : h.today === 0 ? 'не виконано' : 'не відмічено'}">${h.today === 0 ? icon('x', 20) : icon('check', 22)}</button>` : '<span class="h-rest">вихідний</span>'}
      </article>`).join('')
      : `<div class="empty r-empty"><p>Звичка — те, що робиш щодня без нагадувань: зарядка, читання, без солодкого.<br>Щовечора спитаю, чи вдалося, а в календарі буде видно прогрес.</p></div>`) +
      `<button type="button" class="btn primary r-new" data-new>${icon('plus', 16)}Нова звичка</button>
      <div class="h-evening">
        <label class="switch"><input type="checkbox" class="h-on" ${data.on ? 'checked' : ''}><span>${icon('moon', 15)}Питати щовечора о</span></label>
        <input type="time" class="h-time" value="${esc(data.time)}" aria-label="Час вечірнього питання">
        <small>у Telegram і сповіщенням — «Так / Ні» під кожною звичкою</small></div>`;
  }
  async function onClick(e) {
    if (e.target.closest('[data-new]')) return newHabit();
    const t = e.target.closest('[data-today]');
    if (t) {
      const h = data.list.find(x => x.id === +t.dataset.today);
      const next = h.today === null ? true : h.today === 1 ? false : null;   // порожньо → ✓ → ✗ → порожньо
      t.classList.add('pop'); if (navigator.vibrate) navigator.vibrate(10);
      try { await post(`habits/${h.id}/mark`, { day: data.today, done: next }); await load(); changed(); } catch (err) { fail(err); }
    }
  }
  async function onChange(e) {
    if (e.target.matches('.h-time, .h-on')) {
      try { const r = await post('habits/settings', { time: $('.h-time', root).value, on: $('.h-on', root).checked }); toast(r.on ? `Питатиму щовечора о ${r.time}` : 'Вечірнє питання вимкнено'); }
      catch (err) { fail(err); }
    }
  }
  return { render, refresh: load };
}

// Нова звичка: значок, назва, дні тижня, нагадування в певний час (у вибрані дні)
function newHabit() {
  const s = sheet(`<div class="sheet-head"><b>Нова звичка</b></div>
    <form class="h-new">
      ${iconRow(EMOJI[0])}
      <input name="title" class="h-title-in" placeholder="Наприклад: зарядка зранку" maxlength="80" autocomplete="off" required enterkeyhint="done">
      <div class="h-field"><span class="h-lbl">Дні</span>${daysRow(null)}</div>
      <div class="h-field">${remindRow(true, '09:00')}</div>
      <button class="btn primary" type="submit">Створити</button></form>`, { label: 'Нова звичка' });
  let emo = EMOJI[0];
  const inp = $('.h-title-in', s.el); setTimeout(() => inp.focus(), 280);
  bindIconRow($('form', s.el), v => { emo = v; });
  const remOn = $('.h-rem-on', s.el), rem = $('.h-rem', s.el);
  remOn.addEventListener('change', () => { rem.disabled = !remOn.checked; });
  s.el.addEventListener('click', e => {
    const d = e.target.closest('[data-wd]'); if (!d) return;
    if (d.classList.contains('on') && $$('.r-days .day.on', s.el).length === 1) return toast('Хоча б один день');
    d.classList.toggle('on');
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  $('form', s.el).addEventListener('submit', async e => {
    e.preventDefault();
    if (!inp.value.trim()) return inp.focus();
    const btn = $('button[type=submit]', s.el); btn.disabled = true;
    try {
      const h = await post('habits', { title: inp.value, icon: emo, days: $$('.r-days .day.on', s.el).map(b => +b.dataset.wd), remind: remOn.checked ? rem.value || '09:00' : null });
      s.close(); changed(); go('#/habits/' + h.id);
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

// ---------- звичка: календар і налаштування ----------
function habitPage(id) {
  let root, h = null, month = null;
  const saveSoon = debounce(v => save(v), 600);
  async function render(el) {
    root = el;
    root.innerHTML = `<div class="page h-page"><a class="back" href="#/habits">${icon('chevronLeft', 18)}Звички</a><div class="h-body"><span class="spin"></span></div></div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('change', e => {
      if (!e.target.matches('.h-rem-on, .h-rem')) return;
      const on = $('.h-rem-on', root).checked, tm = $('.h-rem', root);
      tm.disabled = !on; save({ remind: on ? tm.value || '09:00' : null }).then(() => toast(on ? `Нагадаю о ${tm.value || '09:00'}` : 'Нагадування вимкнено'));
    });
    root.addEventListener('input', e => { if (e.target.dataset.f) { if (e.target.matches('textarea')) grow(e.target); saveSoon({ [e.target.dataset.f]: e.target.value }); } });
    await load();
  }
  const grow = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  async function load(m) {
    try { h = await get(`habits/${id}${m ? '?month=' + m : ''}`); } catch (e) { $('.h-body', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    month = h.month.month; draw();
  }
  function draw() {
    const m = h.month, [y, mo] = m.month.split('-').map(Number);
    const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7;     // пн — перший стовпчик
    const pct = m.planned ? Math.round(m.done / m.planned * 100) : 0;
    const today = new Date(); const tKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    $('.h-body', root).innerHTML = `
      <div class="r-title"><button type="button" class="r-emoji big" data-a="emoji" aria-label="Значок">${esc(h.icon)}</button>
        <textarea data-f="title" rows="1" maxlength="80">${esc(h.title)}</textarea></div>
      <textarea class="r-body" data-f="why" rows="1" maxlength="600" placeholder="Навіщо мені це — нагадає, коли буде важко">${esc(h.why)}</textarea>
      <div class="h-stats">
        <div><b>${h.streak}</b><small>${dn(h.streak, 'день', 'дні', 'днів')} поспіль</small></div>
        <div><b>${h.best}</b><small>найкраща серія</small></div>
        <div><b>${pct}%</b><small>${m.done} з ${m.planned} цього місяця</small></div>
      </div>
      <section class="h-cal">
        <header><button type="button" class="icon-btn" data-m="-1" aria-label="Попередній місяць">${icon('chevronLeft', 18)}</button>
          <b>${MONTHS[mo - 1]} ${y}</b>
          <button type="button" class="icon-btn" data-m="1" aria-label="Наступний місяць" ${m.month >= tKey.slice(0, 7) ? 'disabled' : ''}>${icon('chevronRight', 18)}</button></header>
        <div class="h-grid">${DAYS.map(d => `<span class="h-wd">${d}</span>`).join('')}${'<span></span>'.repeat(lead)}${m.days.map(d => {
          const cls = ['h-day', d.mark === 1 ? 'ok' : d.mark === 0 ? 'no' : '', !d.planned ? 'np' : '', d.future ? 'fut' : '', d.day === tKey ? 'today' : '', d.before && d.mark == null ? 'before' : ''].filter(Boolean).join(' ');
          return `<button type="button" class="${cls}" data-day="${d.day}" ${d.future ? 'disabled' : ''} aria-label="${d.day}${d.mark === 1 ? ', виконано' : d.mark === 0 ? ', не виконано' : ''}">
            <span>${+d.day.slice(8)}</span>${d.mark != null ? `<i>${MARK[d.mark]}</i>` : ''}</button>`;
        }).join('')}</div>
        <p class="h-legend"><span><i class="ok">${MARK[1]}</i>виконав</span><span><i class="no">${MARK[0]}</i>не виконав</span><span class="muted">торкнись дня, щоб змінити</span></p>
      </section>
      <section class="r-sec"><h3>Дні</h3>${daysRow(h.days)}</section>
      <section class="r-sec"><h3>Нагадування</h3>${remindRow(!!h.remind, h.remind)}</section>
      <section class="r-sec r-foot">
        <label class="switch big"><input type="checkbox" data-a="ask" ${h.ask ? 'checked' : ''}><span>Питати щовечора</span></label>
        <div class="r-acts"><button type="button" class="btn ghost danger" data-a="delete">${icon('trash', 15)}Видалити звичку</button></div>
      </section>`;
    $$('textarea', root).forEach(grow);
  }
  async function save(v) { try { h = await patch(`habits/${id}?month=${month}`, v); changed(); } catch (e) { fail(e); } }
  async function onClick(e) {
    const t = e.target.closest('[data-day], [data-m], [data-wd], [data-a]'); if (!t) return;
    if (t.dataset.day) {
      const d = h.month.days.find(x => x.day === t.dataset.day);
      const next = d.mark == null ? true : d.mark === 1 ? false : null;
      t.classList.add('pop'); if (navigator.vibrate) navigator.vibrate(10);
      try { h = await post(`habits/${id}/mark`, { day: d.day, done: next }); month = h.month.month; draw(); changed(); } catch (err) { fail(err); }
      return;
    }
    if (t.dataset.m) {
      const [y, mo] = month.split('-').map(Number), dt = new Date(y, mo - 1 + +t.dataset.m, 1);
      return load(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
    }
    if (t.dataset.wd) {
      const on = !t.classList.contains('on');
      if (!on && $$('.r-days .day.on', root).length === 1) return toast('Хоча б один день');
      t.classList.toggle('on', on);
      return saveSoon({ days: $$('.r-days .day.on', root).map(b => +b.dataset.wd) });
    }
    const a = t.dataset.a;
    if (a === 'ask') return save({ ask: t.checked });
    if (a === 'emoji') {
      const sh = sheet(`<div class="sheet-head"><b>Значок</b></div><div class="h-new">${iconRow(h.icon)}</div>`, { label: 'Значок' });
      bindIconRow(sh.el, v => { t.textContent = v; h.icon = v; save({ icon: v }); setTimeout(() => sh.close(), 160); });
    }
    if (a === 'delete' && await confirmBox(`Видалити звичку «${h.title}» разом з історією?`)) {
      try { await del('habits/' + id); changed(); toast('Видалено'); go('#/habits'); } catch (err) { fail(err); }
    }
  }
  return { render, refresh: () => {} };
}

// ---------- вечірня відмітка: «Так / Ні» під кожною звичкою ----------
function checkPage() {
  const page = listPage();
  return {
    render(el) {
      page.render(el);
      setTimeout(async () => {
        let d; try { d = await get('habits'); } catch (e) { return fail(e); }
        const list = d.list.filter(h => h.active && h.todayPlanned);
        if (!list.length) return;
        const s = sheet(`<div class="sheet-head"><b>Як сьогодні зі звичками?</b></div>
          <div class="h-check">${list.map(h => `<div class="h-q" data-id="${h.id}"><span class="r-emoji">${esc(h.icon)}</span><b>${esc(h.title)}</b>
            <span class="h-yn"><button type="button" class="${h.today === 1 ? 'ok' : ''}" data-yn="1">${icon('check', 16)}Так</button><button type="button" class="${h.today === 0 ? 'no' : ''}" data-yn="0">${icon('x', 15)}Ні</button></span></div>`).join('')}
          <button type="button" class="btn primary h-done" data-done>Готово</button></div>`, { label: 'Звички за сьогодні', onClose: () => { if (location.hash.startsWith('#/habits/check')) go('#/habits'); } });
        s.el.addEventListener('click', async e => {
          if (e.target.closest('[data-done]')) return s.close();
          const b = e.target.closest('[data-yn]'); if (!b) return;
          const q = b.closest('.h-q');
          q.querySelectorAll('[data-yn]').forEach(x => x.className = '');
          b.className = b.dataset.yn === '1' ? 'ok' : 'no';
          try { await post(`habits/${q.dataset.id}/mark`, { day: d.today, done: b.dataset.yn === '1' }); page.refresh(); changed(); } catch (err) { fail(err); }
        });
      }, 300);
    },
    refresh: () => page.refresh()
  };
}
