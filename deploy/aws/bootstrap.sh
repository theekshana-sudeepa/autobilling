#!/usr/bin/env bash
#
# AutoBilling — one-shot provisioning for an AWS free-tier EC2 instance.
# Target: Ubuntu 24.04 on t2.micro / t3.micro / t4g.micro (1 GB RAM).
#
#   sudo DOMAIN=billing.example.com bash deploy/aws/bootstrap.sh
#   sudo bash deploy/aws/bootstrap.sh                       # no domain yet — IP only, no TLS
#
# Idempotent: safe to re-run. It installs nothing twice and never overwrites an
# existing database or .env file.
#
# AWS differs from Oracle's Always Free box in one big way: 1 GB of RAM instead
# of 24 GB. There is no host-iptables REJECT trap here (the Security Group is
# the only firewall you need — do NOT add ufw on top of it, it just doubles the
# thing you can misconfigure), but the tight RAM means swap is not optional and
# MySQL's buffer pool must be small.
#
set -euo pipefail

DOMAIN="${DOMAIN:-}"
APP_USER="${APP_USER:-autobilling}"
APP_DIR="${APP_DIR:-/srv/autobilling}"
WEB_ROOT="${WEB_ROOT:-/var/www/autobilling}"
DB_NAME="${DB_NAME:-autobilling}"
DB_USER="${DB_USER:-autobilling}"
TZ_NAME="${TZ_NAME:-Asia/Colombo}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SWAP_GB="${SWAP_GB:-2}"

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
  nginx mysql-server git curl ca-certificates gnupg jq rsync unzip \
  certbot python3-certbot-nginx fail2ban unattended-upgrades

say "Unattended security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

# ---------------------------------------------------------------------------
# 2. Swap — NOT optional here. 1 GB of RAM plus `npm ci` + `prisma generate` +
#    a Vite build + MySQL running at the same time is a guaranteed OOM kill
#    without it. This is the single biggest difference from the Oracle box.
# ---------------------------------------------------------------------------
if ! swapon --show | grep -q swapfile; then
  say "${SWAP_GB} GB swapfile"
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >>/etc/sysctl.conf
fi

# ---------------------------------------------------------------------------
# 3. Firewall — AWS Security Groups are the real firewall here (stateful,
#    configured in the console, already covers 22/80/443). Ubuntu's own
#    iptables ships open by default on AWS AMIs, unlike Oracle's — there is no
#    host-level REJECT trap to work around. Do NOT `ufw enable` in addition to
#    the Security Group: two independently-managed firewalls on one box is how
#    people lock themselves out over one forgotten rule. Confirm the Security
#    Group instead (console: EC2 → Instances → your instance → Security tab).
# ---------------------------------------------------------------------------
say "Skipping host firewall — Security Group is authoritative (see docs/DEPLOY-AWS.md §4)"

# ---------------------------------------------------------------------------
# 4. Node.js + PM2
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  say "Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
command -v pm2 >/dev/null || { say "PM2"; npm i -g pm2@latest >/dev/null; }

# ---------------------------------------------------------------------------
# 5. MySQL 8 — localhost only, utf8mb4, small buffer pool for a 1 GB box.
# ---------------------------------------------------------------------------
say "MySQL tuning (sized for 1 GB RAM)"
RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
POOL_MB=$(( RAM_MB / 4 )); (( POOL_MB < 128 )) && POOL_MB=128; (( POOL_MB > 256 )) && POOL_MB=256
cat >/etc/mysql/mysql.conf.d/zz-autobilling.cnf <<EOF
[mysqld]
bind-address                   = 127.0.0.1
character-set-server           = utf8mb4
collation-server               = utf8mb4_unicode_ci
innodb_buffer_pool_size        = ${POOL_MB}M
innodb_flush_log_at_trx_commit = 1
innodb_file_per_table          = 1
max_connections                = 50
performance_schema             = 0
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
chown -R "$APP_USER:www-data" "$WEB_ROOT"
chmod 755 "$WEB_ROOT"
chmod 750 /var/backups/autobilling

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
# 8. Nginx site
# ---------------------------------------------------------------------------
say "Nginx site"
SITE=/etc/nginx/sites-available/autobilling
SERVER_NAME="${DOMAIN:-_}"   # "_" = catch-all on the instance's public IP, no domain yet
sed "s/__DOMAIN__/${SERVER_NAME}/g; s#__WEB_ROOT__#${WEB_ROOT}#g" \
  "$(dirname "$(readlink -f "$0")")/nginx-autobilling.conf" >"$SITE"
ln -sfn "$SITE" /etc/nginx/sites-enabled/autobilling
rm -f /etc/nginx/sites-enabled/default
[[ -f $WEB_ROOT/index.html ]] || echo '<!doctype html><title>AutoBilling</title>provisioned' >"$WEB_ROOT/index.html"
nginx -t
systemctl enable --now nginx
systemctl reload nginx

PUBLIC_IP="$(curl -fsS --max-time 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo '<check EC2 console>')"

cat <<EOF

────────────────────────────────────────────────────────────
Provisioned.

  DB name / user : ${DB_NAME} / ${DB_USER}@localhost
  DB password    : $(cat "$DB_PASS_FILE")
  App directory  : ${APP_DIR}   (owner: ${APP_USER})
  Web root       : ${WEB_ROOT}
  Node           : $(node -v)   MySQL: $(mysql --version | awk '{print $3}')
  Public IP      : ${PUBLIC_IP}
  Swap           : ${SWAP_GB} GB

Next:
  1. Confirm the Security Group allows 22 (your IP only), 80, 443 (0.0.0.0/0).
  2. Clone the repo into ${APP_DIR}, write server/.env, and run:
       sudo -u ${APP_USER} bash ${APP_DIR}/deploy/aws/deploy.sh --first-run
  3. Once the app answers on http://${PUBLIC_IP}, point DNS at it and:
       sudo certbot --nginx -d ${DOMAIN:-<your-domain>}
────────────────────────────────────────────────────────────
EOF
