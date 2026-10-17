#!/usr/bin/env bash
# One-time server setup for mdmy.me on Debian/Ubuntu with nginx.
#
# What it does:
#   1. installs nginx, git and certbot
#   2. clones this repository into /var/www/mdmy.me
#   3. serves it on mdmy.me (and www.mdmy.me if that name resolves)
#   4. gets a free HTTPS certificate from Let's Encrypt
#   5. pulls new commits from GitHub every minute, so a push updates the site
#
# Safe to run again: every step checks what is already there.
#
# Usage (as root or with sudo):
#   sudo bash setup-server.sh
# Optional: EMAIL=you@example.com for certificate expiry notices.

set -euo pipefail

DOMAIN="${DOMAIN:-mdmy.me}"
REPO_HTTPS="https://github.com/maksymchukdmytro/mdmy.me.git"
REPO_SSH="git@github.com:maksymchukdmytro/mdmy.me.git"
WEB_ROOT="/var/www/${DOMAIN}"
EMAIL="${EMAIL:-}"
DEPLOY_KEY="/root/.ssh/mdmy_me_deploy"
SSH_CMD="ssh -i ${DEPLOY_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

say() { printf '\n==> %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root, for example: sudo bash setup-server.sh" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script supports Debian/Ubuntu (apt) only." >&2
  exit 1
fi

for other in apache2 caddy httpd; do
  if systemctl is-active --quiet "$other" 2>/dev/null; then
    echo "$other is already running on this server and holds port 80." >&2
    echo "Stop it first or tell Claude which web server you use." >&2
    exit 1
  fi
done

say "Installing nginx, git and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git certbot python3-certbot-nginx >/dev/null
systemctl enable --now nginx >/dev/null

say "Fetching the site into ${WEB_ROOT}"
if [ -d "${WEB_ROOT}/.git" ]; then
  git -C "${WEB_ROOT}" pull --ff-only -q
elif GIT_TERMINAL_PROMPT=0 git ls-remote "${REPO_HTTPS}" >/dev/null 2>&1; then
  git clone -q --depth 1 "${REPO_HTTPS}" "${WEB_ROOT}"
else
  # Private repository: use a read-only deploy key that only this server holds.
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  if [ ! -f "${DEPLOY_KEY}" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "mdmy.me server deploy key" -f "${DEPLOY_KEY}"
  fi
  if ! GIT_SSH_COMMAND="${SSH_CMD}" git clone -q --depth 1 "${REPO_SSH}" "${WEB_ROOT}" 2>/dev/null; then
    echo
    echo "The repository is private, so this server needs read access to it."
    echo "Add this key on GitHub: repository mdmy.me -> Settings -> Deploy keys -> Add deploy key"
    echo "(leave 'Allow write access' unchecked), then run this script again:"
    echo
    cat "${DEPLOY_KEY}.pub"
    echo
    exit 2
  fi
  git -C "${WEB_ROOT}" config core.sshCommand "${SSH_CMD}"
fi

say "Configuring nginx for ${DOMAIN}"
SERVER_NAMES="${DOMAIN}"
if getent hosts "www.${DOMAIN}" >/dev/null 2>&1; then
  SERVER_NAMES="${DOMAIN} www.${DOMAIN}"
fi

CONF="/etc/nginx/sites-available/${DOMAIN}"
if [ ! -f "${CONF}" ]; then
  cat > "${CONF}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAMES};

    root ${WEB_ROOT};
    index index.html;

    # Never serve the git history, dotfiles or the deploy scripts.
    location ~ /\. { deny all; }
    location ^~ /deploy/ { deny all; }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
NGINX
fi
ln -sf "${CONF}" "/etc/nginx/sites-enabled/${DOMAIN}"
nginx -t -q
systemctl reload nginx

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in the firewall"
  ufw allow 'Nginx Full' >/dev/null
fi

say "Getting an HTTPS certificate"
if [ -n "${EMAIL}" ]; then
  EMAIL_ARGS=(-m "${EMAIL}")
else
  EMAIL_ARGS=(--register-unsafely-without-email)
fi
CERT_ARGS=()
for name in ${SERVER_NAMES}; do CERT_ARGS+=(-d "${name}"); done
if ! certbot --nginx --non-interactive --agree-tos --redirect "${EMAIL_ARGS[@]}" "${CERT_ARGS[@]}"; then
  if [ "${SERVER_NAMES}" != "${DOMAIN}" ]; then
    echo "Retrying with ${DOMAIN} only (www.${DOMAIN} may point somewhere else)."
    certbot --nginx --non-interactive --agree-tos --redirect "${EMAIL_ARGS[@]}" -d "${DOMAIN}" \
      || echo "HTTPS was not set up. Check that ${DOMAIN} points to this server, then run the script again."
  else
    echo "HTTPS was not set up. Check that ${DOMAIN} points to this server, then run the script again."
  fi
fi

say "Turning on automatic updates (every minute)"
cat > /etc/cron.d/mdmy-me-deploy <<CRON
# Pull new commits of mdmy.me from GitHub every minute.
* * * * * root git -C ${WEB_ROOT} pull --ff-only -q >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/mdmy-me-deploy

say "Done"
echo "Site:    https://${DOMAIN}"
echo "Files:   ${WEB_ROOT}"
echo "Updates: every push to GitHub appears on the site within a minute."
