# mdmy.me (by Maksymchuk Dmytro) — нотатки для Claude Code

Особистий робочий сайт на домені mdmy.me: персональний асистент (`/assistant/`) і видаткові накладні з LP-CRM (`/nakladna/`).
Окремий проєкт від OctoType (octotype.tech, репозиторій maksymchukdmytro/octotype): спільний лише сервер. Код, база, вхід, служби й nginx — свої.
Інтерфейс і тексти — українською. Чистий JS без збирання; сервер — Node.js без фреймворків, база — better-sqlite3.

## Як розгорнуто (після deploy/deploy.sh)
- Код: `/opt/mdmy` (власник `mdmy`). База SQLite: `/var/lib/mdmy/mdmy.db`. Копії: `/var/backups/mdmy` (щодня 03:30, `/etc/cron.d/mdmy-backup`).
- Служба: `systemctl status|restart mdmy`, журнал `journalctl -u mdmy -f`. Слухає `127.0.0.1:3001`.
- Nginx: `/etc/nginx/sites-available/mdmy` (проксі, `client_max_body_size 3m` для голосу), HTTPS через certbot.
- Оновлення: `deploy/autoupdate.sh` → сервер кожні 5 хв бере нові коміти з main (`/opt/mdmy-src`, журнал `/var/log/mdmy-update.log`, вручну `mdmy-update --force`).
  Вручну: `sudo bash deploy/deploy.sh mdmy.me <email>` (базу не чіпає). Домен і пошта — у `/etc/mdmy.conf`.
- Розшифровка голосу: служба `dm-stt` (Python, faster-whisper) на `127.0.0.1:8010`; код `/opt/dm-stt/app`, venv `/opt/dm-stt/.venv`,
  моделі `/var/lib/dm-stt`, користувач `dmstt`. Ставиться й оновлюється `deploy/stt.sh` (викликається з deploy.sh).
  Модель за обсягом RAM (≥3.5 ГБ — large-v3-turbo, ≥1.8 ГБ — small, інакше base; distil-* лише англійські) або з `/etc/dm-stt.conf` (`WHISPER_MODEL=...`).
  Nice=10, CPUWeight=20 і MemoryMax, щоб не заважати сайтам; `av<16` у requirements обов'язково (новіші PyAV ламають faster-whisper 1.2.1).
- На тому ж сервері працює OctoType (служба `dm-type`, порт 3000, `/etc/nginx/sites-available/dm-type`) — його не чіпати.

## Структура
- `server.js` — статичні файли з `public/` (розділи `nakladna`, `assistant` віддаються з `X-Frame-Options: DENY`) і `/api/*`.
  Старі адреси `/speachtotext` → 301 на `/assistant/`.
- `lib/auth.js` — `/api/login|logout|me|password`; cookie `mdmy_session` (Path=/, HttpOnly, SameSite=Strict, 30 днів);
  усі запити, крім GET, вимагають заголовок `X-MDMY: 1`. Обмеження спроб входу — 8 за 10 хв з IP.
- `lib/db.js` — схема (PRAGMA user_version): `accounts`, `sessions`, `audit`, `meta` (налаштування: `nakladna_settings`, `nakladna_index`, `assistant_settings`)
  і таблиці асистента `assistant_*`. Нові зміни схеми — новою міграцією з наступним `user_version`.
