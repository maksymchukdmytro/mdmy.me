# mdmy.me

*by Maksymchuk Dmytro*

Робочі інструменти на домені **mdmy.me**. Окремий проєкт, не пов'язаний із тренажером OctoType (octotype.tech): свій репозиторій, своя база, свій вхід, своя служба на сервері.

| Адреса | Що це |
|---|---|
| `/` | головна сторінка з посиланнями на розділи |
| `/assistant/` | **mdmy — задачі й асистент** у стилі Notion: простори (Вхідні, Робота, Особисте + свої), список і канбан-дошка, картка задачі з підзадачами, тегами й описом; **ритуали дня** (вода, зарядка, очі — сповіщення з фото чи відео й таймером за розкладом); голос або текст → задачі, нагадування, нотатки, ритуали; утримати мікрофон — одразу запис; Telegram-бот і Telegram Web App. Спершу зручно на телефоні |
| `/nakladna/` | **Видаткові накладні**: замовлення з LP-CRM → редагування → PDF |

Обидва розділи працюють лише після входу (один обліковий запис на весь сайт).

## Розгортання на VPS

Ubuntu 22.04+, домен уже вказує на IP сервера (A-запис для `mdmy.me` і, за бажанням, `www.mdmy.me`).

```
git clone https://github.com/maksymchukdmytro/mdmy.me.git /opt/mdmy-src && cd /opt/mdmy-src
sudo bash deploy/deploy.sh mdmy.me you@example.com     # сайт, служби, nginx, HTTPS, резервні копії
sudo bash deploy/autoupdate.sh                           # оновлення з GitHub кожні 5 хвилин
```

`deploy.sh` можна запускати повторно: він оновить код і перезапустить сайт, база не зачіпається. Після першого запуску скрипт покаже логін і пароль облікового запису (якщо записів ще немає).

На одному сервері поруч може працювати інший сайт (наприклад, OctoType на `127.0.0.1:3000`): mdmy.me слухає `127.0.0.1:3001` і має власний конфіг nginx `/etc/nginx/sites-available/mdmy`.

**Перенесення зі старої бази OctoType** (раніше накладні й «Голос у текст» жили там) — один раз, у порожню базу:

```
sudo IMPORT_FROM=/var/lib/dm-type/dm-type.db bash deploy/deploy.sh mdmy.me you@example.com
```

Переносяться облікові записи ролі «адміністратор» (з тими самими паролями), налаштування накладних (LP-CRM, реквізити, логотип) і асистента (ключ Claude, Telegram-бот) та всі задачі, нотатки, нагадування й щоденник стану.

## Локальний запуск

Потрібен [Node.js](https://nodejs.org) 20 або 22.

```
npm install
npm run account -- create boss "Ваше ім'я"     # пароль буде показано
npm start                                       # http://localhost:3001
```

Розшифровка голосу потребує Python-служби `services/stt` (Whisper) на `127.0.0.1:8010`; без неї асистент працює з текстом.

## Облікові записи

```
npm run account -- create <логін> "<Ім'я>"    новий обліковий запис
npm run account -- password <логін>           новий пароль (якщо забули)
npm run account -- list                       список
npm run account -- backup <файл.db>           резервна копія бази
```

На сервері: `cd /opt/mdmy && sudo -u mdmy DATA_DIR=/var/lib/mdmy node manage.js list`.

## Файли

- `server.js` — HTTP-сервер: сторінки з `public/` і API `/api/*`
- `lib/db.js` — база SQLite (`mdmy.db`): облікові записи, сесії, журнал, налаштування, дані асистента
- `lib/auth.js` — вхід, вихід, зміна пароля (cookie `mdmy_session`, заголовок `X-MDMY` для змін)
- `lib/nakladna.js` — API накладних (LP-CRM)
- `lib/assistant.js`, `lib/assistant-store.js`, `lib/assistant-time.js`, `lib/telegram.js` — персональний асистент і Telegram-бот
- `public/assistant/` — застосунок (ES-модулі без збирання, `js/views/*`), `docs/API.md` — API для вебу, Android і Telegram Web App
- `lib/stt.js` — міст до служби розшифровки голосу
- `lib/import-octotype.js` — одноразове перенесення зі старої бази OctoType
- `public/index.html` — головна, `public/assistant/` — асистент, `public/nakladna/` — накладні, `public/css/base.css` — спільний стиль
- `services/stt/` — служба розшифровки голосу (faster-whisper, FastAPI)
- `deploy/deploy.sh` — розгортання, `deploy/stt.sh` — служба голосу, `deploy/autoupdate.sh` — автооновлення
- `manage.js` — команди для консолі сервера
- `CLAUDE.md` — опис проєкту для Claude Code
