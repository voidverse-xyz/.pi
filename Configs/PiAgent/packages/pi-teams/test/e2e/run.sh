#!/usr/bin/env bash
# test/e2e/run.sh — the ONE command that verifies pi-teams.
#
#   ./test/e2e/run.sh
#
# Runs a strict typecheck of extensions/ then every phase harness, in order.
# Exits non-zero on the first failure.
#
# Prereqs: node >= 22 and a global install of @earendil-works/pi-coding-agent.
# Set PI_SDK_DIR if the SDK lives somewhere unusual. Optional: NODE, TSC,
# SKIP_TYPECHECK=1.
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE:-node}"

# ---------------------------------------------------------------------------
# 1. Strict typecheck
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
			echo "== typescript not found — installing on demand =="
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
# 2. The e2e harnesses (each standalone; run all, fail on any)
# ---------------------------------------------------------------------------
TESTS=(
	phase1-data-layer.mjs
	phase2-runtime.mjs
	phase3-mail.mjs
	phase4-rails.mjs
	phase5-sandbox.mjs
	phase6-tui.mjs
	phase7-completion.mjs
	phase8-review-fixes.mjs
	phase9-auto-wake.mjs
	phase10-peers.mjs
	loadcheck.mjs
)
for t in "${TESTS[@]}"; do
	echo ""
	echo "== $t =="
	"$NODE" "$t"
done

echo ""
echo "ALL GREEN — typecheck + ${#TESTS[@]} harnesses"
