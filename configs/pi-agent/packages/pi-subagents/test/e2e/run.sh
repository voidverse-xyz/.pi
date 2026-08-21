#!/usr/bin/env bash
# test/e2e/run.sh — the ONE command that verifies pi-subagents.
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
	PKG_ROOT="$("$NODE" -e 'console.log(require("node:path").resolve("../.."))')"
	GEN_DIR="$(mktemp -d)"
	trap 'rm -rf "$GEN_DIR"' EXIT
	"$NODE" --input-type=module - "$PI_PKG" "$PKG_ROOT" "$GEN_DIR/tsconfig.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [piPackage, packageRoot, outputPath] = process.argv.slice(2);
const jsonPath = (value) => JSON.stringify(value.replaceAll("\\", "/")).slice(1, -1);
const config = readFileSync("tsconfig.template.json", "utf8")
	.replaceAll("__PI_PKG__", jsonPath(piPackage))
	.replaceAll("__PKG_ROOT__", jsonPath(packageRoot));
writeFileSync(outputPath, config);
NODE

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
	phase2-typedefs.mjs
	phase3-spawn-turn.mjs
	phase4-await.mjs
	phase5-wake.mjs
	phase6-control.mjs
	phase7-resume.mjs
	phase8-sandbox.mjs
	phase9-tui.mjs
	loadcheck.mjs
)
for t in "${TESTS[@]}"; do
	echo ""
	echo "== $t =="
	"$NODE" "$t"
done

echo ""
echo "ALL GREEN — typecheck + ${#TESTS[@]} harnesses"
