# mdmy API

Один API для вебзастосунку (`/`), майбутнього Android-застосунку й Telegram Web App.
Усі відповіді — JSON. Помилки: HTTP 4xx/5xx і `{ "error": "текст українською" }`.

## Вхід

| Клієнт | Як |
|---|---|
| Браузер | `POST /api/login {login, password}` → cookie `mdmy_session`. Кожен не-GET запит — із заголовком `X-MDMY: 1`. |
| Застосунок (Android тощо) | `POST /api/auth/token {login, password, client: "android"}` → `{token, expiresInDays, account}`. Далі — заголовок `Authorization: Bearer <token>` (без `X-MDMY`). |
| Google | `GET /api/auth/google/start` → Google → `/api/auth/google/callback` → cookie-сесія й редірект у застосунок (новий користувач — з `?welcome=1`). `?link=1` — привʼязати Google до поточного акаунта. `GET /api/auth/config` → `{google, signup, contact}`. |
| Telegram Web App | `POST /api/auth/telegram {initData}` → `{token}` + cookie. Вхід у той обліковий запис, до якого привʼязаний цей Telegram (підпис `initData` перевіряється токеном бота). |

Сесія живе 30 днів від останньої активності. `POST /api/logout` — вийти, `GET /api/me` — поточний обліковий запис (`{id, login, name, admin, demo, email, google, hasPassword, own, googleOn}`; `demo` — гостьовий вхід з окремими демо-даними),
`GET /api/sessions` — активні входи, `POST /api/account/reset {confirm: "ОЧИСТИТИ"}` — стерти всі записи (акаунт лишається), `POST /api/account/delete {confirm: "ВИДАЛИТИ"}` — видалити акаунт і його базу, `DELETE /api/sessions/others` — вийти на всіх інших пристроях, `GET /api/account/quota` → `{quota: {used, limit, today, perDay} | null}` — місце для файлів (окремі бази, крім адмінів: 50 МБ разом і 10 завантажень на добу; понад ліміт завантаження файлу → 413 з `error`, посилання не рахуються), `POST /api/password {old, password}`.
Обмеження: 8 спроб входу за 10 хвилин з однієї адреси.

## Модель даних

**Задача** (`item`):

```json
{
  "id": 12, "kind": "task" | "note",
  "text": "Назва", "description": "Опис / тіло задачі",
  "area": "work",            // ключ простору
  "status": "todo",          // ключ статусу (колонка дошки)
  "position": 2048,          // порядок у колонці
  "priority": 0 | 1 | 2,     // звичайна / важлива / термінова
  "due_at": 1792306800000,   // строк: мс UTC або null; "when" — те саме текстом
  "remind_at": 1792288800000, // нагадування (коли написати власнику) або null; "remindWhen" — текстом; "sent" — уже надіслано
  "repeat": {"freq": "weekly", "interval": 1, "days": [1]} | null, "repeatText": "щопонеділка",
  "tags": ["клієнт"],          // теги (проєктів окремо немає)
  "parent_id": null, "children": [ …підзадачі… ],
  "done": false, "done_at": null, "overdue": false, "sent": false, "created": 1792270040867
}
```

Окремих нагадувань немає (з v11): нагадування — властивість задачі. Старе `kind: "reminder"` у запиті = `remind: true`.
Статус і виконання завжди узгоджені: статус із `done: true` (стандартно `done`) ставить `done_at`, будь-який інший — знімає.
Повторювана задача, позначена виконаною, переходить на наступний раз (`next` у відповіді).

**Простір** (`space`): `{key, name, icon, description, position, archived, system}`. Стандартні: `inbox` (Вхідні), `work`, `personal`; власні — `s…`.
`description` — підказка для асистента, що належить до простору.
**Статус**: `{key, name, position, done}` — `todo`, `doing`, `waiting`, `done`.

## Ендпоінти асистента (`/api/assistant/…`)

