#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# bootstrap_local.sh — run from YOUR machine to do the full first-time setup
# of this app on a Debian 13 VPS over SSH.
#
# Everything it creates on the server is namespaced by the PROJECT name, so the
# VPS can go on serving other deployments (the `rea` project included). If you
# do not pass --project you are prompted for one, and it is remembered in
# scripts/project.conf.
#
# It performs, end to end:
#
#   1. local pre-flight: verify the repo is pushed to GitHub.
#   2. on the VPS (over ssh, as root or via sudo): apt + git, clone the repo,
#      run init_vps.sh — which creates the /opt/<project>* paths, the service
#      user, the systemd unit and the nginx site, and picks a free port.
#   3. optionally ship your local SQLite DB into /opt/<project>-data.
#   4. on the VPS: run deploy.sh (migrate, collectstatic, restart).
#   5. (optional) install certbot and issue a Let's Encrypt cert for HTTPS.
#
# USAGE (from the project root on your local machine):
#
#   bash scripts/bootstrap_local.sh \
#       --project scribe \
#       --host root@203.0.113.10 \
#       --domain scribe.example.com \
#       --repo https://github.com/you/score-editor2.git
#
#   # ship an existing database too:
#   bash scripts/bootstrap_local.sh --project scribe --host root@1.2.3.4 \
#       --domain scribe.example.com --repo https://github.com/you/repo.git --with-db
#
#   # also provision HTTPS:
#   bash scripts/bootstrap_local.sh ... --ssl
#
#   # non-root SSH user that can sudo (the script uses sudo on the server).
#   # Works whether that user already has passwordless sudo OR only
#   # passworded sudo (it provisions NOPASSWD once, prompting for the password
#   # on your local terminal — or pass it with --sudo-password).
#   bash scripts/bootstrap_local.sh --host ubuntu@1.2.3.4 ...
#
# All scripts/config.sh variables can be passed through with --env KEY=VAL.
# A few useful flags:
#   --project scribe       deployment name: service user, unit, /opt paths,
#                          nginx site. Prompted if omitted.
#   --branch main          git branch to deploy (default: main)
#   --db-file PATH         local SQLite DB to ship (default: <repo>/db.sqlite3)
#   --ssh-key ~/.ssh/id_ed25519   explicit identity file
#   --no-db               explicitly skip shipping the DB (the default)
#   --with-db             ship the local DB to the server
#   --sudo-password PASS  password for the non-root SSH user's sudo (used once to
#                         enable passwordless sudo; otherwise prompted interactively)
#   --no-setup-sudo       don't modify sudoers; require the SSH user to already
#                         have passwordless sudo (fails otherwise)
#
# The script is idempotent-ish: re-running it re-clones/re-inits and re-deploys.
# ---------------------------------------------------------------------------
set -Eeuo pipefail

# ===========================================================================
# Defaults  (override with flags below)
# ===========================================================================
HOST=""                 # e.g. root@203.0.113.10  (REQUIRED)
DOMAIN=""               # e.g. scribe.example.com  (REQUIRED)
REPO_URL=""             # e.g. https://github.com/you/score-editor2.git (REQUIRED)
BRANCH="main"
SSH_KEY=""              # optional -i identity
DB_FILE=""              # local SQLite DB to ship; defaults to <repo>/db.sqlite3
SHIP_DB="no"            # set to "yes" with --with-db
DO_SSL="no"             # set to "yes" with --ssl
EXTRA_ENV=()            # KEY=VAL pairs forwarded to the server scripts
SUDO_PASSWORD=""        # one-time sudo password for NOPASSWD setup (--sudo-password)
SETUP_SUDO="yes"        # set to "no" with --no-setup-sudo to refuse sudoers changes

# Server-side paths. All derived from $PROJECT (resolved below) so they match
# scripts/config.sh exactly and cannot collide with another deployment.
REMOTE_APP_ROOT=""
REMOTE_DATA_ROOT=""
REMOTE_REPO_TMP=""
REMOTE_PORT=""          # read back from the server after init_vps.sh picks it

