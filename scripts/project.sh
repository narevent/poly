#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# project.sh — resolves the PROJECT identity every other script keys off.
#
# The project name is the ONE knob that keeps this deployment from colliding
# with anything else on the same VPS. Everything derived from it is namespaced:
#
#   /opt/$PROJECT            checkout          $PROJECT.service   systemd unit
#   /opt/$PROJECT-data       persistent data   $PROJECT           service user
#   /opt/$PROJECT-backups    backups           127.0.0.1:$PORT    gunicorn bind
#   /etc/nginx/sites-available/$PROJECT        nginx site
#
# Resolution order (first hit wins):
#   1. $PROJECT in the environment          (non-interactive / CI)
#   2. scripts/project.conf                 (written on first run)
#   3. interactive prompt                   (then persisted to project.conf)
#
# If none apply and there is no terminal, we fail loudly rather than guessing —
# a wrong name here would write another project's paths.
#
# Sourced by config.sh (on the VPS) and by bootstrap_local.sh (on your machine).
# ---------------------------------------------------------------------------

# Resolve this file's directory even when sourced from another script.
PROJECT_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_CONF="${PROJECT_CONF:-$PROJECT_SH_DIR/project.conf}"

# Fallback logging, only if the caller has not defined its own.
if ! declare -F log >/dev/null 2>&1; then
  log()  { printf '\033[1;34m[%s]\033[0m %s\n' "${PROJECT:-setup}" "$*"; }
  ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
  warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
  die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
fi

# A project name has to be usable as a Linux username, a systemd unit name and
# an nginx site filename all at once: lowercase, starts with a letter, then
# letters/digits/hyphens. 2..32 chars keeps it inside useradd's limit.
project_name_valid() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{1,31}$ ]]
}

# Names we must not take over. 'rea'/'rea5' are the sibling project on this same
# VPS — reusing either would hijack its service user, paths and nginx site.
project_name_reserved() {
  case "$1" in
    rea|rea5|rea-data|rea-backups) return 0 ;;
    root|daemon|bin|sys|nginx|www-data|systemd|postgres|mysql) return 0 ;;
    *) return 1 ;;
  esac
}

project_name_explain() {
  warn "Project names must be 2-32 chars: lowercase letter first, then letters,"
  warn "digits or hyphens. Examples: scribe, score-editor, scribe2"
  warn "Reserved (already used on this VPS or by the system): rea, rea5, root, nginx, ..."
}

# Deterministic default port from the name, so two projects on one box land on
# different ports without anyone having to remember which. 8000 is excluded
# because the rea project already binds it.
project_default_port() {
  local name="$1" n
  n="$(printf '%s' "$name" | cksum | awk '{print $1}')"
  printf '%s' "$(( 8001 + (n % 899) ))"   # 8001..8899
}

# Persist resolved values so every later script agrees without re-prompting.
project_conf_set() {  # <KEY> <VALUE>
  local key="$1" val="$2" tmp
  touch "$PROJECT_CONF" 2>/dev/null || {
    warn "Cannot write $PROJECT_CONF — later scripts will prompt again."
    return 0
  }
  tmp="$(mktemp)"
  grep -v "^${key}=" "$PROJECT_CONF" 2>/dev/null > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  # Keep it sorted and readable; it is a file humans will look at.
  sort -o "$PROJECT_CONF" "$tmp"
  rm -f "$tmp"
  chmod 644 "$PROJECT_CONF" 2>/dev/null || true
}

project_conf_get() {  # <KEY>
  [[ -f "$PROJECT_CONF" ]] || return 1
  local line
  line="$(grep -m1 "^${1}=" "$PROJECT_CONF" 2>/dev/null)" || return 1
  printf '%s' "${line#*=}"
}

