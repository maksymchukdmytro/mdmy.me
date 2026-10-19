// База даних mdmy.me: SQLite в одному файлі (DATA_DIR/mdmy.db).
// Облікові записи власника й сесії входу, журнал дій, налаштування (meta),
// дані персонального асистента (задачі, нагадування, нотатки, ритуали дня).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Шифрування баз на диску: SQLite3 Multiple Ciphers (ChaCha20-Poly1305), ключ кожної бази виводиться з головного (lib/keys.js).
// Пакет необовʼязковий: якщо не встановився, працює звичайний better-sqlite3 без шифрування (з попередженням).
let Cipher = null; try { Cipher = require('better-sqlite3-multiple-ciphers'); } catch (e) { console.warn('[db] better-sqlite3-multiple-ciphers не встановлено — бази НЕ шифруються'); }
const Database = Cipher || require('better-sqlite3');
const keys = require('./keys');
const isPlainFile = f => {
  try { const fd = fs.openSync(f, 'r'), b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b.toString('latin1') === 'SQLite format 3\0'; }
  catch (e) { return false; }
};
// Відкрити файл бази з ключем. Незашифровану (стару) — зашифрувати на місці (rekey; у WAL не працює, тож тимчасово DELETE).
function openFile(file, label, opts = {}) {
  const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
  if (!Cipher && exists && !isPlainFile(file)) throw new Error(`База ${file} зашифрована, а модуль better-sqlite3-multiple-ciphers не встановлено (npm ci).`);
  const db = new Database(file, opts);
  if (!Cipher) return db;
  const pass = keys.dbPass(label);
  if (exists && isPlainFile(file)) {
    if (opts.readonly) return db;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.pragma(`rekey='${pass}'`);
    console.log(`[db] базу ${label} зашифровано`);
  } else db.pragma(`key='${pass}'`);
  db.prepare('SELECT count(*) FROM sqlite_master').get();      // неправильний ключ — помилка одразу, а не посеред роботи
  return db;
}

// Зашифрувати старі незашифровані файли баз у теці (знімки перед міграціями, резервні копії, окремі бази, які ще не відкривались).
// Ключ — за назвою: u5.db або …/ws/u5/*.db → 'u5', решта → 'main'. Відкриті зараз бази не чіпати (rekey потребує монопольного доступу).
function encryptPlainFiles(dir, depth = 2, skip = new Set()) {
  if (!Cipher || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    let st; try { st = fs.lstatSync(f); } catch (e) { continue; }
    if (st.isDirectory()) { if (depth > 0) n += encryptPlainFiles(f, depth - 1, skip); continue; }
    if (!st.isFile() || !/^(mdmy.*|pre-update-.*|u\d+)\.db$/.test(name) || skip.has(path.resolve(f)) || !isPlainFile(f)) continue;
    const parts = path.resolve(f).split(path.sep), m = name.match(/^(u\d+)\.db$/);
    const label = m ? m[1] : parts[parts.length - 3] === 'ws' && /^u\d+$/.test(parts[parts.length - 2]) ? parts[parts.length - 2] : 'main';
    try { openFile(f, label).close(); n++; } catch (e) { console.error('[db] не вдалося зашифрувати', name, e.message); }
  }
  return n;
}

const SCHEMA_VERSION = 10;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mdmy.db');
  // основна база — 'main', окрема база користувача (DATA_DIR/ws/u5) — 'u5': у кожної свій ключ
  const label = path.basename(path.dirname(dataDir)) === 'ws' ? path.basename(dataDir) : 'main';
  const db = openFile(file, label);
  db.label = label;
  db.pragma('journal_mode = WAL');      // читання не блокує запис
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // нижній регістр для кирилиці (вбудовані LIKE і NOCASE SQLite розрізняють регістр лише для латиниці)
  db.function('ulower', { deterministic: true }, s => s == null ? null : String(s).toLowerCase());
  migrate(db, file);
  sealSecrets(db);
  if (label === 'main') seedAccounts(db);
  ensureAdmin(db);
  ensurePubIds(db);
  db.file = file;
  return db;
}

