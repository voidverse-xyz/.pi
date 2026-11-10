#!/usr/bin/env bash
# test/e2e/run.sh — the ONE command that verifies pi-subagents.
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
	PI_TSC="${TSC:-${PI_TSC:-tsc}}" "$NODE" ../../../../tests/typecheck.mjs pi-subagents
	echo "typecheck clean"
else
	echo "== typecheck skipped (SKIP_TYPECHECK=1) =="
fi

# ---------------------------------------------------------------------------
# 2. The e2e harnesses (each standalone; run all, fail on any)
# ---------------------------------------------------------------------------
TESTS=(
	phase1-data-layer.mjs
	phase2-typedefs.mjs
	phase3-spawn-turn.mjs
	phase4-await.mjs
	phase5-wake.mjs
	phase6-control.mjs
	phase7-resume.mjs
	phase8-sandbox.mjs
	phase9-tui.mjs
	phase10-focus.mjs
	loadcheck.mjs
)
for t in "${TESTS[@]}"; do
	echo ""
	echo "== $t =="
	"$NODE" "$t"
done

echo ""
if [ "${SKIP_TYPECHECK:-0}" = "1" ]; then
	echo "ALL GREEN — ${#TESTS[@]} harnesses; typecheck skipped"
else
	echo "ALL GREEN — typecheck + ${#TESTS[@]} harnesses"
fi
