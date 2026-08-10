#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Shared configuration for the deployment scripts.
#
# Every path, user and service name is derived from $PROJECT (see project.sh),
# so this app can share a VPS with other deployments without stepping on them.
#
# Override anything with environment variables BEFORE running a script:
#
#   sudo PROJECT=scribe DOMAIN=scribe.example.com \
#        REPO_URL=https://github.com/me/score-editor2.git \
#        bash scripts/init_vps.sh
#
# With no PROJECT set, the first script you run prompts for one and remembers
# it in scripts/project.conf.
# ---------------------------------------------------------------------------
set -Eeuo pipefail

CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Pretty logging (defined before project.sh so it uses ours) -------------
log()  { printf '\033[1;34m[%s]\033[0m %s\n' "${PROJECT:-setup}" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# --- Identity ---------------------------------------------------------------
# shellcheck source=project.sh
. "$CONFIG_DIR/project.sh"
resolve_project                       # sets $PROJECT and $PORT

# The git URL of the app repository. Only the scripts that clone or pull need it
# (init_vps, deploy, update) — they call require_repo_url. backup.sh and
# restore.sh operate on an already-deployed tree and must not demand it.
: "${REPO_URL:=}"
require_repo_url() {
  [[ -n "$REPO_URL" ]] || die "REPO_URL is required for this script, e.g.
  REPO_URL=https://github.com/you/score-editor2.git sudo -E bash ${0##*/}"
}

# Public hostname the site is served from. On a shared VPS this MUST be a real
# hostname unique to this project — two nginx server blocks answering to the
# same server_name is a conflict nginx resolves by ignoring one of them.
: "${DOMAIN:=localhost}"

# The git branch/tag to deploy and track for updates.
: "${BRANCH:=main}"

# --- Paths (all namespaced by $PROJECT) ------------------------------------
# Where the git checkout lives (the app code).
: "${APP_ROOT:=/opt/$PROJECT}"

# Persistent data that survives deploys/updates. Holds db.sqlite3, which is
# symlinked into the checkout so a redeploy never touches user data.
: "${DATA_ROOT:=/opt/$PROJECT-data}"

# Python virtualenv used by the app.
: "${VENV:=$APP_ROOT/.venv}"

# Where backups are written (backup.sh) / read from (restore.sh).
: "${BACKUP_DIR:=/opt/$PROJECT-backups}"

# --- Service names ----------------------------------------------------------
: "${SERVICE_NAME:=$PROJECT}"
: "${SERVICE_USER:=$PROJECT}"
: "${SERVICE_GROUP:=$PROJECT}"

# --- Django layout (this repo) ---------------------------------------------
# The Django project package — where settings.py and wsgi.py live. This is a
# property of the CODE, not of the deployment, so it does not follow $PROJECT.
: "${DJANGO_PKG:=scribe}"
: "${DJANGO_WSGI:=$DJANGO_PKG.wsgi:application}"

# manage.py, requirements.txt and STATIC_ROOT all sit at the repo root.
: "${MANAGE_DIR:=$APP_ROOT}"
: "${REQUIREMENTS:=$APP_ROOT/requirements.txt}"
: "${STATIC_ROOT:=$APP_ROOT/staticfiles}"
: "${LOG_DIR:=$APP_ROOT/logs}"

# The env-var prefix settings.py reads. Fixed by the code (SCRIBE_SECRET_KEY
# etc. in scribe/settings.py) — it does not rename itself with $PROJECT.
: "${ENV_PREFIX:=SCRIBE}"

# --- App runtime ------------------------------------------------------------
# $PORT comes from project.sh: an explicit env var, the value init_vps.sh pinned
# in project.conf, or a default derived from the project name. Never 8000 by
# default — the rea project on this VPS binds that.
: "${GUNICORN_WORKERS:=3}"
: "${APP_DEBUG:=false}"               # production default

# --- Internal helpers -------------------------------------------------------
ACCT="$SERVICE_USER:$SERVICE_GROUP"
readonly APP_ROOT DATA_ROOT VENV BACKUP_DIR SERVICE_NAME SERVICE_USER SERVICE_GROUP
# NOTE: $PORT is deliberately NOT readonly — init_vps.sh may move it if the
# derived port is already taken, then pin the result in project.conf.

# Run a command as the service user (preserves $VENV activation).
as_user() {
  if [[ "$(id -u)" -eq 0 ]]; then
    sudo -u "$SERVICE_USER" -EH bash -lc "$*"
  else
    bash -lc "$*"
  fi
}

# Symlink persistent data into the checkout, replacing whatever is there.
link_data() {  # <target> <link>
  local target="$1" link="$2"
  if [[ ! -e "$target" ]]; then
    warn "Data source missing: $target — the symlink will dangle until it exists."
  fi
  if [[ -e "$link" && ! -L "$link" ]]; then rm -rf "$link"; fi
  if [[ ! -L "$link" ]]; then ln -s "$target" "$link"; fi
  chown -h "$ACCT" "$link" 2>/dev/null || true
}

# Is a TCP port already bound on this host? This guard is what keeps us off a
# sibling project's gunicorn port, so it must not answer "free" merely because
# it could not tell.
#
# The authoritative test is to try binding the port ourselves. Parsing `ss`
# output is fragile — and `netstat -ltn` is not even valid BSD syntax, which made
# an earlier version of this report every port as free. python3 is always
# present here: it runs the app.
port_in_use() {  # <port>  -> 0 = in use, 1 = free
  local p="$1"
  if command -v python3 >/dev/null 2>&1; then
    # Bind 127.0.0.1:$p exactly as gunicorn will; exit 0 means "already taken".
    if python3 -c 'import socket,sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(0)
finally:
    s.close()
sys.exit(1)' "$p"; then
      return 0
    else
      return 1
    fi
  fi
  # Fallbacks, best effort.
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$" && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E '^tcp' | awk '{print $4}' \
      | grep -qE "[:.]${p}\$" && return 0
  else
    warn "Cannot check whether port $p is free (no python3/ss/netstat)."
  fi
  return 1
}

# Which systemd unit (if any) already binds this port, so error messages can
# name the neighbour instead of just failing.
port_owner() {  # <port>
  local p="$1" who=""
  if command -v ss >/dev/null 2>&1; then
    who="$(ss -ltnp 2>/dev/null | grep -E "[:.]${p}[[:space:]]" \
           | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n1)"
  fi
  if [[ -z "$who" ]] && command -v lsof >/dev/null 2>&1; then
    who="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -Fc 2>/dev/null \
           | sed -n 's/^c//p' | head -n1)"
  fi
  printf '%s' "${who:-unknown}"
}
