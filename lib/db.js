// База даних mdmy.me: SQLite в одному файлі (DATA_DIR/mdmy.db).
// Облікові записи власника й сесії входу, журнал дій, налаштування (meta),
// дані персонального асистента (задачі, нагадування, нотатки, стан, звички).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 4;

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
  if (v < 3) migrateV3(db);
  if (v < 4) migrateV4(db);
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

// v3: фундамент системи задач.
//  • простори (assistant_spaces) замість фіксованих сфер: «Вхідні», «Робота», «Особисте» + власні; опис простору — підказка для асистента;
//  • статуси (assistant_statuses) — колонки канбану: треба зробити / в роботі / чекаю / готово;
//  • у задачі: status, position (порядок у колонці), description (опис / тіло задачі);
//  • сесії: client — з якого застосунку вхід (браузер, Android, Telegram), для токенів API.
// assistant_items перебудовується (SQLite не вміє прибрати CHECK зі сферами), id зберігаються.
const STATUS_SEED = [['todo', 'Треба зробити'], ['doing', 'В роботі'], ['waiting', 'Чекаю'], ['done', 'Готово']];
function migrateV3(db) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    const now = Date.now();
    let hints = {};
    try { hints = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'assistant_settings'").get() || {}).value || '{}'); } catch (e) {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_spaces (
        key         TEXT PRIMARY KEY,                 -- inbox | work | personal | s<число> для власних
        name        TEXT NOT NULL,
        icon        TEXT NOT NULL DEFAULT 'folder',   -- назва лінійної іконки інтерфейсу
        description TEXT,                             -- що сюди належить (підказка для асистента)
        position    REAL NOT NULL,
        archived    INTEGER NOT NULL DEFAULT 0,
        created     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_statuses (
        key      TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        position REAL NOT NULL,
        done     INTEGER NOT NULL DEFAULT 0            -- 1 — статус «виконано»
      );
      CREATE TABLE assistant_items_v3 (
        id          INTEGER PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('task', 'reminder', 'note')),
        text        TEXT NOT NULL,
        due_at      INTEGER,
        sent_at     INTEGER,
        done_at     INTEGER,
        msg_id      INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
        created     INTEGER NOT NULL,
        updated     INTEGER NOT NULL,
        project_id  INTEGER REFERENCES assistant_projects(id) ON DELETE SET NULL,
        priority    INTEGER NOT NULL DEFAULT 0,
        parent_id   INTEGER REFERENCES assistant_items(id) ON DELETE CASCADE,
        repeat      TEXT,
        area        TEXT NOT NULL DEFAULT 'inbox',     -- ключ простору (assistant_spaces.key)
        status      TEXT NOT NULL DEFAULT 'todo',      -- ключ статусу (assistant_statuses.key)
        position    REAL NOT NULL DEFAULT 0,           -- порядок усередині колонки / списку
        description TEXT
      );
      INSERT INTO assistant_items_v3 (id, kind, text, due_at, sent_at, done_at, msg_id, created, updated, project_id, priority, parent_id, repeat, area, status, position)
        SELECT id, kind, text, due_at, sent_at, done_at, msg_id, created, updated, project_id, priority, parent_id, repeat, area,
               CASE WHEN done_at IS NOT NULL THEN 'done' ELSE 'todo' END, id * 1024 FROM assistant_items;
      DROP TABLE assistant_items;
      ALTER TABLE assistant_items_v3 RENAME TO assistant_items;
      CREATE INDEX assistant_items_kind ON assistant_items(kind, done_at);
      CREATE INDEX assistant_items_due ON assistant_items(due_at) WHERE sent_at IS NULL AND done_at IS NULL;
      CREATE INDEX assistant_items_project ON assistant_items(project_id);
      CREATE INDEX assistant_items_parent ON assistant_items(parent_id);
      CREATE INDEX assistant_items_area ON assistant_items(area, status, position);
      ALTER TABLE sessions ADD COLUMN client TEXT;
    `);
    const sp = db.prepare('INSERT OR IGNORE INTO assistant_spaces (key, name, icon, description, position, created) VALUES (?, ?, ?, ?, ?, ?)');
    sp.run('inbox', 'Вхідні', 'inbox', 'Ще не розсортовані задачі', 0, now);
    sp.run('work', 'Робота', 'briefcase', hints.workHint || '', 1, now);
    sp.run('personal', 'Особисте', 'home', hints.personalHint || '', 2, now);
    const st = db.prepare('INSERT OR IGNORE INTO assistant_statuses (key, name, position, done) VALUES (?, ?, ?, ?)');
    STATUS_SEED.forEach(([k, n], i) => st.run(k, n, i, k === 'done' ? 1 : 0));
  })();
  db.pragma('foreign_keys = ON');
  const bad = db.pragma('foreign_key_check');
  if (bad.length) console.warn('Міграція v3: зв\'язків, що посилаються на відсутні рядки:', bad.length);
}

// v4: push-сповіщення (Web Push) — підписка кожного браузера / встановленого застосунку
function migrateV4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY,
      account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      device     TEXT,                              -- коротко: «Android · Chrome»
      created    INTEGER NOT NULL,
      last_ok    INTEGER,
      fails      INTEGER NOT NULL DEFAULT 0
    );
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
