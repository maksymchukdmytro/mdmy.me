// Одноразове перенесення даних зі старої бази OctoType (там раніше жили /nakladna і /speachtotext).
//   node manage.js import /var/lib/dm-type/dm-type.db
// Переносить: облікові записи ролі admin (з тими самими паролями), налаштування накладних і асистента
// (meta: nakladna_*, assistant_*) і всі дані асистента. Зі старої бази лише читає.
// Працює тільки в порожню базу mdmy.me, щоб нічого не перезаписати й не задвоїти.
// Облікові записи з очевидним паролем (admin, логін, 12345678, password) не переносяться: тут зберігаються ключі API.
const fs = require('fs');
const D = require('./db');

const ASSISTANT_TABLES = [   // порядок: спершу ті, на які посилаються інші
  ['assistant_messages', 'id, at, source, text, reply'],
  ['assistant_projects', 'id, name, archived, created'],
  ['assistant_items', 'id, kind, text, due_at, sent_at, done_at, msg_id, created, updated, project_id, priority, parent_id, repeat'],
  ['assistant_tags', 'id, name'],
  ['assistant_item_tags', 'item_id, tag_id'],
  ['assistant_events', 'id, at, msg_id, kind, ref, action, before, after, undone_at'],
  ['assistant_checkins', 'day, mood, energy, sleep, note, updated'],
  ['assistant_habits', 'id, name, archived, created'],
  ['assistant_habit_log', 'habit_id, day'],
  ['assistant_fts', 'text, ref_type, ref_id']
];

module.exports = function importOctotype(db, file) {
  if (!file || !fs.existsSync(file)) throw new Error('Не знайдено стару базу: ' + file);
  const busy = db.prepare('SELECT (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM assistant_messages) + (SELECT COUNT(*) FROM assistant_items) + (SELECT COUNT(*) FROM meta) AS n').get().n;
  if (busy) throw new Error('База mdmy.me вже містить дані — перенесення пропущено, щоб нічого не перезаписати.');

  // стара база OctoType не зашифрована — KEY '' (інакше SQLite3 Multiple Ciphers застосує ключ основної бази)
  db.prepare(D.encrypted ? "ATTACH DATABASE ? AS old KEY ''" : 'ATTACH DATABASE ? AS old').run(file);
  const report = {};
  try {
    const has = name => !!db.prepare("SELECT 1 FROM old.sqlite_master WHERE name = ?").get(name);
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      if (has('admins')) {
        report.accounts = db.prepare(`INSERT OR IGNORE INTO accounts (login, name, salt, hash, disabled, created, last_login)
          SELECT login, name, salt, hash, disabled, created, last_login FROM old.admins WHERE role = 'admin'`).run().changes;
      }
      if (has('meta')) {
        report.settings = db.prepare(`INSERT OR REPLACE INTO meta (key, value)
          SELECT key, value FROM old.meta WHERE key LIKE 'nakladna%' OR key LIKE 'assistant%'`).run().changes;
      }
      for (const [table, cols] of ASSISTANT_TABLES) {
        if (!has(table)) continue;
        report[table] = db.prepare(`INSERT INTO main.${table} (${cols}) SELECT ${cols} FROM old.${table}`).run().changes;
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
    db.exec('DETACH DATABASE old');
  }
  const weak = db.prepare('SELECT id, login, salt, hash FROM accounts').all()
    .filter(a => ['admin', a.login, '12345678', 'password'].some(p => D.checkPass(p, a.salt, a.hash)));
  for (const a of weak) db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
  if (weak.length) { report.accounts -= weak.length; report.skippedWeak = weak.map(a => a.login); }
  const bad = db.pragma('foreign_key_check');
  if (bad.length) console.warn('Увага: після перенесення', bad.length, 'записів посилаються на відсутні рядки.');
  return report;
};
