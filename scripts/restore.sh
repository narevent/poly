#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore.sh — restore a backup produced by backup.sh.
#
# Stops the app, restores the database and .env into the persistent data
# directory, then re-links and restarts. The current DB is copied aside first.
#
# The archive's MANIFEST is checked against this deployment, so a backup from
# another project on this VPS cannot be restored over this one by accident
# (override with FORCE=true if you really mean it).
#
# USAGE:
#   sudo bash scripts/restore.sh                 # latest backup for $PROJECT
#   sudo bash scripts/restore.sh /opt/<name>-backups/<name>-backup-2026...tar.gz
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

: "${FORCE:=false}"

[[ "$(id -u)" -eq 0 ]] || die "restore.sh must run as root (use sudo)."

# --- Resolve the archive ----------------------------------------------------
if [[ $# -ge 1 ]]; then
  archive="$1"
else
  archive="$(ls -1t "$BACKUP_DIR/$PROJECT-backup-"*.tar.gz 2>/dev/null | head -n1 || true)"
  [[ -n "$archive" ]] || die "No backup for '$PROJECT' in $BACKUP_DIR. Pass a path explicitly."
fi
[[ -f "$archive" ]] || die "Backup not found: $archive"
log "Restoring from: $archive"

# --- Extract to a staging area ---------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$archive" -C "$STAGE"

# --- Guard: does this archive belong to this deployment? --------------------
if [[ -f "$STAGE/MANIFEST" ]]; then
  archive_project="$(sed -n 's/^project=//p' "$STAGE/MANIFEST" | head -n1)"
  if [[ -n "$archive_project" && "$archive_project" != "$PROJECT" ]]; then
    if [[ "$FORCE" == "true" ]]; then
      warn "Archive is from project '$archive_project', restoring into '$PROJECT' anyway (FORCE=true)."
    else
      die "This archive belongs to project '$archive_project', but you are restoring
into '$PROJECT'. Refusing — that would overwrite one project's data with
another's. Re-run with FORCE=true if this is deliberate."
    fi
  fi
else
  warn "Archive has no MANIFEST (made by an older backup.sh) — cannot verify its origin."
fi

# --- Stop the app so we don't restore into a live DB -----------------------
log "Stopping $SERVICE_NAME ..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true

# --- Restore the database ---------------------------------------------------
if [[ -f "$STAGE/db.sqlite3" ]]; then
  log "Restoring database -> $DATA_ROOT/db.sqlite3"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$DATA_ROOT"
  # Preserve a copy of the current DB just in case.
  if [[ -f "$DATA_ROOT/db.sqlite3" && ! -L "$DATA_ROOT/db.sqlite3" ]]; then
    keep="$DATA_ROOT/db.sqlite3.pre-restore.$(date +%s)"
    cp -a "$DATA_ROOT/db.sqlite3" "$keep"
    log "  previous DB kept at $keep"
  fi
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 640 "$STAGE/db.sqlite3" "$DATA_ROOT/db.sqlite3"
else
  warn "Archive contains no db.sqlite3 — leaving the current database untouched."
fi

# --- Restore .env -----------------------------------------------------------
if [[ -f "$STAGE/env" ]]; then
  log "Restoring .env -> $APP_ROOT/.env"
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 600 "$STAGE/env" "$APP_ROOT/.env"
fi

# --- Re-link data into the checkout ----------------------------------------
link_data "$DATA_ROOT/db.sqlite3" "$APP_ROOT/db.sqlite3"

# --- Rebuild static + restart ----------------------------------------------
log "collectstatic ..."
set -a; . "$APP_ROOT/.env"; set +a
as_user "cd $MANAGE_DIR && $VENV/bin/python manage.py collectstatic --noinput --clear" \
  || warn "collectstatic failed — check the venv / repo."

log "Starting $SERVICE_NAME ..."
systemctl start "$SERVICE_NAME"
nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true

sleep 1
systemctl is-active --quiet "$SERVICE_NAME" \
  || die "$SERVICE_NAME did not come back up. Check: journalctl -u $SERVICE_NAME -n 50"

ok "restore.sh complete."
