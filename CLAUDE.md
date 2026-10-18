# mdmy.me (by Maksymchuk Dmytro) — нотатки для Claude Code

Особистий робочий сайт на домені mdmy.me: персональний асистент (`/assistant/`: задачі, нотатки, ритуали дня) і видаткові накладні з LP-CRM (`/nakladna/`).
Окремий проєкт від OctoType (octotype.tech, репозиторій maksymchukdmytro/octotype): спільний лише сервер. Код, база, вхід, служби й nginx — свої.
Інтерфейс і тексти — українською. Чистий JS без збирання; сервер — Node.js без фреймворків, база — better-sqlite3.

## Як розгорнуто (після deploy/deploy.sh)
- Код: `/opt/mdmy` (власник `mdmy`). База SQLite: `/var/lib/mdmy/mdmy.db`. Копії: `/var/backups/mdmy` (щодня 03:30, `/etc/cron.d/mdmy-backup`).
- Служба: `systemctl status|restart mdmy`, журнал `journalctl -u mdmy -f`. Слухає `127.0.0.1:3001`.
- Nginx: `/etc/nginx/sites-available/mdmy` (проксі, `client_max_body_size 64m` — голос і відео ритуалів; deploy.sh сам піднімає старі 3m), HTTPS через certbot.
- Оновлення: `deploy/autoupdate.sh` → сервер кожні 5 хв бере нові коміти з main (`/opt/mdmy-src`, журнал `/var/log/mdmy-update.log`, вручну `mdmy-update --force`).
  Вручну: `sudo bash deploy/deploy.sh mdmy.me <email>` (базу не чіпає). Домен і пошта — у `/etc/mdmy.conf`.
- Розшифровка голосу: служба `dm-stt` (Python, faster-whisper) на `127.0.0.1:8010`; код `/opt/dm-stt/app`, venv `/opt/dm-stt/.venv`,
  моделі `/var/lib/dm-stt`, користувач `dmstt`. Ставиться й оновлюється `deploy/stt.sh` (викликається з deploy.sh).
  Модель за обсягом RAM (≥3.5 ГБ — large-v3-turbo, ≥1.8 ГБ — small, інакше base; distil-* лише англійські) або з `/etc/dm-stt.conf` (`WHISPER_MODEL=...`).
  Nice=10, CPUWeight=20 і MemoryMax, щоб не заважати сайтам; `av<16` у requirements обов'язково (новіші PyAV ламають faster-whisper 1.2.1).
- На тому ж сервері працює OctoType (служба `dm-type`, порт 3000, `/etc/nginx/sites-available/dm-type`) — його не чіпати.

