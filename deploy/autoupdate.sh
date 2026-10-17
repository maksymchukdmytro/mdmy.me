#!/usr/bin/env bash
# Автооновлення mdmy.me з GitHub: сервер раз на 5 хвилин перевіряє гілку main
# і, якщо з'явилася нова версія, сам оновлює сайт (база не зачіпається).
#
#   sudo bash deploy/autoupdate.sh [адреса репозиторію] [гілка]
#   (типово https://github.com/maksymchukdmytro/mdmy.me.git, гілка main)
#
# Публічний репозиторій береться по HTTPS без ключів. Для приватного вкажіть адресу git@github.com:…
# — скрипт створить окремий ключ лише для читання (deploy key) і покаже, куди його додати на GitHub.
set -euo pipefail
REPO="${1:-https://github.com/maksymchukdmytro/mdmy.me.git}"; BRANCH="${2:-main}"
SRC=/opt/mdmy-src
KEY=/root/.ssh/mdmy-deploy
say()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Запустіть від root: sudo bash deploy/autoupdate.sh"
[ -f /etc/mdmy.conf ] || die "Спершу розгорніть сайт: sudo bash deploy/deploy.sh <домен> <email>"
command -v git >/dev/null || apt-get install -y git

SSH_CMD=""
if [[ "$REPO" == git@* ]]; then
  say "Ключ доступу до репозиторію (лише читання)"
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  [ -f "$KEY" ] || ssh-keygen -t ed25519 -N '' -C "mdmy-server" -f "$KEY" >/dev/null
  # -F /dev/null: не брати чужі налаштування github.com із ~/.ssh/config (там може бути ключ іншого проєкту)
  SSH_CMD="ssh -F /dev/null -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  if ! GIT_SSH_COMMAND="$SSH_CMD" git ls-remote "$REPO" >/dev/null 2>&1; then
    echo
    echo "Додайте цей ключ на GitHub: репозиторій → Settings → Deploy keys → Add deploy key"
    echo "(назва будь-яка, галочку «Allow write access» НЕ ставити):"
    echo
    cat "$KEY.pub"
    echo
    echo "Потім запустіть цю саму команду ще раз."
    exit 0
  fi
fi

say "Копія репозиторію в $SRC"
if [ -d "$SRC/.git" ]; then git -C "$SRC" remote set-url origin "$REPO"
else rm -rf "$SRC"; GIT_SSH_COMMAND="${SSH_CMD:-ssh}" git clone -q -b "$BRANCH" "$REPO" "$SRC"; fi
if [ -n "$SSH_CMD" ]; then git -C "$SRC" config core.sshCommand "$SSH_CMD"; else git -C "$SRC" config --unset core.sshCommand || true; fi
git -C "$SRC" fetch -q origin "$BRANCH"
git -C "$SRC" reset -q --hard "origin/$BRANCH"

say "Служба оновлення"
cat > /usr/local/bin/mdmy-update <<EOS
#!/usr/bin/env bash
# Перевірка нової версії mdmy.me на GitHub (запускається таймером systemd)
set -uo pipefail
exec 9>/run/mdmy-update.lock; flock -n 9 || exit 0
. /etc/mdmy.conf
cd $SRC || exit 1
git fetch -q origin $BRANCH || { echo "\$(date '+%F %T') не вдалося перевірити GitHub"; exit 1; }
[ "\$(git rev-parse HEAD)" = "\$(git rev-parse origin/$BRANCH)" ] && [ "\${1:-}" != "--force" ] && exit 0
git reset -q --hard origin/$BRANCH
echo "\$(date '+%F %T') оновлення до \$(git log -1 --format='%h %s')"
QUICK=1 bash deploy/deploy.sh "\$DOMAIN" "\$EMAIL" 9>&-
EOS
chmod 755 /usr/local/bin/mdmy-update
cat > /etc/systemd/system/mdmy-update.service <<'EOS'
[Unit]
Description=mdmy.me: оновлення з GitHub
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/mdmy-update
StandardOutput=append:/var/log/mdmy-update.log
StandardError=append:/var/log/mdmy-update.log
EOS
cat > /etc/systemd/system/mdmy-update.timer <<'EOS'
[Unit]
Description=mdmy.me: перевірка оновлень кожні 5 хвилин
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOS
systemctl daemon-reload
systemctl enable --now mdmy-update.timer >/dev/null

say "Готово!"
echo "  Сервер перевіряє GitHub кожні 5 хвилин і сам оновлює сайт."
echo "  Журнал оновлень:   tail -n 50 /var/log/mdmy-update.log"
echo "  Оновити негайно:   mdmy-update --force"
echo "  Вимкнути:          systemctl disable --now mdmy-update.timer"
