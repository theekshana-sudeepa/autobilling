#!/usr/bin/env bash
#
# AutoBilling — nightly backup of the receivables ledger.
#
#   sudo bash deploy/aws/backup.sh
#   sudo S3_BUCKET=autobilling-backups-yourname bash deploy/aws/backup.sh   # + offsite
#
# Local dumps handle "I deleted the wrong client". Only the offsite copy
# protects against losing the instance. Upload uses the instance's IAM role
# (an instance profile attached in the EC2 console) — no access keys stored on
# the box, same principle as Oracle's instance-principal auth.
#
# Install as root cron:
#   15 2 * * *  /bin/bash /srv/autobilling/deploy/aws/backup.sh >> /var/log/autobilling-backup.log 2>&1
#
set -euo pipefail

DB_NAME="${DB_NAME:-autobilling}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/autobilling}"
STORAGE_DIR="${STORAGE_DIR:-/srv/autobilling/server/storage}"
KEEP_DAYS="${KEEP_DAYS:-14}"
S3_BUCKET="${S3_BUCKET:-}"
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

if [[ -n "$S3_BUCKET" ]] && command -v aws >/dev/null; then
  for f in "$DUMP" $ARCHIVE; do
    [[ -n "$f" ]] || continue
    aws s3 cp "$f" "s3://${S3_BUCKET}/$(basename "$f")" --only-show-errors --storage-class STANDARD_IA
    echo "$(date -Is)  uploaded $(basename "$f") → s3://$S3_BUCKET"
  done
fi

find "$BACKUP_DIR" -name 'db-*.sql.gz'      -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'storage-*.tar.gz' -mtime +60           -delete

echo "$(date -Is)  backup complete"
