#!/usr/bin/env bash
# Розгортання mdmy.me на Ubuntu (VPS). Можна запускати повторно: оновить код і перезапустить сайт, база не зачіпається.
#   sudo bash deploy/deploy.sh mdmy.me admin@mdmy.me
#
# Що робить:
#   1) встановлює Node.js 22, Nginx, Certbot, інструменти збирання, firewall;
#   2) створює системного користувача mdmy і копіює сайт у /opt/mdmy (база — /var/lib/mdmy);
#   3) запускає сайт як службу systemd mdmy на 127.0.0.1:3001 (автозапуск після перезавантаження);
#   4) ставить службу розшифровки голосу dm-stt (deploy/stt.sh);
#   5) налаштовує Nginx для домену й безкоштовний HTTPS-сертифікат (Let's Encrypt);
#   6) щоденна резервна копія бази о 03:30 у /var/backups/mdmy (зберігаються 14 останніх);
#   7) якщо облікових записів ще немає — створює перший і показує пароль.
#
# Перенесення даних зі старої бази OctoType (лише при першому розгортанні, у порожню базу):
#   sudo IMPORT_FROM=/var/lib/dm-type/dm-type.db bash deploy/deploy.sh mdmy.me admin@mdmy.me
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR=/opt/mdmy
DATA_DIR=/var/lib/mdmy
BACKUP_DIR=/var/backups/mdmy
APP_USER=mdmy
PORT=3001
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMPORT_FROM="${IMPORT_FROM:-}"

say()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустіть від root: sudo bash deploy/deploy.sh <домен> <email>"
[ -n "$DOMAIN" ] || die "Вкажіть домен: sudo bash deploy/deploy.sh mdmy.me admin@mdmy.me"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Домен виглядає неправильно: $DOMAIN"
[ -f "$SRC_DIR/server.js" ] || die "Не знайдено server.js поруч зі скриптом. Запускайте з папки проєкту."

export DEBIAN_FRONTEND=noninteractive

# QUICK=1 — швидке оновлення коду (без встановлення пакетів), так запускає автооновлення
QUICK="${QUICK:-0}"
if [ "$QUICK" != 1 ]; then
  say "1/7 Пакети системи"
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg nginx certbot python3-certbot-nginx build-essential python3 ufw rsync dnsutils git

  say "2/7 Node.js 22 LTS"
  NODE_MAJOR=0
  command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  node -v
fi
# домен і пошта — для автооновлення
printf 'DOMAIN=%q\nEMAIL=%q\n' "$DOMAIN" "$EMAIL" > /etc/mdmy.conf

say "3/7 Користувач і файли сайту"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude '.git' --exclude '.npm' "$SRC_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
chmod 750 "$DATA_DIR" "$BACKUP_DIR"
cd "$APP_DIR"
sudo -u "$APP_USER" env HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund --cache "$APP_DIR/.npm"

# Одноразове перенесення зі старої бази (лише якщо бази mdmy ще немає)
if [ -n "$IMPORT_FROM" ] && [ ! -f "$DATA_DIR/mdmy.db" ]; then
  say "Перенесення даних з $IMPORT_FROM"
  [ -f "$IMPORT_FROM" ] || die "Не знайдено $IMPORT_FROM"
  DATA_DIR="$DATA_DIR" node manage.js import "$IMPORT_FROM"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
fi

say "4/7 Служба systemd"
cat > /etc/systemd/system/mdmy.service <<EOF
[Unit]
Description=mdmy.me — накладні й персональний асистент
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR $BACKUP_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mdmy >/dev/null
# копія бази перед оновленням (нова версія може змінити структуру таблиць); зберігаємо 5 останніх
if [ -f "$DATA_DIR/mdmy.db" ] && systemctl is-active --quiet mdmy; then
  systemctl stop mdmy
  cp "$DATA_DIR/mdmy.db" "$BACKUP_DIR/pre-update-$(date +%F-%H%M%S).db" && chown "$APP_USER:$APP_USER" "$BACKUP_DIR"/pre-update-*.db
  ls -1t "$BACKUP_DIR"/pre-update-*.db 2>/dev/null | tail -n +6 | xargs -r rm -f
fi
systemctl restart mdmy
sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/ping" >/dev/null || { journalctl -u mdmy -n 40 --no-pager; die "Сайт не запустився (журнал вище)."; }
echo "Сайт працює на 127.0.0.1:$PORT"

say "5/7 Розшифровка голосу (Whisper)"
bash "$SRC_DIR/deploy/stt.sh" || warn "Служба розшифровки голосу не запустилася (сайт працює). Журнал: journalctl -u dm-stt -n 50"

