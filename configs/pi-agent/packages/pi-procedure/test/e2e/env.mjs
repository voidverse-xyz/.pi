/**
 * test/e2e/env.mjs — shared harness environment (jiti-alias pattern, adapted
 * from pi-subagents/test/e2e/env.mjs).
 *
 *   PI_PKG — installed @earendil-works/pi-coding-agent dir (PI_SDK_DIR overrides).
 *   EXT    — this package's extensions/procedure source dir.
 *   WORLDS — scratch root for test worlds (os tmpdir; wiped per file).
 *   jiti   — jiti instance aliasing the SDK's bare specifiers to the installed
 *            package, exactly the way Pi's extension loader does.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** extensions/procedure, two levels up from test/e2e/. */
export const EXT = join(HERE, "..", "..", "extensions", "procedure");

function findPiPkg() {
	const home = process.env.HOME ?? "";
	const candidates = [
		process.env.PI_SDK_DIR,
		join(home, ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "dist", "index.js"))) return candidate;
	}
	throw new Error(
		"@earendil-works/pi-coding-agent not found — install pi globally or set PI_SDK_DIR to its package dir.",
	);
}

export const PI_PKG = findPiPkg();

export const WORLDS = join(tmpdir(), "pi-procedure-e2e");

const { createJiti } = await import(join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs"));

export const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: true,
	alias: {
		"@earendil-works/pi-ai": join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(PI_PKG, "dist/index.js"),
		"@earendil-works/pi-tui": join(PI_PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"),
		typebox: join(PI_PKG, "node_modules/typebox/build/index.mjs"),
	},
});
