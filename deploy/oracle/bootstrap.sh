#!/usr/bin/env bash
#
# AutoBilling — one-shot provisioning for an Oracle Cloud Always Free instance.
# Target: Ubuntu 24.04 (aarch64) on VM.Standard.A1.Flex.
#
#   sudo DOMAIN=billing.example.com bash deploy/oracle/bootstrap.sh
#
# Idempotent: safe to re-run. It installs nothing twice and never overwrites an
# existing database or .env file.
#
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=billing.example.com}"
APP_USER="${APP_USER:-autobilling}"
APP_DIR="${APP_DIR:-/srv/autobilling}"
WEB_ROOT="${WEB_ROOT:-/var/www/autobilling}"
DB_NAME="${DB_NAME:-autobilling}"
DB_USER="${DB_USER:-autobilling}"
TZ_NAME="${TZ_NAME:-Asia/Colombo}"
NODE_MAJOR="${NODE_MAJOR:-22}"

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Base system
# ---------------------------------------------------------------------------
say "System clock → $TZ_NAME (node-cron and the backup cron must agree)"
timedatectl set-timezone "$TZ_NAME"

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  nginx mysql-server git curl ca-certificates gnupg jq rsync \
  certbot python3-certbot-nginx fail2ban unattended-upgrades \
  iptables-persistent netfilter-persistent

say "Unattended security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

# ---------------------------------------------------------------------------
# 2. Swap — 24 GB of RAM makes this belt-and-braces, but an OOM during
#    `npm ci` on a 1 GB micro shape is a very common first-day failure.
# ---------------------------------------------------------------------------
if ! swapon --show | grep -q swapfile; then
  say "4 GB swapfile"
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >>/etc/sysctl.conf
fi

# ---------------------------------------------------------------------------
# 3. Host firewall.
#
#    THE Oracle gotcha: the VCN security list is only half the story. Oracle's
#    Ubuntu images ship an INPUT chain that ends in a REJECT, so opening 80/443
#    in the console alone gets you a silent timeout. Insert ACCEPTs at the top
#    and persist them. Do NOT `ufw enable` here — it fights these rules and
#    routinely locks people out of their only SSH session.
# ---------------------------------------------------------------------------
say "Opening 80/443 in the host firewall"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
done
netfilter-persistent save >/dev/null

# ---------------------------------------------------------------------------
# 4. Node.js (arm64 build) + PM2
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  say "Node.js ${NODE_MAJOR}.x (aarch64)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
command -v pm2 >/dev/null || { say "PM2"; npm i -g pm2@latest >/dev/null; }

# ---------------------------------------------------------------------------
# 5. MySQL 8 — localhost only, utf8mb4, durable commits (this is a ledger).
# ---------------------------------------------------------------------------
say "MySQL tuning"
RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
POOL_MB=$(( RAM_MB / 4 )); (( POOL_MB < 256 )) && POOL_MB=256
cat >/etc/mysql/mysql.conf.d/zz-autobilling.cnf <<EOF
[mysqld]
bind-address                   = 127.0.0.1
character-set-server           = utf8mb4
collation-server               = utf8mb4_unicode_ci
innodb_buffer_pool_size        = ${POOL_MB}M
innodb_flush_log_at_trx_commit = 1
innodb_file_per_table          = 1
max_connections                = 100
slow_query_log                 = 1
long_query_time                = 1
EOF
systemctl enable --now mysql
systemctl restart mysql

DB_PASS_FILE=/root/.autobilling-db-password
if [[ ! -f $DB_PASS_FILE ]]; then
  say "Creating database + user"
  DB_PASS="$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)"
  mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
  umask 077; echo "$DB_PASS" >"$DB_PASS_FILE"
else
  say "Database already provisioned (password in $DB_PASS_FILE)"
fi

# ---------------------------------------------------------------------------
# 6. Service account + directories
# ---------------------------------------------------------------------------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" "$WEB_ROOT" /var/backups/autobilling
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# The deploy user writes the web root; nginx (www-data) only ever reads it.
chown -R "$APP_USER:www-data" "$WEB_ROOT"
chmod 755 "$WEB_ROOT"
chmod 750 /var/backups/autobilling

# Log rotation belongs to the app user's PM2 daemon, not root's — they are two
# separate daemons and modules do not carry across.
sudo -u "$APP_USER" -H bash -c '
  pm2 install pm2-logrotate >/dev/null 2>&1 || exit 0
  pm2 set pm2-logrotate:max_size 20M   >/dev/null 2>&1
  pm2 set pm2-logrotate:retain 14      >/dev/null 2>&1
  pm2 set pm2-logrotate:compress true  >/dev/null 2>&1
' || true

# ---------------------------------------------------------------------------
# 7. fail2ban for SSH
# ---------------------------------------------------------------------------
cat >/etc/fail2ban/jail.d/autobilling.conf <<'EOF'
[sshd]
enabled  = true
maxretry = 4
bantime  = 1h
findtime = 10m
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# ---------------------------------------------------------------------------
# 8. Nginx site (HTTP only — certbot adds TLS in the next step)
# ---------------------------------------------------------------------------
say "Nginx site for $DOMAIN"
SITE=/etc/nginx/sites-available/autobilling
sed "s/__DOMAIN__/${DOMAIN}/g; s#__WEB_ROOT__#${WEB_ROOT}#g" \
  "$(dirname "$(readlink -f "$0")")/nginx-autobilling.conf" >"$SITE"
ln -sfn "$SITE" /etc/nginx/sites-enabled/autobilling
rm -f /etc/nginx/sites-enabled/default
[[ -f $WEB_ROOT/index.html ]] || echo '<!doctype html><title>AutoBilling</title>provisioned' >"$WEB_ROOT/index.html"
nginx -t
systemctl enable --now nginx
systemctl reload nginx

cat <<EOF

────────────────────────────────────────────────────────────
Provisioned.

  DB name / user : ${DB_NAME} / ${DB_USER}@localhost
  DB password    : $(cat "$DB_PASS_FILE")
  App directory  : ${APP_DIR}   (owner: ${APP_USER})
  Web root       : ${WEB_ROOT}
  Node           : $(node -v)   MySQL: $(mysql --version | awk '{print $3}')

Next:
  1. Point ${DOMAIN} at this instance's reserved public IP, then:
       sudo certbot --nginx -d ${DOMAIN}
  2. Clone the repo into ${APP_DIR}, write server/.env, and run:
       sudo -u ${APP_USER} bash ${APP_DIR}/deploy/oracle/deploy.sh --first-run
────────────────────────────────────────────────────────────
EOF
