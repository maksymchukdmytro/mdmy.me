// Вкладення: фото, файли, посилання — у задачах, дорученнях (докази) і відмітках челенджів.
// attachHtml(list, {edit}) — сітка; bindAttach(box, {upload, link, remove, after}) — кнопки «Фото / Файл / Посилання», видалення, перегляд фото.
// Великі фото перед завантаженням зменшуються до 2048 px (JPEG) — звіт легкий, а видно все.
import { authHeaders } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, fail, sheet } from '../ui.js';

const kb = n => n > 1048576 ? (n / 1048576).toFixed(1).replace('.0', '') + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';

export function attachHtml(list, { edit = true } = {}) {
  const tiles = (list || []).map(a => {
    const del = edit && a.canDelete !== false ? `<button type="button" class="at-del" data-at-del="${a.id}" aria-label="Прибрати">${icon('x', 12)}</button>` : '';
    if (a.kind === 'image') return `<div class="at at-img" data-at-view="${esc(a.url)}"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">${del}</div>`;
    if (a.kind === 'link') return `<a class="at at-file" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon('link', 18)}<span><b>${esc(a.name)}</b><small>посилання</small></span>${del}</a>`;
    return `<a class="at at-file" href="${esc(a.url)}" target="_blank" rel="noopener">${icon('file', 18)}<span><b>${esc(a.name)}</b><small>${a.size ? kb(a.size) : 'файл'}</small></span>${del}</a>`;
  }).join('');
  const add = edit ? `<div class="at-add">
      <label class="at-btn">${icon('image', 16)}<span>Фото</span><input type="file" accept="image/*" multiple hidden data-at-pick="image"></label>
      <label class="at-btn">${icon('paperclip', 16)}<span>Файл</span><input type="file" multiple hidden data-at-pick="file"></label>
      <button type="button" class="at-btn" data-at-link>${icon('link', 16)}<span>Посилання</span></button>
    </div>` : '';
  return `<div class="at-grid">${tiles}</div>${add}`;
}

// зменшити велике фото (JPEG до 2048 px), щоб звіти важили мало
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1048576) return file;
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch (e) { return file; }
}
// завантажити файл сирим тілом (сервер: lib/files.js)
export async function uploadFile(url, file) {
  const f = await shrink(file);
  const r = await fetch('/api/' + url, { method: 'POST', credentials: 'same-origin', headers: { ...authHeaders(), 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'файл') }, body: f });
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || 'Не вдалося завантажити');
  return d;
}

export function askLink() {
  return new Promise(resolve => {
    let done = false;
    const s = sheet(`<div class="sheet-head"><b>Посилання</b></div><form class="link-form"><input type="url" placeholder="https://…" inputmode="url" autocomplete="off" required>
      <button class="btn primary" type="submit">Додати</button></form>`, { label: 'Посилання', onClose: () => { if (!done) resolve(null); } });
    const inp = s.el.querySelector('input'); setTimeout(() => inp.focus(), 250);
    s.el.querySelector('form').addEventListener('submit', e => { e.preventDefault(); let v = inp.value.trim(); if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v; done = true; s.close(); resolve(v || null); });
  });
}
function viewImage(url) {
  const w = document.createElement('div'); w.className = 'at-viewer';
  w.innerHTML = `<img src="${esc(url)}" alt=""><button type="button" class="icon-btn" aria-label="Закрити">${icon('x', 22)}</button>`;
  document.body.append(w); requestAnimationFrame(() => w.classList.add('in'));
  const close = () => { w.classList.remove('in'); setTimeout(() => w.remove(), 200); document.removeEventListener('keydown', key, true); };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  w.addEventListener('click', close);
}

// upload(file) і link(url) — повертають новий список (або що завгодно — after(result) перемалює); remove(id)
export function bindAttach(box, { upload, link, remove, after }) {
  box.addEventListener('change', async e => {
    const inp = e.target.closest('[data-at-pick]'); if (!inp || !inp.files.length) return;
    const list = [...inp.files]; inp.value = '';
    box.classList.add('busy');
    try { let r; for (const f of list) r = await upload(f); after(r); toast(list.length > 1 ? `Додано: ${list.length}` : 'Додано'); }
    catch (err) { fail(err); } finally { box.classList.remove('busy'); }
  });
  box.addEventListener('click', async e => {
    const v = e.target.closest('[data-at-view]'); const d = e.target.closest('[data-at-del]');
    if (d) { e.preventDefault(); e.stopPropagation(); try { after(await remove(+d.dataset.atDel)); } catch (err) { fail(err); } return; }
    if (v) return viewImage(v.dataset.atView);
    if (e.target.closest('[data-at-link]')) { const u = await askLink(); if (!u) return; try { after(await link(u)); } catch (err) { fail(err); } }
  });
}
