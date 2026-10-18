# mdmy API

Один API для вебзастосунку (`/assistant/`), майбутнього Android-застосунку й Telegram Web App.
Усі відповіді — JSON. Помилки: HTTP 4xx/5xx і `{ "error": "текст українською" }`.

## Вхід

| Клієнт | Як |
|---|---|
| Браузер | `POST /api/login {login, password}` → cookie `mdmy_session`. Кожен не-GET запит — із заголовком `X-MDMY: 1`. |
| Застосунок (Android тощо) | `POST /api/auth/token {login, password, client: "android"}` → `{token, expiresInDays, account}`. Далі — заголовок `Authorization: Bearer <token>` (без `X-MDMY`). |
| Telegram Web App | `POST /api/auth/telegram {initData}` → `{token}` + cookie. Пускає лише власника привʼязаного до асистента бота (підпис `initData` перевіряється токеном бота). |

Сесія живе 30 днів від останньої активності. `POST /api/logout` — вийти, `GET /api/me` — поточний обліковий запис,
`GET /api/sessions` — активні входи, `DELETE /api/sessions/others` — вийти на всіх інших пристроях, `POST /api/password {old, password}`.
Обмеження: 8 спроб входу за 10 хвилин з однієї адреси.

## Модель даних

**Задача** (`item`):

```json
{
  "id": 12, "kind": "task" | "reminder" | "note",
  "text": "Назва", "description": "Опис / тіло задачі",
  "area": "work",            // ключ простору
  "status": "todo",          // ключ статусу (колонка дошки)
  "position": 2048,          // порядок у колонці
  "priority": 0 | 1 | 2,     // звичайна / важлива / термінова
  "due_at": 1792306800000,   // мс UTC або null; "when" — те саме текстом
  "repeat": {"freq": "weekly", "interval": 1, "days": [1]} | null, "repeatText": "щопонеділка",
  "project": "Магазин", "project_id": 2, "tags": ["клієнт"],
  "parent_id": null, "children": [ …підзадачі… ],
  "done": false, "done_at": null, "overdue": false, "sent": false, "created": 1792270040867
}
```

Статус і виконання завжди узгоджені: статус із `done: true` (стандартно `done`) ставить `done_at`, будь-який інший — знімає.
Повторювана задача, позначена виконаною, переходить на наступний раз (`next` у відповіді).

**Простір** (`space`): `{key, name, icon, description, position, archived, system}`. Стандартні: `inbox` (Вхідні), `work`, `personal`; власні — `s…`.
`description` — підказка для асистента, що належить до простору.
**Статус**: `{key, name, position, done}` — `todo`, `doing`, `waiting`, `done`.

## Ендпоінти асистента (`/api/assistant/…`)

| Метод і шлях | Що робить |
|---|---|
| `GET meta` | Довідники й лічильники для навігації: `spaces`, `statuses`, `projects`, `icons`, `counts {spaces, today, inbox, all, views}` |
| `GET tasks?area&view&status&q&project&prio&sort&offset&limit` | Список верхньорівневих задач з підзадачами (`children`), `total`, `counts`. `area`: ключ простору або `all`; `view`: `open` · `today` · `overdue` · `week` · `nodate` · `done` · `any`; `sort`: `smart` · `prio` · `created` · `alpha` · `manual`; `limit` до 200 |
| `GET board?area&view&q&project&prio` | Канбан: `columns[] = {status, name, done, total, items[]}`; «готово» — за останні 14 днів |
| `POST items` | Створити: `{text, area?, status?, due?, priority?, project?, tags?, description?, parent_id?, kind?, after?, before?}`. `due` — місцевий час `YYYY-MM-DDTHH:MM` |
| `GET items/:id` | Задача з підзадачами й батьком |
| `PATCH items/:id` | Змінити будь-які з полів вище; `due: ""` — прибрати строк |
| `DELETE items/:id` | Видалити разом із підзадачами |
| `POST items/:id/move` | Перетягнути: `{status?, area?, before?, after?}` (id сусідніх карток) |
| `POST items/:id/complete`, `POST items/:id/reopen` | Виконати / повернути |
| `POST bulk` | Масово: `{ids[], action: done · reopen · delete · area · status · priority · due, value}`; `due`: `today` · `tomorrow` · `week` · `none` |
| `POST triage` | Підказки Claude для задач у «Вхідних»: `{suggestions: [{id, area}]}` (нічого не змінює) |
| `GET spaces`, `POST spaces`, `PATCH spaces/:key`, `DELETE spaces/:key` | Простори. Видалення власного простору повертає його задачі у «Вхідні» |
| `GET statuses` | Статуси |
| `GET notes?q` | Нотатки (`q` — пошук або `#тег`) |
| `GET search?q` | Пошук по всьому, що сказано асистенту, і по записах |
| `POST message {text}` | Повідомлення асистенту (як у Telegram): `{reply, done[], items[], msgId, undoable}` |
| `POST undo {msgId}` | Скасувати дії повідомлення |
| `GET state?days` | Щоденник стану й звички |
| `GET settings`, `POST settings` | Налаштування асистента (ключ Claude і токен бота назад не віддаються) |
| `POST plan`, `POST summary` | Ранковий план / підсумок дня (і надіслати в Telegram) |

Голос: `POST /api/stt/transcribe?lang=uk|ru|en|auto`, тіло — сирі байти аудіо (webm/ogg/m4a/wav, до 20 МБ) → `{text, duration, …}`; `GET /api/stt/health`.

## Telegram Web App

Бот сам ставить кнопку меню «Задачі», що відкриває `https://<домен>/assistant/` (змінна середовища `PUBLIC_URL` у службі `mdmy`).
Сторінка бере `initData` з фрагмента адреси (`#tgWebAppData=…`), викликає `POST /api/auth/telegram` і далі працює з токеном.
