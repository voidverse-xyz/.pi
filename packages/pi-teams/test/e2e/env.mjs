import { createPiJiti, findPiPackage } from "../../../../tests/runtime.mjs";
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

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** extensions/teams, two levels up from test/e2e/. */
export const EXT = join(HERE, "..", "..", "extensions", "teams");

export const PI_PKG = findPiPackage();

export const WORLDS = join(tmpdir(), "pi-teams-e2e");

export const jiti = await createPiJiti(import.meta.url);


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
