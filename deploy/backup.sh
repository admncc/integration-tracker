#!/usr/bin/env bash
# Everything worth keeping: the SQLite file, the attachments, and .env - which
# holds the seed password and the proxy settings and is nowhere else.
# Run from cron, e.g.  0 3 * * *  /opt/integration-tracker/deploy/backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/integration-tracker}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/integration-tracker}"
KEEP_DAYS="${KEEP_DAYS:-30}"

fail() {
  echo "backup FAILED: $*" >&2
  exit 1
}

[ -d "$APP_DIR" ] || fail "APP_DIR $APP_DIR does not exist"

# The app reads these from .env; the backup has to follow them, otherwise an
# admin who moved the database to a data volume gets a cheerful message and an
# empty archive.
if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$APP_DIR/.env"
  set +a
fi

DB_PATH="${DATABASE_PATH:-$APP_DIR/data/tracker.db}"
UPLOADS="${UPLOAD_DIR:-$APP_DIR/data/uploads}"
case "$DB_PATH" in /*) ;; *) DB_PATH="$APP_DIR/$DB_PATH" ;; esac
case "$UPLOADS" in /*) ;; *) UPLOADS="$APP_DIR/$UPLOADS" ;; esac

[ -f "$DB_PATH" ] || fail "no database at $DB_PATH"

mkdir -p "$BACKUP_DIR" || fail "cannot create $BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)
target="$BACKUP_DIR/tracker-$stamp.db"

# A consistent copy while the app is writing. sqlite3 is not a dependency of the
# app itself (it uses node:sqlite), so on a host without the CLI the script used
# to die at this line under `set -e` and never write the uploads either - an
# empty backup directory whose only signal was a cron mail.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$target'" || fail "sqlite3 .backup failed"
else
  echo "sqlite3 not installed - falling back to node:sqlite VACUUM INTO" >&2
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    db.exec(`VACUUM INTO ${JSON.stringify(process.argv[2]).replace(/"/g, "'"'"'")}`);
    db.close();
  ' "$DB_PATH" "$target" || fail "node VACUUM INTO failed"
fi

[ -s "$target" ] || fail "the database copy is empty"

# Prove the copy opens and holds rows before claiming success.
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const check = db.prepare("PRAGMA integrity_check").get();
  const result = Object.values(check)[0];
  if (result !== "ok") { console.error("integrity_check: " + result); process.exit(1); }
  const sites = db.prepare("SELECT COUNT(*) AS n FROM sites").get().n;
  const issues = db.prepare("SELECT COUNT(*) AS n FROM issues").get().n;
  console.log(`  verified: ${sites} site(s), ${issues} issue(s)`);
  db.close();
' "$target" || fail "the database copy did not verify"

if [ -d "$UPLOADS" ]; then
  tar -czf "$BACKUP_DIR/uploads-$stamp.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")" \
    || fail "could not archive $UPLOADS"
else
  echo "  note: no upload directory at $UPLOADS - nothing to archive" >&2
fi

if [ -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env" "$BACKUP_DIR/env-$stamp" && chmod 600 "$BACKUP_DIR/env-$stamp"
fi

find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete
echo "Backed up to $BACKUP_DIR (tracker-$stamp.db)"
