// Test-only Pi package resolver: PI_SDK_DIR, else Pi's managed installation. No npm-global fallback.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const MARKER = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" };
const VERSION = /^[0-9A-Za-z._+-]+$/;

export function resolvePiPackageDir(env = process.env, home = homedir()) {
	if (env.PI_SDK_DIR) return requirePackage(resolve(env.PI_SDK_DIR), "PI_SDK_DIR has no package.json");
	const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	const root = resolve(env.PI_MANAGED_INSTALL_ROOT?.trim() || join(agentDir, "install"));
	const markerPath = join(root, "managed-install.json");
	if (!existsSync(markerPath)) throw new Error(`No managed Pi installation found at ${root}; install Pi with its installer, or set PI_SDK_DIR.`);
	let marker;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		marker = undefined;
	}
	if (Object.entries(MARKER).some(([key, value]) => marker?.[key] !== value)) throw new Error(`Managed Pi install marker is invalid: ${markerPath}`);
	const versionPath = join(root, "current-version");
	const version = existsSync(versionPath) ? readFileSync(versionPath, "utf8").trim() : "";
	if (!version || version === "." || version === ".." || !VERSION.test(version)) throw new Error(`Managed Pi version file is invalid: ${versionPath}`);
	const packageDir = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	return requirePackage(packageDir, "Managed Pi release is missing");
}

function requirePackage(packageDir, problem) {
	if (!existsSync(join(packageDir, "package.json"))) throw new Error(`${problem}: ${packageDir}`);
	return packageDir;
}
