#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — full deploy / first-run application setup.
#
# Idempotent. Run after init_vps.sh. Performs (in order):
#
#   1. pull latest code from origin/$BRANCH
#   2. pip install -r requirements.txt   (venv updated in place)
#   3. Django: migrate, collectstatic
#   4. restart gunicorn + reload nginx
#
# Only this project's unit is restarted, and nginx is reloaded (not restarted),
# so a sibling deployment on this VPS keeps serving throughout.
#
# USAGE:
#   sudo bash scripts/deploy.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

[[ "$(id -u)" -eq 0 ]] || die "deploy.sh must run as root (use sudo)."
require_repo_url   # this script clones or pulls
[[ -d "$APP_ROOT/.git" ]] || die "No checkout at $APP_ROOT — run init_vps.sh first."

cd "$APP_ROOT"

# --- 1. Pull latest code ----------------------------------------------------
log "Pulling latest code from origin/$BRANCH ..."
as_user "cd $APP_ROOT && git fetch --prune origin && git checkout $BRANCH && git reset --hard origin/$BRANCH"

# Re-link data (init_vps may have re-cloned and nuked the symlink).
link_data "$DATA_ROOT/db.sqlite3" "$APP_ROOT/db.sqlite3"

# Ensure the service user can actually WRITE the database. SQLite needs to
# create its journal/WAL file *next to* the (resolved) db file, i.e. inside
# $DATA_ROOT, AND the dir holding the symlink must be writable too. After a
# partial bootstrap or an rsync-as-root these can end up root-owned, which
# surfaces as "attempt to write a readonly database" during migrate.
chown -R "$ACCT" "$DATA_ROOT"
chown "$ACCT" "$APP_ROOT"
chmod 750 "$DATA_ROOT"
chmod 640 "$DATA_ROOT/db.sqlite3" 2>/dev/null || true

# --- 2. Python deps --------------------------------------------------------
log "Installing/updating Python dependencies..."
as_user "$VENV/bin/pip install --upgrade pip wheel"
as_user "$VENV/bin/pip install -r $REQUIREMENTS gunicorn"

# --- 3. Django housekeeping ------------------------------------------------
log "Running Django migrations + collectstatic ..."
# Export the app's env (SECRET_KEY, ALLOWED_HOSTS, ...) for the manage.py calls.
set -a; . "$APP_ROOT/.env"; set +a

as_user "cd $MANAGE_DIR && $VENV/bin/python manage.py migrate --noinput"
as_user "cd $MANAGE_DIR && $VENV/bin/python manage.py collectstatic --noinput --clear"

# Sanity: the settings Django actually loaded should be deployable.
as_user "cd $MANAGE_DIR && $VENV/bin/python manage.py check --deploy" 2>&1 \
  | sed 's/^/    /' || warn "manage.py check --deploy reported warnings (see above)."

# --- 4. Restart services ---------------------------------------------------
log "Restarting $SERVICE_NAME and reloading nginx..."
systemctl restart "$SERVICE_NAME"
# reload, not restart: a restart would blip every other site on this box.
nginx -t && systemctl reload nginx

sleep 1
if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "$SERVICE_NAME is active on 127.0.0.1:$PORT"
else
  die "$SERVICE_NAME failed to start. Check: journalctl -u $SERVICE_NAME -n 50"
fi

ok "deploy.sh complete."
warn "Service:  systemctl status $SERVICE_NAME"
warn "Logs:     tail -f $LOG_DIR/{access,error}.log"
warn "Site:     http://$DOMAIN/"
