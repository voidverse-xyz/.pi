/**
 * core.ts — the facade (D23 structural rule 1). tools/ and tui/ import ONLY
 * this; they never import runtime/in-process.ts, so the runtime stays a
 * swap-point behind runtime/types.ts.
 *
 */

import type { CreateAgentSessionServicesOptions, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { collectResultNote, validateAgainstSchema } from "./mail/collect.ts";
import { composeWakeDigest, type DigestItem } from "./mail/digest.ts";
import { parseAddress } from "./mail/envelope.ts";
import { markDone, peekCollectRequest, pendingCount, readPending, takeCollectRequest } from "./mail/mailbox.ts";
import { makeHopsGuard } from "./rails/hops.ts";
import type { ConfirmFn } from "./sandbox/safety-bridge.ts";
import { InProcessRuntime } from "./runtime/in-process.ts";
import type {
	AgentActivityRow,
	AgentDetail,
	AwaitOptions,
	AwaitResult,
	CollectResult,
	InterruptResult,
	PeerMode,
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
import type { Layout } from "./store/layout.ts";
import { isWorking } from "./store/registry.ts";
import { listTypeDefs, resolveFromSource } from "./typedefs/discover.ts";

export interface AvailableType {
	name: string;
	source: "global" | "project";
	description?: string;
	/** Set when the type file failed to parse. */
	invalid?: string;
}

/** A retired agent visible in the picker's .archive section (D13). */
export interface ArchivedAgentInfo {
	address: string;
	/** ISO retirement time, if recorded. */
	retiredAt?: string;
}

export interface SubagentsCore {
	spawn(options: SpawnOptions): Promise<SpawnResult>;
	send(options: SendOptions): Promise<SendResult>;
	sendAsUser(options: SendOptions): Promise<SendResult>;
	collect(to: string, schema: unknown): Promise<CollectResult>;
	/** Explicit in-run join for a final/collect result (D27'). */
	awaitResult(options: AwaitOptions): Promise<AwaitResult>;
	status(): Promise<RosterEntry[]>;
	peek(address: string, tail?: number): Promise<AgentDetail | null>;
	steer(to: string, text: string): Promise<SteerResult>;
	interrupt(to: string): Promise<InterruptResult>;
	/** The human brake (D22): interrupt every working (running/queued/waiting) agent. */
	interruptAllWorking(): Promise<{ stopped: string[]; failed: string[] }>;
	retire(to: string): Promise<RetireResult>;
	/** The type catalog, for the spawn tool's not-found hint and the picker. */
	availableTypes(): AvailableType[];
	/** Unprocessed envelopes in the main agent's mailbox (wake pump + tests). */
	mainUnreadCount(): number;
	/**
	 * Compose a wake digest from the main mailbox WITHOUT consuming it, plus a
	 * `commit()` that marks the drained envelopes done and clears fulfilled collect
	 * requests. The caller commits only AFTER handing the wake to the SDK — which
	 * accepts synchronously (pi.sendMessage returns void), so a throwing injection
	 * can't lose main mail; a later async delivery failure inside the SDK can.
	 * Collect results are validated against their request schema (findings #9/#10).
	 * Returns null when there is no pending main mail.
	 */
	takeMainMailDigest(): { digest: string; commit: () => void } | null;
	/** Unprocessed envelopes in a subagent's mailbox (picker badge). */
	agentUnreadCount(address: string): number;
	/** Retired agents still on disk in .archive (D13). */
	archived(): ArchivedAgentInfo[];
	/** Live per-agent activity, usage, and queued mail for the tree widget. */
	activitySnapshot(): AgentActivityRow[];
	/** User-level peer-messaging control (D12): "on"/"off" force it, "llm" delegates to main. */
	setUserPeerMode(mode: PeerMode): void;
	/** Main-agent peer override (D12), honored only while the user delegates. null = per-type default. */
	setMainPeerOverride(value: boolean | null): void;
	/** Current peer-control state. */
	peerState(): { userMode: PeerMode; mainOverride: boolean | null; userControls: boolean };
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
	/** Chain-depth cap (D21). May be a live getter. Default DEFAULT_MAX_HOPS. */
	maxHops?: number | (() => number);
	modelRuntime?: ModelRuntime;
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	projectTrusted?: () => boolean;
	/** Human confirmation for guarded tool calls (D10a); default fail-closed deny. */
	confirm?: ConfirmFn;
	/** Initial user-level peer-messaging control (D12). Default "llm". */
	peersMode?: PeerMode;
}

export function createCore(options: CoreOptions): SubagentsCore {
	const runtime = new InProcessRuntime({
		layout: options.layout,
		...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
		...(options.maxHops !== undefined ? { hopsGuard: makeHopsGuard(options.maxHops) } : {}),
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
		...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
		...(options.projectTrusted ? { projectTrusted: options.projectTrusted } : {}),
		...(options.confirm ? { confirm: options.confirm } : {}),
		...(options.peersMode ? { peersMode: options.peersMode } : {}),
	});
	const projectTrusted = (): boolean => (options.projectTrusted ? options.projectTrusted() : true);

	return {
		runtime,
		spawn: (spawnOptions) => runtime.spawn(spawnOptions),
		send: (sendOptions) => runtime.send(sendOptions),
		sendAsUser: (sendOptions) => runtime.sendAsUser(sendOptions),
		collect: (to, schema) => runtime.collect(to, schema),
		awaitResult: (awaitOptions) => runtime.awaitResult(awaitOptions),
		status: () => runtime.status(),
		peek: (address, tail) => runtime.peek(address, tail),
		steer: (to, text) => runtime.steer(to, text),
		interrupt: (to) => runtime.interrupt(to),
		async interruptAllWorking() {
			const working = (await runtime.status()).filter((entry) => isWorking(entry.state));
			const results = await Promise.allSettled(working.map((entry) => runtime.interrupt(entry.address)));
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
			const collectToClear: string[] = [];
			const items: DigestItem[] = pending.map((p) => {
				const item: DigestItem = { envelope: p.envelope, redelivered: p.redelivered };
				if (p.envelope.type === "report" && p.envelope.correlationId) {
					// Peek (non-destructive) — the request is cleared only on commit.
					const schema = peekCollectRequest(box, p.envelope.correlationId, p.envelope.from);
					if (schema !== undefined) {
						item.note = collectResultNote(validateAgainstSchema(p.envelope.payload.data, schema));
						collectToClear.push(p.envelope.correlationId);
					}
				}
				return item;
			});
			const digest = composeWakeDigest({ items, questionLookup: () => undefined });
			const commit = (): void => {
				for (const correlationId of collectToClear) takeCollectRequest(box, correlationId);
				for (const p of pending) markDone(box, p.envelope.id);
			};
			return { digest, commit };
		},
		agentUnreadCount: (address) => {
			const to = parseAddress(address);
			return to?.kind === "agent" ? pendingCount(options.layout.mailboxDir(to.type, to.id)) : 0;
		},
		archived: () => runtime.archived(),
		activitySnapshot: () => runtime.activitySnapshot(),
		setUserPeerMode: (mode) => runtime.setUserPeerMode(mode),
		setMainPeerOverride: (value) => runtime.setMainPeerOverride(value),
		peerState: () => runtime.peerState(),
		whenIdle: () => runtime.whenIdle(),
		dispose: () => runtime.dispose(),
		availableTypes(): AvailableType[] {
			return listTypeDefs(options.layout, { projectTrusted: projectTrusted() }).map((source) => {
				const resolved = resolveFromSource(source);
				if (resolved.ok) {
					return { name: source.name, source: source.origin, description: resolved.resolved.definition.config.description };
				}
				return { name: source.name, source: source.origin, invalid: resolved.error };
			});
		},
	};
}
