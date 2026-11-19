#!/usr/bin/env bash
#
# AutoBilling — nightly backup of the receivables ledger.
#
#   sudo bash deploy/oracle/backup.sh
#   sudo OCI_BUCKET=autobilling-backups bash deploy/oracle/backup.sh   # + offsite
#
# Local dumps protect against "I deleted the wrong client". Only the offsite
# copy protects against losing the instance — and on Always Free, losing the
# instance is a real scenario, not a theoretical one. Object Storage upload uses
# instance principal auth, so there are no API keys sitting on this box.
#
# Install as root cron:
#   15 2 * * *  /bin/bash /srv/autobilling/deploy/oracle/backup.sh >> /var/log/autobilling-backup.log 2>&1
#
set -euo pipefail

DB_NAME="${DB_NAME:-autobilling}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/autobilling}"
STORAGE_DIR="${STORAGE_DIR:-/srv/autobilling/server/storage}"
KEEP_DAYS="${KEEP_DAYS:-14}"
OCI_BUCKET="${OCI_BUCKET:-}"
STAMP="$(date +%F_%H%M)"

mkdir -p "$BACKUP_DIR"
umask 077

DUMP="$BACKUP_DIR/db-${STAMP}.sql.gz"

# --single-transaction gives a consistent InnoDB snapshot without locking the
# tables, so an 08:00 billing run colliding with the backup cannot deadlock.
mysqldump --single-transaction --quick --routines --triggers --events \
  --default-character-set=utf8mb4 "$DB_NAME" | gzip -9 >"$DUMP"

# A dump that is not verifiably readable is not a backup.
gzip -t "$DUMP"
SIZE=$(stat -c%s "$DUMP")
(( SIZE > 1024 )) || { echo "✖ dump suspiciously small (${SIZE}B)"; exit 1; }
echo "$(date -Is)  db dump ok  $(basename "$DUMP")  $(numfmt --to=iec "$SIZE")"

# Invoice PDFs + branding assets, weekly (Sundays).
ARCHIVE=""
if [[ "$(date +%u)" == "7" && -d "$STORAGE_DIR" ]]; then
  ARCHIVE="$BACKUP_DIR/storage-${STAMP}.tar.gz"
  tar czf "$ARCHIVE" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
  echo "$(date -Is)  storage archive ok  $(basename "$ARCHIVE")"
fi

if [[ -n "$OCI_BUCKET" ]] && command -v oci >/dev/null; then
  for f in "$DUMP" $ARCHIVE; do
    oci os object put --auth instance_principal \
      --bucket-name "$OCI_BUCKET" \
      --file "$f" --name "$(basename "$f")" \
      --force --no-retry >/dev/null
    echo "$(date -Is)  uploaded $(basename "$f") → oci://$OCI_BUCKET"
  done
fi

find "$BACKUP_DIR" -name 'db-*.sql.gz'      -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'storage-*.tar.gz' -mtime +60           -delete

echo "$(date -Is)  backup complete"