# --- SSH connection multiplexing -------------------------------------------
# We open ONE master SSH connection and reuse it for every ssh/scp/rsync call,
# so you enter the SSH password (if any) only ONCE for the whole run instead of
# being prompted for every remote command.
#
# IMPORTANT — socket path length: macOS limits Unix-domain socket paths to 104
# chars.  Using $TMPDIR (e.g. /var/folders/.../T/) + mktemp + ssh's %C hash
# expansion blows past that limit and fails with "path ... too long for Unix
# domain socket".  So we use a SHORT, fixed path directly under /tmp:
#   /tmp/<project>-ssh.<pid>.<hash>   (short, well under the limit).
SSH_CONTROL_SOCK=""

# ===========================================================================
# Helpers
# ===========================================================================
c_blue=$'\033[1;34m'; c_grn=$'\033[1;32m'; c_ylw=$'\033[1;33m'
c_red=$'\033[1;31m'; c_rst=$'\033[0m'
log()  { printf '%s[%s]%s %s\n' "$c_blue" "${PROJECT:-setup}" "$c_rst" "$*"; }
ok()   { printf '%s[ok]%s  %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_ylw"   "$c_rst" "$*" >&2; }
die()  { printf '%s[x]%s %s\n'  "$c_red"   "$c_rst" "$*" >&2; exit 1; }

# Build a string of common SSH options (space-separated), + optional identity.
# We return a *string* (not an array) so this works on bash 3.2 (macOS default),
# which lacks `mapfile -d ''`.  Callers split it read-only.
#
# IMPORTANT: we deliberately do NOT use BatchMode=yes.  BatchMode disables all
# password/keyboard-interactive prompts, which makes SSH fail instantly with
# "Permission denied (publickey,password)" when no SSH key is authorized — i.e.
# it breaks the common case of password-based VPS login.  Instead we rely on
# connection multiplexing (ssh_control_setup) so a password, when needed, is
# entered only once for the whole run.
ssh_args_str() {
  local s="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
  [[ -n "$SSH_KEY" ]] && s+=" -i $SSH_KEY"
  if [[ -n "$SSH_CONTROL_SOCK" ]]; then
    s+=" -o ControlPath=$SSH_CONTROL_SOCK -o ControlMaster=no -o ControlPersist=no"
  fi
  printf '%s' "$s"
}

# Open the SSH master control connection (once).  Prompts for the login
# password here if key auth is not set up.  Must be called AFTER $HOST is known.
ssh_control_setup() {
  # Short, unique-ish socket path under /tmp.  Keep it well under macOS's
  # 104-char Unix-socket limit (this is ~30 chars).  No %C: a literal path
  # avoids any hash-expansion surprises and is trivial to clean up.
  SSH_CONTROL_SOCK="/tmp/$PROJECT-ssh.$$.$(printf '%s' "$HOST" | cksum | awk '{print $1}')"
  rm -f "$SSH_CONTROL_SOCK"  # stale socket from a previous crashed run
  local master_opts=( -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15
                      -o ControlMaster=yes -o ControlPath="$SSH_CONTROL_SOCK"
                      -o ControlPersist=300 )
  [[ -n "$SSH_KEY" ]] && master_opts+=( -i "$SSH_KEY" )
  log "  opening SSH master connection to $HOST (enter password if prompted)..."
  # Foreground with a trivial command so a connection failure surfaces now.
  if ! ssh "${master_opts[@]}" -o ServerAliveInterval=30 "$HOST" 'true'; then
    rm -f "$SSH_CONTROL_SOCK"
    SSH_CONTROL_SOCK=""
    die "Could not establish SSH connection to $HOST (check host/credentials/network)."
  fi
  ok "  SSH master connection up (reused for the rest of the run)."
}

# Tear down the master connection and remove its socket.  Safe to call if never set up.
ssh_control_teardown() {
  if [[ -n "$SSH_CONTROL_SOCK" ]]; then
    ssh -o ControlPath="$SSH_CONTROL_SOCK" -O exit "$HOST" 2>/dev/null || true
    rm -f "$SSH_CONTROL_SOCK"
    SSH_CONTROL_SOCK=""
  fi
}

# Run a remote command over ssh (reuses the master connection).
remote_run() {
  local -a base
  # shellcheck disable=SC2206
  base=( $(ssh_args_str) )
  ssh "${base[@]}" "$HOST" "$@"
}

# Run a remote command over ssh WITH a tty (-t).  Needed for interactive sudo
# (password prompt) and any command that writes to /dev/tty.
remote_run_tty() {
  local -a base
  # shellcheck disable=SC2206
  base=( $(ssh_args_str) )
  ssh "${base[@]}" -t "$HOST" "$@"
}

# rsync over ssh, reusing the master connection.
rsync_run() {
  local -a base
  # shellcheck disable=SC2206
  base=( $(ssh_args_str) )
  local e="ssh "
  local i
  for i in "${base[@]}"; do e+="$i "; done
  rsync -avz --progress -e "$e" "$@"
}

# Ship the local SQLite DB to /opt/<project>-data/db.sqlite3 via scp into /tmp
# then a sudo-move into place. Works whether the SSH user is root or a non-root
# sudoer. scp honours -o ControlPath, so it reuses the master connection.
_ship_db() {
  local scp_opts=( -o "StrictHostKeyChecking=accept-new" -o "ConnectTimeout=15" )
  if [[ -n "$SSH_CONTROL_SOCK" ]]; then
    scp_opts+=( -o "ControlPath=$SSH_CONTROL_SOCK" -o "ControlMaster=no" -o "ControlPersist=no" )
  fi
  [[ -n "$SSH_KEY" ]] && scp_opts+=( -i "$SSH_KEY" )
  local remote_tmp="/tmp/$PROJECT-db.sqlite3"
  scp "${scp_opts[@]}" "$DB_FILE" "$HOST:$remote_tmp" \
    || die "scp of $DB_FILE failed."
  # Stop the app first: replacing a live SQLite file under a running gunicorn
  # is how you get a half-written database.
  remote_run "$SUDO systemctl stop $PROJECT 2>/dev/null || true"
  remote_run "$SUDO mv $remote_tmp $REMOTE_DATA_ROOT/db.sqlite3 && \
              $SUDO chown $PROJECT:$PROJECT $REMOTE_DATA_ROOT/db.sqlite3 && \
              $SUDO chmod 640 $REMOTE_DATA_ROOT/db.sqlite3 && \
              $SUDO chown $PROJECT:$PROJECT $REMOTE_DATA_ROOT && \
              $SUDO chmod 750 $REMOTE_DATA_ROOT" \
    || die "Could not place db.sqlite3 into $REMOTE_DATA_ROOT."
}

# ===========================================================================
# Parse arguments
# ===========================================================================
# Print the comment banner at the top of this file as help text.
# NOTE: `\?` is a GNU sed extension — this script runs on the developer's
# machine, which may well be macOS (BSD sed), where it silently fails to strip
# the leading "# ". Use POSIX intervals instead.
_banner() {
  sed -n '3,/^# ---*$/p' "$0" | sed -e 's/^#\{0,1\} \{0,1\}//'
}

usage()      { _banner >&2; }
print_help() { _banner; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)        HOST="$2"; shift 2 ;;
    --project)     PROJECT="$2"; shift 2 ;;
    --domain)      DOMAIN="$2"; shift 2 ;;
    --repo)        REPO_URL="$2"; shift 2 ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    --ssh-key)     SSH_KEY="$2"; shift 2 ;;
    --db-file)     DB_FILE="$2"; SHIP_DB="yes"; shift 2 ;;
    --with-db)     SHIP_DB="yes"; shift ;;
    --no-db)       SHIP_DB="no"; shift ;;
    --ssl)         DO_SSL="yes"; shift ;;
    --env)         EXTRA_ENV+=("$2"); shift 2 ;;
    --sudo-password) SUDO_PASSWORD="$2"; shift 2 ;;
    --no-setup-sudo) SETUP_SUDO="no"; shift ;;
    -h|--help)     print_help ;;
    *)             usage >&2; die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ -n "$HOST" ]]     || die "--host is required (e.g. root@203.0.113.10)"
