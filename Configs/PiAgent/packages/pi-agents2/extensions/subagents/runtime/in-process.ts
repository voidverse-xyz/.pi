/**
 * runtime/in-process.ts — the in-process SubagentRuntime (D7).
 *
 * Each live agent is a real `AgentSession` built with `createAgentSession`,
 * resuming/creating a Pi-native JSONL under the instance dir (D3). Mutual
 * exclusion is the host-scope lease (D7) — there are NO per-agent run-owner
 * locks. Turns are gated by the concurrency scheduler (D13).
 *
 * Phase 2 surface: spawn (get-or-create + optional first task turn), status,
 * peek, steer, interrupt, dispose. Mail delivery (wake digests) and lifecycle
 * (retire/archive) arrive in later phases; here a spawn `task` is prompted
 * directly as the agent's first turn.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	type AuthStorage,
	createAgentSession,
	type CreateAgentSessionOptions,
	DefaultResourceLoader,
	type ModelRegistry,
	parseSessionEntries,
	resolveCliModel,
	type SessionMessageEntry,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { composeContext, type IdentityOptions, type PeerInfo } from "../context/compose.ts";
import { formatAgentAddress, isValidIdSegment } from "../mail/envelope.ts";
import {
	type AgentRecord,
	type AgentState,
	type AgentVitals,
	getAgent,
	listAgents,
	patchAgent,
	type Registry,
	readRegistry,
	upsertAgent,
	writeRegistry,
} from "../store/registry.ts";
import type { Layout } from "../store/layout.ts";
import { resolveTypeDef } from "../typedefs/discover.ts";
import type { TypeDefinition } from "../typedefs/parse.ts";
import type {
	AgentDetail,
	InheritedDefaults,
	InterruptResult,
	RosterEntry,
	RuntimeEvent,
	RuntimeEventListener,
	SpawnOptions,
	SpawnResult,
	SteerResult,
	SubagentRuntime,
	TranscriptEntry,
} from "./types.ts";
import { Scheduler } from "./scheduler.ts";

const TMP_ID_BYTES = 4;

export interface RuntimeOptions {
	layout: Layout;
	maxConcurrent?: number;
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	authStorage?: AuthStorage;
	/** Whether project-local type defs are trusted (Pi project-trust; D6/finding #7). */
	projectTrusted?: () => boolean;
}

interface Handle {
	session: AgentSession;
	generationId: string;
	abortedBy: "interrupt" | null;
}

/** Live vitals from an AgentSession (D15). SessionStats recomputes whole-life on resume. */
function vitalsFrom(session: AgentSession, state: AgentState): AgentVitals {
	const stats = session.getSessionStats();
	return {
		state,
		ctxPercent: stats.contextUsage?.percent ?? null,
		tokens: stats.tokens.total,
		cost: stats.cost,
		turns: stats.assistantMessages,
	};
}

export class InProcessRuntime implements SubagentRuntime {
	private readonly layout: Layout;
	private readonly scheduler: Scheduler;
	private registry: Registry;
	private handles = new Map<string, Handle>();
	private buildLocks = new Map<string, Promise<Handle>>();
	private listeners = new Set<RuntimeEventListener>();
	private activeTurns = new Set<Promise<void>>();
	private disposed = false;

	constructor(private readonly options: RuntimeOptions) {
		this.layout = options.layout;
		this.scheduler = new Scheduler(options.maxConcurrent);
		this.registry = readRegistry(this.layout.registryFile);
	}

	// ----------------------------------------------------------------- spawn
	async spawn(options: SpawnOptions): Promise<SpawnResult> {
		if (this.disposed) throw new Error("runtime disposed");
		const type = options.type;
		const lifetime = options.lifetime ?? "persistent";

		if (lifetime === "oneshot" && options.id !== undefined) {
			throw new Error("oneshot spawns must not pass an id (named = persistent, anonymous = disposable).");
		}
		let id = options.id ?? (lifetime === "oneshot" ? this.freshTmpId() : "main");
		if (!isValidIdSegment(id)) throw new Error(`Invalid instance id ${JSON.stringify(id)}.`);

		const resolved = resolveTypeDef(this.layout, type, { projectTrusted: this.projectTrusted() });
		if (!resolved.ok) throw new Error(resolved.error);
		const def = resolved.resolved.definition;

		const address = formatAgentAddress(type, id);
		const now = new Date().toISOString();
		const { record, created } = upsertAgent(this.registry, {
			type,
			id,
			lifetime,
			typeFileHash: resolved.resolved.hash,
			now,
		});
		this.persist();

		if (options.task !== undefined) {
			const turn = this.scheduleTurn(address, record, def, options.task, options.inherit);
			void turn; // background-by-default (D27'); await via subagent_await (Phase 7)
		}

		return {
			address,
			created,
			state: record.vitals.state,
			vitals: record.vitals,
		};
	}