# --- The prompt -------------------------------------------------------------
project_prompt() {
  local suggestion="$1" answer
  # Prompts and reads go to the terminal, not stdout: callers capture stdout.
  {
    printf '\n'
    printf '  This deployment needs a project name. It becomes the service user,\n'
    printf '  the systemd unit, /opt/<name>, and the nginx site — so it must not\n'
    printf '  clash with anything already on this VPS (the rea project included).\n\n'
  } >&2
  while :; do
    printf '  Project name [%s]: ' "$suggestion" >&2
    answer=""
    local rc=0
    # Read order matters. When stdin is already the terminal, read stdin. Only
    # when it is not (e.g. `curl ... | bash`) fall back to /dev/tty — and probe
    # that by actually opening it, because on some hosts /dev/tty stats fine yet
    # cannot be opened ("Device not configured").
    if [[ -t 0 ]]; then
      IFS= read -r answer || rc=$?
    elif { : </dev/tty; } 2>/dev/null; then
      IFS= read -r answer </dev/tty || rc=$?
    else
      rc=1
    fi
    # A failed read must NEVER fall through to the suggested default — that
    # would name the whole deployment without anyone confirming it. (`read`
    # also returns non-zero on a final line with no trailing newline, which is
    # legitimate, so only an empty result counts as failure.)
    if (( rc != 0 )) && [[ -z "$answer" ]]; then
      printf '\n' >&2
      die "Could not read a project name from the terminal.
Pass it explicitly instead:  PROJECT=myapp bash ${0##*/}"
    fi
    # Empty input (bare Enter) is a deliberate "use the suggestion".
    answer="${answer:-$suggestion}"
    # Lowercase and trim the OUTER whitespace only. Deleting all whitespace
    # would silently turn "score editor" into the valid-but-different
    # "scoreeditor"; internal spaces should be rejected, not papered over.
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' \
              | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if ! project_name_valid "$answer"; then
      warn "Invalid name: '$answer'"; project_name_explain; continue
    fi
    if project_name_reserved "$answer"; then
      warn "'$answer' is reserved and would collide with an existing service."
      continue
    fi
    printf '%s' "$answer"
    return 0
  done
}

# --- Main entry point -------------------------------------------------------
# Sets and exports PROJECT. Also exports PORT when project.conf carries one
# (init_vps.sh pins it there once it has probed for a free port).
resolve_project() {
  local suggestion="${PROJECT_SUGGESTION:-scribe}"

  # 1. Environment.
  if [[ -n "${PROJECT:-}" ]]; then
    PROJECT="$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]')"
    if ! project_name_valid "$PROJECT"; then
      project_name_explain; die "Invalid PROJECT='$PROJECT'."
    fi
    # Explicit `if` rather than `cmd && die`: under `set -e` an AND-OR list whose
    # first command "fails" (here: name is fine) is a well-known footgun.
    if project_name_reserved "$PROJECT"; then
      die "PROJECT='$PROJECT' is reserved (it would collide with an existing service)."
    fi
  # 2. Persisted from a previous run.
  elif PROJECT="$(project_conf_get PROJECT)" && [[ -n "$PROJECT" ]]; then
    project_name_valid "$PROJECT" \
      || die "$PROJECT_CONF holds an invalid PROJECT='$PROJECT'. Fix or delete the file."
  # 3. Ask.
  else
    if [[ ! -t 0 ]] && ! { : </dev/tty; } 2>/dev/null; then
      die "No project name available and no terminal to ask on.
Pass it explicitly:  PROJECT=myapp bash ${0##*/}
or write it once:     echo 'PROJECT=myapp' > $PROJECT_CONF"
    fi
    PROJECT="$(project_prompt "$suggestion")"
  fi

  export PROJECT
  project_conf_set PROJECT "$PROJECT"

  # A port may have been pinned by a previous init_vps.sh run. An explicit
  # $PORT in the environment still wins.
  if [[ -z "${PORT:-}" ]]; then
    PORT="$(project_conf_get PORT || true)"
    [[ -n "$PORT" ]] || PORT="$(project_default_port "$PROJECT")"
  fi
  export PORT
}
