/**
 * Run Guard
 *
 * Prompts for confirmation before actions that stop an in-flight agent run.
 * Offers a "don't ask again until reload/restart" choice that silently
 * auto-approves later confirmations for the rest of this extension instance.
 *
 * Loaded as a pi package: its path is listed in ~/.pi/agent/settings.json
 * `packages[]`. Edit, then /reload.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
} from "@earendil-works/pi-coding-agent";

const STOP = "Stop the run";
const STOP_AND_SKIP = "Stop the run and don't ask again until reload/restart";
const CANCEL = "Cancel";

/**
 * Process-lifetime flag: once set, every later confirmation auto-approves
 * silently. Module-scoped on purpose — never persisted to disk, so it resets
 * on process restart (and on /reload, which re-evaluates the module).
 */
let skipConfirmations = false;

function isWorking(ctx: ExtensionContext): boolean {
	return !ctx.isIdle();
}

async function confirmInterrupt(
	ctx: ExtensionContext,
	title: string,
	cancelLabel: string,
): Promise<{ cancel: true } | undefined> {
	if (!isWorking(ctx)) return;
	if (skipConfirmations) return;
	// Never silently interrupt an active run when no confirmation UI exists.
	if (!ctx.hasUI || ctx.mode !== "tui") return { cancel: true };

	const choice = await ctx.ui.select(`${title} while agent is working?`, [
		STOP,
		STOP_AND_SKIP,
		CANCEL,
	]);

	if (!choice || choice === CANCEL) {
		ctx.ui.notify(`${cancelLabel} cancelled`, "info");
		return { cancel: true };
	}

	if (choice === STOP_AND_SKIP) {
		skipConfirmations = true;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
		if (event.reason === "new") {
			return confirmInterrupt(ctx, "Start new session", "New session");
		}
		return confirmInterrupt(ctx, "Switch session", "Session switch");
	});

	pi.on("session_before_fork", async (event: SessionBeforeForkEvent, ctx) => {
		const label = event.position === "at" ? "Clone" : "Fork";
		return confirmInterrupt(ctx, label, label);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		return confirmInterrupt(ctx, "Tree navigation", "Tree navigation");
	});
}
