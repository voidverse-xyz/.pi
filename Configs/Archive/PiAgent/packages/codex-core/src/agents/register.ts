/**
 * Registers the Phase-1 declarative-agent tools + commands on pi:
 *   spawn_agent   — run a named .pi/agents/<name>.md agent on a task
 *   delegate      — auto-pick the best agent by description, then run it
 *   list_agents   — list live sub-agents
 *   wait_agent    — await agents' final status + results
 *   interrupt_agent / close_agent — lifecycle
 *   /agents       — list defined agents / inspect a live one
 *
 * Definitions are (re)loaded from disk on session_start and reload, so editing
 * a .pi/agents/*.md file takes effect on the next session without a rebuild.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CARD, type AgentResultData } from "../contract.ts";
import { loadAgents, type AgentDef } from "./loader.ts";
import { AgentManager, statusText } from "./spawn.ts";
import { pickAgent } from "./delegate.ts";
import { sweepStaleWorktrees } from "./worktree.ts";

export function registerAgents(pi: ExtensionAPI, deps?: { createSession: any }): AgentManager {
	const mgr = new AgentManager(pi, deps);
	let defs = new Map<string, AgentDef>();

	const reload = (ctx: ExtensionContext) => {
		const { agents, diagnostics } = loadAgents(ctx);
		defs = agents;
		for (const d of diagnostics) ctx.ui.notify?.(d, "warning");
	};

	pi.on("session_start", async (_e, ctx) => {
		reload(ctx);
		void sweepStaleWorktrees(pi, ctx.cwd).catch(() => 0);
	});
	pi.on("resources_discover", async (event: any, ctx: ExtensionContext) => {
		if (event?.reason === "reload") reload(ctx);
		return undefined;
	});

	const agentList = () => [...defs.values()];

	// --- spawn_agent (by definition name) ---------------------------------
	pi.registerTool({
		name: "spawn_agent",
		label: "spawn_agent",
		description:
			"Run a declarative sub-agent (defined in .pi/agents/<name>.md) on a scoped task. The sub-agent uses only its declared tools and model, in its own context, optionally in an isolated git worktree. Returns an agent_id to wait on with wait_agent. Prefer `delegate` if you're unsure which agent fits.",
		parameters: Type.Object({
			agent: Type.String({ description: "Name of a defined agent (see /agents)." }),
			task: Type.String({ description: "The full task instructions for the sub-agent." }),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const def = defs.get(params.agent);
			if (!def) {
				return { content: [{ type: "text", text: `No agent named "${params.agent}". Defined: ${agentList().map((d) => d.name).join(", ") || "(none)"}` }], isError: true };
			}
			const rec = await mgr.spawn(def, params.task, ctx);
			if ("error" in rec) return { content: [{ type: "text", text: rec.error }], isError: true };
			return { content: [{ type: "text", text: JSON.stringify(mgr.serialize(rec)) }], details: mgr.serialize(rec) };
		},
	});

	// --- delegate (auto-pick) ---------------------------------------------
	pi.registerTool({
		name: "delegate",
		label: "delegate",
		description:
			"Delegate a task to the best-matching declarative sub-agent, chosen automatically from each agent's description. Optionally pass `agent` to force one. Use for well-scoped sidecar work that can run in parallel.",
		parameters: Type.Object({
			task: Type.String({ description: "The task to delegate." }),
			agent: Type.Optional(Type.String({ description: "Force a specific agent by name." })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const { agent } = pickAgent(params.task, params.agent, agentList());
			if (!agent) {
				return { content: [{ type: "text", text: `No suitable agent. Defined: ${agentList().map((d) => `${d.name} (${d.description})`).join("; ") || "(none)"}` }], isError: true };
			}
			const rec = await mgr.spawn(agent, params.task, ctx);
			if ("error" in rec) return { content: [{ type: "text", text: rec.error }], isError: true };
			return { content: [{ type: "text", text: JSON.stringify({ ...mgr.serialize(rec), delegated_to: agent.name }) }], details: mgr.serialize(rec) };
		},
	});

	// --- list_agents ------------------------------------------------------
	pi.registerTool({
		name: "list_agents",
		label: "list_agents",
		description: "List live sub-agents and their status.",
		parameters: Type.Object({}),
		async execute() {
			const list = [...mgr.agents.values()].map((a) => mgr.serialize(a));
			return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }], details: list };
		},
	});

	// --- wait_agent -------------------------------------------------------
	pi.registerTool({
		name: "wait_agent",
		label: "wait_agent",
		description: "Wait for one or more sub-agents to finish, then return their results.",
		parameters: Type.Object({
			agent_ids: Type.Optional(Type.Array(Type.String())),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const targets = params.agent_ids?.length
				? (params.agent_ids.map((i) => mgr.agents.get(i)).filter(Boolean) as any[])
				: [...mgr.agents.values()];
			const turns = targets.map((a) => a.turn ?? Promise.resolve());
			if (params.timeout_ms) {
				let t: any;
				await Promise.race([Promise.allSettled(turns), new Promise((r) => (t = setTimeout(r, params.timeout_ms)))]);
				clearTimeout(t);
			} else {
				await Promise.allSettled(turns);
			}
			const results = targets.map((a) => ({ ...mgr.serialize(a), result: a.lastResult }));
			return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], details: results };
		},
	});

	// --- interrupt_agent --------------------------------------------------
	pi.registerTool({
		name: "interrupt_agent",
		label: "interrupt_agent",
		description: "Interrupt a sub-agent's current turn; it stays available.",
		parameters: Type.Object({ agent_id: Type.String() }),
		async execute(_id, params) {
			const rec = mgr.agents.get(params.agent_id);
			if (!rec?.session) return { content: [{ type: "text", text: `no such agent: ${params.agent_id}` }], isError: true };
			await rec.session.abort?.();
			rec.status = { kind: "interrupted" };
			mgr.broadcast();
			return { content: [{ type: "text", text: `interrupted ${params.agent_id}` }] };
		},
	});

	// --- close_agent ------------------------------------------------------
	pi.registerTool({
		name: "close_agent",
		label: "close_agent",
		description: "Close a sub-agent and free its resources (removes a clean worktree; keeps a dirty one).",
		parameters: Type.Object({ agent_id: Type.String() }),
		async execute(_id, params) {
			const res = await mgr.close(params.agent_id);
			if (res.error) return { content: [{ type: "text", text: res.error }], isError: true };
			const note = res.worktreeNote ? ` (${res.worktreeNote})` : "";
			return { content: [{ type: "text", text: JSON.stringify({ closed: res.closed }) + note }] };
		},
	});

	// --- /agents command --------------------------------------------------
	pi.registerCommand("agents", {
		description: "list defined sub-agents and inspect live ones",
		handler: async (_args, ctx) => {
			const live = [...mgr.agents.values()];
			if (live.length > 0) {
				const labels = live.map((a) => `${a.nickname} [${a.def.name}] — ${statusText(a.status)}`);
				const choice = await ctx.ui.select("Live sub-agents", [...labels, "— defined agents —"]);
				const rec = live[labels.indexOf(choice ?? "")];
				if (rec?.lastResult) {
					pi.sendMessage<AgentResultData>(
						{ customType: CARD.agentResult, content: "", display: true, details: { nickname: rec.nickname, role: rec.def.name, result: rec.lastResult } },
						{ triggerTurn: false },
					);
					return;
				}
				if (rec) { ctx.ui.notify(`${rec.nickname}: ${statusText(rec.status)}`, "info"); return; }
			}
			const list = agentList();
			if (list.length === 0) {
				ctx.ui.notify("No agents defined. Create .pi/agents/<name>.md (frontmatter: name, description, tools, model). Docs: README.", "info");
				return;
			}
			ctx.ui.notify(`Defined agents:\n${list.map((d) => `  ${d.name} — ${d.description}`).join("\n")}`, "info");
		},
	});

	// /agent + /subagents (Codex aliases) open the live-agent picker.
	const livePicker = async (_args: string, ctx: ExtensionContext) => {
		const live = [...mgr.agents.values()];
		if (live.length === 0) { ctx.ui.notify("No live sub-agents. Spawn one with the spawn_agent/delegate tool.", "info"); return; }
		const labels = live.map((a) => `${a.nickname} [${a.def.name}] — ${statusText(a.status)}`);
		const choice = await ctx.ui.select("Sub-agents", labels);
		if (choice === undefined) return;
		const rec = live[labels.indexOf(choice)];
		if (rec?.lastResult) {
			pi.sendMessage<AgentResultData>(
				{ customType: CARD.agentResult, content: "", display: true, details: { nickname: rec.nickname, role: rec.def.name, result: rec.lastResult } },
				{ triggerTurn: false },
			);
		} else if (rec) ctx.ui.notify(`${rec.nickname}: ${statusText(rec.status)}`, "info");
	};
	pi.registerCommand("agent", { description: "switch the active agent thread", handler: livePicker });
	pi.registerCommand("subagents", { description: "switch the active agent thread", handler: livePicker });

	return mgr;
}