[[ -n "$DOMAIN" ]]   || die "--domain is required (e.g. scribe.example.com)"
[[ -n "$REPO_URL" ]] || die "--repo is required (e.g. https://github.com/you/score-editor2.git)"

# Always clean up the SSH master connection + temp socket dir on exit/error,
# so we never leave a lingering control socket or temp files behind.
trap 'ssh_control_teardown' EXIT INT TERM

# This script lives in <repo>/scripts/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve the deployment name: --project, $PROJECT, scripts/project.conf, or a
# prompt. Everything on the server is namespaced by it.
# shellcheck source=project.sh
. "$SCRIPT_DIR/project.sh"
resolve_project

REMOTE_APP_ROOT="/opt/$PROJECT"
REMOTE_DATA_ROOT="/opt/$PROJECT-data"
REMOTE_REPO_TMP="/tmp/$PROJECT-init"
[[ -n "$DB_FILE" ]] || DB_FILE="$REPO_ROOT/db.sqlite3"

log "Project:         $PROJECT"
log "Remote paths:    $REMOTE_APP_ROOT | $REMOTE_DATA_ROOT"
log "Remote host:     $HOST"
log "Domain:          $DOMAIN"
log "Repo:            $REPO_URL (branch $BRANCH)"
log "Ship DB:         $SHIP_DB   | SSL: $DO_SSL"

