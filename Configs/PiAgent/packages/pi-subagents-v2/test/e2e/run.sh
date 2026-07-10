#!/usr/bin/env bash
# test/e2e/run.sh — the ONE command that verifies pi-subagents-v2.
#
#   cd packages/pi-subagents-v2 && ./test/e2e/run.sh
#
# Runs, in order: a strict typecheck of extensions/ (tsc, installed on demand
# if missing), the phase 1–7 e2e harnesses (jiti-alias pattern, mock LLM
# provider — no network, no real model), and the Pi extension-loader check.
# Exits non-zero on the first failure.
#
# Prereqs: node >= 22 and a global install of @earendil-works/pi-coding-agent
# (the pi CLI). If pi lives somewhere unusual, set PI_SDK_DIR to its package
# dir. Optional env: NODE (node binary), TSC (tsc command), SKIP_TYPECHECK=1.
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE:-node}"

# ---------------------------------------------------------------------------
# 1. Strict typecheck (same flags as development: strict, exactOptional, ...)
# ---------------------------------------------------------------------------
if [ "${SKIP_TYPECHECK:-0}" != "1" ]; then
	PI_PKG="$("$NODE" print-pi-pkg.mjs)"
	PKG_ROOT="$(cd ../.. && pwd)"
	GEN_DIR="$(mktemp -d)"
	trap 'rm -rf "$GEN_DIR"' EXIT
	sed -e "s|__PI_PKG__|$PI_PKG|g" -e "s|__PKG_ROOT__|$PKG_ROOT|g" \
		tsconfig.template.json > "$GEN_DIR/tsconfig.json"

	if [ -z "${TSC:-}" ]; then
		if command -v tsc >/dev/null 2>&1; then
			TSC=tsc
		else
			# On-demand install into the throwaway dir (NOT the repo: keeps the
			# package clean, and some checkouts live on symlink-less mounts
			# where npm's .bin links fail).
			echo "== typescript not found — installing on demand (npm --prefix <tmp> install typescript) =="
			npm install --prefix "$GEN_DIR" --no-audit --no-fund --silent typescript
			TSC="$GEN_DIR/node_modules/.bin/tsc"
		fi
	fi
	echo "== typecheck (strict) =="
	$TSC -p "$GEN_DIR/tsconfig.json"
	echo "typecheck clean"
else
	echo "== typecheck skipped (SKIP_TYPECHECK=1) =="
fi

# ---------------------------------------------------------------------------
# 2. The e2e harnesses (each is standalone; run everything, fail on any)
# ---------------------------------------------------------------------------
TESTS=(
	phase1-data-layer.mjs
	phase2-runtime.mjs
	phase3-mail.mjs
	phase4-teams-rails.mjs
	phase5-sandbox.mjs
	phase6-tui.mjs
	phase7-full-story.mjs
	phase-lifecycle-fixes.mjs
	phase-runtime-fixes.mjs
	loadcheck.mjs
)
for t in "${TESTS[@]}"; do
	echo ""
	echo "== $t =="
	"$NODE" "$t"
done

echo ""
echo "ALL GREEN — typecheck + ${#TESTS[@]} harnesses"