function migrate(db, file) {
  const v = db.pragma('user_version', { simple: true });
  if (v >= SCHEMA_VERSION) return;
  // знімок бази перед зміною схеми (поруч із базою): mdmy-before-v7-2026-10-18.db
  if (v >= 1 && file) {
    const snap = path.join(path.dirname(file), `mdmy-before-v${SCHEMA_VERSION}-${new Date().toISOString().slice(0, 10)}.db`);
    try { if (!fs.existsSync(snap)) db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`); } catch (e) { console.error('[db] знімок перед міграцією:', e.message); }
  }
  if (v < 1) migrateV1(db);
  if (v < 2) migrateV2(db);
  if (v < 3) migrateV3(db);
  if (v < 4) migrateV4(db);
  if (v < 5) migrateV5(db);
  if (v < 6) migrateV6(db);
  if (v < 7) migrateV7(db);
  if (v < 8) migrateV8(db);
  if (v < 9) migrateV9(db);
  if (v < 10) migrateV10(db);
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

// v5: проєкти стають тегами (окремих проєктів більше немає); ритуали — повторювані завдання дня з фото/відео
function migrateV5(db) {
  db.transaction(() => {
    // назва проєкту → тег (нижній регістр, до 30 символів) на кожному записі проєкту
    db.exec(`
      INSERT OR IGNORE INTO assistant_tags (name)
        SELECT DISTINCT substr(ulower(trim(name)), 1, 30) FROM assistant_projects WHERE trim(name) <> '';
      INSERT OR IGNORE INTO assistant_item_tags (item_id, tag_id)
        SELECT i.id, t.id FROM assistant_items i
          JOIN assistant_projects p ON p.id = i.project_id
          JOIN assistant_tags t ON t.name = substr(ulower(trim(p.name)), 1, 30);
      UPDATE assistant_items SET project_id = NULL WHERE project_id IS NOT NULL;
      DELETE FROM assistant_projects;

      -- Ритуал: що зробити, кроки з таймером, медіа й розклад (певні години або «кожні N хвилин з … до …»)
      CREATE TABLE IF NOT EXISTS routines (
        id          INTEGER PRIMARY KEY,
        title       TEXT NOT NULL,
        icon        TEXT NOT NULL DEFAULT '✨',
        body        TEXT,                     -- коротко: що зробити
        steps       TEXT,                     -- JSON [{text, sec}]
        media       TEXT,                     -- JSON [{type: image|video|youtube|link|eyes|water|breath, url, name}]
        times       TEXT,                     -- JSON ["09:00", "13:00"] — режим «у певний час»
        every       INTEGER,                  -- хвилин між нагадуваннями — режим «кожні N хвилин»
        from_hm     TEXT, to_hm TEXT,         -- межі для режиму «кожні N хвилин»
        days        TEXT,                     -- JSON [1..7] (пн=1); NULL — щодня
        active      INTEGER NOT NULL DEFAULT 1,
        position    REAL NOT NULL DEFAULT 0,
        last_slot   TEXT,                     -- 'YYYY-MM-DD HH:MM' — останній надісланий раз
        snooze_at   INTEGER, snooze_slot TEXT, -- «пізніше»: повторити цей раз
        created     INTEGER NOT NULL,
        updated     INTEGER NOT NULL
      );
      -- Кожен раз ритуалу: надіслано / зроблено / пропущено
      CREATE TABLE IF NOT EXISTS routine_log (
        id         INTEGER PRIMARY KEY,
        routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        day        TEXT NOT NULL,             -- місцева дата YYYY-MM-DD
        slot       TEXT NOT NULL,             -- HH:MM за розкладом
        status     TEXT NOT NULL,             -- sent | done | skip
        at         INTEGER NOT NULL,
        UNIQUE (routine_id, day, slot)
      );
      CREATE INDEX IF NOT EXISTS routine_log_day ON routine_log(day);
    `);
  })();
}

// v6: формування звичок — список звичок і відмітки по днях (так / ні); щовечора асистент питає
function migrateV6(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id          INTEGER PRIMARY KEY,
      title       TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '✨',
      why         TEXT,                     -- навіщо (мотивація)
      days        TEXT,                     -- JSON [1..7] (пн=1); NULL — щодня
      ask         INTEGER NOT NULL DEFAULT 1,   -- питати щовечора
      active      INTEGER NOT NULL DEFAULT 1,
      position    REAL NOT NULL DEFAULT 0,
      start_day   TEXT NOT NULL,            -- з якого дня відстежуємо (YYYY-MM-DD)
      created     INTEGER NOT NULL,
      updated     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS habit_marks (
      habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      day        TEXT NOT NULL,             -- місцева дата YYYY-MM-DD
      done       INTEGER NOT NULL,          -- 1 — виконав, 0 — ні
      at         INTEGER NOT NULL,
      PRIMARY KEY (habit_id, day)
    );
  `);
}

// v7: ролі облікових записів (admin бачить і змінює ключ Claude, модель і бота Telegram)
// і нагадування звички в певний час у заплановані дні.
function migrateV7(db) {
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols('accounts').includes('role')) db.exec("ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  if (!cols('habits').includes('remind')) db.exec('ALTER TABLE habits ADD COLUMN remind TEXT');          // HH:MM або NULL
  if (!cols('habits').includes('reminded_day')) db.exec('ALTER TABLE habits ADD COLUMN reminded_day TEXT');
}
// v8: окремі дані облікового запису. accounts.ws — імʼя окремої бази (DATA_DIR/ws/<ws>/mdmy.db) з власними задачами,
// нотатками, звичками, ритуалами й сповіщеннями; NULL — основна база власника (як було до v8).
// Роль demo — гостьовий вхід (спільний пароль): без зміни пароля, накладних, завантаження медіа, з денним лімітом асистента.
// На наявній установці створюється гостьовий вхід guest / guest з окремою демо-базою.
function migrateV8(db) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!cols.includes('ws')) db.exec('ALTER TABLE accounts ADD COLUMN ws TEXT');
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get() && !db.prepare("SELECT 1 FROM accounts WHERE login = 'guest'").get()) createDemo(db, 'guest', 'Гість', 'guest');
}
// v9: вхід через Google. google_sub — незмінний ідентифікатор користувача Google (за ним і шукаємо, не за поштою),
// email — для показу в налаштуваннях. Акаунт, створений через Google, пароля не має (hash = '').
function migrateV9(db) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!cols.includes('google_sub')) db.exec('ALTER TABLE accounts ADD COLUMN google_sub TEXT');
  if (!cols.includes('email')) db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_google ON accounts(google_sub) WHERE google_sub IS NOT NULL');
}
// v10: вкладення до задач (фото, файли, посилання — у базі власника записів, файли в <тека бази>/files)
// і спільне між акаунтами — лише в основній базі: публічний ID акаунта (pub_id), дозволи «хто може давати мені задачі»,
// доручення з підтвердженням виконання, челенджі з учасниками й щоденними відмітками, файли-докази (DATA_DIR/shared).
function migrateV10(db) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (cols.length && !cols.includes('pub_id')) db.exec('ALTER TABLE accounts ADD COLUMN pub_id TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_pub ON accounts(pub_id) WHERE pub_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS attachments (
      id      INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES assistant_items(id) ON DELETE CASCADE,
      kind    TEXT NOT NULL CHECK (kind IN ('image', 'file', 'link')),
      name    TEXT, mime TEXT, size INTEGER,
      fkey    TEXT UNIQUE,                       -- імʼя файлу на диску (32 hex) — для image / file
      url     TEXT,                              -- для link
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_item ON attachments(item_id);
    CREATE TABLE IF NOT EXISTS team_links (            -- member дозволив boss давати йому задачі
      boss_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created   INTEGER NOT NULL,
      PRIMARY KEY (boss_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id           INTEGER PRIMARY KEY,
      boss_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      member_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      text         TEXT NOT NULL,
      description  TEXT,
      due_at       INTEGER,
      need_proof   INTEGER NOT NULL DEFAULT 0,       -- 1 — без фото / файлу / посилання не здати
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'rework', 'approved', 'failed')),
      report       TEXT,                             -- що написав виконавець, здаючи
      review_note  TEXT,                             -- коментар того, хто перевіряє
      created      INTEGER NOT NULL,
      updated      INTEGER NOT NULL,
      submitted_at INTEGER,
      reviewed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS assignments_member ON assignments(member_id, status);
    CREATE INDEX IF NOT EXISTS assignments_boss ON assignments(boss_id, status);
    CREATE TABLE IF NOT EXISTS challenges (
      id          INTEGER PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,              -- за ним долучаються
      owner_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT,
      days        INTEGER NOT NULL,
      start_day   TEXT NOT NULL,                     -- YYYY-MM-DD
      confirm     INTEGER NOT NULL DEFAULT 0,        -- 1 — відмітки підтверджує автор челенджу
      need_proof  INTEGER NOT NULL DEFAULT 0,        -- 1 — відмітка лише з фото / файлом / посиланням
      created     INTEGER NOT NULL,
      closed      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS challenge_members (
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      joined       INTEGER NOT NULL,
      PRIMARY KEY (challenge_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS challenge_checks (
      id           INTEGER PRIMARY KEY,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      day          TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'ok', 'rejected')),   -- draft — доказ додано, відмітку ще не надіслано
      note         TEXT,
      created      INTEGER NOT NULL,
      reviewed_at  INTEGER,
      UNIQUE (challenge_id, account_id, day)
    );
    CREATE TABLE IF NOT EXISTS shared_files (           -- докази до доручень і відміток челенджів
      id         INTEGER PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('assignment', 'check')),
      owner_id   INTEGER NOT NULL,
      by_account INTEGER NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('image', 'file', 'link')),
      name TEXT, mime TEXT, size INTEGER, fkey TEXT UNIQUE, url TEXT,
      created    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shared_files_owner ON shared_files(owner_kind, owner_id);
  `);
}
// Публічний ID акаунта (6 символів без схожих 0/O, 1/I) — ним діляться, щоб давати задачі
const PUB_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randCode = (n = 6) => Array.from(crypto.randomBytes(n), b => PUB_ABC[b % PUB_ABC.length]).join('');
function ensurePubIds(db) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!cols.includes('pub_id')) return;
  for (const a of db.prepare('SELECT id FROM accounts WHERE pub_id IS NULL').all()) {
    let c; do c = randCode(); while (db.prepare('SELECT 1 FROM accounts WHERE pub_id = ?').get(c));
    db.prepare('UPDATE accounts SET pub_id = ? WHERE id = ?').run(c, a.id);
  }
}

// Новий користувач (реєстрація через Google): своя окрема база u<id>, без пароля. Логін — з пошти, унікальний.
function createUser(db, { name, email, googleSub }) {
  const base = String(email || 'user').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'user';
  let login = base.length >= 3 ? base : base + 'user';
  for (let i = 2; db.prepare('SELECT 1 FROM accounts WHERE login = ?').get(login); i++) login = base + i;
  return db.transaction(() => {
    const id = db.prepare("INSERT INTO accounts (login, name, salt, hash, created, role, google_sub, email) VALUES (?, ?, ?, '', ?, 'user', ?, ?)")
      .run(login, String(name || login).slice(0, 80), newSalt(), Date.now(), googleSub || null, email || null).lastInsertRowid;
    db.prepare('UPDATE accounts SET ws = ? WHERE id = ?').run('u' + id, id);
    ensurePubIds(db);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  })();
}

// Гостьовий (демо) обліковий запис з окремою базою
function createDemo(db, login, name, pass) {
  const salt = newSalt();
  const id = db.prepare("INSERT INTO accounts (login, name, salt, hash, created, role) VALUES (?, ?, ?, ?, ?, 'demo')").run(login, name, salt, hashPass(pass, salt), Date.now()).lastInsertRowid;
  db.prepare('UPDATE accounts SET ws = ? WHERE id = ?').run('u' + id, id);
  ensurePubIds(db);
  return id;
}
const wsDir = (dataDir, ws) => { if (!/^u\d+$/.test(ws || '')) throw new Error('Неправильне імʼя бази.'); return path.join(dataDir, 'ws', ws); };

// Секрети в meta (ключі API, токени, приватні ключі) — зашифровані головним ключем (lib/keys.js); старі відкриті значення шифруються під час запуску.
const SEALED = { assistant_settings: ['anthropicKey', 'botToken'], auth_settings: ['googleClientSecret', 'cookieSecret'], nakladna_settings: ['apiKey'], push_vapid: ['privateKey', 'secret'] };
function sealSecrets(db) {
  const put = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
  for (const [key, fields] of Object.entries(SEALED)) {
    const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); if (!r) continue;
    let v; try { v = JSON.parse(r.value); } catch (e) { continue; }
    if (keys.hasPlain(v, fields)) put.run(JSON.stringify(keys.sealFields(v, fields)), key);
  }
  const m = db.prepare("SELECT value FROM meta WHERE key = 'media_secret'").get();
  if (m && !keys.isSealed(m.value)) put.run(keys.seal(m.value), 'media_secret');
}

// Разові облікові записи, створені на прохання власника під час оновлення (у коді — лише хеш пароля).
// Ставляться один раз (позначка в meta): якщо запис потім видалили або змінили пароль — не відновлюється.
// Логін уже є — йому ставиться цей пароль і роль (база не змінюється).
// Роль nakladna — лише накладні (/nakladna/): асистент, налаштування й інші API закриті (server.js blocked).
const SEED = [
  { key: 'seed_admin_nakladna_2026_10_19', login: 'admin', name: 'Накладні', role: 'nakladna',
    salt: 'ea5c562aba81d5db4c8e9845e3bc2bd2', hash: 'b05b12a355876f5327f7471154d826e76006ae77759a427856aaf39411ef95a9' },
];
function seedAccounts(db) {
  for (const a of SEED) {
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(a.key)) continue;
    db.transaction(() => {
      const old = db.prepare('SELECT id FROM accounts WHERE login = ?').get(a.login);
      if (old) db.prepare('UPDATE accounts SET name = ?, salt = ?, hash = ?, role = ?, disabled = 0 WHERE id = ?').run(a.name, a.salt, a.hash, a.role, old.id);
      else db.prepare('INSERT INTO accounts (login, name, salt, hash, created, role) VALUES (?, ?, ?, ?, ?, ?)').run(a.login, a.name, a.salt, a.hash, Date.now(), a.role);
      db.prepare('INSERT INTO audit (at, login, action, target) VALUES (?, ?, ?, ?)').run(Date.now(), 'оновлення', old ? 'account:password' : 'account:create', a.login);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(a.key, String(Date.now()));
    })();
    console.log(`[db] обліковий запис ${a.login}: ${a.role}`);
  }
}

// Адміністратор має бути завжди: якщо немає жодного — ним стає найперший обліковий запис (власник).
function ensureAdmin(db) {
  if (db.prepare("SELECT 1 FROM accounts WHERE role = 'admin' LIMIT 1").get()) return;
  db.prepare("UPDATE accounts SET role = 'admin' WHERE id = (SELECT MIN(id) FROM accounts WHERE ws IS NULL AND role NOT IN ('demo', 'nakladna'))").run();
}

// ---------- паролі й токени ----------
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const checkPass = (pass, salt, hash) => {
  if (!hash) return false;                       // акаунт лише з входом через Google
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

module.exports = { open, openFile, encryptPlainFiles, encrypted: !!Cipher, ensureAdmin, ensurePubIds, randCode, createDemo, createUser, wsDir, hashPass, checkPass, newSalt, sha, newToken, tempPassword };