	// ----------------------------------------------------------------- status / peek
	async status(): Promise<RosterEntry[]> {
		return listAgents(this.registry).map((record) => this.rosterEntry(record));
	}

	async peek(address: string, tail = 20): Promise<AgentDetail | null> {
		const record = getAgent(this.registry, address);
		if (!record) return null;
		const sessionFile = this.latestSessionFile(record.type, record.id) ?? null;
		return {
			...this.rosterEntry(record),
			typeFileHash: record.typeFileHash,
			createdAt: record.createdAt,
			sessionFile,
			tail: sessionFile ? readTranscriptTail(sessionFile, tail) : [],
		};
	}

	// ----------------------------------------------------------------- steer / interrupt
	async steer(to: string, text: string): Promise<SteerResult> {
		const handle = this.handles.get(to);
		if (!handle || !handle.session.isStreaming) return { steered: false };
		await handle.session.steer(text);
		return { steered: true };
	}

	async interrupt(to: string): Promise<InterruptResult> {
		const handle = this.handles.get(to);
		if (!handle || !handle.session.isStreaming) return { interrupted: false };
		handle.abortedBy = "interrupt";
		await handle.session.abort();
		return { interrupted: true };
	}

	// ----------------------------------------------------------------- events / dispose
	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Test/host helper: await all in-flight turns (not part of the interface). */
	async whenIdle(): Promise<void> {
		while (this.activeTurns.size > 0) {
			await Promise.allSettled([...this.activeTurns]);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const aborts: Promise<void>[] = [];
		for (const handle of this.handles.values()) {
			if (handle.session.isStreaming) aborts.push(handle.session.abort().catch(() => {}));
		}
		await Promise.allSettled(aborts);
		await this.whenIdle();
		this.handles.clear();
	}

	// ----------------------------------------------------------------- internals
	private projectTrusted(): boolean {
		return this.options.projectTrusted ? this.options.projectTrusted() : true;
	}

	private freshTmpId(): string {
		for (;;) {
			const id = `tmp-${randomHex(TMP_ID_BYTES)}`;
			if (!getAgent(this.registry, formatAgentAddress("_", id)) && !existsSync(this.layout.agentInstanceDir("_", id))) {
				// uniqueness is per-type; a collision across types is harmless, but keep it simple
				return id;
			}
		}
	}

	private persist(): void {
		writeRegistry(this.layout.registryFile, this.registry);
	}

	private emit(event: RuntimeEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private setState(address: string, state: AgentState): void {
		patchAgent(this.registry, address, { vitals: { state } });
		this.persist();
		this.emit({ type: "state-changed", address, state });
	}

	private rosterEntry(record: AgentRecord): RosterEntry {
		return {
			address: formatAgentAddress(record.type, record.id),
			type: record.type,
			id: record.id,
			state: record.vitals.state,
			lifetime: record.lifetime,
			purview: record.id,
			vitals: record.vitals,
			unread: 0,
			updatedAt: record.lastActiveAt,
		};
	}

	private identityFor(address: string, record: AgentRecord): IdentityOptions {
		const peers: PeerInfo[] = listAgents(this.registry)
			.filter((other) => formatAgentAddress(other.type, other.id) !== address)
			.map((other) => ({ address: formatAgentAddress(other.type, other.id), purview: other.id }));
		return { address, purview: record.id, peers };
	}

	private latestSessionFile(type: string, id: string): string | undefined {
		const dir = this.layout.agentInstanceDir(type, id);
		if (!existsSync(dir)) return undefined;
		const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
		const last = files[files.length - 1];
		return last ? join(dir, last) : undefined;
	}

	/** Schedule and run one turn; tracked so whenIdle()/dispose() can await it. */
	private scheduleTurn(
		address: string,
		record: AgentRecord,
		def: TypeDefinition,
		promptText: string,
		inherit?: InheritedDefaults,
	): Promise<void> {
		const turn = this.runTurn(address, record, def, promptText, inherit).finally(() => {
			this.activeTurns.delete(turn);
		});
		this.activeTurns.add(turn);
		return turn;
	}

	private async runTurn(
		address: string,
		record: AgentRecord,
		def: TypeDefinition,
		promptText: string,
		inherit?: InheritedDefaults,
	): Promise<void> {
		this.setState(address, "queued");
		const release = await this.scheduler.acquire();
		try {
			if (this.disposed) return;
			const handle = await this.ensureHandle(address, record, def, inherit);
			handle.abortedBy = null;
			this.setState(address, "running");
			this.emit({ type: "turn-started", address });

			let failure: { stopReason: string; message: string } | null = null;
			const unsubscribe = handle.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				for (const message of event.messages) {
					const m = message as { role?: string; stopReason?: string; errorMessage?: string };
					if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
						failure = { stopReason: m.stopReason, message: m.errorMessage ?? "(no error message)" };
					}
				}
			});
			try {
				await handle.session.prompt(promptText);
				await handle.session.waitForIdle();
			} finally {
				unsubscribe();
			}

			const vitals = vitalsFrom(handle.session, "dormant");
			patchAgent(this.registry, address, { vitals, lastActiveAt: new Date().toISOString() });
			this.persist();

			if (failure && (failure as { stopReason: string }).stopReason === "error") {
				this.emit({ type: "turn-error", address, error: (failure as { message: string }).message });
			}
			this.emit({ type: "state-changed", address, state: "dormant" });
			this.emit({ type: "turn-finished", address, vitals });
		} finally {
			release();
		}
	}

	/** Build (or reuse) the AgentSession for an address, with a per-address build lock. */
	private async ensureHandle(
		address: string,
		record: AgentRecord,
		def: TypeDefinition,
		inherit?: InheritedDefaults,
	): Promise<Handle> {
		const existing = this.handles.get(address);
		if (existing) return existing;
		const pending = this.buildLocks.get(address);
		if (pending) return pending;

		const build = this.buildHandle(address, record, def, inherit)
			.then((handle) => {
				this.handles.set(address, handle);
				return handle;
			})
			.finally(() => this.buildLocks.delete(address));
		this.buildLocks.set(address, build);
		return build;
	}

	private async buildHandle(
		address: string,
		record: AgentRecord,
		def: TypeDefinition,
		inherit?: InheritedDefaults,
	): Promise<Handle> {
		const layout = this.layout;
		const instanceDir = layout.agentInstanceDir(record.type, record.id);
		mkdirSync(instanceDir, { recursive: true });

		const latest = this.latestSessionFile(record.type, record.id);
		const sessionManager = latest
			? SessionManager.open(latest, instanceDir, layout.cwd)
			: SessionManager.create(layout.cwd, instanceDir);

		// Layers 3+4 via appendSystemPrompt; layer 2 (project context) is Pi's own
		// (native ordering, D18') — enabled by NOT setting noContextFiles when the
		// type opts in.
		const composed = composeContext(def, this.identityFor(address, record));
		const loader = new DefaultResourceLoader({
			cwd: layout.cwd,
			agentDir: layout.agentDir,
			...(this.options.settingsManager ? { settingsManager: this.options.settingsManager } : {}),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: !def.config.projectContext,
			appendSystemPrompt: composed.appendSystemPrompt,
		});
		await loader.reload();

		const sessionOptions: CreateAgentSessionOptions = {
			cwd: layout.cwd,
			agentDir: layout.agentDir,
			sessionManager,
			resourceLoader: loader,
			...(this.options.modelRegistry ? { modelRegistry: this.options.modelRegistry } : {}),
			...(this.options.settingsManager ? { settingsManager: this.options.settingsManager } : {}),
			...(this.options.authStorage ? { authStorage: this.options.authStorage } : {}),
			noTools: "builtin",
			customTools: [],
		};

		const model = this.resolveModel(def, inherit);
		if (model) sessionOptions.model = model;
		const thinkingLevel = def.config.thinking ?? inherit?.thinkingLevel;
		if (thinkingLevel !== undefined) sessionOptions.thinkingLevel = thinkingLevel;

		const { session } = await createAgentSession(sessionOptions);
		return { session, generationId: record.generationId, abortedBy: null };
	}

	private resolveModel(def: TypeDefinition, inherit?: InheritedDefaults): CreateAgentSessionOptions["model"] | undefined {
		const registry = this.options.modelRegistry;
		if (!registry) return undefined;
		const ref = def.config.model ?? inherit?.modelRef;
		if (ref === undefined) return undefined;
		const resolved = resolveCliModel({ cliModel: ref, modelRegistry: registry });
		if (!resolved.model) {
			if (def.config.model !== undefined) throw new Error(resolved.error ?? `Type "${def.config.name}": unknown model "${ref}".`);
			return undefined; // inherited ref that no longer resolves — fall back to SDK default
		}
		return resolved.model;
	}
}

function randomHex(bytes: number): string {
	let out = "";
	for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
	return out;
}

/** Read the last `n` message entries of a Pi-native JSONL as flattened transcript lines. */
function readTranscriptTail(sessionFile: string, n: number): TranscriptEntry[] {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const messages = parseSessionEntries(content).filter(
		(entry): entry is SessionMessageEntry => "type" in entry && entry.type === "message",
	);
	return messages.slice(-n).map((entry) => ({
		role: entry.message.role,
		text: flattenMessageText(entry.message),
		timestamp: typeof (entry as { timestamp?: unknown }).timestamp === "string" ? (entry as { timestamp: string }).timestamp : "",
	}));
}

function flattenMessageText(message: SessionMessageEntry["message"]): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				if (p.type === "text" && typeof p.text === "string") return p.text;
				return p.type ? `[${p.type}]` : "";
			})
			.filter(Boolean)
			.join(" ");
	}
	return "";
}
