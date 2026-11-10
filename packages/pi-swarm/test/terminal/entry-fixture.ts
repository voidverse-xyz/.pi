// Scripted public native provider only; the normal entry is loaded separately with -e.
import { appendFileSync } from "node:fs";
import { guardNetwork } from "../network-guard.mjs";
import { createAssistantMessageEventStream, createProvider, getCurrentTools } from "@earendil-works/pi-ai";

export default function (pi) {
	if (process.env.PI_OFFLINE !== "1" || !process.env.SWARM_TERMINAL_FIXTURE) throw new Error("Offline fixture required");
	const cleanup = [];
	guardNetwork({ after: fn => cleanup.push(fn) });
	pi.on("session_shutdown", () => { for (const fn of cleanup) fn(); });
	const record = value => appendFileSync(process.env.SWARM_TERMINAL_FIXTURE, JSON.stringify(value) + "\n", { mode: 0o600 });
	const model = { id: "first", name: "Entry scripted", provider: "entry-fixture", api: "openai-responses",
		baseUrl: "https://entry.invalid/v1", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let pending;
	const stream = (selected, _context, options) => {
		if (options.apiKey !== "memory-only-fixture") throw new Error("Fixture auth missing");
		if (getCurrentTools(_context.messages).some(tool => tool.name === "swarm_start")) {
			const last = _context.messages.at(-1);
			const text = typeof last?.content === "string" ? last.content : last?.content?.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
			const explicit = last?.role === "user" && text === "start" && pending;
			const action = explicit ? "confirm" : last?.role === "user" && text.startsWith("fixture chat ") ? text.slice("fixture chat ".length) : undefined;
   const launch = Boolean(action);
   const name = explicit ? pending.name : action === "launch" ? "swarm_start" : action === "status" ? "swarm_status" : "swarm_control";
   const args = explicit ? { ...(pending.name === 'swarm_control' ? { action: pending.args.action } : {}), proposalId: pending.proposalId } : action === "launch" ? { objective: "Fixture chat goal" } : action === "status" ? {} : { action };
   if (explicit || ['pause', 'stop'].includes(action)) pending = undefined;
			const output = createAssistantMessageEventStream();
			const message = { role: "assistant", content: launch
				? [{ type: "toolCall", id: `chat-${Date.now()}`, name, arguments: args }]
				: [{ type: "text", text: pending ? "Fixture main agent returned. Type start to proceed with this Swarm configuration." : "Fixture main agent returned." }],
				api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), stopReason: launch ? "toolUse" : "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			output.push({ type: "done", reason: message.stopReason, message }); output.end();
			record({ type: "main-dispatch", launch: Boolean(launch), action });
			return output;
		}
		record({ type: "dispatch", model: selected.id });
		const output = createAssistantMessageEventStream();
		void (async () => {
			if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
			const error = { role: "assistant", content: [], api: selected.api, provider: selected.provider, model: selected.id,
				stopReason: "aborted", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			output.push({ type: "error", reason: "aborted", error }); output.end(); record({ type: "settled" });
		})();
		return output;
	};
	pi.registerProvider(createProvider({ id: model.provider, models: [model, { ...model, id: "second" }],
		auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }),
			resolve: async () => { record({ type: "auth" }); return { auth: { apiKey: "memory-only-fixture" } }; } } },
		api: { stream, streamSimple: stream } }));
	pi.on("agent_settled", () => record({ type: "main-settled" }));
	pi.on("tool_result", event => {
		if (event.details?.proposalId && ["swarm_start", "swarm_control"].includes(event.toolName)) pending = { name: event.toolName, args: event.input, proposalId: event.details.proposalId };
		if (event.toolName === "swarm_start") record({ type: "chat-result", data: event.details });
		if (event.toolName === "swarm_control") {
			record({ type: "control-result", action: event.input.action });
			if (event.details?.awaitingConfirmation) record({ type: "agreement", data: event.details });
		}
	});
	pi.on("session_start", (_event, ctx) => {
		const names = pi.getAllTools().map(tool => tool.name);
		const expected = ["swarm_start", "swarm_status", "swarm_control", "swarm_history"];
		if (!expected.every(name => names.filter(item => item === name).length === 1)) throw new Error("Swarm main tool discovery failed");
		record({ type: "ready", tools: expected });
		ctx.ui.notify("Entry fixture ready", "info");
	});
	pi.registerCommand("fixture-model", { handler: async (_args, ctx) => {
		await pi.setModel(ctx.modelRegistry.find("entry-fixture", "second"));
		ctx.ui.notify("Entry model changed", "info");
	} });
}
