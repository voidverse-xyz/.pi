/**
 * codex-subagents — Codex multi-agent orchestration for pi.
 *
 * Ports codex-rs/core/src/tools/handlers/multi_agents_spec.rs (multi_agent_v1)
 * onto pi's SDK: each sub-agent is a real in-memory `createAgentSession` that
 * inherits the parent's model + auth and runs a scoped task. The parent agent
 * drives them through tools; the TUI shows live status the way
 * codex-rs/tui/src/multi_agents.rs does (status dots + "nickname [role]").
 *
 * Sub-agents get only the built-in coding tools — never the spawn tool — so
 * they cannot recurse (codex enforces the same rule).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types & registry
// ---------------------------------------------------------------------------

export type AgentStatus =
	| { kind: "pending_init" }
	| { kind: "running" }
	| { kind: "interrupted" }
	| { kind: "shutdown" }
	| { kind: "completed"; result: string | null }
	| { kind: "errored"; error: string };

interface AgentRecord {
	agentId: string;
	taskName: string;
	nickname: string;
	role: string;
	status: AgentStatus;
	session?: any; // AgentSession
	dispose?: () => void;
	/** Resolves when the current turn settles. */
	turn?: Promise<void>;
	lastResult: string | null;
}

const NICKNAMES = [
	"otter", "finch", "lynx", "heron", "vole", "marten", "shrike", "civet",
	"tanager", "dace", "quokka", "saiga", "ibex", "serval", "gecko", "pika",
];

/** Injectable session factory so the tools are testable without a live model. */
export interface SubagentDeps {
	createSession: typeof createAgentSession;
}
const defaultDeps: SubagentDeps = { createSession: createAgentSession };