| Метод і шлях | Що робить |
|---|---|
| `GET meta` | Довідники й лічильники для навігації: `spaces`, `statuses`, `tags [{name, open}]`, `icons`, `counts {spaces, today, inbox, all, views, done7 {простір: n}, doneToday}`, `activity [{day, n}]` — зроблено по днях за 14 днів (задачі + ритуали) |
| `GET tasks?area&view&status&q&tag&prio&sort&offset&limit` | Список верхньорівневих задач з підзадачами (`children`), `total`, `counts`. `area`: ключ простору або `all`; `view`: `open` · `today` · `overdue` · `week` · `nodate` · `done` · `any`; `sort`: `smart` · `prio` · `created` · `alpha` · `manual`; `limit` до 200 |
| `GET board?area&view&q&tag&prio` | Канбан: `columns[] = {status, name, done, total, items[]}`; «готово» — за останні 14 днів |
| `POST items` | Створити: `{text, area?, status?, due?, priority?, tags?, description?, parent_id?, remind?, after?, before?}`. `due` — місцевий час `YYYY-MM-DDTHH:MM`; `remind` — так само, або `true` (у час строку) |
| `GET items/:id` | Задача з підзадачами й батьком |
| `PATCH items/:id` | Змінити будь-які з полів вище; `due: ""` — прибрати строк, `remind: null` — без нагадування. Строк зсувається — нагадування зсувається на стільки ж |
| `DELETE items/:id` | Видалити разом із підзадачами |
| `POST items/:id/move` | Перетягнути: `{status?, area?, before?, after?}` (id сусідніх карток) |
| `POST items/:id/complete`, `POST items/:id/reopen` | Виконати / повернути |
| `POST bulk` | Масово: `{ids[], action: done · reopen · delete · area · status · priority · due, value}`; `due`: `today` · `tomorrow` · `week` · `none` |
| `POST triage` | Підказки Claude для задач у «Вхідних»: `{suggestions: [{id, area}]}` (нічого не змінює) |
| `GET spaces`, `POST spaces`, `PATCH spaces/:key`, `DELETE spaces/:key` | Простори `{key, name, icon, color, description, position, archived}`; `color` — gray / blue / green / orange / purple / pink / teal / amber. Видалення власного простору повертає його задачі у «Вхідні» |
| `GET statuses` | Статуси |
| `GET notes?q` | Нотатки (`q` — пошук або `#тег`) |
| `GET search?q` | Пошук по всьому, що сказано асистенту, і по записах |
| `POST message {text}` | Повідомлення асистенту (як у Telegram): `{reply, done[], items[], msgId, undoable}` |
| `POST undo {msgId}` | Скасувати дії повідомлення |
| `GET settings`, `POST settings` | Налаштування асистента (ключ Claude і токен бота назад не віддаються). `style` — стиль спілкування (промпт власника, до 1500 символів). Ключ, модель і токен бота (`anthropicKey`, `clearKey`, `model`, `botToken`, `clearBot`) змінює лише адміністратор (іншим — 403; `hasKey`, `model`, `botError` в `GET` лише для нього). Привʼязка Telegram — для кожного: `hasBot`, `botName`, `linked`, `linkUrl` (t.me/<бот>?start=<код>), `unlink` |
| `POST plan`, `POST summary` | Ранковий план / підсумок дня (і надіслати в Telegram) |

Голос: `POST /api/stt/transcribe?lang=uk|ru|en|auto`, тіло — сирі байти аудіо (webm/ogg/m4a/wav, до 20 МБ) → `{text, duration, …}`; `GET /api/stt/health`.

## Ритуали дня (`/api/routines/…`)

Коротка повторювана справа з фото / відео / анімацією й кроками з таймером, що приходить сповіщенням за розкладом.

```json
{
  "id": 2, "title": "Склянка води", "icon": "💧", "body": "Випий склянку води",
  "steps": [{"text": "Потягнись", "sec": 30}],
  "media": [{"type": "image", "url": "/m/<32 hex>.jpg"}, {"type": "youtube", "url": "https://youtu.be/…"}, {"type": "eyes"}],
  "times": ["09:00", "13:00"],            // або every (хв) + from + to
  "every": null, "from": null, "to": null,
  "days": [1, 2, 3, 4, 5] | null,         // пн=1 … нд=7; null — щодня
  "active": true, "schedule": "пн–пт · 09:00, 13:00",
  "today": [{"slot": "09:00", "status": "done | sent | skip | missed | planned"}],
  "done": 1, "total": 2, "next": "13:00", "pending": "09:00" | null
}
```

Типи медіа: `image`, `video` (лише завантажені), `youtube`, `link`, вбудовані анімації `eyes`, `water`, `breath`.

