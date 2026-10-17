#!/usr/bin/env bash
# Служба розшифровки голосу dm-stt (Whisper) для персонального асистента mdmy.me (/assistant і Telegram).
# Викликається з deploy/deploy.sh, отже й під час автооновлення; можна запустити окремо:
#   sudo bash deploy/stt.sh
# Повторні запуски швидкі: залежності ставляться лише при зміні requirements.txt,
# служба перезапускається лише при зміні коду чи налаштувань.
# Модель обирається за обсягом пам'яті; задати вручну: echo WHISPER_MODEL=small > /etc/dm-stt.conf
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STT_DIR=/opt/dm-stt                 # код і віртуальне середовище Python
CACHE_DIR=/var/lib/dm-stt           # завантажені моделі
STT_USER=dmstt
PORT=8010
UNIT=/etc/systemd/system/dm-stt.service
VENV="$STT_DIR/.venv"

die() { printf '✖ %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Запустіть від root: sudo bash deploy/stt.sh"
[ -f "$SRC_DIR/services/stt/app.py" ] || die "Не знайдено services/stt/app.py"
export DEBIAN_FRONTEND=noninteractive

# ---- модель і обмеження пам'яті ----
WHISPER_MODEL=""
[ -f /etc/dm-stt.conf ] && . /etc/dm-stt.conf
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
# large-v3-turbo — найкраща якість для української за розумну швидкість на CPU (≈1.5 ГБ пам'яті);
# distil-* не годяться: вони лише англійські.
if [ -z "$WHISPER_MODEL" ]; then
  if   [ "$MEM_MB" -ge 3500 ]; then WHISPER_MODEL=large-v3-turbo
  elif [ "$MEM_MB" -ge 1800 ]; then WHISPER_MODEL=small
  else WHISPER_MODEL=base; fi
fi
case "$WHISPER_MODEL" in
  tiny|base)                 MEM_MAX=1G ;;
  small)                     MEM_MAX=2G ;;
  medium|large-v3-turbo|turbo) MEM_MAX=3G ;;
  *)                         MEM_MAX=4G ;;
esac
echo "Модель Whisper: $WHISPER_MODEL (пам'ять сервера ${MEM_MB} МБ, ліміт служби $MEM_MAX)"

# ---- Python ----
command -v python3 >/dev/null || apt-get install -y -qq python3 >/dev/null
python3 -c 'import ensurepip, venv' 2>/dev/null || apt-get install -y -qq python3-venv >/dev/null
command -v rsync >/dev/null || apt-get install -y -qq rsync >/dev/null

# ---- користувач і файли ----
id "$STT_USER" >/dev/null 2>&1 || useradd --system --home "$STT_DIR" --shell /usr/sbin/nologin "$STT_USER"
mkdir -p "$STT_DIR/app" "$CACHE_DIR"
rsync -a --delete --exclude '__pycache__' "$SRC_DIR/services/stt/" "$STT_DIR/app/"
chown -R "$STT_USER:$STT_USER" "$STT_DIR" "$CACHE_DIR"
chmod 750 "$CACHE_DIR"

[ -x "$VENV/bin/python" ] || sudo -u "$STT_USER" python3 -m venv "$VENV"
REQ_SHA="$(sha256sum "$STT_DIR/app/requirements.txt" | cut -d' ' -f1)"
if [ "$(cat "$STT_DIR/.req.sha" 2>/dev/null)" != "$REQ_SHA" ]; then
  echo "Встановлюю залежності Python (перший раз — кілька хвилин)…"
  sudo -u "$STT_USER" env HOME="$STT_DIR" "$VENV/bin/pip" install -q --no-cache-dir --upgrade pip
  sudo -u "$STT_USER" env HOME="$STT_DIR" "$VENV/bin/pip" install -q --no-cache-dir -r "$STT_DIR/app/requirements.txt"
  echo "$REQ_SHA" > "$STT_DIR/.req.sha"
fi

# ---- модель (завантажується один раз, без запуску) ----
if ! ls -d "$CACHE_DIR"/hub/models--*faster-whisper-"$WHISPER_MODEL" >/dev/null 2>&1; then
  echo "Завантажую модель $WHISPER_MODEL…"
  sudo -u "$STT_USER" env HOME="$STT_DIR" HF_HOME="$CACHE_DIR" HF_HUB_DISABLE_TELEMETRY=1 \
    "$VENV/bin/python" -c "from faster_whisper import download_model; download_model('$WHISPER_MODEL')"
fi

# ---- служба systemd ----
# Nice/CPUWeight — сайти мають пріоритет над розшифровкою; MemoryMax — служба не з'їсть пам'ять сайтів.
NEW_UNIT="$(cat <<EOF
[Unit]
Description=mdmy.me — розшифровка голосу (Whisper) для персонального асистента
After=network.target

[Service]
Type=simple
User=$STT_USER
WorkingDirectory=$STT_DIR/app
Environment=WHISPER_MODEL=$WHISPER_MODEL
Environment=WHISPER_LANGUAGE=uk
Environment=HF_HOME=$CACHE_DIR
Environment=HF_HUB_OFFLINE=1
Environment=HOME=$STT_DIR
ExecStart=$VENV/bin/uvicorn app:app --host 127.0.0.1 --port $PORT --log-level warning
Restart=always
RestartSec=10
Nice=10
CPUWeight=20
MemoryMax=$MEM_MAX
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$CACHE_DIR

[Install]
WantedBy=multi-user.target
EOF
)"
UNIT_CHANGED=0
if [ "$(cat "$UNIT" 2>/dev/null)" != "$NEW_UNIT" ]; then
  printf '%s\n' "$NEW_UNIT" > "$UNIT"; systemctl daemon-reload; UNIT_CHANGED=1
fi
systemctl enable dm-stt >/dev/null 2>&1

# Перезапуск лише якщо щось змінилося або служба не працює
FP="$(cd "$STT_DIR/app" && find . -type f -not -path '*/__pycache__/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)-$REQ_SHA-$WHISPER_MODEL"
if [ "$UNIT_CHANGED" = 1 ] || [ "$(cat "$STT_DIR/.deployed" 2>/dev/null)" != "$FP" ] || ! systemctl is-active --quiet dm-stt; then
  systemctl restart dm-stt
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    [ "$i" = 60 ] && { journalctl -u dm-stt -n 30 --no-pager; die "Служба dm-stt не відповідає"; }
    sleep 3
  done
  echo "$FP" > "$STT_DIR/.deployed"
fi
echo "Розшифровка працює: $(curl -fsS "http://127.0.0.1:$PORT/health")"
