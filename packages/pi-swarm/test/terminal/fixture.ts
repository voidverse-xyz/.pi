import { driveMainAgentTools } from "./main-agent-fixture.ts";
// Test-only CLI entry: never register this fixture in personal settings.
import { appendFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSwarmExtension } from "../../extensions/swarm/extension.mjs";
import { createMockRuntime } from "../sdk-env.mjs";

export default async function (pi) {
	if (!process.env.SWARM_TERMINAL_FIXTURE || !process.env.PI_OFFLINE) throw new Error("Isolated terminal fixture required");
	if (getAgentDir() !== process.env.PI_CODING_AGENT_DIR) throw new Error("Agent directory isolation failed");
	const record = (event) => appendFileSync(process.env.SWARM_TERMINAL_FIXTURE, JSON.stringify(event) + "\n", { mode: 0o600 });
	let steps = [];
	const mock = await createMockRuntime(({ options }) => {
		record({ type: "worker-start" });
		options.signal.addEventListener("abort", () => record({ type: "worker-abort" }), { once: true });
		return steps.shift() ?? { waitForAbort: true };
	});
	pi.registerCommand("fixture-uncertain", { handler: async (_args, ctx) => {
		steps = [
			{ toolCalls: [{ name: "swarm_task", arguments: { action: "create", id: "task1", title: "Fixture check", criteria: [0], dependencies: [] } }] },
			{ toolCalls: [{ name: "swarm_task", arguments: { action: "claim", taskId: "task1", kind: "build" } }] },
			{ toolCalls: [{ name: "bash", arguments: { command: "simulated uncertain operation" } }] },
		];
		ctx.ui.notify("Uncertain fixture armed", "info");
	} });
	pi.registerCommand("fixture-light", { handler: async (_args, ctx) => {
		if (!ctx.ui.setTheme("light").success) throw new Error("Built-in light theme unavailable");
		ctx.ui.notify("Fixture light theme selected", "info");
	} });
	let context;
	const unsubscribe = pi.events.on("pi-plan:query-mode", request => request.respond({
		version: 1, instanceId: "terminal-fixture", revision: 1, contextRevision: 1,
		ready: Boolean(context), sessionId: context?.sessionManager.getSessionId(),
		selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false,
	}));
	pi.on("session_start", (event, ctx) => { context = ctx; record({ type: "start", reason: event.reason }); });
	// No Safety provider here: approved bounded Swarm policy must authorize the
	// selected worker tools without Swarm-owned operation/lifecycle dialogs.
	// production-fixture separately verifies independently enabled pi-safety.
	pi.on("session_shutdown", () => { unsubscribe(); record({ type: "shutdown" }); });
	// Observe real methods without replacing native dialogs or command dispatch.
	const instrumented = Object.create(pi);
	instrumented.registerCommand = (name, definition) => pi.registerCommand(name, {
		...definition,
		handler: async (args, ctx) => {
			try { await definition.handler(args, ctx); record({ type: "command", args, ok: true }); }
			catch (error) { record({ type: "command", args, ok: false, code: error.code }); throw error; }
		},
	});
	createSwarmExtension({ modelRuntime: mock.modelRuntime, mainModel: mock.model,
		runner: async () => { record({ type: "uncertain-runner" }); return { settled: false, exitCode: null }; },
	})(driveMainAgentTools(instrumented));
	pi.on("session_start", (_event, ctx) => ctx.ui.notify("Swarm terminal fixture ready", "info"));
}
