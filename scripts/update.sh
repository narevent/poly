#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update.sh — pull the latest code from GitHub and apply it.
#
# Intended for routine "I pushed a new commit, ship it" updates. Runs:
#   1. git fetch + reset --hard origin/$BRANCH
#   2. pip install -r requirements.txt   (only if it changed)
#   3. migrate --noinput
#   4. collectstatic --noinput --clear
#   5. systemctl restart $SERVICE_NAME ; nginx reload
#
# Touches only this project's unit; a sibling deployment on this VPS is
# unaffected.
#
# USAGE:
#   sudo bash scripts/update.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

[[ "$(id -u)" -eq 0 ]] || die "update.sh must run as root (use sudo)."
require_repo_url   # this script clones or pulls
[[ -d "$APP_ROOT/.git" ]] || die "No checkout at $APP_ROOT — run init_vps.sh first."

cd "$APP_ROOT"

# --- 1. Pull ---------------------------------------------------------------
log "Fetching latest from origin/$BRANCH ..."
OLD_SHA="$(git -C "$APP_ROOT" rev-parse HEAD)"
as_user "cd $APP_ROOT && git fetch --prune origin && git checkout $BRANCH && git reset --hard origin/$BRANCH"
NEW_SHA="$(git -C "$APP_ROOT" rev-parse HEAD)"

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  ok "Already up to date ($NEW_SHA). Nothing to do."
  exit 0
fi
log "Updated: $OLD_SHA -> $NEW_SHA"

# Re-establish the data symlink in case the new tree shipped a real file there.
link_data "$DATA_ROOT/db.sqlite3" "$APP_ROOT/db.sqlite3"

# --- 2. Python deps (only if requirements.txt changed) --------------------
if git -C "$APP_ROOT" diff --name-only "$OLD_SHA" "$NEW_SHA" | grep -q '^requirements\.txt$'; then
  log "requirements.txt changed — reinstalling deps..."
  as_user "$VENV/bin/pip install -r $REQUIREMENTS gunicorn"
else
  log "requirements.txt unchanged; skipping pip install."
fi

# --- 3. Django housekeeping ------------------------------------------------
log "migrate + collectstatic ..."
set -a; . "$APP_ROOT/.env"; set +a
as_user "cd $MANAGE_DIR && $VENV/bin/python manage.py migrate --noinput"
as_user "cd $MANAGE_DIR && $VENV/bin/python manage.py collectstatic --noinput --clear"

# --- 4. Restart ------------------------------------------------------------
log "Restarting $SERVICE_NAME, reloading nginx..."
systemctl restart "$SERVICE_NAME"
nginx -t && systemctl reload nginx

sleep 1
systemctl is-active --quiet "$SERVICE_NAME" \
  || die "$SERVICE_NAME failed to start after update. Roll back with:
  sudo -u $SERVICE_USER git -C $APP_ROOT reset --hard $OLD_SHA && sudo bash $SCRIPT_DIR/update.sh
Check: journalctl -u $SERVICE_NAME -n 50"

ok "update.sh complete -> $NEW_SHA"
