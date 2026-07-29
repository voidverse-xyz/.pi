/**
 * core.ts — the facade. tools/ and tui/ import ONLY this; they never import
 * runtime/in-process.ts, so the runtime stays a swap-point behind
 * runtime/types.ts.
 */

import type { CreateAgentSessionServicesOptions, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { composeWakeDigest, type DigestItem } from "./mail/digest.ts";
import { parseAddress, terminalTaskAnchors } from "./mail/envelope.ts";
import { markDone, pendingCount, readPending } from "./mail/mailbox.ts";
import { closeAllFor, closeOpenTask } from "./store/open-tasks.ts";
import type { ConfirmFn } from "./sandbox/safety-bridge.ts";
import { InProcessRuntime } from "./runtime/in-process.ts";
import type {
	AgentActivityRow,
	AgentDetail,
	AwaitOptions,
	AwaitResult,
	CancelResult,
	OpenTaskEntry,
	RetireResult,
	RosterEntry,
	RuntimeEventListener,
	SendOptions,
	SendResult,
	SpawnOptions,
	SpawnResult,
	SteerResult,
	SubagentRuntime,
} from "./runtime/types.ts";
import type { ArchivedInfo } from "./store/archive.ts";
import type { Layout } from "./store/layout.ts";
import { isWorking } from "./store/registry.ts";
import { listTypeDefs, resolveFromSource } from "./typedefs/discover.ts";

export interface AvailableType {
	name: string;
	source: "global" | "project" | "adhoc";
	description?: string;
	/** Foreign-key warnings from the tolerant parser (e.g. an ignored teams `peers:`). */
	warnings?: string[];
	/** Set when the type file failed to parse. */
	invalid?: string;
}

/** A retired agent visible in the picker's .archive section (= store/archive's ArchivedInfo). */
export type ArchivedAgentInfo = ArchivedInfo;

export interface SubagentsCore {
	/** Stable opaque fingerprint for the owning main Pi session scope. */
	readonly ownerScopeId: string;
	spawn(options: SpawnOptions): Promise<SpawnResult>;
	send(options: SendOptions): Promise<SendResult>;
	sendAsUser(options: SendOptions): Promise<SendResult>;
	/** Explicit in-run join for final reports (one, many, or all open tasks). */
	awaitResults(options: AwaitOptions): Promise<AwaitResult>;
	/** The open task anchors — subagent_await's default target set. */
	openTasks(): OpenTaskEntry[];
	status(): Promise<RosterEntry[]>;
	peek(address: string, tail?: number): Promise<AgentDetail | null>;
	steer(to: string, text: string): Promise<SteerResult>;
	cancel(to: string): Promise<CancelResult>;
	/** The human brake: cancel every working (running/queued/waiting) agent. */
	cancelAllWorking(): Promise<{ stopped: string[]; failed: string[] }>;
	retire(to: string): Promise<RetireResult>;
	/** The type catalog, for the spawn tool's not-found hint and the picker. */
	availableTypes(): AvailableType[];
	/** Unprocessed envelopes in the main agent's mailbox (widget 📬). */
	mainUnreadCount(): number;
	/**
	 * Compose a wake digest from the main mailbox WITHOUT consuming it, plus a
	 * `commit()` that marks the drained envelopes done and closes the open tasks
	 * completed by final reports / fatal errors. The caller commits only AFTER
	 * handing the wake to the SDK — which accepts synchronously (pi.sendMessage
	 * returns void), so a throwing injection can't lose main mail.
	 * Returns null when there is no pending main mail.
	 */
	takeMainMailDigest(): { digest: string; commit: () => void } | null;
	/** Unprocessed envelopes in a subagent's mailbox (picker badge). */
	agentUnreadCount(address: string): number;
	/** Retired agents still on disk in .archive. */
	archived(): ArchivedAgentInfo[];
	/** Live per-agent activity for the tree widget (current tool call + count). */
	activitySnapshot(): AgentActivityRow[];
	onEvent(listener: RuntimeEventListener): () => void;
	/** Await all in-flight subagent turns (host shutdown / tests). */
	whenIdle(): Promise<void>;
	dispose(): Promise<void>;
	/** The underlying runtime, for direct event subscription in the TUI. */
	readonly runtime: SubagentRuntime;
}

type ModelRuntime = NonNullable<CreateAgentSessionServicesOptions["modelRuntime"]>;

export interface CoreOptions {
	layout: Layout;
	maxConcurrent?: number;
	modelRuntime?: ModelRuntime;
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	projectTrusted?: () => boolean;
	/** Human confirmation for guarded tool calls; default fail-closed deny. */
	confirm?: ConfirmFn;
}

export function createCore(options: CoreOptions): SubagentsCore {
	const runtime = new InProcessRuntime({
		layout: options.layout,
		...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
		...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
		...(options.projectTrusted ? { projectTrusted: options.projectTrusted } : {}),
		...(options.confirm ? { confirm: options.confirm } : {}),
	});
	const projectTrusted = (): boolean => (options.projectTrusted ? options.projectTrusted() : true);
	const ownerScopeId = createHash("sha256").update(options.layout.ownerSessionId).digest("hex").slice(0, 24);

	return {
		runtime,
		ownerScopeId,
		spawn: (spawnOptions) => runtime.spawn(spawnOptions),
		send: (sendOptions) => runtime.send(sendOptions),
		sendAsUser: (sendOptions) => runtime.sendAsUser(sendOptions),
		awaitResults: (awaitOptions) => runtime.awaitResults(awaitOptions),
		openTasks: () => runtime.openTasks(),
		status: () => runtime.status(),
		peek: (address, tail) => runtime.peek(address, tail),
		steer: (to, text) => runtime.steer(to, text),
		cancel: (to) => runtime.cancel(to),
		async cancelAllWorking() {
			const working = (await runtime.status()).filter((entry) => isWorking(entry.state));
			const results = await Promise.allSettled(working.map((entry) => runtime.cancel(entry.address)));
			const stopped: string[] = [];
			const failed: string[] = [];
			working.forEach((entry, i) => (results[i]?.status === "fulfilled" ? stopped : failed).push(entry.address));
			return { stopped, failed };
		},
		retire: (to) => runtime.retire(to),
		onEvent: (listener) => runtime.onEvent(listener),
		mainUnreadCount: () => pendingCount(options.layout.mainMailboxDir),
		takeMainMailDigest(): { digest: string; commit: () => void } | null {
			const box = options.layout.mainMailboxDir;
			const pending = readPending(box);
			if (pending.length === 0) return null;
			const items: DigestItem[] = pending.map((p) => ({ envelope: p.envelope, redelivered: p.redelivered }));
			const digest = composeWakeDigest({ items });
			const commit = (): void => {
				for (const p of pending) {
					markDone(box, p.envelope.id);
					// A consumed final report/error closes only the exact task snapshot
					// persisted on that terminal envelope.
					const from = parseAddress(p.envelope.from);
					if (from?.kind !== "agent") continue;
					const terminal =
						(p.envelope.type === "report" && p.envelope.payload.final === true) || p.envelope.type === "error";
					if (!terminal) continue;
					const anchors = terminalTaskAnchors(p.envelope);
					if (anchors.kind === "anchors") {
						for (const anchorId of anchors.anchors) closeOpenTask(options.layout.openTasksFile, anchorId);
					} else {
						closeAllFor(options.layout.openTasksFile, p.envelope.from); // legacy unscoped error
					}
				}
			};
			return { digest, commit };
		},
		agentUnreadCount: (address) => {
			const to = parseAddress(address);
			return to?.kind === "agent" ? pendingCount(options.layout.mailboxDir(to.type, to.id)) : 0;
		},
		archived: () => runtime.archived(),
		activitySnapshot: () => runtime.activitySnapshot(),
		whenIdle: () => runtime.whenIdle(),
		dispose: () => runtime.dispose(),
		availableTypes(): AvailableType[] {
			return listTypeDefs(options.layout, { projectTrusted: projectTrusted() }).map((source) => {
				const resolved = resolveFromSource(source);
				if (resolved.ok) {
					return {
						name: source.name,
						source: source.origin,
						description: resolved.resolved.definition.config.description,
						...(resolved.resolved.warnings.length > 0 ? { warnings: resolved.resolved.warnings } : {}),
					};
				}
				return { name: source.name, source: source.origin, invalid: resolved.error };
			});
		},
	};
}
