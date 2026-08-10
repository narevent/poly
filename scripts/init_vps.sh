#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# init_vps.sh — one-time bootstrap of the app on a Debian 13 VPS.
#
# Installs system deps, creates the service user, clones the repo, sets up the
# persistent data directory, the Python venv, the Gunicorn systemd service and
# the Nginx reverse proxy.
#
# SAFE ON A SHARED VPS. This box also runs the `rea` project, so this script:
#   - namespaces everything under $PROJECT (user, /opt paths, unit, nginx site)
#   - refuses to reuse a name/path/unit that belongs to another deployment
#   - picks a free gunicorn port instead of assuming 8000 (rea has that)
#   - never chowns /opt, never touches another project's nginx site
#   - leaves an existing ufw config alone and does not apt-upgrade by default
#
# USAGE (as root):
#   sudo PROJECT=scribe \
#        REPO_URL=https://github.com/you/score-editor2.git \
#        DOMAIN=scribe.example.com \
#        bash scripts/init_vps.sh
#
# Omit PROJECT and you will be prompted for it.
#
# Opt-in extras:
#   SYSTEM_UPGRADE=true   also run `apt-get upgrade` (off by default: this box
#                         is already serving another app)
#   MANAGE_UFW=true       configure the firewall (off by default if ufw is
#                         already active — it was set up for the other project)
#
# After it finishes:
#   sudo bash /opt/$PROJECT/scripts/deploy.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

: "${SYSTEM_UPGRADE:=false}"
: "${MANAGE_UFW:=auto}"

[[ "$(id -u)" -eq 0 ]] || die "init_vps.sh must run as root (use sudo)."
require_repo_url   # this script clones or pulls

log "Project '$PROJECT' -> $APP_ROOT (service '$SERVICE_NAME', user '$SERVICE_USER')"

# --- 0. Collision checks ----------------------------------------------------
# Everything below is namespaced, but a name typo could still land on top of a
# neighbouring deployment. Fail before we write anything.

# 0a. An existing checkout at $APP_ROOT must be OUR repo, not someone else's.
if [[ -d "$APP_ROOT/.git" ]]; then
  existing_origin="$(git -C "$APP_ROOT" config --get remote.origin.url 2>/dev/null || true)"
  if [[ -n "$existing_origin" && "$existing_origin" != "$REPO_URL" ]]; then
    die "$APP_ROOT already holds a different repo:
  existing: $existing_origin
  wanted:   $REPO_URL
Pick another PROJECT name, or remove that directory yourself if it is stale."
  fi
elif [[ -e "$APP_ROOT" ]] && [[ -n "$(ls -A "$APP_ROOT" 2>/dev/null)" ]]; then
  die "$APP_ROOT exists and is not empty, but is not a git checkout.
Pick another PROJECT name, or clear that directory yourself."
fi

# 0b. A systemd unit with our name must belong to our APP_ROOT.
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [[ -f "$UNIT_FILE" ]]; then
  existing_wd="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" | head -n1)"
  if [[ -n "$existing_wd" && "$existing_wd" != "$APP_ROOT" ]]; then
    die "systemd unit '$SERVICE_NAME.service' already exists and points at
  $existing_wd (not $APP_ROOT). That is another deployment — pick another
  PROJECT name."
  fi
fi

# 0c. An nginx site with our name must be ours; and no OTHER enabled site may
#     already answer to our server_name.
NGINX_SITE="/etc/nginx/sites-available/$PROJECT"
if [[ -d /etc/nginx/sites-enabled ]] && [[ "$DOMAIN" != "localhost" ]]; then
  while IFS= read -r site; do
    [[ -e "$site" ]] || continue
    [[ "$(basename "$site")" == "$PROJECT" ]] && continue
    if grep -qE "^[[:space:]]*server_name[^;]*[[:space:]]${DOMAIN}[[:space:];]" "$site" 2>/dev/null \
    || grep -qE "^[[:space:]]*server_name[[:space:]]+${DOMAIN}[[:space:];]" "$site" 2>/dev/null; then
      die "nginx site '$(basename "$site")' already serves '$DOMAIN'.
Two server blocks with the same server_name conflict — give this project its
own hostname via DOMAIN=..."
    fi
  done < <(find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 2>/dev/null)
fi

