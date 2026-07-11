/**
 * Per-agent spawning over declarative AgentDefs (Phase 1).
 *
 * Each spawn runs a real in-memory AgentSession whose tools and model come from
 * the agent's definition, optionally inside a git worktree. Live records are
 * kept addressable (for the mailbox tools in Phase 2) and broadcast on the event
 * bus so the active look renders the status widget.
 *
 * Adapted from the original codex-core/src/subagents.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { EVT, type AgentSummary } from "../contract.ts";
import type { AgentDef } from "./loader.ts";
import { createWorktree, type Worktree } from "./worktree.ts";

// Default coding tools when an agent declares no `tools:` allowlist. The list
// deliberately excludes every sub-agent/orchestration tool, which is how we
// prevent a subagent from recursively spawning (Phase 1: no nesting).
export const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const NICKNAMES = ["otter", "finch", "lynx", "heron", "vole", "marten", "shrike", "civet", "tanager", "dace", "quokka", "saiga", "ibex", "serval", "gecko", "pika"];

export type AgentStatus =
	| { kind: "pending_init" } | { kind: "running" } | { kind: "interrupted" } | { kind: "shutdown" }
	| { kind: "completed"; result: string | null } | { kind: "errored"; error: string };

export interface AgentRecord {
	agentId: string;
	def: AgentDef;
	nickname: string;
	status: AgentStatus;
	session?: any;
	worktree?: Worktree;
	turn?: Promise<void>;
	lastResult: string | null;
	turnCount: number;
	/** Queued mailbox messages (Phase 2 delivers these). */
	mailbox: string[];
}

export interface SpawnDeps {
	createSession: typeof createAgentSession;
}
const defaultDeps: SpawnDeps = { createSession: createAgentSession };

export function statusText(s: AgentStatus): string {
	return s.kind === "completed" ? "completed" : s.kind === "errored" ? `errored: ${s.error}` : s.kind;
}

function assistantText(messages: any[]): string | null {
	const last = messages.filter((m) => m.role === "assistant").pop();
	if (!last) return null;
	const text = (last.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
	return text || null;
}

export class AgentManager {
	readonly agents = new Map<string, AgentRecord>();
	private counter = 0;
	constructor(private pi: ExtensionAPI, private deps: SpawnDeps = defaultDeps) {}

	broadcast(): void {
		const list: AgentSummary[] = [...this.agents.values()].map((a) => ({
			nickname: a.nickname,
			role: a.def.role,
			color: a.def.color,
			status: statusText(a.status),
			closed: a.status.kind === "shutdown",
		}));
		this.pi.events.emit(EVT.agents, list);
	}

	serialize(a: AgentRecord) {
		return {
			agent_id: a.agentId,
			agent: a.def.name,
			nickname: a.nickname,
			role: a.def.role,
			status:
				a.status.kind === "completed" ? { completed: a.status.result }
					: a.status.kind === "errored" ? { errored: a.status.error }
						: a.status.kind,
		};
	}

	/** Run one turn on a record, with two-phase commit (status flips on agent_end, not dispatch). */
	runTurn(rec: AgentRecord, message: string): Promise<void> {
		rec.status = { kind: "running" };
		this.broadcast();
		const collected: any[] = [];
		const unsub = rec.session.subscribe((ev: any) => {
			if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
				collected.push(...ev.messages);
				rec.turnCount++;
			}
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
				this.broadcast();
			});
		rec.turn = p;
		return p;
	}

	/** Spawn a sub-agent from a definition. Returns the record or an error string. */
	async spawn(def: AgentDef, task: string, ctx: ExtensionContext): Promise<AgentRecord | { error: string }> {
		const agentId = `agent_${++this.counter}`;
		const nickname = NICKNAMES[(this.counter - 1) % NICKNAMES.length];
		const rec: AgentRecord = {
			agentId, def, nickname, status: { kind: "pending_init" }, lastResult: null, turnCount: 0, mailbox: [],
		};
		this.agents.set(agentId, rec);
		this.broadcast();

		// Optional worktree isolation.
		let cwd = ctx.cwd;
		if (def.isolation === "worktree") {
			const { wt, reason } = await createWorktree(this.pi, ctx.cwd, nickname);
			if (wt) {
				rec.worktree = wt;
				cwd = wt.dir;
			} else {
				ctx.ui.notify?.(`agent ${nickname}: ${reason}; running in the main tree`, "warning");
			}
		}

		// Per-agent least privilege: explicit allowlist (never includes sub-agent tools),
		// plus the definition's denylist.
		const tools = def.tools.length ? def.tools : DEFAULT_AGENT_TOOLS;
		const excludeTools = def.disallowedTools;

		try {
			const { session } = await this.deps.createSession({
				cwd,
				model: def.model ?? ctx.model,
				tools,
				excludeTools,
				sessionManager: SessionManager.inMemory(cwd),
			});
			rec.session = session;
		} catch (err: any) {
			rec.status = { kind: "errored", error: err?.message ?? String(err) };
			this.broadcast();
			return { error: `failed to spawn ${def.name}: ${rec.status.kind === "errored" ? rec.status.error : ""}` };
		}

		const seed = `${def.prompt}\n\n# Task\n${task}`;
		void this.runTurn(rec, seed);
		return rec;
	}

	async close(agentId: string): Promise<{ closed?: any; error?: string; worktreeNote?: string }> {
		const rec = this.agents.get(agentId);
		if (!rec) return { error: `no such agent: ${agentId}` };
		const prior = this.serialize(rec);
		try { await rec.session?.abort?.(); } catch { /* ignore */ }
		rec.session?.dispose?.();
		let worktreeNote: string | undefined;
		if (rec.worktree) {
			const { removed, keptReason } = await rec.worktree.remove();
			if (!removed) worktreeNote = `${keptReason} at ${rec.worktree.dir}`;
		}
		this.agents.delete(agentId);
		this.broadcast();
		return { closed: prior, worktreeNote };
	}
}
