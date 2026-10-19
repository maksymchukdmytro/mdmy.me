#!/usr/bin/env node
// Керування mdmy.me з консолі сервера.
//   npm run account -- create <логін> "<Ім'я>"   створити обліковий запис (пароль буде показано)
//   npm run account -- password <логін>          видати новий пароль
//   npm run account -- list                      список облікових записів
//   npm run account -- admin <логін>             зробити адміністратором (ключ Claude, модель, бот Telegram)
//   npm run account -- user <логін>              зняти права адміністратора
//   npm run account -- demo <логін> <пароль>     гостьовий вхід з окремою демо-базою (пароль може бути простим)
//   npm run account -- backup <файл.db>          резервна копія бази
//   npm run account -- import <стара.db>         перенести дані зі старої бази OctoType (один раз, у порожню базу)
const path = require('path');
const DB = require('./lib/db');

const db = DB.open(process.env.DATA_DIR || path.join(__dirname, 'data'));
const [cmd, login, ...rest] = process.argv.slice(2);
const name = rest.join(' ').trim();
const fail = msg => { console.error(msg); process.exitCode = 1; };
const audit = (action, target) => db.prepare('INSERT INTO audit (at, login, action, target) VALUES (?, ?, ?, ?)').run(Date.now(), 'консоль', action, target || null);

(async () => {
  if (cmd === 'create') {
    const l = String(login || '').toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(l)) return fail('Логін: 3–32 латинські літери, цифри, крапка або дефіс.');
    if (db.prepare('SELECT 1 FROM accounts WHERE login = ?').get(l)) return fail('Такий логін уже є.');
    const pass = DB.tempPassword(), salt = DB.newSalt();
    db.prepare('INSERT INTO accounts (login, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)')
      .run(l, name || 'Власник', salt, DB.hashPass(pass, salt), Date.now());
    audit('account:create', l);
    DB.ensureAdmin(db); DB.ensurePubIds(db);
    console.log(`Створено обліковий запис: ${l}\nПароль: ${pass}`);
  } else if (cmd === 'password') {
    const a = db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(login || ''));
    if (!a) return fail('Такого логіна немає.');
    const pass = DB.tempPassword(), salt = DB.newSalt();
    db.prepare('UPDATE accounts SET salt = ?, hash = ?, disabled = 0 WHERE id = ?').run(salt, DB.hashPass(pass, salt), a.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(a.id);
    audit('account:password', a.login);
    console.log(`Новий пароль для ${a.login}: ${pass}`);
  } else if (cmd === 'demo') {
    const l = String(login || '').toLowerCase(), p = rest[0];
    if (!/^[a-z0-9._-]{3,32}$/.test(l) || !p) return fail('Використання: demo <логін> <пароль>');
    if (db.prepare('SELECT 1 FROM accounts WHERE login = ?').get(l)) return fail('Такий логін уже є.');
    DB.createDemo(db, l, 'Гість', p);
    audit('account:demo', l);
    console.log(`Гостьовий вхід ${l} створено (окрема демо-база). Демо-дані зʼявляться під час першого входу.`);
  } else if (cmd === 'admin' || cmd === 'user') {
    const a = db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(login || ''));
    if (!a) return fail('Такого логіна немає.');
    if (cmd === 'user' && db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND id <> ?").get(a.id).n === 0) return fail('Це єдиний адміністратор — спершу призначте іншого.');
    db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(cmd, a.id);
    audit('account:role', `${a.login} → ${cmd}`);
    console.log(`${a.login}: ${cmd === 'admin' ? 'адміністратор' : 'звичайний користувач'}`);
  } else if (cmd === 'list') {
    const list = db.prepare('SELECT login, name, role, disabled, last_login FROM accounts ORDER BY login').all();
    if (!list.length) console.log('Облікових записів ще немає.');
    list.forEach(a => console.log(`${a.login.padEnd(20)} ${a.name}${a.role === 'admin' ? '  (адмін)' : a.role === 'demo' ? '  (гість, окрема база)' : ''}${a.disabled ? '  (вимкнено)' : ''}`));
  } else if (cmd === 'backup') {
    const out = login || `mdmy-backup-${Date.now()}.db`;
    await db.backup(out);
    console.log('Резервну копію збережено:', out);
    // окремі бази користувачів (DATA_DIR/ws/<ws>/mdmy.db) — у теку поруч: mdmy-2026-10-19-ws/u5.db; зберігаються 14 останніх тек
    const wsRoot = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'ws'), fs = require('fs');
    if (fs.existsSync(wsRoot)) {
      const dir = out.replace(/\.db$/, '') + '-ws';
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const ws of fs.readdirSync(wsRoot)) {
        const f = path.join(wsRoot, ws, 'mdmy.db');
        if (!/^u\d+$/.test(ws) || !fs.existsSync(f)) continue;
        const Database = require('better-sqlite3'), src = new Database(f, { readonly: true, fileMustExist: true });
        try { await src.backup(path.join(dir, ws + '.db')); n++; } finally { src.close(); }
      }
      console.log(`Окремих баз збережено: ${n} → ${dir}`);
      const parent = path.dirname(path.resolve(dir));
      fs.readdirSync(parent).filter(x => /^mdmy-.+-ws$/.test(x)).map(x => ({ x, t: fs.statSync(path.join(parent, x)).mtimeMs }))
        .sort((a, b) => b.t - a.t).slice(14).forEach(({ x }) => fs.rmSync(path.join(parent, x), { recursive: true, force: true }));
    }
  } else if (cmd === 'import') {
    try {
      const r = require('./lib/import-octotype')(db, login);
      audit('import:octotype', login);
      DB.ensureAdmin(db);
      console.log('Перенесено зі старої бази:', JSON.stringify(r));
      if (r.skippedWeak) console.log('Не перенесено через надто простий пароль:', r.skippedWeak.join(', '));
    } catch (e) { fail(e.message); }
  } else {
    console.log(`Команди:
  npm run account -- create <логін> "<Ім'я>"   створити обліковий запис
  npm run account -- password <логін>          видати новий пароль
  npm run account -- list                      список
  npm run account -- admin <логін>             зробити адміністратором
  npm run account -- user <логін>              зняти права адміністратора
  npm run account -- demo <логін> <пароль>     гостьовий вхід з окремою демо-базою
  npm run account -- backup <файл.db>          резервна копія бази
  npm run account -- import <стара.db>         перенести дані зі старої бази OctoType`);
  }
  db.close();
})();