# ===========================================================================
# 1. Local pre-flight
# ===========================================================================
log "Step 1/5: local pre-flight checks"

command -v git   >/dev/null || die "git not found locally."
command -v ssh   >/dev/null || die "ssh not found locally."
command -v rsync >/dev/null || die "rsync not found locally (brew install rsync / apt install rsync)."

# Verify the working repo is clean & pushed, so the VPS clones something real.
GIT_DIR_LOCAL="$SCRIPT_DIR/.."
if git -C "$GIT_DIR_LOCAL" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "  checking local git state..."
  git -C "$GIT_DIR_LOCAL" rev-parse --abbrev-ref HEAD >/dev/null
  if [[ -n "$(git -C "$GIT_DIR_LOCAL" status --porcelain)" ]]; then
    warn "  local repo has uncommitted changes — they will NOT be on the VPS."
    warn "  commit & push first if you want them deployed."
  fi
  # Sanity: HEAD exists on origin (best-effort, ignore offline failures).
  if git -C "$GIT_DIR_LOCAL" ls-remote --heads origin "$BRANCH" \
        | grep -q "$BRANCH"; then
    ok "  origin has branch '$BRANCH'."
  else
    warn "  could not confirm '$BRANCH' on origin — make sure you pushed."
  fi
fi

if [[ "$SHIP_DB" == "yes" ]]; then
  [[ -f "$DB_FILE" ]] || die "--with-db but no database at $DB_FILE (use --db-file PATH)."
  ok "  local database found: $DB_FILE"
fi

# ===========================================================================
# 2. SSH connectivity + server bootstrap
# ===========================================================================
log "Step 2/5: SSH connectivity + server bootstrap"

# Open ONE persistent SSH master connection and reuse it for every subsequent
# ssh/scp/rsync call.  This is where you'll be prompted for the SSH *login*
# password (if key auth isn't set up) — but only this once for the whole run.
ssh_control_setup
ok "  SSH connected to $HOST."

# We need root privileges on the server.  If the SSH user is root, use it
# directly; otherwise we need sudo.  We accept both passwordless sudo AND a
# passworded sudoer (the latter gets elevated to passwordless for the rest of
# the run, since the bootstrap makes many separate privileged calls).
remote_is_root() {
  remote_run '[[ "$(id -u)" -eq 0 ]] && echo yes || echo no'
}
remote_user() {
  remote_run 'id -un'
}

SUDO=""          # the sudo prefix used for privileged remote calls
REMOTE_USER="$(remote_user)"
IS_ROOT="$(remote_is_root)"

