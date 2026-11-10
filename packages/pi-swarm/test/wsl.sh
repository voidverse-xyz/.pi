#!/usr/bin/env bash
# Run the pi-swarm test suite on Linux (WSL) against a Windows worktree's current state.
#
# Usage (from Git Bash on Windows):
#   packages/pi-swarm/test/wsl.sh [--pty] [--distro NAME] [WORKTREE]
#
#   WORKTREE   Windows git worktree to test (default: the current repository root).
#              Its HEAD commit, uncommitted diff and untracked files are all included.
#   --pty      Also run test/terminal/run.py, production.py, native.py and entry.py.
#   --distro   WSL distribution (default: Ubuntu-24.04).
#
# Prerequisites inside WSL: git, python3, Node >= 22.19 at ~/.local/share/pi-node/current,
# and Pi installed with its managed installer (~/.pi/agent/install). See the pi-swarm
# package README verification section.
#
# Side effects: creates a unique ~/swarm-runs/<worktree-name>.XXXXXX inside WSL. Nothing on the Windows
# side is written except a temporary bundle under $TMPDIR. Commands inside WSL run with
# a Linux-only PATH, so Windows programs (including a Windows Pi) are never reachable.
#
# Exit status: 0 when every test passed, 1 otherwise.
set -euo pipefail

pty=0
distro="Ubuntu-24.04"
worktree=""
while [ $# -gt 0 ]; do
	case "$1" in
		--pty) pty=1 ;;
		--distro) distro="$2"; shift ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) worktree="$1" ;;
	esac
	shift
done
worktree="${worktree:-$(git rev-parse --show-toplevel)}"
worktree="$(cd "$worktree" && git rev-parse --show-toplevel)"
name="$(basename "$worktree")"
base="$(git -C "$worktree" rev-parse HEAD)"
common="$(cd "$worktree" && cd "$(git rev-parse --git-common-dir)" && pwd)"
repo_root="$(dirname "$common")"

bundle="$(mktemp -d)"
trap 'rm -rf "$bundle"' EXIT
git -C "$worktree" diff --binary HEAD > "$bundle/changes.patch"
git -C "$worktree" ls-files --others --exclude-standard -z > "$bundle/untracked.list"
if [ -s "$bundle/untracked.list" ]; then
	(cd "$worktree" && tar -cf "$bundle/untracked.tar" --null -T "$bundle/untracked.list")
fi

to_wsl() { # C:/x/y or /c/x/y -> /mnt/c/x/y
	local path; path="$(cygpath -m "$1")"
	printf '/mnt/%s%s' "$(printf '%s' "${path:0:1}" | tr 'A-Z' 'a-z')" "${path:2}"
}

cat > "$bundle/run.sh" <<'EOS'
#!/bin/sh
set -u
repo="$1"; base="$2"; name="$3"; bundle="$4"; pty="$5"
CLEAN_PATH="$HOME/.local/share/pi-node/current/bin:/usr/local/bin:/usr/bin:/bin"
run() { env -i HOME="$HOME" USER="$(id -un)" PATH="$CLEAN_PATH" LANG=C.UTF-8 TERM=xterm-256color "$@"; }
mkdir -p "$HOME/swarm-runs"
name=$(printf "%s" "$name" | tr -c "a-zA-Z0-9_-" "_")
dest=$(mktemp -d "$HOME/swarm-runs/$name.XXXXXX") || exit 2
run git clone -q --no-checkout "$repo" "$dest" || exit 2
cd "$dest" || exit 2
run git -c advice.detachedHead=false checkout -q "$base" || exit 2
if [ -s "$bundle/changes.patch" ]; then run git apply --whitespace=nowarn "$bundle/changes.patch" || { echo "patch did not apply"; exit 2; }; fi
if [ -f "$bundle/untracked.tar" ]; then
	tar -xf "$bundle/untracked.tar"
	tr '\0' '\n' < "$bundle/untracked.list" | while IFS= read -r file; do
		case "$file" in *.mjs|*.js|*.ts|*.py|*.json|*.md|*.sh) sed -i 's/\r$//' "$file" ;; esac
	done
fi
cd packages/pi-swarm || exit 2
echo "base: $(git log --oneline -1 "$base")"
run npm test > "$dest/npm-test.log" 2>&1
status=$?
grep -E "^# (tests|pass|fail|cancelled) " "$dest/npm-test.log"
grep -E "^not ok " "$dest/npm-test.log" | sed 's/^not ok [0-9]* - /FAIL: /'
if [ "$pty" = 1 ]; then
	for script in run.py production.py native.py entry.py; do
		run timeout 900 python3 "test/terminal/$script" > "$dest/$script.log" 2>&1
		code=$?
		echo "PTY $script exit $code"
		[ "$code" = 0 ] || { tail -15 "$dest/$script.log"; status=1; }
	done
fi
echo "logs: $dest"
exit "$status"
EOS

set +e
MSYS_NO_PATHCONV=1 wsl.exe -d "$distro" -- sh "$(to_wsl "$bundle/run.sh")" \
	"$(to_wsl "$repo_root")" "$base" "$name" "$(to_wsl "$bundle")" "$pty" 2>&1 \
	| tr -d '\0' | grep -v "Failed to mount\|screen size is bogus"
exit "${PIPESTATUS[0]}"
