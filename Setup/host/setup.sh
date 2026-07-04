#!/usr/bin/env bash
#
# Host setup / preflight check.
#   - Verifies the `claude` and `codex` CLIs are installed and logged in.
#   - Ensures the JetBrainsMono Nerd Font is installed in the user font dir.
#
set -uo pipefail

FONT_URL="https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.tar.xz"
FONT_NAME="JetBrainsMono Nerd Font"
FONT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/JetBrainsMonoNerdFont"

# --- output helpers ---------------------------------------------------------
if [ -t 1 ]; then
  green=$'\033[32m'; red=$'\033[31m'; yellow=$'\033[33m'; bold=$'\033[1m'; reset=$'\033[0m'
else
  green=''; red=''; yellow=''; bold=''; reset=''
fi
ok()   { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
fail() { printf '  %s✗%s %s\n' "$red" "$reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$*"; }
head() { printf '\n%s%s%s\n' "$bold" "$*" "$reset"; }

# --- claude -----------------------------------------------------------------
check_claude() {
  head "claude"
  if ! command -v claude >/dev/null 2>&1; then
    fail "not installed (claude not on PATH)"
    return 1
  fi
  ok "installed at $(command -v claude)"

  local creds="$HOME/.claude/.credentials.json"
  if [ ! -f "$creds" ]; then
    fail "not logged in (no credentials at $creds)"
    return 1
  fi

  # OAuth creds live under claudeAiOauth; access token has an expiry in ms.
  # An expired access token is fine as long as a refresh token is present.
  local msg
  if msg="$(python3 - "$creds" <<'PY'
import json, sys, time
try:
    oauth = json.load(open(sys.argv[1])).get("claudeAiOauth") or {}
except Exception as e:
    print(f"could not parse credentials: {e}"); sys.exit(2)
if not oauth.get("refreshToken") and not oauth.get("accessToken"):
    print("no oauth tokens present"); sys.exit(2)
exp = oauth.get("expiresAt")
if isinstance(exp, (int, float)) and exp > time.time() * 1000:
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(exp / 1000))
    print(f"logged in (token valid until {when})")
else:
    print("logged in (access token expired; will refresh on next use)")
PY
  )"; then
    ok "$msg"
  else
    fail "not logged in (${msg:-credential check failed})"
    return 1
  fi
}

# --- codex ------------------------------------------------------------------
check_codex() {
  head "codex"
  if ! command -v codex >/dev/null 2>&1; then
    fail "not installed (codex not on PATH)"
    return 1
  fi
  ok "installed at $(command -v codex)"

  local out
  if out="$(codex login status 2>&1)" && [ -n "$out" ]; then
    ok "$out"
  else
    fail "not logged in (${out:-codex login status failed})"
    return 1
  fi
}

# Return 0 if the Nerd Font is registered with fontconfig.
# Captures fc-list into a variable first: piping directly into `grep -q` lets
# grep close the pipe on first match, which (under `set -o pipefail`) can
# surface fc-list's SIGPIPE as a false "not found".
font_installed() {
  local listing
  listing="$(fc-list 2>/dev/null)"
  grep -qi "JetBrainsMono Nerd Font" <<<"$listing"
}

# --- nerd font --------------------------------------------------------------
check_font() {
  head "$FONT_NAME"
  if font_installed; then
    ok "already installed"
    return 0
  fi

  warn "not installed — downloading"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  if ! curl -fsSL "$FONT_URL" -o "$tmp/font.tar.xz"; then
    fail "download failed from $FONT_URL"
    return 1
  fi

  mkdir -p "$FONT_DIR"
  if ! tar -xJf "$tmp/font.tar.xz" -C "$FONT_DIR"; then
    fail "extraction failed"
    return 1
  fi

  # Rebuild the whole user cache (not just $FONT_DIR) so fontconfig registers
  # the newly-created subdirectory under the font search path.
  fc-cache -f >/dev/null 2>&1
  if font_installed; then
    ok "installed to $FONT_DIR"
  else
    fail "installed files but font not detected by fontconfig"
    return 1
  fi
}

# --- run --------------------------------------------------------------------
rc=0
check_claude || rc=1
check_codex  || rc=1
check_font   || rc=1

if [ "$rc" -eq 0 ]; then
  printf '\n%sAll checks passed.%s\n' "$green" "$reset"
else
  printf '\n%sSome checks failed — see above.%s\n' "$red" "$reset"
fi
exit "$rc"