# Nginx і HTTPS: при повному розгортанні або якщо сертифіката для домену ще немає
if [ "$QUICK" != 1 ] || [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  say "6/7 Nginx і HTTPS"
  # прибрати залишки старого статичного варіанту сайту, якщо він колись ставився
  rm -f /etc/cron.d/mdmy-me-deploy
  [ -L "/etc/nginx/sites-enabled/$DOMAIN" ] && rm -f "/etc/nginx/sites-enabled/$DOMAIN"
  LISTEN6=""; [ -s /proc/net/if_inet6 ] && LISTEN6="listen [::]:80;"
  MYIP="$(curl -fsS -4 --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')"
  NAMES="$DOMAIN"; CERT_DOMAINS=(-d "$DOMAIN")
  if [ "$(dig +short A "www.$DOMAIN" | tail -n1)" = "$MYIP" ]; then NAMES="$DOMAIN www.$DOMAIN"; CERT_DOMAINS+=(-d "www.$DOMAIN"); fi
  cat > /etc/nginx/sites-available/mdmy <<EOF
server {
    listen 80;
    $LISTEN6
    server_name $NAMES;
    client_max_body_size 3m;     # голосові записи для розшифровки (≈10 хв)
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/mdmy /etc/nginx/sites-enabled/mdmy
  nginx -t
  systemctl reload nginx
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw --force enable >/dev/null

  DNSIP="$(dig +short A "$DOMAIN" | tail -n1)"
  HTTPS_OK=0
  if [ -n "$MYIP" ] && [ "$DNSIP" = "$MYIP" ]; then
    if [ -n "$EMAIL" ]; then EMAIL_ARGS=(-m "$EMAIL"); else EMAIL_ARGS=(--register-unsafely-without-email); fi
    certbot --nginx "${CERT_DOMAINS[@]}" --reinstall --redirect --agree-tos "${EMAIL_ARGS[@]}" -n && HTTPS_OK=1 \
      || warn "Сертифікат не отримано. Перевірте, що порти 80 і 443 відкриті у брандмауері Hostinger."
  else
    warn "Домен $DOMAIN поки вказує на '${DNSIP:-нікуди}', а IP сервера — '${MYIP:-невідомо}'."
    warn "Створіть A-запис домену на IP сервера, зачекайте 10–30 хв і запустіть скрипт ще раз — тоді з'явиться HTTPS."
  fi
else
  HTTPS_OK=0; [ -d "/etc/letsencrypt/live/$DOMAIN" ] && HTTPS_OK=1
fi

say "7/7 Щоденна резервна копія бази"
cat > /etc/cron.d/mdmy-backup <<EOF
# mdmy.me: копія бази щодня о 03:30, зберігаються 14 останніх
30 3 * * * $APP_USER cd $APP_DIR && DATA_DIR=$DATA_DIR $(command -v node) manage.js backup $BACKUP_DIR/mdmy-\$(date +\%F).db >/dev/null 2>&1 && ls -1t $BACKUP_DIR/mdmy-*.db | tail -n +15 | xargs -r rm -f
EOF
chmod 644 /etc/cron.d/mdmy-backup

ACCOUNT_INFO=""
if sudo -u "$APP_USER" env HOME="$APP_DIR" DATA_DIR="$DATA_DIR" node manage.js list | grep -q 'ще немає'; then
  ACCOUNT_INFO="$(sudo -u "$APP_USER" env HOME="$APP_DIR" DATA_DIR="$DATA_DIR" node manage.js create owner 'Власник')"
fi

SCHEME=http; [ "$HTTPS_OK" = 1 ] && SCHEME=https
say "Готово!"
echo "  Сайт:        $SCHEME://$DOMAIN"
echo "  Асистент:    $SCHEME://$DOMAIN/assistant/"
echo "  Накладні:    $SCHEME://$DOMAIN/nakladna/"
[ -n "$ACCOUNT_INFO" ] && printf '\n%s\n' "$ACCOUNT_INFO"
echo
echo "  Журнал:           journalctl -u mdmy -f"
echo "  Перезапуск:       systemctl restart mdmy"
echo "  Резервні копії:   $BACKUP_DIR"
if systemctl is-enabled mdmy-update.timer >/dev/null 2>&1; then
  echo "  Оновлення:        автоматично з GitHub кожні 5 хв (журнал: /var/log/mdmy-update.log)"
else
  echo "  Оновлення:        sudo bash deploy/autoupdate.sh   (або знову запустіть цей скрипт)"
fi
