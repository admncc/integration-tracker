#!/usr/bin/env bash
# Everything worth keeping is under data/: the SQLite file and the screenshots.
# Run from cron, e.g.  0 3 * * *  /opt/integration-tracker/deploy/backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/integration-tracker}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/integration-tracker}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)

# .backup gives a consistent copy even while the app is writing.
sqlite3 "$APP_DIR/data/tracker.db" ".backup '$BACKUP_DIR/tracker-$stamp.db'"
tar -czf "$BACKUP_DIR/uploads-$stamp.tar.gz" -C "$APP_DIR/data" uploads

find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete
echo "Backed up to $BACKUP_DIR (tracker-$stamp.db)"