if [[ "$IS_ROOT" == "yes" ]]; then
  ok "  SSH user is root — no sudo needed."
else
  # Non-root SSH user. We need root privileges via sudo. Handle three sub-cases:
  #  (a) sudo installed + already NOPASSWD  -> just use sudo
  #  (b) sudo installed + passworded sudo   -> provision NOPASSWD with the
  #      user's sudo password (--sudo-password or interactive prompt)
  #  (c) sudo NOT installed on the server (some minimal Debian images ship
  #      without it) -> install it via `su` (root password), then configure
  #      NOPASSWD in the same step.
  #
  # NOTE on the original failure: a *very* minimal Debian 13 cloud image can
  # come without `sudo` at all, so the very first `sudo ...` call dies with
  # "sudo: command not found". We therefore check for sudo's existence FIRST.

  SUDO_INSTALLED="$(remote_run 'command -v sudo >/dev/null 2>&1 && echo yes || echo no')"

  if [[ "$SUDO_INSTALLED" != "yes" ]]; then
    # (c) sudo is missing -> install it via `su` (needs the ROOT password).
    #     `su` reads the password from its controlling tty, so we run this over
    #     a real ssh pty (ssh -t reusing the master connection) and the prompt
    #     reaches the local terminal.  `su` has no -S, so a tty is required here.
    if [[ "$SETUP_SUDO" == "no" ]]; then
      die "sudo is not installed on the server and --no-setup-sudo was given. SSH in as root (or use the provider console) and run: apt-get install -y sudo"
    fi
    warn "sudo is not installed on the server. Installing it now via 'su' — enter the ROOT password when prompted."
    [[ -t 0 ]] || die "Need the root password to install sudo but stdin is not a terminal. SSH in as root and install sudo manually, then re-run."
    remote_run_tty "su -c 'set -e; apt-get update -qq; apt-get install -y -qq sudo; \
        install -d -m 700 /etc/sudoers.d; \
        printf \"%s ALL=(ALL) NOPASSWD:ALL\\n\" \"$REMOTE_USER\" > /etc/sudoers.d/$PROJECT-bootstrap; \
        chmod 440 /etc/sudoers.d/$PROJECT-bootstrap; \
        visudo -cf /etc/sudoers.d/$PROJECT-bootstrap >/dev/null; \
        echo SUDO_INSTALL_OK'" \
      || die "Could not install/configure sudo via 'su' (wrong root password, or root account locked?). SSH in as root and run: apt-get install -y sudo && echo '$REMOTE_USER ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/$PROJECT-bootstrap && chmod 440 /etc/sudoers.d/$PROJECT-bootstrap"
    # Sanity: sudo must now be on PATH.
    remote_run 'command -v sudo >/dev/null 2>&1' \
      || die "sudo install reported success but 'sudo' is still not on PATH — check the server."
    # Verify NOPASSWD took effect.
    remote_run 'sudo -n true' \
      || die "sudo installed but 'sudo -n true' still fails — check /etc/sudoers.d/$PROJECT-bootstrap on the server."
    SUDO="sudo"
    ok "  sudo installed and NOPASSWD provisioned for '$REMOTE_USER' (/etc/sudoers.d/$PROJECT-bootstrap)."
  elif remote_run 'sudo -n true' 2>/dev/null; then
    # (a) already passwordless
    SUDO="sudo"
    ok "  passwordless sudo available for '$REMOTE_USER'."
  else
    # (b) passworded sudo -> provision NOPASSWD for this user now.
    if [[ "$SETUP_SUDO" == "no" ]]; then
      die "Passwordless sudo is required (or pass --sudo-password, or omit --no-setup-sudo to let this script set it up)."
    fi
    log "  '$REMOTE_USER' has passworded sudo. Provisioning NOPASSWD sudo..."
    if [[ -n "$SUDO_PASSWORD" ]]; then
      # Pipe the password in (no tty needed).  Use -S so sudo reads it from stdin.
      remote_run "echo '$(printf '%s' "$SUDO_PASSWORD" | sed "s/'/'\\\\''/g")' | \
                  sudo -S -p '' bash -c ' \
                    id -un >/dev/null && \
                    install -d -m 700 /etc/sudoers.d && \
                    echo \"$REMOTE_USER ALL=(ALL) NOPASSWD:ALL\" > /etc/sudoers.d/$PROJECT-bootstrap && \
                    chmod 440 /etc/sudoers.d/$PROJECT-bootstrap && \
                    visudo -cf /etc/sudoers.d/$PROJECT-bootstrap >/dev/null'" \
        || die "Could not set up passwordless sudo. Check the password / sudoers config."
    else
      # Ask for the sudo password on the LOCAL terminal, then feed it to
      # `sudo -S` over ssh stdin.  We read it locally (no echo) and pipe it in
      # rather than relying on a remote pty for sudo's prompt — this is the
      # same proven path as the --sudo-password branch above.
      if [[ ! -t 0 ]]; then
        die "Need the sudo password for '$REMOTE_USER' but stdin is not a terminal. Re-run with --sudo-password '...'."
      fi
      pw=""
      printf '%s[%s]%s Enter sudo password for %s on %s: ' "$c_blue" "$PROJECT" "$c_rst" "$REMOTE_USER" "$HOST" >&2
      read -rs pw </dev/tty || read -rs pw
      printf '\n' >&2
      [[ -n "$pw" ]] || die "Empty sudo password — aborting."
      printf '%s\n' "$pw" | remote_run "sudo -S -p '' bash -c ' \
        install -d -m 700 /etc/sudoers.d && \
        echo \"$REMOTE_USER ALL=(ALL) NOPASSWD:ALL\" > /etc/sudoers.d/$PROJECT-bootstrap && \
        chmod 440 /etc/sudoers.d/$PROJECT-bootstrap && \
        visudo -cf /etc/sudoers.d/$PROJECT-bootstrap >/dev/null && \
        echo SUDOERS_OK'" \
        || die "Could not set up passwordless sudo (wrong password / sudoers config). Re-run, or pass --sudo-password '...'."
    fi
    # Verify it took effect.
    remote_run 'sudo -n true' \
      || die "sudoers file was written but 'sudo -n true' still fails — check /etc/sudoers.d/$PROJECT-bootstrap on the server."
    SUDO="sudo"
    ok "  passwordless sudo provisioned for '$REMOTE_USER' (/etc/sudoers.d/$PROJECT-bootstrap)."
  fi