# 0d. A free gunicorn port. The derived default may already be taken (by rea on
#     8000, or by a third project). Walk upward, then pin the choice so
#     deploy.sh, the unit file and the nginx site all agree.
if port_in_use "$PORT"; then
  original="$PORT"
  for _ in $(seq 1 200); do
    PORT=$(( PORT + 1 ))
    port_in_use "$PORT" || break
  done
  port_in_use "$PORT" && die "Could not find a free port near $original."
  warn "Port $original is in use (by: $(port_owner "$original")); using $PORT instead."
fi
project_conf_set PORT "$PORT"
log "Gunicorn will bind 127.0.0.1:$PORT"

# --- 1. System packages -----------------------------------------------------
log "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
if [[ "$SYSTEM_UPGRADE" == "true" ]]; then
  warn "SYSTEM_UPGRADE=true — upgrading all packages on a box that serves other apps."
  apt-get upgrade -y
else
  log "Skipping apt-get upgrade (set SYSTEM_UPGRADE=true to include it)."
fi
apt-get install -y --no-install-recommends \
  ca-certificates curl git python3 python3-venv python3-dev \
  build-essential libssl-dev libffi-dev \
  nginx ufw sqlite3 rsync

# --- 2. Service user --------------------------------------------------------
if ! id "$SERVICE_USER" &>/dev/null; then
  log "Creating service user '$SERVICE_USER'..."
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" \
          --shell /usr/sbin/nologin --user-group "$SERVICE_USER"
else
  log "Service user '$SERVICE_USER' already exists."
fi

# The parent of $APP_ROOT is /opt, shared with other projects: make sure it
# exists but leave its ownership to root. (Chowning /opt would hand another
# deployment's directory to this project's user.)
install -d -o root -g root -m 755 "$(dirname "$APP_ROOT")"

# --- 3. Clone the repo ------------------------------------------------------
if [[ ! -d "$APP_ROOT/.git" ]]; then
  log "Cloning $REPO_URL -> $APP_ROOT ..."
  if [[ "$REPO_URL" == git@* ]]; then
    die "SSH repo URL requires deploy keys. Use an HTTPS URL for init_vps.sh, e.g. https://github.com/you/score-editor2.git"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 755 "$APP_ROOT"
  # Clone as the SERVICE USER so the working tree is owned by them from the
  # start (avoids git's "dubious ownership" error on re-runs, and avoids a
  # later chown -R over many files).
  as_user "git clone --branch $BRANCH $REPO_URL $APP_ROOT"
else
  log "Repo already present at $APP_ROOT; fetching latest..."
  # Run git as the SERVICE USER: the repo is owned by them, and root operating
  # on another user's repo trips git's "dubious ownership" refusal.
  as_user "git -C $APP_ROOT fetch --prune origin"
  as_user "git -C $APP_ROOT checkout $BRANCH"
  as_user "git -C $APP_ROOT reset --hard origin/$BRANCH"
fi
chown -R "$ACCT" "$APP_ROOT"

# --- 4. Persistent data directory ------------------------------------------
log "Creating persistent data dir at $DATA_ROOT ..."
# Mode 750 and owned by the service user: SQLite writes its journal/WAL next to
# db.sqlite3 inside this dir, so the service user MUST be able to write here.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$DATA_ROOT"

# Place an empty DB so the first deploy can migrate without a copy.
if [[ ! -f "$DATA_ROOT/db.sqlite3" ]]; then
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 640 /dev/null "$DATA_ROOT/db.sqlite3"
fi

# --- 5. Python virtualenv + deps -------------------------------------------
log "Creating virtualenv and installing Python deps..."
as_user "python3 -m venv $VENV"
as_user "$VENV/bin/pip install --upgrade pip wheel"
as_user "$VENV/bin/pip install -r $REQUIREMENTS gunicorn"

# --- 6. Secret key + env file ----------------------------------------------
# Keys are read by metronome/settings.py, which looks for METRONOME_* (or
# whatever ENV_PREFIX is) regardless of the project name — see config.sh.
ENV_FILE="$APP_ROOT/.env"
# Regenerate when missing OR when it predates a prefix change (e.g. an old
# SCRIBE_* file left over from a renamed project). Never clobber a file that
# already has the current prefix's SECRET_KEY.
if [[ ! -f "$ENV_FILE" ]] || ! grep -q "^${ENV_PREFIX}_SECRET_KEY=" "$ENV_FILE"; then
  if [[ -f "$ENV_FILE" ]]; then
    log "$ENV_FILE predates current prefix; backing up and regenerating."
    mv "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
  else
    log "Generating $ENV_FILE ..."
  fi
  if [[ -x "$VENV/bin/python" ]]; then
    SECRET="$("$VENV/bin/python" -c 'import secrets;print(secrets.token_urlsafe(60))')"
  else
    SECRET="$(openssl rand -base64 48)"
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
${ENV_PREFIX}_SECRET_KEY=$SECRET
${ENV_PREFIX}_DEBUG=$([[ "$APP_DEBUG" == "true" ]] && echo 1 || echo 0)
${ENV_PREFIX}_ALLOWED_HOSTS=$DOMAIN,localhost,127.0.0.1
${ENV_PREFIX}_DOMAIN=$DOMAIN
EOF
  chown "$ACCT" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  log "$ENV_FILE already exists with current prefix; leaving it alone."
