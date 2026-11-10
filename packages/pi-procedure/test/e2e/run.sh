#!/usr/bin/env bash
# test/e2e/run.sh — the ONE command that verifies pi-procedure.
#
#   ./test/e2e/run.sh
#
# Runs the unit tests, a strict typecheck of extensions/, then every phase
# harness, in order. Exits non-zero on the first failure.
#
# Prereqs: node >= 22 and an installed Pi SDK and TypeScript compiler.
# Set PI_SDK_DIR if the SDK lives somewhere unusual. Optional: NODE, TSC,
# SKIP_TYPECHECK=1.
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE:-node}"

# ---------------------------------------------------------------------------
# 1. Unit tests (pure modules, no SDK needed)
# ---------------------------------------------------------------------------
echo "== unit tests =="
(cd ../.. && "$NODE" --test "extensions/procedure/**/*.test.ts")

# ---------------------------------------------------------------------------
# 2. Strict typecheck
# ---------------------------------------------------------------------------
TYPECHECK_RESULT="typecheck"
if [ "${SKIP_TYPECHECK:-0}" != "1" ]; then
	PI_TSC="${TSC:-${PI_TSC:-tsc}}" "$NODE" ../../../../tests/typecheck.mjs pi-procedure
	echo "typecheck clean"
else
	TYPECHECK_RESULT="typecheck skipped"
	echo "== typecheck skipped (SKIP_TYPECHECK=1) =="
fi

# ---------------------------------------------------------------------------
# 3. The e2e harnesses (each standalone; run all, fail on any)
# ---------------------------------------------------------------------------
TESTS=(
	phase1-live-run.mjs
	phase2-schema.mjs
	phase3-resume.mjs
	phase4-stop-sandbox.mjs
	loadcheck.mjs
)
for t in "${TESTS[@]}"; do
	echo ""
	echo "== $t =="
	"$NODE" "$t"
done

echo ""
echo "ALL GREEN — unit tests + $TYPECHECK_RESULT + ${#TESTS[@]} harnesses"
