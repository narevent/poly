#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh — snapshot the SQLite DB (all accounts and their stored scores) to
# a gzipped tarball in $BACKUP_DIR. Keeps a configurable number of recent ones.
#
# Backs up:
#   - $DATA_ROOT/db.sqlite3   (via sqlite .backup for a consistent, safe copy)
#   - $APP_ROOT/.env          (secret key — keep backups secure!)
#
# Archives are named $PROJECT-backup-<stamp>.tar.gz, so several projects can
# share a backup volume without overwriting each other's snapshots.
#
# USAGE:
#   sudo bash scripts/backup.sh                 # keep last 14 backups
#   sudo KEEP=30 bash scripts/backup.sh         # keep last 30
#
# Nightly, via root's crontab:
#   15 3 * * *  PROJECT=<name> bash /opt/<name>/scripts/backup.sh >/dev/null 2>&1
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

: "${KEEP:=14}"

[[ "$(id -u)" -eq 0 || "$(id -un)" == "$SERVICE_USER" ]] \
  || die "backup.sh must run as root or the $SERVICE_USER user."

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/$PROJECT-backup-$stamp.tar.gz"

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$BACKUP_DIR"

log "Creating backup -> $archive"

# Stage a consistent copy of the DB (SQLite .backup is crash-safe even while the
# app is writing). Using a short-lived file so we never touch the live DB.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ -f "$DATA_ROOT/db.sqlite3" ]]; then
  if [[ -x "$VENV/bin/python" ]]; then
    as_user "$VENV/bin/python -c \"import sqlite3;sqlite3.connect('$DATA_ROOT/db.sqlite3').backup(sqlite3.connect('$STAGE/db.sqlite3'))\""
  else
    # Fallback: sqlite3 CLI (still safe, but holds a brief lock).
    sqlite3 "$DATA_ROOT/db.sqlite3" ".backup '$STAGE/db.sqlite3'"
  fi
  # The staged copy is written by the service user; root must be able to tar it.
  chmod 644 "$STAGE/db.sqlite3" 2>/dev/null || true
else
  warn "No database at $DATA_ROOT/db.sqlite3 — backing up .env only."
fi

# Capture .env for completeness (contains the secret key — protect the archive!).
[[ -f "$APP_ROOT/.env" ]] && cp -a "$APP_ROOT/.env" "$STAGE/env"

# Record which deployment this came from, so a restore can't be pointed at the
# wrong project by accident.
cat > "$STAGE/MANIFEST" <<EOF
project=$PROJECT
app_root=$APP_ROOT
data_root=$DATA_ROOT
domain=$DOMAIN
created=$stamp
EOF

tar -czf "$archive" -C "$STAGE" .
chown "$ACCT" "$archive"
chmod 640 "$archive"

ok "Wrote $archive ($(du -h "$archive" | cut -f1))."

# --- Rotation ---------------------------------------------------------------
# Only ever matches THIS project's archives.
log "Rotating — keeping last $KEEP backups of '$PROJECT'..."
mapfile -t old < <(ls -1t "$BACKUP_DIR/$PROJECT-backup-"*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [[ ${#old[@]} -gt 0 ]]; then
  printf '  removing: %s\n' "${old[@]}"
  rm -f "${old[@]}"
fi

ok "backup.sh complete."
