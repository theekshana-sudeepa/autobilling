#!/usr/bin/env bash
#
# AutoBilling — build and release on the Oracle instance.
#
#   sudo -u autobilling bash /srv/autobilling/deploy/oracle/deploy.sh            # normal release
#   sudo -u autobilling bash /srv/autobilling/deploy/oracle/deploy.sh --first-run # + seed admin user
#
# Order matters: migrate BEFORE restarting the API, so the running process never
# sees a schema it was not compiled against. Runs as the app user, never root.
#
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/autobilling}"
WEB_ROOT="${WEB_ROOT:-/var/www/autobilling}"
FIRST_RUN=0
[[ "${1:-}" == "--first-run" ]] && FIRST_RUN=1

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

cd "$APP_DIR"

say "Fetching latest"
git fetch --quiet origin
git reset --hard --quiet "origin/$(git rev-parse --abbrev-ref HEAD)"
echo "  at $(git log -1 --format='%h %s')"

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
cd "$APP_DIR/server"
[[ -f .env ]] || { echo "✖ server/.env is missing — copy .env.example and fill it in"; exit 1; }
mkdir -p logs storage/invoices storage/branding

say "Installing server dependencies"
npm ci --no-audit --no-fund

say "Prisma client (generates the aarch64 engine for this box)"
npx prisma generate

say "Applying migrations"
npx prisma migrate deploy

say "Compiling TypeScript"
npm run build

if (( FIRST_RUN )); then
  say "Seeding admin user + settings singleton"
  npm run seed
fi

# ---------------------------------------------------------------------------
# Web — VITE_API_URL is intentionally EMPTY: same-origin, nginx routes /api.
# ---------------------------------------------------------------------------
say "Building the admin UI"
cd "$APP_DIR/web"
npm ci --no-audit --no-fund
VITE_API_URL= npm run build

say "Publishing to $WEB_ROOT"
rsync -a --delete-after "$APP_DIR/web/dist/" "$WEB_ROOT/"

# ---------------------------------------------------------------------------
# Restart + verify. A deploy that does not prove /health is not a deploy.
# ---------------------------------------------------------------------------
say "Restarting the API"
cd "$APP_DIR/server"
if pm2 describe autobilling-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save >/dev/null

say "Health check"
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 http://127.0.0.1:4000/health | grep -q '"status":"healthy"'; then
    curl -fsS http://127.0.0.1:4000/health; echo
    printf '\n\033[1;32m✔ released\033[0m\n\n'
    exit 0
  fi
  sleep 1
done

echo "✖ API did not become healthy in 20s — pm2 logs autobilling-api --lines 80"
exit 1