fi

# --- 7. Symlink persistent data into the checkout --------------------------
log "Symlinking data into the checkout..."
link_data "$DATA_ROOT/db.sqlite3" "$APP_ROOT/db.sqlite3"

# --- 8. Directories gunicorn/nginx need ------------------------------------
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 755 "$STATIC_ROOT" "$LOG_DIR"
install -d -o root -g root -m 755 "$(dirname "$BACKUP_DIR")"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$BACKUP_DIR"

# --- 9. systemd service ----------------------------------------------------
log "Installing systemd service '$SERVICE_NAME'..."
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=$PROJECT Django app (Gunicorn)
After=network.target

[Service]
Type=exec
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_ROOT
EnvironmentFile=$APP_ROOT/.env
ExecStart=$VENV/bin/gunicorn \\
    --workers $GUNICORN_WORKERS \\
    --bind 127.0.0.1:$PORT \\
    --access-logfile $LOG_DIR/access.log \\
    --error-logfile  $LOG_DIR/error.log \\
    --chdir $APP_ROOT \\
    $DJANGO_WSGI
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

# --- 10. Nginx site --------------------------------------------------------
log "Configuring Nginx site '$PROJECT' for $DOMAIN ..."
cat > "$NGINX_SITE" <<EOF
# $PROJECT — managed by scripts/init_vps.sh. Do not hand-edit; re-run the script.
# No default_server here: this box serves other projects, and claiming the
# default would swallow their traffic.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 25m;

    location /static/ {
        alias $STATIC_ROOT/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_redirect off;
    }
}
EOF
ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/$PROJECT"

# Leave nginx's stock default site alone if other projects are enabled — on this
# box removing it is not ours to decide.
enabled_count="$(find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
if [[ -e /etc/nginx/sites-enabled/default && "$enabled_count" -le 2 ]]; then
  log "Removing nginx's stock default site (no other project is enabled)."
  rm -f /etc/nginx/sites-enabled/default
elif [[ -e /etc/nginx/sites-enabled/default ]]; then
  warn "Leaving /etc/nginx/sites-enabled/default in place (other sites are enabled)."
fi
nginx -t || die "nginx config test failed — not reloading. Fix the above, then re-run."

if [[ "$DOMAIN" == "localhost" ]]; then
  warn "DOMAIN is 'localhost'. On a shared VPS that will collide with any other"
  warn "site using the same name — set DOMAIN=your.host before going live."
fi

# --- 11. Firewall (opt-in, non-fatal) --------------------------------------
if command -v ufw >/dev/null; then
  ufw_active="$(ufw status 2>/dev/null | head -n1 | grep -qi active && echo yes || echo no)"
  if [[ "$MANAGE_UFW" == "true" ]] || { [[ "$MANAGE_UFW" == "auto" ]] && [[ "$ufw_active" == "no" ]]; }; then
    log "Opening firewall ports 22, 80, 443..."
    ufw allow OpenSSH || true
    ufw allow 'Nginx Full' || true
    yes | ufw enable || true
  else
    log "ufw is already active — leaving the existing firewall rules alone."
    log "(80/443 are presumably already open for the other project; MANAGE_UFW=true to force.)"
  fi
fi

# --- 12. Enable + start ----------------------------------------------------
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" nginx

ok "init_vps.sh done for '$PROJECT'."
warn "Next steps:"
warn "  1. (optional) put an existing db.sqlite3 at $DATA_ROOT/db.sqlite3"
warn "  2. Run:  sudo bash $APP_ROOT/scripts/deploy.sh"
warn "  3. (optional, for HTTPS) install certbot:"
warn "        apt-get install -y certbot python3-certbot-nginx"
warn "        certbot --nginx -d $DOMAIN"
warn ""
warn "This deployment: port $PORT, unit $SERVICE_NAME, paths /opt/$PROJECT*"
warn "Pinned in $PROJECT_CONF so the other scripts agree."
