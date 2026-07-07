/**
 * Confirm Interrupt While Working
 *
 * Prompts for confirmation before actions that stop an in-flight agent run.
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

const BODY =
	"The agent is still running. This will stop the current run and any in-flight tool or bash work.";

function isWorking(ctx: ExtensionContext): boolean {
	return !ctx.isIdle();
}

async function confirmInterrupt(
	ctx: ExtensionContext,
	title: string,
	cancelLabel: string,
): Promise<{ cancel: true } | undefined> {
	if (!ctx.hasUI) return;
	if (!isWorking(ctx)) return;

	const confirmed = await ctx.ui.confirm(`${title} while agent is working?`, BODY);

	if (!confirmed) {
		ctx.ui.notify(`${cancelLabel} cancelled`, "info");
		return { cancel: true };
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