- `public/nakladna/` + `lib/nakladna.js` — видаткові накладні: LP-CRM getOrdersByID; короткий номер (напр. 353) шукається через getStatuses + getOrdersIdByStatus
  за датами, відповідність кешується в meta `nakladna_index`; назви товарів — getProduct. PDF у браузері (pdfmake і шрифт Inter у `public/nakladna/vendor/`,
  шаблон `public/nakladna/invoice.js`). Спосіб доставки: delivery_id з CRM → назва з `deliveryMap` (запам'ятовується зі сторінки).
  Адреса CRM, API-ключ і реквізити — у meta `nakladna_settings`; ключ не віддається в браузер і не комітиться. API `/api/nakladna/*`.
- `public/assistant/` — застосунок «mdmy» (задачі й асистент) у стилі Notion: монохром, лінійні іконки (`js/icons.js`), світла/темна тема.
  ES-модулі без збирання: `js/main.js` (оболонка: бічна панель, нижня панель на телефоні, маршрути `#/…`, вхід, Ctrl+K-палітра),
  `js/nav.js` (маршрути), `js/api.js` (cookie + `X-MDMY`, у Telegram Web App — Bearer), `js/store.js` (довідники й лічильники), `js/ui.js` (меню, діалоги, тости, дати),
  `js/views/tasks.js` (сторінка простору / «Сьогодні» / «Найближчі» / «Усі»: список із групами, канбан з перетягуванням мишею й пальцем, фільтри, масові дії, розбір «Вхідних» по одній),
  `js/views/panel.js` (бічна картка задачі: властивості, підзадачі, опис, автозбереження), `notes.js`, `state.js`, `record.js` (голос → асистент), `settings.js` (простори, Telegram, пристрої).
  Маршрути: `#/today`, `#/upcoming`, `#/all`, `#/s/<простір>`, `#/notes`, `#/state`, `#/record`, `#/settings[/розділ]`, суфікс `/t/<id>` — відкрита задача.
  Після будь-якої зміни сторінки шлють подію `mdmy:changed` → оновлення поточної сторінки й лічильників.
- Модель задач (міграція v3): простори `assistant_spaces` (inbox / work / personal + власні `s…`, опис — підказка агенту), статуси `assistant_statuses`
  (todo / doing / waiting / done — колонки канбану; статус «done» ⇔ `done_at`), у задачі `status`, `position` (порядок у колонці), `description`.
  API для всіх клієнтів (веб, Android, Telegram Web App) — `docs/API.md`; змінюючи API, оновлюйте й цей файл.
- Вхід для застосунків: `POST /api/auth/token` → Bearer-токен; Telegram Web App: `POST /api/auth/telegram` (initData, лише власник привʼязаного бота).
  Бот ставить кнопку меню «Задачі» на `PUBLIC_URL/assistant/` (`PUBLIC_URL` задає deploy.sh у службі).
- Push-сповіщення (міграція v4, `push_subscriptions`): `lib/push.js` (бібліотека `web-push`, ключі VAPID у meta `push_vapid`, підписані токени кнопок),
  сервіс-воркер `public/assistant/sw.js` (без кешування; кнопки «Готово» / «+1 год» → `POST /api/push/action`), фронтенд `js/push.js` + розділ «Сповіщення» в налаштуваннях
  і одноразова пропозиція увімкнути. Таймер асистента шле нагадування в усі канали (Telegram і push); невідправлені нагадування, прострочені понад 12 год, не надсилаються.
  Іконки застосунку й сповіщень: `public/assistant/icon-*.png`, `badge-96.png` (одноколірна для рядка стану Android).
- `lib/stt.js` → Python-служба `services/stt` (`/health`, `/transcribe`). Аудіо на сервері не зберігається.
- Асистент: `lib/assistant.js` (агент, таймер, API `/api/assistant/*`) + `lib/assistant-store.js` (усі зміни даних) + `lib/assistant-time.js` (часові пояси, повтори) + `lib/telegram.js` (бот).
  Агент: текст → Claude API (за замовч. `claude-haiku-5-5`) з інструментами `search_memory` (FTS по всьому сказаному), `get_state` (стан/звички) і фінальним `save_actions`;
  цикл до 4 запитів, `tool_choice` any → на останньому кроці примусово save_actions; для Opus/Sonnet/Fable/Mythos — `auto`.
  Дії: reminder / task / note / complete / reopen / update / delete / checkin / undo; поля area, status, description, project, priority (0–2), parent_id, repeat {freq, interval, days}.
  Простір задачі (`area`): агент визначає за змістом, проєктом, описами просторів і тим, як розкладені схожі задачі; незрозуміле — у `inbox` («Вхідні»).
  Підзадачі успадковують простір батька, перенесення задачі переносить і підзадачі. Агент також ставить `status` («почав» → doing, «чекаю» → waiting) і `description`.
  `/api/assistant/triage` — підказки Claude для «Вхідних» (нічого не змінює). Telegram `/inbox` — кнопки просторів під кожною задачею.
  Таблиці: `assistant_messages`, `assistant_items`, `assistant_projects`, `assistant_tags` + `assistant_item_tags`, `assistant_events` (знімки до/після → скасування),
  `assistant_checkins`, `assistant_habits` + `assistant_habit_log`, `assistant_fts` (FTS5; оновлюється лише кодом сховища — дані міняти тільки через `assistant-store.js`).
  Telegram: long polling без бібліотек, один привʼязаний приватний чат (`/start <код>`), `lastUpdateId` у налаштуваннях; таймер кожні 20 с — нагадування,
  ранковий план після `morningTime` (до 12:00), підсумок після `summaryTime`. Ключ Claude і токен бота — у meta `assistant_settings`, у браузер не віддаються.
  Тести — з макетами через `ANTHROPIC_BASE_URL` і `TELEGRAM_API_BASE`.
- `manage.js` — CLI: `DATA_DIR=/var/lib/mdmy node manage.js create|password|list|backup|import`.
- `lib/import-octotype.js` — одноразове перенесення зі старої бази OctoType (`IMPORT_FROM=… deploy.sh`), лише в порожню базу.

## Правила
- Особисті дані власника (задачі, нотатки, щоденник) і ключі API не виводити в журнали й не копіювати з сервера без потреби.
- Перед змінами схеми бази: копія (`node manage.js backup …`) і нова міграція в `lib/db.js`.
- Не запускати сайт від root; файли в `/opt/mdmy` і `/var/lib/mdmy` належать `mdmy`.
- Після змін у коді на сервері: `systemctl restart mdmy` і перевірка `curl -s 127.0.0.1:3001/api/ping`.
- Розшифровка: `systemctl status|restart dm-stt`, журнал `journalctl -u dm-stt -f`, перевірка `curl -s 127.0.0.1:8010/health`.
- Назовні відкриті лише 22, 80, 443 (ufw). Порти 3001 і 8010 назовні не відкривати.
