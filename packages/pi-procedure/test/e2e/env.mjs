import { createPiJiti, findPiPackage } from "../../../../tests/runtime.mjs";
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

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** extensions/procedure, two levels up from test/e2e/. */
export const EXT = join(HERE, "..", "..", "extensions", "procedure");

export const PI_PKG = findPiPackage();

export const WORLDS = join(tmpdir(), "pi-procedure-e2e");

export const jiti = await createPiJiti(import.meta.url);
