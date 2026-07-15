/**
 * Subagents (v2) — extension entry.
 *
 * Design: ~/Agents/Documents/Configs/Subagent-Docs/ (D1'–D27'). v1 is archived
 * at packages/_archive/pi-agents-v1/.
 *
 * At session_start the core is acquired under a single host-scope lease (D7),
 * keyed by the owning main session id (D3/D25'). Non-persisted (temporary)
 * sessions cannot spawn subagents at all (D25'). Torn down on shutdown.
 *
 * Registration grows phase by phase. Phase 2: team_spawn / team_status.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCore, type SubagentsCore } from "./core.ts";
import { createLayout } from "./store/layout.ts";
import { claimHostScope, HostScopeLockedError, type HostScopeLease } from "./store/host-lease.ts";
import { SettingsLoader } from "./store/settings.ts";
import { createCollectTool, createSendTool, createSpawnTool, createStatusTool, createSteerTool } from "./tools/main-agent.ts";

export default function (pi: ExtensionAPI): void {
	let core: SubagentsCore | null = null;
	let lease: HostScopeLease | null = null;
	/** Set when subagents are unavailable this session (non-persisted, or lease held elsewhere). */
	let unavailableReason: string | null = null;

	const getCore = (_ctx: ExtensionContext): SubagentsCore => {
		if (core) return core;
		throw new Error(unavailableReason ?? "Subagents are not available in this session.");
	};

	pi.registerTool(createSpawnTool(getCore));
	pi.registerTool(createSendTool(getCore));
	pi.registerTool(createSteerTool(getCore));
	pi.registerTool(createCollectTool(getCore));
	pi.registerTool(createStatusTool(getCore));

	pi.on("session_start", async (_event, ctx) => {
		// Fresh scope per session_start (reload/resume rebuilds it).
		await teardown();

		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		if (!persisted) {
			unavailableReason = "Subagents require a persisted session (start or resume a saved session).";
			return;
		}

		const layout = createLayout(ctx.cwd, { sessionId });
		try {
			lease = claimHostScope(layout);
		} catch (error) {
			if (error instanceof HostScopeLockedError) {
				unavailableReason = `Another process (pid ${error.ownerPid}) owns this session's subagents.`;
				if (ctx.hasUI) ctx.ui.notify(unavailableReason, "warning");
				return;
			}
			throw error;
		}

		const { settings, warnings } = new SettingsLoader(layout.globalSettingsFile, layout.projectSettingsFile).load();
		if (ctx.hasUI) for (const warning of warnings) ctx.ui.notify(`pi-agents: ${warning}`, "warning");

		unavailableReason = null;
		core = createCore({
			layout,
			maxConcurrent: settings.maxConcurrent,
			maxHops: settings.maxHops,
			// settingsManager/authStorage are not on ExtensionContext — the SDK
			// defaults them; only modelRegistry is host-provided.
			...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
			projectTrusted: () => {
				try {
					return ctx.isProjectTrusted?.() === true;
				} catch {
					return false; // trust uncertainty fails closed (finding #7)
				}
			},
		});
	});

	pi.on("session_shutdown", async () => {
		await teardown();
	});

	async function teardown(): Promise<void> {
		if (core) {
			try {
				await core.dispose();
			} catch {
				/* best effort */
			}
			core = null;
		}
		if (lease) {
			lease.release();
			lease = null;
		}
	}
}
