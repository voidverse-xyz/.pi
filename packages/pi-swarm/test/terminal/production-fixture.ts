import { driveMainAgentTools } from "./main-agent-fixture.ts";
// Test-only composition of the actual production factories. No policy substitutes.
import { appendFileSync } from "node:fs";
import { createMockRuntime } from "../sdk-env.mjs";
import { createNativeWorker } from "./native-worker.mjs";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import planExtension from "../../../pi-plan/extensions/plan/index.ts";
import safetyExtension from "../../../pi-safety/extensions/safety/index.ts";
import { createNativeSwarmExtension, createSwarmExtension } from "../../extensions/swarm/extension.mjs";

export default async function (pi) {
	if (!process.env.SWARM_TERMINAL_FIXTURE || process.env.PI_OFFLINE !== "1") throw new Error("Isolated offline fixture required");
	if (getAgentDir() !== process.env.PI_CODING_AGENT_DIR) throw new Error("Agent directory isolation failed");
	const record = event => appendFileSync(process.env.SWARM_TERMINAL_FIXTURE, JSON.stringify(event) + "\n", { mode: 0o600 });
	let activeDialogs = 0;
	// Observe native calls and their actual completion; do not stub dialogs or lifecycle.
	const observeContext = (ctx, owner) => {
		const ui = Object.create(ctx.ui);
		for (const kind of ["select", "input", "confirm", "custom"]) {
			ui[kind] = async (...args) => {
				record({ type: "dialog-open", owner, kind, active: ++activeDialogs });
				try { return await ctx.ui[kind](...args); }
				finally { record({ type: "dialog-close", owner, kind, active: --activeDialogs }); }
			};
		}
		return Object.create(ctx, { ui: { value: ui } });
	};
	const observeFactory = owner => {
		const api = Object.create(pi);
		api.on = (event, handler) => pi.on(event, (data, ctx) => handler(data, observeContext(ctx, owner)));
		api.registerCommand = (name, definition) => pi.registerCommand(name, {
			...definition,
			handler: async (args, ctx) => {
				try { await definition.handler(args, observeContext(ctx, owner)); record({ type: "command", name, args, ok: true }); }
				catch (error) { record({ type: "command", name, args, ok: false, code: error.code }); throw error; }
			},
		});
		return api;
	};
	const unsubscribeMode = pi.events.on("pi-plan:mode-changed", snapshot => record({ type: "mode", ...snapshot }));
	planExtension(observeFactory("plan"));
	safetyExtension(observeFactory("safety"));

	// A separate scripted main provider makes selected/enforced transitions observable
	// while the real CLI turn unwinds. No fabricated agent lifecycle events.
	const main = await createMockRuntime(async ({ options }) => {
		record({ type: "main-start" });
		await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
		record({ type: "main-abort" });
		await new Promise(resolve => setTimeout(resolve, 700));
		return { text: "aborted main fixture" };
	});
	pi.registerProvider(main.modelRuntime.getProvider("swarm-mock"));
	let steps = [];
	let release;
	const native = process.env.SWARM_TERMINAL_NATIVE === "1";
	const nextStep = async ({ options }) => {
		record({ type: "worker-start" });
		options.signal.addEventListener("abort", () => record({ type: "worker-abort" }), { once: true });
		const step = steps.shift();
		if (step?.hold) {
			record({ type: "worker-held" });
			await new Promise(resolve => {
				release = resolve;
				options.signal.addEventListener("abort", resolve, { once: true });
			});
		}
		return step ?? { waitForAbort: true };
	};
	const worker = native ? await createNativeWorker(record, nextStep) : await createMockRuntime(nextStep);
	const extension = native ? await createNativeSwarmExtension({ modelRegistry: worker.modelRegistry, mainModel: worker.mainModel,
		runner: async request => {
			if (request.command === `node -e "console.log('phase8-uncertain')"`) {
				record({ type: "uncertain-runner" });
				return { settled: false, exitCode: null }; // No process spawned for this one controlled seam.
			}
			try {
    const result = await createBashToolDefinition(request.cwd).execute("fixture", { command: request.command }, request.signal);
    return { nativeResult: result, settled: true, exitCode: result.structuredContent.exit_code };
   } catch (error) { error.settled = true; throw error; }
		},
	}) : createSwarmExtension({ modelRuntime: worker.modelRuntime, mainModel: worker.model });
	extension(driveMainAgentTools(observeFactory("swarm")));
	pi.registerCommand("fixture-script", { handler: async (args, ctx) => {
		const [id, hold] = args.trim().split(/\s+/);
		if (!/^[a-z]+$/.test(id)) throw new Error("Named disposable script required");
		steps = [
			{ toolCalls: [{ name: "swarm_task", arguments: { action: "create", id, title: id, criteria: [0], dependencies: [] } }] },
			{ toolCalls: [{ name: "swarm_task", arguments: { action: "claim", taskId: id, kind: "build" } }] },
			{ hold: hold === "hold", toolCalls: [{ name: "bash", arguments: { command: `node -e "console.log('phase8-${id}')"` } }] },
		];
		ctx.ui.notify(`Script armed: ${id}`, "info");
	} });

	// Public protocol clients only: exercise queued cancellation without needing
	// simultaneous shell leases (Swarm deliberately serializes those leases).
	let probes = [];
	pi.registerCommand("fixture-queue", { handler: async () => {
		probes = [new AbortController(), new AbortController(), new AbortController()];
		for (const [index, controller] of probes.entries()) {
			const request = { tool: "bash", command: `node -e "console.log('queue-${index}')"`, signal: controller.signal };
			const claims = [];
			pi.events.emit("swarm:confirm-request", { method: "confirm", request, claim: fn => claims.push(fn) });
			if (claims.length !== 1) throw new Error("Exactly one production safety provider required");
			record({ type: "probe-request", index });
			void claims[0](request).then(result => record({ type: "probe-result", index, ...result }));
		}
	} });
	pi.on("session_start", (event, ctx) => {
		ctx.ui.onTerminalInput(data => {
			if (data === "\x1bg") { release?.(); release = undefined; return { consume: true }; }
			if (data === "\x1bx") { probes[1]?.abort(); return { consume: true }; }
			if (data === "\x1bz") { probes[0]?.abort(); return { consume: true }; }
		});
		record({ type: "start", reason: event.reason });
		ctx.ui.notify("Production policy fixture ready", "info");
	});
	pi.on("session_shutdown", async event => {
		for (const probe of probes) probe.abort();
		unsubscribeMode();
		if (native && event.reason !== "reload") await worker.close();
		record({ type: "shutdown", reason: event.reason, activeDialogs });
	});
}
