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
const SUPPORTED_PI_VERSIONS = new Set(["0.80.10", "0.81.0", "0.81.1"]);

type ProjectTrustWarningRenderer = (this: InteractiveModeInternals) => void;

type TrustWarningPatch = {
	original: ProjectTrustWarningRenderer;
	patched: ProjectTrustWarningRenderer;
};

type InteractiveModeInternals = {
	sessionManager?: { getCwd?: () => string };
	renderProjectTrustWarningIfNeeded?: ProjectTrustWarningRenderer;
	[TRUST_WARNING_PATCH]?: TrustWarningPatch | ProjectTrustWarningRenderer;
};

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
 * Verified Pi releases have no supported API for suppressing one
 * untrusted-project banner.
 * Patch its renderer idempotently and fail open if that private method changes.
 */
export function installAliasTrustWarningPatch(): (() => void) | undefined {
	if (!SUPPORTED_PI_VERSIONS.has(VERSION)) return undefined;
	const prototype = InteractiveMode.prototype as unknown as InteractiveModeInternals;
	const existing = prototype[TRUST_WARNING_PATCH];
	if (existing && typeof existing !== "function") return () => {};
	// Migrate a patch installed by the pre-cleanup implementation during /reload.
	if (typeof existing === "function") {
		prototype.renderProjectTrustWarningIfNeeded = existing;
		delete prototype[TRUST_WARNING_PATCH];
	}

	const original = prototype.renderProjectTrustWarningIfNeeded;
	if (typeof original !== "function") return undefined;

	const patched: ProjectTrustWarningRenderer = function renderProjectTrustWarningIfNeeded(): void {
		const cwd = getInteractiveModeCwd(this);
		if (cwd && isGlobalConfigExposedAsProject(cwd)) return;
		original.call(this);
	};
	prototype.renderProjectTrustWarningIfNeeded = patched;
	prototype[TRUST_WARNING_PATCH] = { original, patched };

	return () => {
		const state = prototype[TRUST_WARNING_PATCH];
		if (!state || typeof state === "function" || prototype.renderProjectTrustWarningIfNeeded !== state.patched) return;
		prototype.renderProjectTrustWarningIfNeeded = state.original;
		delete prototype[TRUST_WARNING_PATCH];
	};
}

export default function configAliasGuard(pi: ExtensionAPI): void {
	const restoreTrustWarning = installAliasTrustWarningPatch();
	pi.on("project_trust", (event) => {
		if (isGlobalConfigExposedAsProject(event.cwd)) return { trusted: "no" };
		return { trusted: "undecided" };
	});
	pi.on("session_shutdown", () => {
		restoreTrustWarning?.();
	});
}
