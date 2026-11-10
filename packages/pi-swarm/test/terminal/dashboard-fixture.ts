// Static, offline inspection fixture: no controller, workers, model or provider calls.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { showDashboard } from "../../extensions/swarm/dashboard.mjs";

export default function (pi) {
	if (!process.env.PI_OFFLINE || !process.env.SWARM_DASHBOARD_FIXTURE) throw new Error("Offline fixture required");
	if (getAgentDir() !== process.env.PI_CODING_AGENT_DIR) throw new Error("Isolated agent directory required");
	let status = "running";
	let attached = true;
	const run = {
		status, revision: 1, cycle: 1, elapsedMs: 0, limits: { active: 4 }, objective: "Offline dashboard verification",
		workers: [
			{ id: "alpha", specialization: "Implementation", brief: "Inspect Unicode 界🙂 and selected detail" },
			{ id: "beta", specialization: "Independent review", brief: "Review without executing work" },
		],
		tasks: [{ id: "fixture-task", title: "Fixture task", status: "assigned", assignment: { workerId: "alpha", kind: "build" } }],
		messages: [
			{ from: "owner", to: "alpha", text: "Fixture main message", topic: "fixture-task" },
			{ from: "alpha", to: "beta", text: "Fixture peer message", topic: "fixture-task" },
			{ from: "beta", to: "@board", text: "Fixture board message", topic: "Review" },
		],
	};
	const source = {
		snapshot: () => attached ? { run: { ...run, status }, driver: { active: ["alpha"], queued: ["beta"], errors: [] }, errors: [] } : undefined,
		history: () => Array.from({ length: 100 }, (_, index) => ({ id: String(index), message: { role: "assistant", content: `Fixture history ${index}` } })),
	};
	let closeCount = 0;
	const open = async ctx => {
		await showDashboard(ctx, source, new AbortController().signal);
		ctx.ui.notify(`Fixture closed-${++closeCount}`, "info");
	};
	pi.registerCommand("fixture-dashboard", { handler: async (args, ctx) => {
		if (args) {
			attached = args !== "unattached";
			status = args;
		}
		await open(ctx);
	} });
	// Exercises Pi's shortcut transport; production shortcut ownership has separate tests.
	pi.registerShortcut("alt+n", { description: "Static Swarm dashboard fixture", handler: open });
	pi.on("session_start", (_event, ctx) => ctx.ui.notify("Static dashboard fixture ready", "info"));
}
