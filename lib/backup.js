// Резервні копії баз mdmy: створення (VACUUM INTO — копія зашифрована тим самим ключем, що й база), перелік і перевірка.
// Спільне для консолі (manage.js backup) і адмінки («Резервні копії»).
//   <тека>/mdmy-2026-10-19.db        — основна база
//   <тека>/mdmy-2026-10-19-ws/u5.db  — окремі бази користувачів (зберігаються 14 останніх тек)
const fs = require('fs');
const path = require('path');
const DB = require('./db');

const q = f => `'${path.resolve(f).replace(/'/g, "''")}'`;
const wsDirOf = file => file.replace(/\.db$/, '') + '-ws';

function make(db, dataDir, out) {
  const t0 = Date.now();
  if (fs.existsSync(out)) fs.rmSync(out);
  db.exec(`VACUUM INTO ${q(out)}`);
  const wsRoot = path.join(dataDir, 'ws'), parent = path.dirname(path.resolve(out)), errors = [];
  let n = 0;
  if (fs.existsSync(wsRoot)) {
    const dir = wsDirOf(out);
    fs.mkdirSync(dir, { recursive: true });
    for (const ws of fs.readdirSync(wsRoot)) {
      const f = path.join(wsRoot, ws, 'mdmy.db'), to = path.join(dir, ws + '.db');
      if (!/^u\d+$/.test(ws) || !fs.existsSync(f)) continue;
      try {
        const src = DB.openFile(f, ws, { readonly: true, fileMustExist: true });
        try { if (fs.existsSync(to)) fs.rmSync(to); src.exec(`VACUUM INTO ${q(to)}`); n++; } finally { src.close(); }
      } catch (e) { errors.push(`${ws}: ${e.message}`); }
    }
    fs.readdirSync(parent).filter(x => /^mdmy-.+-ws$/.test(x)).map(x => ({ x, t: fs.statSync(path.join(parent, x)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(14).forEach(({ x }) => fs.rmSync(path.join(parent, x), { recursive: true, force: true }));
  }
  // старі копії, зроблені ще до шифрування, — зашифрувати на місці
  const encrypted = DB.encryptPlainFiles(parent, 1);
  return { file: out, size: fs.statSync(out).size, ws: n, errors, encrypted, ms: Date.now() - t0 };
}

function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { error: 'Тека копій недоступна.', list: [] }; }
  const out = names.filter(x => /^(mdmy|pre-update)-.+\.db$/.test(x)).map(x => {
    const f = path.join(dir, x), st = fs.statSync(f), wd = wsDirOf(f);
    let ws = 0, wsSize = 0;
    try { for (const y of fs.readdirSync(wd)) if (/^u\d+\.db$/.test(y)) { ws++; wsSize += fs.statSync(path.join(wd, y)).size; } } catch (e) {}
    return { name: x, at: st.mtimeMs, size: st.size, ws, wsSize, kind: x.startsWith('pre-update') ? 'update' : 'daily' };
  }).sort((a, b) => b.at - a.at);
  return { list: out };
}

// Перевірка: копія відкривається ключем, цілісна (quick_check), має облікові записи; те саме для окремих баз
function verify(file) {
  const t0 = Date.now(), problems = [];
  let accounts = 0, version = 0, ws = 0;
  try {
    const d = DB.openFile(file, 'main', { readonly: true, fileMustExist: true });
    try {
      const qc = d.pragma('quick_check', { simple: true });
      if (qc !== 'ok') problems.push('основна база: ' + qc);
      version = d.pragma('user_version', { simple: true });
      accounts = d.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
    } finally { d.close(); }
  } catch (e) { problems.push('основна база: ' + e.message); }
  const wd = wsDirOf(file);
  if (fs.existsSync(wd)) for (const y of fs.readdirSync(wd)) {
    const m = /^(u\d+)\.db$/.exec(y); if (!m) continue;
    try {
      const d = DB.openFile(path.join(wd, y), m[1], { readonly: true, fileMustExist: true });
      try { const qc = d.pragma('quick_check', { simple: true }); if (qc !== 'ok') problems.push(`${m[1]}: ${qc}`); else ws++; } finally { d.close(); }
    } catch (e) { problems.push(`${m[1]}: ${e.message}`); }
  }
  return { file: path.basename(file), at: Date.now(), ok: !problems.length, accounts, version, ws, problems: problems.slice(0, 10), ms: Date.now() - t0 };
}

module.exports = { make, list, verify };
