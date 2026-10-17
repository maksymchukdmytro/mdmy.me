// База даних mdmy.me: SQLite в одному файлі (DATA_DIR/mdmy.db).
// Облікові записи власника й сесії входу, журнал дій, налаштування (meta),
// дані персонального асистента (задачі, нагадування, нотатки, стан, звички).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 2;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mdmy.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');      // читання не блокує запис
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // нижній регістр для кирилиці (вбудовані LIKE і NOCASE SQLite розрізняють регістр лише для латиниці)
  db.function('ulower', { deterministic: true }, s => s == null ? null : String(s).toLowerCase());
  migrate(db);
  db.file = file;
  return db;
}

function migrate(db) {
  const v = db.pragma('user_version', { simple: true });
  if (v >= SCHEMA_VERSION) return;
  if (v < 1) migrateV1(db);
  if (v < 2) migrateV2(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function migrateV1(db) {
  db.exec(`
    -- Хто може входити на сайт (власник і, за потреби, помічники)
    CREATE TABLE IF NOT EXISTS accounts (
      id         INTEGER PRIMARY KEY,
      login      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name       TEXT NOT NULL,
      salt       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      disabled   INTEGER NOT NULL DEFAULT 0,
      created    INTEGER NOT NULL,
      last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created    INTEGER NOT NULL,
      last_used  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id         INTEGER PRIMARY KEY,
      at         INTEGER NOT NULL,
      account_id INTEGER,
      login      TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      details    TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
    -- Налаштування розділів: nakladna_settings, nakladna_index, assistant_settings
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    -- ---------- персональний асистент (lib/assistant-store.js) ----------
    -- Що сказав власник (розшифровка голосу або текст) і що відповів асистент
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id     INTEGER PRIMARY KEY,
      at     INTEGER NOT NULL,
      source TEXT NOT NULL,                        -- 'web' | 'telegram' | 'telegram-voice'
      text   TEXT NOT NULL,
      reply  TEXT
    );
    CREATE INDEX IF NOT EXISTS assistant_messages_at ON assistant_messages(at);
    CREATE TABLE IF NOT EXISTS assistant_projects (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      archived INTEGER NOT NULL DEFAULT 0,
      created  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_items (
      id         INTEGER PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('task', 'reminder', 'note')),
      text       TEXT NOT NULL,
      due_at     INTEGER,                          -- строк задачі / час нагадування (мс UTC)
      sent_at    INTEGER,                          -- коли нагадування надіслано
      done_at    INTEGER,
      msg_id     INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
      created    INTEGER NOT NULL,
      updated    INTEGER NOT NULL,
      project_id INTEGER REFERENCES assistant_projects(id) ON DELETE SET NULL,
      priority   INTEGER NOT NULL DEFAULT 0,       -- 0 звичайна, 1 важлива, 2 термінова
      parent_id  INTEGER REFERENCES assistant_items(id) ON DELETE CASCADE,
      repeat     TEXT                              -- JSON {freq, interval, days}
    );
    CREATE INDEX IF NOT EXISTS assistant_items_kind ON assistant_items(kind, done_at);
    CREATE INDEX IF NOT EXISTS assistant_items_due ON assistant_items(due_at) WHERE sent_at IS NULL AND done_at IS NULL;
    CREATE INDEX IF NOT EXISTS assistant_items_project ON assistant_items(project_id);
    CREATE INDEX IF NOT EXISTS assistant_items_parent  ON assistant_items(parent_id);
    CREATE TABLE IF NOT EXISTS assistant_tags (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE IF NOT EXISTS assistant_item_tags (
      item_id INTEGER NOT NULL REFERENCES assistant_items(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES assistant_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS assistant_item_tags_tag ON assistant_item_tags(tag_id);
    -- Кожна зміна записів: для «скасуй» і для контексту розмови
    CREATE TABLE IF NOT EXISTS assistant_events (
      id        INTEGER PRIMARY KEY,
      at        INTEGER NOT NULL,
      msg_id    INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
      kind      TEXT NOT NULL,                     -- 'item' | 'checkin' | 'habit'
      ref       TEXT NOT NULL,                     -- id запису / день / 'habitId:день'
      action    TEXT NOT NULL,                     -- create | update | complete | delete | advance | checkin | habit
      before    TEXT,                              -- JSON стану до (NULL — запису не було)
      after     TEXT,
      undone_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS assistant_events_msg ON assistant_events(msg_id);
    CREATE TABLE IF NOT EXISTS assistant_checkins (
      day     TEXT PRIMARY KEY,                    -- місцева дата YYYY-MM-DD
      mood    INTEGER CHECK (mood BETWEEN 1 AND 10),
      energy  INTEGER CHECK (energy BETWEEN 1 AND 10),
      sleep   REAL CHECK (sleep BETWEEN 0 AND 24),
      note    TEXT,
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_habits (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      archived INTEGER NOT NULL DEFAULT 0,
      created  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_habit_log (
      habit_id INTEGER NOT NULL REFERENCES assistant_habits(id) ON DELETE CASCADE,
      day      TEXT NOT NULL,
      PRIMARY KEY (habit_id, day)
    );
    -- Повнотекстовий пошук по всьому сказаному й по записах (оновлюється лише кодом сховища)
    CREATE VIRTUAL TABLE IF NOT EXISTS assistant_fts USING fts5(text, ref_type UNINDEXED, ref_id UNINDEXED, tokenize = 'unicode61');
  `);
}

// v2: сфера задачі — робоча, особиста або ще не розсортована (inbox). Наявні записи потрапляють у «Несортовані».
function migrateV2(db) {
  db.exec(`
    ALTER TABLE assistant_items ADD COLUMN area TEXT NOT NULL DEFAULT 'inbox' CHECK (area IN ('inbox', 'work', 'personal'));
    CREATE INDEX IF NOT EXISTS assistant_items_area ON assistant_items(area, done_at);
  `);
}

// ---------- паролі й токени ----------
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const checkPass = (pass, salt, hash) => {
  try { return crypto.timingSafeEqual(Buffer.from(hashPass(pass, salt), 'hex'), Buffer.from(hash, 'hex')); } catch (e) { return false; }
};
const newSalt = () => crypto.randomBytes(16).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
// Тимчасовий пароль без схожих символів (0/O, 1/l)
function tempPassword(n = 12) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(n), b => abc[b % abc.length]).join('');
}

module.exports = { open, hashPass, checkPass, newSalt, sha, newToken, tempPassword };