fi

# Build the env string forwarded to init_vps.sh.
# PROJECT must be forwarded too: the server scripts would otherwise prompt for
# it (and there is no terminal on the far side of ssh).
ENV_EXPORT="PROJECT=$PROJECT REPO_URL=$REPO_URL DOMAIN=$DOMAIN BRANCH=$BRANCH"
for kv in "${EXTRA_ENV[@]:-}"; do
  [[ -n "$kv" ]] && ENV_EXPORT+=" $kv"
done

# Install git on the server (idempotent) and clone the repo to a temp dir so we
# can run init_vps.sh, which will (re)clone into REMOTE_APP_ROOT.
log "  ensuring git is installed on the server..."
remote_run "$SUDO apt-get update -qq && $SUDO apt-get install -y -qq git ca-certificates" \
  || die "Failed to install git on the server."

# Always fetch the latest init_vps.sh onto the server (clone fresh into tmp).
log "  cloning repo to $REMOTE_REPO_TMP on the server..."
remote_run "rm -rf $REMOTE_REPO_TMP && \
            git clone --quiet --branch $BRANCH $REPO_URL $REMOTE_REPO_TMP" \
  || die "Failed to clone $REPO_URL on the server."

log "  running init_vps.sh on the server (this installs deps, builds venv, sets up systemd + nginx)..."
remote_run "cd $REMOTE_REPO_TMP && $SUDO env $ENV_EXPORT bash scripts/init_vps.sh" \
  || die "init_vps.sh failed on the server. See output above."
ok "  init_vps.sh completed."

# ===========================================================================
# 3. Ship the database (optional)
# ===========================================================================
log "Step 3/5: database"