function assistantText(messages: any[]): string | null {
	const assistants = messages.filter((m) => m.role === "assistant");
	const last = assistants[assistants.length - 1];
	if (!last) return null;
	const text = (last.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();
	return text || null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodexSubagents(pi: ExtensionAPI, deps: SubagentDeps = defaultDeps) {
	const agents = new Map<string, AgentRecord>();
	let counter = 0;
	let uiCtx: ExtensionContext | undefined;

	const statusDot = (theme: Theme, s: AgentStatus): string => {
		switch (s.kind) {
			case "running":
				return theme.fg("warning", "●");
			case "completed":
				return theme.fg("success", "●");
			case "errored":
				return theme.fg("error", "●");
			case "interrupted":
				return theme.fg("muted", "◐");
			default:
				return theme.fg("dim", "○");
		}
	};

	const statusText = (s: AgentStatus): string =>
		s.kind === "completed" ? "completed" : s.kind === "errored" ? `errored: ${s.error}` : s.kind;

	/** Live widget above the editor: one line per agent (multi_agents.rs picker rows). */
	function refreshWidget() {
		if (!uiCtx || uiCtx.mode !== "tui") return;
		if (agents.size === 0) {
			uiCtx.ui.setWidget("codex-agents", undefined);
			return;
		}
		uiCtx.ui.setWidget(
			"codex-agents",
			(_tui, theme: Theme) => ({
				render(): string[] {
					const lines = [theme.fg("dim", "  agents")];
					for (const a of agents.values()) {
						const name = a.role ? `${a.nickname} ${theme.fg("dim", `[${a.role}]`)}` : a.nickname;
						lines.push(`  ${statusDot(theme, a.status)} ${name} ${theme.fg("dim", "· " + statusText(a.status))}`);
					}
					return lines;
				},
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	function serialize(a: AgentRecord) {
		return {
			agent_id: a.agentId,
			task_name: a.taskName,
			nickname: a.nickname,
			role: a.role,
			status:
				a.status.kind === "completed"
					? { completed: a.status.result }
					: a.status.kind === "errored"
						? { errored: a.status.error }
						: a.status.kind,
		};
	}

	// Track latest ctx so widgets/model inheritance are current.
	pi.on("session_start", async (_e, ctx) => {
		uiCtx = ctx;
	});
	pi.on("turn_start", async (_e, ctx) => {
		uiCtx = ctx;
	});

	/** Run one turn on a record's session, updating status + result. */
	function runTurn(rec: AgentRecord, message: string): Promise<void> {
		rec.status = { kind: "running" };
		refreshWidget();
		const collected: any[] = [];
		const unsub = rec.session.subscribe((ev: any) => {
			if (ev.type === "agent_end" && Array.isArray(ev.messages)) collected.push(...ev.messages);
		});
		const p = rec.session
			.prompt(message, { source: "extension" })
			.then(() => {
				rec.lastResult = assistantText(collected) ?? rec.lastResult;
				if (rec.status.kind === "running") rec.status = { kind: "completed", result: rec.lastResult };
			})
			.catch((err: any) => {
				rec.status = { kind: "errored", error: err?.message ?? String(err) };
			})
			.finally(() => {
				unsub();
				refreshWidget();
			});
		rec.turn = p;
		return p;
	}

	// --- spawn_agent -------------------------------------------------------
	pi.registerTool({
		name: "spawn_agent",
		label: "spawn_agent",
		description:
			"Spawn a sub-agent for a well-scoped task. The sub-agent runs independently with its own context and the built-in coding tools, inheriting your model. Give each sub-agent a disjoint write-scope so parallel agents don't conflict. Returns an agent_id you can wait on with wait_agent. Do not spawn sub-agents unless the task clearly benefits from parallel or isolated work.",
		parameters: Type.Object({
			task_name: Type.String({ description: "Short lowercase/underscore name for the task, e.g. `refactor_auth`." }),
			message: Type.String({ description: "The full task instructions for the sub-agent." }),
			model: Type.Optional(Type.String({ description: "Model id override; defaults to the parent's model." })),
			role: Type.Optional(Type.String({ description: "Optional role label shown in the UI, e.g. `worker`, `reviewer`." })),
			fork_turns: Type.Optional(
				Type.Union([Type.Literal("none"), Type.Literal("all")], {
					description: "`none` = fresh context (default). `all` = seed with the parent's task context.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const agentId = `agent_${++counter}`;
			const nickname = NICKNAMES[(counter - 1) % NICKNAMES.length];
			const rec: AgentRecord = {
				agentId,
				taskName: params.task_name,
				nickname,
				role: params.role ?? "worker",
				status: { kind: "pending_init" },
				lastResult: null,
			};
			agents.set(agentId, rec);
			refreshWidget();

			try {
				const model =
					params.model && ctx.modelRegistry
						? ((await ctx.modelRegistry.resolve?.(params.model)) ?? ctx.model)
						: ctx.model;
				const { session } = await deps.createSession({
					cwd: ctx.cwd,
					model,
					sessionManager: SessionManager.inMemory(ctx.cwd),
					// Only the coding tools — never spawn_agent — to prevent recursion.
					tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
				});
				rec.session = session;
			} catch (err: any) {
				rec.status = { kind: "errored", error: err?.message ?? String(err) };
				refreshWidget();
				return { content: [{ type: "text", text: `Failed to spawn ${agentId}: ${rec.status.kind === "errored" ? rec.status.error : ""}` }], isError: true };
			}

			let seed = params.message;
			if (params.fork_turns === "all") {
				seed = `# Parent task context\n${ctx.getSystemPrompt().slice(0, 2000)}\n\n# Your task\n${params.message}`;
			}
			void runTurn(rec, seed);

			return {
				content: [{ type: "text", text: JSON.stringify(serialize(rec)) }],
				details: serialize(rec),
			};
		},
	});

	// --- wait_agent --------------------------------------------------------
	pi.registerTool({
		name: "wait_agent",
		label: "wait_agent",
		description: "Wait for one or more sub-agents to reach a final status (completed/errored), then return their results.",
		parameters: Type.Object({
			agent_ids: Type.Optional(Type.Array(Type.String(), { description: "Agent ids to wait for; omit to wait for all." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Max time to wait before returning current statuses." })),
		}),
		async execute(_id, params) {
			const targets = params.agent_ids?.length
				? (params.agent_ids.map((id) => agents.get(id)).filter(Boolean) as AgentRecord[])
				: [...agents.values()];
			const turns = targets.map((a) => a.turn ?? Promise.resolve());
			if (params.timeout_ms) {
				let timer: any;
				const timeout = new Promise<void>((res) => (timer = setTimeout(res, params.timeout_ms)));
				await Promise.race([Promise.allSettled(turns), timeout]);
				clearTimeout(timer);
			} else {
				await Promise.allSettled(turns);
			}
			const results = targets.map((a) => ({ ...serialize(a), result: a.lastResult }));
			return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], details: results };
		},
	});

	// --- send_input --------------------------------------------------------
	pi.registerTool({
		name: "send_input",
		label: "send_input",
		description: "Send a follow-up message to a running or completed sub-agent, starting a new turn.",
		parameters: Type.Object({
			agent_id: Type.String(),
			message: Type.String(),
		}),
		async execute(_id, params) {
			const rec = agents.get(params.agent_id);
			if (!rec?.session) return { content: [{ type: "text", text: `No such agent: ${params.agent_id}` }], isError: true };
			if (rec.status.kind === "running")
				return { content: [{ type: "text", text: `Agent ${params.agent_id} is still running; wait first.` }], isError: true };
			await runTurn(rec, params.message);
			return { content: [{ type: "text", text: JSON.stringify({ ...serialize(rec), result: rec.lastResult }) }] };
		},
	});

	// --- list_agents -------------------------------------------------------
	pi.registerTool({
		name: "list_agents",
		label: "list_agents",
		description: "List all live sub-agents and their current status.",
		parameters: Type.Object({
			path_prefix: Type.Optional(Type.String({ description: "Only list agents whose task_name starts with this prefix." })),
		}),
		async execute(_id, params) {
			let list = [...agents.values()];
			if (params.path_prefix) list = list.filter((a) => a.taskName.startsWith(params.path_prefix!));
			return { content: [{ type: "text", text: JSON.stringify(list.map(serialize), null, 2) }], details: list.map(serialize) };
		},
	});

	// --- interrupt_agent ---------------------------------------------------
	pi.registerTool({
		name: "interrupt_agent",
		label: "interrupt_agent",
		description: "Interrupt a sub-agent's current turn; the agent stays available for send_input.",
		parameters: Type.Object({ agent_id: Type.String() }),
		async execute(_id, params) {
			const rec = agents.get(params.agent_id);
			if (!rec?.session) return { content: [{ type: "text", text: `No such agent: ${params.agent_id}` }], isError: true };
			await rec.session.abort?.();
			rec.status = { kind: "interrupted" };
			refreshWidget();
			return { content: [{ type: "text", text: `Interrupted ${params.agent_id}` }] };
		},
	});

	// --- close_agent -------------------------------------------------------
	pi.registerTool({
		name: "close_agent",
		label: "close_agent",
		description: "Close a sub-agent and free its resources. Returns its final status.",
		parameters: Type.Object({ agent_id: Type.String() }),
		async execute(_id, params) {
			const rec = agents.get(params.agent_id);
			if (!rec) return { content: [{ type: "text", text: `No such agent: ${params.agent_id}` }], isError: true };
			const prior = serialize(rec);
			try {
				await rec.session?.abort?.();
			} catch {
				/* ignore */
			}
			rec.session?.dispose?.();
			agents.delete(params.agent_id);
			refreshWidget();
			return { content: [{ type: "text", text: JSON.stringify({ closed: prior }) }] };
		},
	});

	// --- /agent + /subagents picker (codex: "switch the active agent thread") --
	const agentPickerHandler = async (_args: string, ctx: any) => {
		if (agents.size === 0) {
			ctx.ui.notify("No sub-agents. The model spawns them with the spawn_agent tool.", "info");
			return;
		}
		const list = [...agents.values()];
		const labels = list.map((a) => `${a.nickname} [${a.role}] — ${statusText(a.status)}`);
		const choice = await ctx.ui.select("Sub-agents", labels);
		if (choice === undefined) return;
		const rec = list[labels.indexOf(choice)];
		if (rec?.lastResult) {
			pi.sendMessage(
				{ customType: "codex-agent-result", content: "", display: true, details: { nickname: rec.nickname, role: rec.role, result: rec.lastResult } },
				{ triggerTurn: false },
			);
		} else {
			ctx.ui.notify(`${rec.nickname}: ${statusText(rec.status)}`, "info");
		}
	};
	pi.registerCommand("agent", { description: "switch the active agent thread", handler: agentPickerHandler });
	pi.registerCommand("subagents", { description: "switch the active agent thread", handler: agentPickerHandler });

	pi.registerMessageRenderer<{ nickname: string; role: string; result: string }>("codex-agent-result", (message, _o, theme) => {
		const d = message.details as { nickname: string; role: string; result: string };
		return {
			render(): string[] {
				return [
					theme.fg("customMessageLabel", `● ${d.nickname} [${d.role}]`),
					...d.result.split("\n").map((l) => theme.fg("text", l)),
				];
			},
			invalidate() {},
		};
	});

	// Expose registry for tests.
	return { agents, runTurn };
}
