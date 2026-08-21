/**
 * test/e2e/env.mjs — shared harness environment (jiti-alias pattern).
 *
 * Every e2e file imports { PI_PKG, EXT, WORLDS, jiti } from here:
 *   PI_PKG — installed @earendil-works/pi-coding-agent dir (PI_SDK_DIR overrides).
 *   EXT    — this package's extensions/teams source dir.
 *   WORLDS — scratch root for test worlds (os tmpdir; wiped per file).
 *   jiti   — jiti instance aliasing the SDK's bare specifiers to the installed
 *            package, exactly the way Pi's extension loader does, so the
 *            extension's .ts sources load without a build step.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** extensions/teams, two levels up from test/e2e/. */
export const EXT = join(HERE, "..", "..", "extensions", "teams");

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

export const WORLDS = join(tmpdir(), "pi-teams-e2e");

const jitiModuleUrl = pathToFileURL(join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs")).href;
const { createJiti } = await import(jitiModuleUrl);

export const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(PI_PKG, "dist/index.js"),
		"@earendil-works/pi-tui": join(PI_PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"),
		typebox: join(PI_PKG, "node_modules/typebox/build/index.mjs"),
	},
});

/**
 * Create the current SDK's canonical ModelRuntime plus its extension-facing
 * ModelRegistry facade, then register deterministic mock providers. Keeping this
 * here prevents every phase from depending on removed AuthStorage/ModelRegistry
 * factory APIs.
 */
export async function createTestModelRuntime(piSdk, options) {
	const services = await piSdk.createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
	});
	for (const [providerId, config] of Object.entries(options.providers ?? {})) {
		services.modelRuntime.registerProvider(providerId, config);
	}
	return {
		modelRuntime: services.modelRuntime,
		modelRegistry: new piSdk.ModelRegistry(services.modelRuntime),
	};
}
