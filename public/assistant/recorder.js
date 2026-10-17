// Персональний асистент, вкладка «Запис»: мікрофон → /api/stt/transcribe → текст → (за бажанням) асистент виконує дії.
// Вхід — сесія mdmy.me (cookie mdmy_session), зміни — із заголовком X-MDMY.
// Історія розшифровок зберігається лише в цьому браузері (localStorage); задачі й нотатки — на сервері (assistant.js).
(() => {
  const $ = id => document.getElementById(id);
  const MAX_SEC = 10 * 60;               // автоматична зупинка запису
  const MAX_BYTES = 2.8 * 1024 * 1024;   // nginx пропускає до 3 МБ (≈10 хв мови при 32 кбіт/с)
  const HISTORY_KEY = 'mdmy-assistant-history';

  async function api(path, opts = {}) {
    const r = await fetch('/api/' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: Object.assign({ 'X-MDMY': '1' }, opts.json ? { 'Content-Type': 'application/json' } : {}, opts.headers || {}),
      body: opts.json ? JSON.stringify(opts.json) : opts.body
    });
    let data = null; try { data = await r.json(); } catch (e) {}
    if (r.status === 401 && path !== 'login') { showLogin(); throw new Error('Потрібно увійти.'); }
    if (r.status === 413) throw new Error('Запис завеликий. Спробуйте коротший.');
    if (!r.ok) throw new Error((data && data.error) || `Помилка ${r.status}`);
    return data;
  }

  // Спільне для assistant.js
  const MD = window.MD = { api, hooks: [], assist: null };

  // ---------- вкладки ----------
  const TAB_KEY = 'mdmy-assistant-tab';
  function showTab(name) {
    if (!document.querySelector(`[data-panel="${name}"]`)) name = 'rec';
    for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
    document.dispatchEvent(new CustomEvent('md:tab', { detail: name }));
  }
  MD.showTab = showTab;
  $('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

  // ---------- вхід ----------
  function showLogin() { $('appView').hidden = true; $('loginView').hidden = false; $('lgLogin').focus(); }
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault(); $('lgErr').textContent = '';
    try { await api('login', { method: 'POST', json: { login: $('lgLogin').value, password: $('lgPass').value } }); $('lgPass').value = ''; start(); }
    catch (err) { $('lgErr').textContent = err.message; }
  });
  $('logoutBtn').addEventListener('click', async () => { try { await api('logout', { method: 'POST' }); } catch (e) {} showLogin(); });

  async function start() {
    let me;
    try { me = (await api('me')).account; } catch (e) { return; }
    $('loginView').hidden = true; $('appView').hidden = false;
    renderHistory();
    checkService();
    let tab = 'rec'; try { tab = localStorage.getItem(TAB_KEY) || 'rec'; } catch (e) {}
    showTab(tab);
    for (const f of MD.hooks) f();
  }

  async function checkService() {
    const tag = $('svc');
    try {
      const h = await api('stt/health');
      tag.textContent = 'Whisper ' + ({ 'large-v3-turbo': 'Turbo', turbo: 'Turbo', 'large-v3': 'Large' }[h.model] || h.model);
      tag.title = `Модель ${h.model}`; tag.className = 'tag ok';
    } catch (e) {
      tag.textContent = 'сервіс недоступний'; tag.className = 'tag gray';
      tag.title = e.message;
    }
  }

  // ---------- запис ----------
  const btn = $('rec');
  let recorder = null, stream = null, chunks = [], startedAt = 0, timer = null, audioCtx = null, raf = 0;

  function setStatus(html, isErr = false) { const s = $('status'); s.innerHTML = html; s.classList.toggle('err', isErr); }
  const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  function startMeter() {
    try {
      audioCtx = new AudioContext();
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2;
        btn.style.setProperty('--level', Math.min(1, Math.sqrt(s / buf.length) * 4).toFixed(2));
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {}
  }
  function stopMeter() {
    cancelAnimationFrame(raf); btn.style.setProperty('--level', 0);
    if (audioCtx) audioCtx.close().catch(() => {}); audioCtx = null;
  }

  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) return setStatus('Цей браузер не вміє записувати звук.', true);
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return setStatus('Немає доступу до мікрофона. Дозвольте його в налаштуваннях браузера.', true); }
    chunks = [];
    // 32 кбіт/с цілком досить для мови і вдесятеро менше за типові налаштування браузера
    try { recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 }); } catch (e) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = upload;
    recorder.start(1000);
    startMeter();
    startedAt = Date.now();
    btn.classList.add('recording'); btn.setAttribute('aria-label', 'Зупинити запис');
    setStatus('<span class="st-dot">●</span> Запис 0:00');
    timer = setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000;
      setStatus(`<span class="st-dot">●</span> Запис ${fmt(sec)}`);
      if (sec >= MAX_SEC) stopRec();
    }, 250);
  }

  function stopRec() {
    clearInterval(timer); stopMeter();
    if (recorder && recorder.state === 'recording') recorder.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
    btn.classList.remove('recording'); btn.setAttribute('aria-label', 'Почати запис');
  }

  async function upload() {
    const type = (recorder.mimeType || 'audio/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    if (blob.size < 1000) return setStatus('Запис надто короткий.', true);
    if (blob.size > MAX_BYTES) return setStatus('Запис завеликий. До 10 хвилин за раз.', true);
    btn.disabled = true;
    setStatus('<span class="st-spin"></span>Розшифровую…');
    try {
      const r = await api('stt/transcribe?lang=' + lang, { method: 'POST', body: blob, headers: { 'Content-Type': type } });
      const item = addHistory({ text: r.text, duration: r.duration, elapsed: r.elapsed, lang: r.language, at: Date.now() });
      setStatus('Готово. Можна записувати ще.');
      if (r.text && $('assistOn').checked && MD.assist) runAssist(item);
    } catch (e) {
      setStatus(e.message, true);
      if (/недоступний|не запущено/.test(e.message)) checkService();
    } finally { btn.disabled = false; }
  }

  btn.addEventListener('click', () => (recorder && recorder.state === 'recording') ? stopRec() : startRec());

  // ---------- мова ----------
  const LANG_KEY = 'mdmy-assistant-lang';
  const LANG_NAMES = { uk: 'укр', ru: 'рус', en: 'англ' };
  let lang = 'uk';
  try { lang = localStorage.getItem(LANG_KEY) || 'uk'; } catch (e) {}
  function setLang(l) {
    lang = ['uk', 'ru', 'auto'].includes(l) ? l : 'uk';
    for (const b of document.querySelectorAll('#langs button')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
  }
  $('langs').addEventListener('click', e => { const b = e.target.closest('button[data-lang]'); if (b) setLang(b.dataset.lang); });
  setLang(lang);

  // ---------- історія ----------
  function loadHistory() { try { return (JSON.parse(localStorage.getItem(HISTORY_KEY)) || []).map(x => ({ ...x, pending: false })); } catch (e) { return []; } }
  function saveHistory(list) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) {} }
  let history = [];
  function addHistory(item) { history.unshift(item); saveHistory(history); renderHistory(); return item; }

  // ---------- асистент: текст → дії ----------
  const ASSIST_KEY = 'mdmy-assistant-assist';
  try { $('assistOn').checked = localStorage.getItem(ASSIST_KEY) !== '0'; } catch (e) { $('assistOn').checked = true; }
  $('assistOn').addEventListener('change', () => { try { localStorage.setItem(ASSIST_KEY, $('assistOn').checked ? '1' : '0'); } catch (e) {} });
  async function runAssist(item) {
    item.pending = true; renderHistory();
    try { const r = await MD.assist(item.text); item.assist = { reply: r.reply, done: r.done, msgId: r.msgId, undoable: r.undoable }; }
    catch (e) { item.assist = { error: e.message }; }
    item.pending = false; saveHistory(history); renderHistory();
  }
  $('askForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('askInput').value.trim();
    if (!text) return;
    if (!MD.assist) return setStatus('Асистент ще завантажується…', true);
    $('askInput').value = '';
    runAssist(addHistory({ text, typed: true, at: Date.now() }));
  });

  function renderHistory() {
    if (!history.length) history = loadHistory();
    const box = $('results');
    $('clearBtn').hidden = !history.length;
    if (!history.length) { box.innerHTML = '<p class="st-empty muted">Тут з\'являтимуться тексти. Історія розшифровок зберігається лише в цьому браузері.</p>'; return; }
    box.innerHTML = '';
    for (const it of history) {
      const card = document.createElement('article'); card.className = 'st-item';
      const p = document.createElement('p'); p.textContent = it.text || '(нічого не розпізнано)';
      const meta = document.createElement('div'); meta.className = 'st-meta';
      const when = new Date(it.at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const info = document.createElement('span');
      info.textContent = it.typed ? `${when} · набрано` : `${when} · ${it.duration} с запису · ${it.elapsed} с обробки` + (it.lang ? ` · ${LANG_NAMES[it.lang] || it.lang}` : '');
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn small'; copy.textContent = 'Копіювати';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(it.text); copy.textContent = 'Скопійовано'; copy.classList.add('done'); }
        catch (e) { copy.textContent = 'Не вдалося'; }
        setTimeout(() => { copy.textContent = 'Копіювати'; copy.classList.remove('done'); }, 1500);
      };
      meta.append(info, copy); card.append(p);
      if (it.pending || it.assist) {
        const a = document.createElement('div'); a.className = 'st-assist' + (it.assist && it.assist.error ? ' err' : '');
        if (it.pending) a.innerHTML = '<span class="st-spin"></span>Асистент думає…';
        else if (it.assist.error) a.textContent = '⚠️ ' + it.assist.error;
        else a.textContent = [it.assist.reply, ...(it.assist.done || [])].filter(Boolean).join('\n') || 'Записав 👍';
        if (it.assist && it.assist.undoable && it.assist.msgId && !it.assist.undone) {
          const u = document.createElement('button'); u.type = 'button'; u.className = 'btn small st-undo'; u.textContent = '↩️ Скасувати';
          u.onclick = async () => {
            u.disabled = true;
            try { const r = await MD.api('assistant/undo', { method: 'POST', json: { msgId: it.assist.msgId } }); it.assist.undone = true;
                  it.assist.done = [...(it.assist.done || []), '↩️ Скасовано' + (r.undone.length ? ': ' + r.undone.join('; ') : '')]; }
            catch (e) { alert(e.message); }
            saveHistory(history); renderHistory();
          };
          a.append(document.createElement('br'), u);
        }
        card.append(a);
      }
      card.append(meta); box.append(card);
    }
  }
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('Видалити всі розшифровки з цього браузера?')) return;
    history = []; saveHistory(history); renderHistory();
  });

  start();
})();
