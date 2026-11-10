#!/usr/bin/env bash
# test/e2e/run.sh — the ONE command that verifies pi-teams.
#
#   ./test/e2e/run.sh
#
# Runs a strict typecheck of extensions/ then every phase harness, in order.
# Exits non-zero on the first failure.
#
# Prereqs: node >= 22 and an installed Pi SDK and TypeScript compiler.
# Set PI_SDK_DIR if the SDK lives somewhere unusual. Optional: NODE, TSC,
# SKIP_TYPECHECK=1.
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE:-node}"

# ---------------------------------------------------------------------------
# 1. Strict typecheck
# ---------------------------------------------------------------------------
if [ "${SKIP_TYPECHECK:-0}" != "1" ]; then
	PI_TSC="${TSC:-${PI_TSC:-tsc}}" "$NODE" ../../../../tests/typecheck.mjs pi-teams
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
	phase10-focus.mjs
	lifecycle-runtime.mjs
	wake-policy.mjs
	loadcheck.mjs
)
for t in "${TESTS[@]}"; do
	echo ""
	echo "== $t =="
	"$NODE" "$t"
done

echo ""
echo "ALL GREEN — typecheck + ${#TESTS[@]} harnesses"