| Метод і шлях | Що робить |
|---|---|
| `GET /api/routines` | `{list, templates}` |
| `POST /api/routines` | Створити: поля вище або `{template: "morning · eyes · water · back · breath"}` |
| `GET / PATCH / DELETE /api/routines/:id` | Прочитати / змінити будь-які поля / видалити |
| `POST /api/routines/:id/done · skip · later` | Відмітити поточний раз; `later` — нагадати ще раз через 15 хв |
| `POST /api/routines/:id/send` | Надіслати зараз (перевірка) |
| `POST /api/routines/media` | Сирі байти файлу з `Content-Type` (JPEG, PNG, WebP, GIF, MP4, WebM, MOV; до 60 МБ) → `{url, type}` |
| `GET /m/<імʼя>` | Сам файл (без входу, з Range) |

## Звички (`/api/habits/…`)

| Метод і шлях | Що робить |
|---|---|
| `GET /api/habits` | `{list, today, time, on}`; звичка: `{id, title, icon, why, days, ask, active, start, todayPlanned, today: 1·0·null, remind, dayNo, week[7] {day, planned, mark, future, today}, streak, best}`; `week` — тиждень звички: перший елемент — перший день (start), з 8-го дня — наступні 7 |
| `POST /api/habits` | Створити `{title, icon?, why?, days?, ask?, remind?}`; `remind` — `HH:MM` або null: нагадування у вибрані дні (Telegram «Зроблено / Не сьогодні» і push), якщо звичку ще не відмічено |
| `GET /api/habits/:id?month=YYYY-MM` | Звичка + `month {days[{day, planned, mark, future}], planned, done, missed}` |
| `PATCH / DELETE /api/habits/:id` | Змінити / видалити (разом з історією) |
| `POST /api/habits/:id/mark {day, done}` | `done`: true ✓, false ✗, null — прибрати відмітку; лише сьогодні й минулі дні |
| `POST /api/habits/settings {time, on}` | Час вечірнього питання (за замовчуванням 22:00) |
| `POST /api/habits/ask` | Надіслати вечірнє питання зараз |

## Push-сповіщення (Web Push)

| Метод і шлях | Що робить |
|---|---|
| `GET /api/push/key` | Публічний VAPID-ключ для `pushManager.subscribe({applicationServerKey})` |
| `POST /api/push/subscribe {subscription}` | Зберегти підписку пристрою (`subscription.toJSON()`) |
| `POST /api/push/unsubscribe {endpoint}` або `{id}` | Прибрати підписку |
| `GET /api/push/subscriptions` | Пристрої, що отримують сповіщення |
| `POST /api/push/test` | Тестове сповіщення на всі пристрої |
| `POST /api/push/action {token, action: done · snooze}` | Кнопки в сповіщенні; без сесії — `token` підписаний сервером і діє для однієї задачі 3 доби |

Що приходить у push (JSON): `{kind: "reminder" · "routine" · "text", title, body, url, tag, id?, token?, actions?, image?}`. Для ритуалу дії — `rdone` / `rlater`, токен — на `r<id>`.
Надсилаються нагадування (одночасно з Telegram, якщо його привʼязано), ранковий план і підсумок дня. Майбутній Android-застосунок
може отримувати ті самі події через FCM.

## Telegram Web App

Бот сам ставить кнопку меню «Задачі», що відкриває `https://<домен>/` (змінна середовища `PUBLIC_URL` у службі `mdmy`).
Сторінка бере `initData` з фрагмента адреси (`#tgWebAppData=…`), викликає `POST /api/auth/telegram` і далі працює з токеном.


## Вкладення
| Запит | Опис |
|---|---|
| `POST /api/assistant/items/:id/attachments` | Файл — сирим тілом (`Content-Type` файлу, `X-Name: <назва urlencoded>`, до 25 МБ; фото, PDF, документи, таблиці, відео, аудіо) або JSON `{url}` — посилання |
| `DELETE /api/assistant/attachments/:id` | Прибрати вкладення |
| `GET /api/assistant/files/<ключ>` | Файл (лише власнику) |

