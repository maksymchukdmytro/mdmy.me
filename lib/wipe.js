// «Почати спочатку»: стерти всі записи облікового запису (задачі, нотатки, розмови з асистентом, звички, щоденні завдання,
// власні простори, медіа), залишивши сам акаунт, вхід, налаштування, Telegram і сповіщення.
// Після видалення — VACUUM і скорочення журналу WAL, щоб стерті дані не лишались у файлі бази.
const fs = require('fs');
const path = require('path');

const TABLES = ['attachments', 'assistant_item_tags', 'assistant_events', 'assistant_items', 'assistant_tags', 'assistant_messages', 'assistant_projects',
                'assistant_checkins', 'assistant_habit_log', 'assistant_habits', 'routine_log', 'routines', 'habit_marks', 'habits', 'assistant_fts'];

module.exports = function wipe(db) {
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const t of TABLES) if (has(t)) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare("DELETE FROM assistant_spaces WHERE key NOT IN ('inbox', 'work', 'personal')").run();
      db.prepare("UPDATE assistant_spaces SET archived = 0").run();
      db.prepare("DELETE FROM meta WHERE key IN ('demo_seeded')").run();
    })();
  } finally { db.pragma('foreign_keys = ON'); }
  for (const sub of ['media', 'files']) {
    const dir = path.join(path.dirname(db.file), sub);
    try { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); } catch (e) {}
  }
  try { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('[wipe] vacuum:', e.message); }
};
