// Offline actual agent-focus producer verification; presenter simulation is plain data only.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createFocusBridge } from "../../extensions/swarm/focus.mjs";

export default async function (pi) {
	if (!process.env.PI_OFFLINE || !process.env.SWARM_FOCUS_FIXTURE) throw new Error("Offline fixture required");
	if (getAgentDir() !== process.env.PI_CODING_AGENT_DIR) throw new Error("Isolated configuration required");
	const workers = [
		{ id: "alpha", specialization: "Alpha implementation", brief: "Safe static implementation detail" },
		{ id: "beta", specialization: "Beta review", brief: "Safe static independent review detail" },
	];
	const composer = process.env.SWARM_FOCUS_COMPOSER === "1";
	const run = { runId: "fixture-run", status: composer ? "running" : "paused", revision: 1, workers, tasks: [], messages: [
		{ from: "owner", to: "alpha", text: "Alpha fixture message 界🙂", topic: "Fixture" },
		{ from: "owner", to: "beta", text: "Beta fixture message", topic: "Fixture" },
	] };
	const source = {
		snapshot: () => ({ run, driver: { active: [], queued: [] } }),
		history: id => [{ id: "fixture-history", message: { role: "assistant", content: [{ type: "text", text: `${id} fixture assistant message` }], stopReason: "stop" } }],
		subscribe: () => () => {},
	};
	// Reference is an optional test input, never a production dependency. Only
	// its public focus producer is loaded; the plain-data core cannot spawn work.
	const reference = process.env.SWARM_FOCUS_REFERENCE;
	const factory = reference ? (await import(reference)).createFocusBridge : createFocusBridge;
	const sourceName = process.env.SWARM_FOCUS_SOURCE || "swarm";
	const core = {
		status: async () => workers.map(worker => ({ address: worker.id, label: worker.specialization, state: "idle" })),
		peek: async id => ({ label: workers.find(worker => worker.id === id)?.specialization, state: "idle", sessionFile: process.env.SWARM_FOCUS_SESSION }),
		onEvent: () => () => {},
		sendAsUser: () => { throw new Error("Read-only fixture cannot send mail"); },
	};
	let bridge;
	let context;
	let index = -1;
	let closes = 0;
	const focus = () => pi.events.emit("agent-focus:focus", index < 0 ? { source: "main" } : {
		source: sourceName, id: workers[index].id, position: index + 1, total: workers.length,
	});
	const next = () => { index = (index + 1) % workers.length; focus(); };
	const off = pi.events.on("agent-focus:navigate", target => {
		if (target?.source !== sourceName) return;
		if (target.action === "next") next();
		else if (target.action === "back") {
			index = -1; focus(); context.ui.notify(`Fixture main-${++closes}`, "info");
		} else if (target.action === "select") {
			index = workers.findIndex(worker => worker.id === target.targetId); focus();
		}
	});
	pi.registerShortcut("alt+n", { description: "Fixture plain-data presenter next", handler: next });
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		// Optional composer acceptance records only local fixture mail; no dispatch or provider.
		const mail = composer ? { send: async (to, text) => {
			run.messages.push({ from: "owner", to, text, topic: "Fixture" }); run.revision++;
		} } : undefined;
		bridge = reference ? factory(pi, core, ctx.ui, ctx.cwd) : factory(pi, source, ctx.ui, mail);
		pi.events.emit("agent-focus:roster-request", {});
		ctx.ui.notify("Actual focus fixture ready", "info");
	});
	pi.on("session_shutdown", () => { bridge?.dispose(); off(); });
}