## Доручення (`/api/team/…`)
| Запит | Опис |
|---|---|
| `GET /api/team` | `{me {id, pub_id, name}, bosses, members, counts {todo, review, checks}}` |
| `POST /api/team/allow {pub_id}` | Дозволити акаунту з цим ID давати мені задачі |
| `DELETE /api/team/bosses/:id`, `DELETE /api/team/members/:id` | Відкликати дозвіл / прибрати з команди |
| `GET /api/team/tasks?role=member\|boss` | Мої доручення / доручені мною |
| `POST /api/team/tasks {member_id, text, description?, due_at?, need_proof?}` | Доручити |
| `GET / PATCH / DELETE /api/team/tasks/:id` | Деталі (з `files`), змінити, видалити (той, хто доручив) |
| `POST /api/team/tasks/:id/files` | Доказ від виконавця (як вкладення) |
| `POST /api/team/tasks/:id/submit {report}` | Здати на перевірку |
| `POST /api/team/tasks/:id/review {verdict: approve\|rework\|fail, note}` | Перевірка; для rework коментар обовʼязковий |
| `GET /api/shared/<ключ>`, `DELETE /api/shared/files/:id` | Файл-доказ (учасникам) / прибрати свій |

## Челенджі (`/api/challenges/…`)
| Запит | Опис |
|---|---|
| `GET /api/challenges` | Мої (створені й ті, де я учасник) |
| `POST /api/challenges {title, description?, days, start_day?, confirm?, need_proof?}` | Створити (повертає `code`) |
| `POST /api/challenges/join {code}` | Долучитися |
| `GET / PATCH / DELETE /api/challenges/:id` | Деталі (`myDays`, `board`, для автора `queue`), змінити / завершити (`closed`), видалити |
| `POST /api/challenges/:id/check {note?, day?, final: true}` | Відмітка за сьогодні або вчора; `{undo: true}` — скасувати |
| `POST /api/challenges/:id/files?day=` | Доказ до відмітки |
| `POST /api/challenges/:id/review/:checkId {ok}` | Автор підтверджує / відхиляє |
| `POST /api/challenges/:id/leave` | Вийти |

## Адмінка (лише роль admin)

Сторінка — `/admin/`. Усі відповіді — цифри без змісту записів.

| Запит | Що робить |
|---|---|
| `GET /api/admin/overview` | Огляд: `users` (усього, нові за 1/7/30 днів, ряд за 30 днів), `active` (за день / 7 / 30, ряд), `retention` (d1/d7/d30: `{pct, base}`), `activation` (задачі, Telegram, сповіщення), `ai` (сьогодні, місяць, прогноз, за моделями, ряд витрат), `voice`, `reminders`, `uploads`, `server` (версія, памʼять, диск, копії, розшифровка) |
| `GET /api/admin/users` | Список: `{id, login, name, email, role, ws, disabled, created, last_login, seen, google, limits, own, ai30: {n, cost}, shape: {tasks, open, notes, habits, routines, messages, telegram, push, storage}}` |
| `GET /api/admin/users/:id` | Те саме + `sessions`, `activity` (30 днів), `usage`, `audit` |
| `POST /api/admin/users/:id` | `{action}`: `disable` / `enable` / `logout` / `separate` / `role` (`{role: admin|user}`) / `limits` (`{limits: {ai, storageMb, uploadsDay}}`, null — загальний) / `delete` |
| `GET/POST /api/admin/limits` | Загальні ліміти `{ai, aiDemo, storageMb, uploadsDay}` (0 — без обмежень) |
| `GET/POST /api/admin/prices` | Ціни моделей ($ за 1 млн токенів): `{model, in, out}` або `{model, reset: true}` |
| `GET/POST /api/admin/budget` | Бюджет на Claude: `{usd, stop}` → `{usd, stop, cost, forecast, exceeded, month}`; сповіщення адмінам на 80% і 100% |
| `GET /api/admin/backups` | Копії в `BACKUP_DIR`: `{list: [{name, at, size, ws, wsSize, kind: daily|update}], dir, check}` |
| `POST /api/admin/backups` | `{action: "make"}` — зробити копію зараз (і перевірити), `{action: "verify"}` — перевірити свіжу |
| `GET /api/admin/system` | Сервер, розмір баз і файлів, підписки на сповіщення, нагадування й помилки Claude за 14 днів, журнал оновлень |
| `GET/POST /api/admin/service` | Ключ Claude, модель, бот — як `/api/assistant/settings`, але завжди для основної бази |
| `GET/POST /api/admin/auth` | Вхід через Google: Client ID, секрет, реєстрація, контакт |

