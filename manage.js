#!/usr/bin/env node
// Керування mdmy.me з консолі сервера.
//   npm run account -- create <логін> "<Ім'я>"   створити обліковий запис (пароль буде показано)
//   npm run account -- password <логін>          видати новий пароль
//   npm run account -- list                      список облікових записів
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
    console.log(`Створено обліковий запис: ${l}\nПароль: ${pass}`);
  } else if (cmd === 'password') {
    const a = db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(login || ''));
    if (!a) return fail('Такого логіна немає.');
    const pass = DB.tempPassword(), salt = DB.newSalt();
    db.prepare('UPDATE accounts SET salt = ?, hash = ?, disabled = 0 WHERE id = ?').run(salt, DB.hashPass(pass, salt), a.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(a.id);
    audit('account:password', a.login);
    console.log(`Новий пароль для ${a.login}: ${pass}`);
  } else if (cmd === 'list') {
    const list = db.prepare('SELECT login, name, disabled, last_login FROM accounts ORDER BY login').all();
    if (!list.length) console.log('Облікових записів ще немає.');
    list.forEach(a => console.log(`${a.login.padEnd(20)} ${a.name}${a.disabled ? '  (вимкнено)' : ''}`));
  } else if (cmd === 'backup') {
    const out = login || `mdmy-backup-${Date.now()}.db`;
    await db.backup(out);
    console.log('Резервну копію збережено:', out);
  } else if (cmd === 'import') {
    try {
      const r = require('./lib/import-octotype')(db, login);
      audit('import:octotype', login);
      console.log('Перенесено зі старої бази:', JSON.stringify(r));
      if (r.skippedWeak) console.log('Не перенесено через надто простий пароль:', r.skippedWeak.join(', '));
    } catch (e) { fail(e.message); }
  } else {
    console.log(`Команди:
  npm run account -- create <логін> "<Ім'я>"   створити обліковий запис
  npm run account -- password <логін>          видати новий пароль
  npm run account -- list                      список
  npm run account -- backup <файл.db>          резервна копія бази
  npm run account -- import <стара.db>         перенести дані зі старої бази OctoType`);
  }
  db.close();
})();