## Структура
- `server.js` — статичні файли з `public/` (розділи `nakladna`, `assistant` віддаються з `X-Frame-Options: DENY`), `/api/*` і `/m/<файл>` (медіа ритуалів).
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
  `js/views/panel.js` (картка задачі: властивості, теги-чипи, підзадачі, опис, автозбереження; на телефоні — аркуш на весь екран), `notes.js`, `record.js` (сторінка запису), `settings.js` (простори, Telegram, пристрої),
  `rituals.js` (ритуали: список, редактор з автозбереженням, шаблони, завантаження фото/відео, смужка на «Сьогодні»), `ritual-play.js` (екран виконання #/r/<id>: медіа, кроки з таймером, вбудовані анімації eyes / water / breath).
  Голос: `js/voice.js` (запис, розшифровка, історія в браузері, відправка асистенту) — спільний для сторінки й `js/hold.js`
  (центральна кнопка нижньої панелі: натиснути — сторінка запису, утримати — одразу запис, відпустити — надіслати, убік — скасувати).
  Принцип інтерфейсу: mobile first і нічого зайвого — без дублів кнопок, описів і великих іконок; поля вводу без рамки фокусу (outline), на сенсорних екранах без «залиплого» :hover.
  Телефон: меню й вибір дати — нижні аркуші (`ui.sheet`, `ui.menu` сам перемикається), шапка зʼявляється лише з прокруткою, панель інструментів в один рядок,
  утримання задачі — вибір кількох, свайп вправо — виконано, вліво — видалити (рядок «Задачу видалено · Повернути», видалення через 4,5 с);
  нова задача — `views/composer.js`, голосом насамперед: велика кнопка мікрофона внизу по центру, «Надіслати» праворуч, за замовчуванням розбирає асистент («Вручну» — строк, простір, пріоритет, нагадування, підзадачі);
  центральна кнопка нижньої панелі — натиснути: нова задача й одразу слухає (утримати — надіслати одразу), кнопка «+» — те саме з клавіатурою;
  «Сьогодні»: привітання з датою, чорна картка дня (кільце «зроблено з», задачі + ритуали; прострочене; «Далі о … — …»), ритуали, задачі за часом дня (група `tod`: прострочене / зранку / вдень / увечері / без часу), «Зроблено сьогодні» згорнуте внизу;
  свайп униз закриває аркуші й картку задачі пальцем з будь-якого місця, коли вміст прокручено до верху (`ui.dragToClose`, touch-події);
  нижня панель: Сьогодні · Вхідні · мікрофон · Усі задачі · Меню; меню на телефоні — легкий нижній аркуш (`phoneMenu` у main.js: пошук, простори, ритуали, решта розділів; бічна панель на телефоні не використовується); графік «Стабільність» (`meta.activity`) — у бічній панелі на компʼютері.
  Нотатки редагуються в аркуші (`editNote` у notes.js): текст, теги, автозбереження, «Зробити задачею», видалення. Підзадачі в картці — форма (Enter працює й на клавіатурі телефона),
  додаються в кінець списку й оновлюються без перемальовування картки. На телефоні поля вводу 16px (iOS не збільшує сторінку).
  Анімації: перехід сторінок, поява рядків, галочка → закреслення → згортання, пружні аркуші (`--spring`), з prefers-reduced-motion вимикаються.
  Маршрути: `#/today`, `#/upcoming`, `#/all`, `#/s/<простір>`, `#/notes`, `#/rituals[/<id>]`, `#/r/<id>` (виконати ритуал, поверх сторінки), `#/record`, `#/settings[/розділ]`, суфікс `/t/<id>` — відкрита задача.
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
- Ритуали дня (міграція v5, таблиці `routines`, `routine_log`): `lib/routines.js` — розклад (певні години або «кожні N хв з … до …», дні тижня), таймер (викликається з таймера асистента),
  надсилання в Telegram (фото/відео за URL, кнопки `rt:<id>:done|later|skip`) і push (велика картинка, кнопки rdone / rlater, токен `r<id>`), «+15 хв», журнал за день,
  шаблони (зарядка, очі, вода, спина, дихання), API `/api/routines/*`. Медіа — `DATA_DIR/media/<32 hex>.<ext>`, до 60 МБ, без входу за випадковим імʼям; непотрібні файли прибираються через добу.
  Асистент сам створює ритуал із фрази («нагадуй пити воду кожні 2 години» → дія routine).
- Розділ «Щоденні завдання» (у коді — routines / «ритуали») має вкладки «Завдання» (#/rituals) і «Звички» (#/habits).
- Звички (міграція v6, таблиці `habits`, `habit_marks` (habit_id, day, done 1/0)): `lib/habits.js` — серії, місяць для календаря, відмітки (лише сьогодні й минулі дні),
  вечірнє питання (налаштування `habitsTime` 22:00, `habitsOn`, `lastHabitsDay` в assistant_settings) у Telegram (кнопки `hb:<id>:<день>:y|n`, повідомлення оновлюється)
  і push (одна звичка — кнопки hyes / hno з токеном `h<id>`, кілька — відкриває #/habits/check); API `/api/habits/*`; дія агента `habit` (назва + done + day).
  Фронтенд `views/habits.js`: список (серія, 7 днів, кнопка «сьогодні»: порожньо → ✓ → ✗), звичка з календарем місяця (✓ зелений `--green`, ✗ чорний), #/habits/check.
- Проєктів немає (з v5): назви проєктів стали тегами; таблиця `assistant_projects` лишилась порожньою для сумісності. Фільтр задач — за тегом (`tag`). «Стан і звички» прибрано (таблиці checkins/habits не використовуються).
- `lib/stt.js` → Python-служба `services/stt` (`/health`, `/transcribe`). Аудіо на сервері не зберігається.
- Асистент: `lib/assistant.js` (агент, таймер, API `/api/assistant/*`) + `lib/assistant-store.js` (усі зміни даних) + `lib/assistant-time.js` (часові пояси, повтори) + `lib/telegram.js` (бот).
  Агент: текст → Claude API (за замовч. `claude-haiku-5-5`) з інструментами `search_memory` (FTS по всьому сказаному) і фінальним `save_actions`;
  цикл до 4 запитів, `tool_choice` any → на останньому кроці примусово save_actions; для Opus/Sonnet/Fable/Mythos — `auto`.
  Дії: reminder / task / note / complete / reopen / update / delete / undo / routine; поля area, status, description, tags, priority (0–2), parent_id, repeat {freq, interval, days}; для routine — times / every+from+to / days / icon.
  Простір задачі (`area`): агент визначає за змістом, тегами, описами просторів і тим, як розкладені схожі задачі; незрозуміле — у `inbox` («Вхідні»).
  Підзадачі успадковують простір батька, перенесення задачі переносить і підзадачі. Агент також ставить `status` («почав» → doing, «чекаю» → waiting) і `description`.
  `/api/assistant/triage` — підказки Claude для «Вхідних» (нічого не змінює). Telegram `/inbox` — кнопки просторів під кожною задачею.
  Таблиці: `assistant_messages`, `assistant_items`, `assistant_projects`, `assistant_tags` + `assistant_item_tags`, `assistant_events` (знімки до/після → скасування),
  `assistant_fts` (FTS5; оновлюється лише кодом сховища — дані міняти тільки через `assistant-store.js`).
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
