import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	InteractiveMode,
	VERSION,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const TRUST_WARNING_PATCH = Symbol.for("void-agent.config-alias-trust-warning-patch");
const SUPPORTED_PI_VERSION = "0.80.10";

type InteractiveModeInternals = {
	sessionManager?: { getCwd?: () => string };
	renderProjectTrustWarningIfNeeded?: () => void;
	[key: symbol]: unknown;
};

type ProjectTrustWarningRenderer = (this: InteractiveModeInternals) => void;

function sameFilesystemEntry(left: string, right: string): boolean {
	try {
		const leftStat = statSync(left);
		const rightStat = statSync(right);
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

export function isGlobalConfigExposedAsProject(cwd: string): boolean {
	return sameFilesystemEntry(join(cwd, CONFIG_DIR_NAME), dirname(getAgentDir()));
}

function getInteractiveModeCwd(mode: InteractiveModeInternals): string | undefined {
	try {
		return mode.sessionManager?.getCwd?.();
	} catch {
		return undefined;
	}
}

/**
 * Pi 0.80.10 has no supported API for suppressing one untrusted-project banner.
 * Patch its renderer idempotently and fail open if that private method changes.
 */
export function installAliasTrustWarningPatch(): boolean {
	if (VERSION !== SUPPORTED_PI_VERSION) return false;
	const prototype = InteractiveMode.prototype as unknown as InteractiveModeInternals;
	if (typeof prototype[TRUST_WARNING_PATCH] === "function") return true;

	const renderWarning = prototype.renderProjectTrustWarningIfNeeded as ProjectTrustWarningRenderer | undefined;
	if (typeof renderWarning !== "function") return false;

	prototype[TRUST_WARNING_PATCH] = renderWarning;
	prototype.renderProjectTrustWarningIfNeeded = function renderProjectTrustWarningIfNeeded(): void {
		const cwd = getInteractiveModeCwd(this);
		if (cwd && isGlobalConfigExposedAsProject(cwd)) return;
		renderWarning.call(this);
	};
	return true;
}

export default function configAliasGuard(pi: ExtensionAPI): void {
	installAliasTrustWarningPatch();
	pi.on("project_trust", (event) => {
		if (isGlobalConfigExposedAsProject(event.cwd)) return { trusted: "no" };
		return { trusted: "undecided" };
	});
}
