#!/usr/bin/env bash
# CRM на mdmy.me/crm — окремий проєкт (github.com/maksymchukdmytro/crm), спільний лише сервер і nginx.
# Цей скрипт бере код CRM з GitHub і ставить або оновлює його через deploy/install.sh того репозиторію.
#
#   sudo bash deploy/crm.sh --setup   встановити таймер crm-update (кожні 5 хв) і одразу перевірити
#   crm-update [--force]              перевірити нову версію CRM (так запускає таймер)
#
# Сайт mdmy не зачіпає: помилки CRM лише пишуться в журнал /var/log/mdmy-update.log.
# Невдалу версію повторює не частіше ніж раз на годину (щоб не ставити пакети кожні 5 хвилин).
set -uo pipefail
REPO="${CRM_REPO:-https://github.com/maksymchukdmytro/crm.git}"
BRANCH=main
SRC=/opt/crm-src
STATE=/var/lib/crm-deploy
SITE=/etc/nginx/sites-available/mdmy
LOG=/var/log/mdmy-update.log
ts() { date '+%F %T'; }

[ "$(id -u)" -eq 0 ] || { echo "Запустіть від root"; exit 1; }

if [ "${1:-}" = "--setup" ]; then
  install -m 755 "$0" /usr/local/bin/crm-update
  cat > /etc/systemd/system/crm-update.service <<EOS
[Unit]
Description=CRM (mdmy.me/crm): оновлення з GitHub
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/crm-update
StandardOutput=append:$LOG
StandardError=append:$LOG
EOS
  cat > /etc/systemd/system/crm-update.timer <<'EOS'
[Unit]
Description=CRM (mdmy.me/crm): перевірка оновлень кожні 5 хвилин
[Timer]
OnBootSec=4min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOS
  systemctl daemon-reload
  systemctl enable --now crm-update.timer >/dev/null 2>&1   # --now: запустити таймер одразу, а не лише після перезавантаження
  # перша перевірка — у фоні таймером, щоб не затримувати оновлення mdmy
  systemctl start --no-block crm-update.service
  echo "CRM: таймер crm-update увімкнено (журнал: $LOG)"
  exit 0
fi

exec 8>/run/crm-update.lock
flock -n 8 || exit 0
[ -f /etc/mdmy.conf ] || { echo "$(ts) CRM: немає /etc/mdmy.conf"; exit 1; }
# shellcheck disable=SC1091
. /etc/mdmy.conf
mkdir -p "$STATE"

if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  if ! git clone -q -b "$BRANCH" "$REPO" "$SRC" 2>/dev/null; then
    # репозиторій ще не створено або порожній — тихо чекаємо (пишемо в журнал раз на добу)
    if [ ! -f "$STATE/waiting" ] || [ -n "$(find "$STATE/waiting" -mmin +1440 2>/dev/null)" ]; then
      echo "$(ts) CRM: репозиторій $REPO поки недоступний, чекаю"; touch "$STATE/waiting"
    fi
    rm -rf "$SRC"; exit 0
  fi
  rm -f "$STATE/waiting"
fi

git -C "$SRC" fetch -q origin "$BRANCH" || { echo "$(ts) CRM: не вдалося перевірити GitHub"; exit 1; }
NEW="$(git -C "$SRC" rev-parse "origin/$BRANCH")"
[ "$NEW" = "$(cat "$STATE/deployed" 2>/dev/null)" ] && [ "${1:-}" != "--force" ] && exit 0
if [ "$NEW" = "$(cat "$STATE/failed" 2>/dev/null)" ] && [ "${1:-}" != "--force" ] \
   && [ -z "$(find "$STATE/failed" -mmin +60 2>/dev/null)" ]; then
  exit 0
fi

git -C "$SRC" reset -q --hard "origin/$BRANCH"
echo "$(ts) CRM: оновлення до $(git -C "$SRC" log -1 --format='%h %s')"
if bash "$SRC/deploy/install.sh" "$DOMAIN" /crm "$SITE" 9>&- 8>&-; then
  echo "$NEW" > "$STATE/deployed"; rm -f "$STATE/failed"
  echo "$(ts) CRM: готово — https://$DOMAIN/crm/"
else
  echo "$NEW" > "$STATE/failed"
  echo "$(ts) CRM: оновлення не вдалося (повтор через годину або crm-update --force)"
  exit 1
fi