# Read back the port init_vps.sh settled on — it may have moved off the derived
# default to avoid a port already bound by another project on this box.
REMOTE_PORT="$(remote_run "grep -m1 '^PORT=' $REMOTE_APP_ROOT/scripts/project.conf 2>/dev/null | cut -d= -f2" 2>/dev/null || true)"
[[ -n "$REMOTE_PORT" ]] && log "  server picked gunicorn port $REMOTE_PORT"

if [[ "$SHIP_DB" == "yes" ]]; then
  log "  scp: $DB_FILE -> $REMOTE_DATA_ROOT/db.sqlite3"
  _ship_db
  ok "  db.sqlite3 uploaded."
else
  warn "  no --with-db: deploy.sh will migrate a fresh empty database."
  warn "  (accounts and stored scores start empty; users register on the site.)"
fi

# ===========================================================================
# 4. Deploy
# ===========================================================================
log "Step 4/5: deploy (migrate, collectstatic, import data, restart services)"
remote_run "$SUDO env $ENV_EXPORT bash $REMOTE_APP_ROOT/scripts/deploy.sh" \
  || die "deploy.sh failed on the server. See output above."
ok "  deploy.sh completed."

# Quick smoke test: is gunicorn up & is nginx routing our hostname to it?
log "  smoke test..."
if remote_run "$SUDO systemctl is-active --quiet $PROJECT" 2>/dev/null; then
  ok "  gunicorn ($PROJECT): active"
else
  warn "  gunicorn not active — check: ssh $HOST '$SUDO systemctl status $PROJECT'"
fi
# Hit gunicorn directly on OUR port, and nginx with OUR Host header — on a
# shared box a bare request to 127.0.0.1 would answer from whichever site
# happens to be first, telling us nothing about this deployment.
if [[ -n "$REMOTE_PORT" ]]; then
  remote_run "curl -fsS -o /dev/null -w '  gunicorn 127.0.0.1:$REMOTE_PORT -> HTTP %{http_code}\n' http://127.0.0.1:$REMOTE_PORT/ || echo '  gunicorn: no response'"
fi
remote_run "curl -fsS -o /dev/null -H 'Host: $DOMAIN' -w '  nginx (Host: $DOMAIN) -> HTTP %{http_code}\n' http://127.0.0.1/ || echo '  nginx: no response for $DOMAIN'"

ok "  app should now be live at http://$DOMAIN/  (DNS must point here)."

# ===========================================================================
# 5. HTTPS via Let's Encrypt (optional)
# ===========================================================================
if [[ "$DO_SSL" == "yes" ]]; then
  log "Step 5/5: provisioning HTTPS with certbot"
  remote_run "$SUDO apt-get install -y -qq certbot python3-certbot-nginx" \
    || die "Failed to install certbot on the server."
  remote_run "$SUDO certbot --nginx -d $DOMAIN --non-interactive --agree-tos \
                --register-unsafely-without-email --redirect" \
    || die "certbot failed. Make sure $DOMAIN DNS points to this server."
  ok "  HTTPS provisioned."
else
  ok "Step 5/5: skipped (--ssl not set). HTTP only for now."
  warn "  when ready: bash scripts/bootstrap_local.sh ... --ssl   (or run certbot on the server)."
fi

if [[ "$DO_SSL" == "yes" ]]; then
  ok "All done. Site: https://$DOMAIN/"
else
  ok "All done. Site: http://$DOMAIN/"
fi
warn "Routine updates after pushing to GitHub:"
warn "  ssh $HOST 'sudo PROJECT=$PROJECT bash $REMOTE_APP_ROOT/scripts/update.sh'"
warn "Backups:"
warn "  ssh $HOST 'sudo PROJECT=$PROJECT bash $REMOTE_APP_ROOT/scripts/backup.sh'"
warn ""
warn "This deployment is namespaced as '$PROJECT': unit $PROJECT.service,"
warn "user $PROJECT, $REMOTE_APP_ROOT, $REMOTE_DATA_ROOT, nginx site $PROJECT."
warn "Nothing it touches is shared with another project on this VPS."