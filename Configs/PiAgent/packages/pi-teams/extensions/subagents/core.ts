/**
 * core.ts — the facade (D23 structural rule 1). tools/ and tui/ import ONLY
 * this; they never import runtime/in-process.ts, so the runtime stays a
 * swap-point behind runtime/types.ts.
 *
 * Phase 2 surface: spawn/status/peek/steer/interrupt + type catalog + events.
 * Mail (send/collect/await), retire, and main-mailbox wiring grow the facade in
 * later phases.
 */

import type { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { pendingCount } from "./mail/mailbox.ts";
import { makeHopsGuard } from "./rails/hops.ts";
import type { ConfirmFn } from "./sandbox/safety-bridge.ts";
import { InProcessRuntime } from "./runtime/in-process.ts";
import type {
	AgentDetail,
	CollectResult,
	InterruptResult,
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
import { listTypeDefs, resolveTypeDef } from "./typedefs/discover.ts";

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
	status(): Promise<RosterEntry[]>;
	peek(address: string, tail?: number): Promise<AgentDetail | null>;
	steer(to: string, text: string): Promise<SteerResult>;
	interrupt(to: string): Promise<InterruptResult>;
	retire(to: string): Promise<RetireResult>;
	/** The type catalog, for the spawn tool's not-found hint and the picker. */
	availableTypes(): AvailableType[];
	/** Unprocessed envelopes in the main agent's mailbox (widget 📬). */
	mainUnreadCount(): number;
	/** Unprocessed envelopes in a subagent's mailbox (picker badge). */
	agentUnreadCount(address: string): number;
	/** Retired agents still on disk in .archive (D13). Empty until Phase 7. */
	archived(): ArchivedAgentInfo[];
	onEvent(listener: RuntimeEventListener): () => void;
	/** Await all in-flight subagent turns (host shutdown / tests). */
	whenIdle(): Promise<void>;
	dispose(): Promise<void>;
	/** The underlying runtime, for direct event subscription in the TUI. */
	readonly runtime: SubagentRuntime;
}

export interface CoreOptions {
	layout: Layout;
	maxConcurrent?: number;
	/** Chain-depth cap (D21). May be a live getter. Default DEFAULT_MAX_HOPS. */
	maxHops?: number | (() => number);
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	authStorage?: AuthStorage;
	projectTrusted?: () => boolean;
	/** Human confirmation for guarded tool calls (D10a); default fail-closed deny. */
	confirm?: ConfirmFn;
}

export function createCore(options: CoreOptions): SubagentsCore {
	const runtime = new InProcessRuntime({
		layout: options.layout,
		...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
		...(options.maxHops !== undefined ? { hopsGuard: makeHopsGuard(options.maxHops) } : {}),
		...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
		...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
		...(options.authStorage ? { authStorage: options.authStorage } : {}),
		...(options.projectTrusted ? { projectTrusted: options.projectTrusted } : {}),
		...(options.confirm ? { confirm: options.confirm } : {}),
	});
	const projectTrusted = (): boolean => (options.projectTrusted ? options.projectTrusted() : true);

	return {
		runtime,
		spawn: (spawnOptions) => runtime.spawn(spawnOptions),
		send: (sendOptions) => runtime.send(sendOptions),
		sendAsUser: (sendOptions) => runtime.sendAsUser(sendOptions),
		collect: (to, schema) => runtime.collect(to, schema),
		status: () => runtime.status(),
		peek: (address, tail) => runtime.peek(address, tail),
		steer: (to, text) => runtime.steer(to, text),
		interrupt: (to) => runtime.interrupt(to),
		retire: (to) => runtime.retire(to),
		onEvent: (listener) => runtime.onEvent(listener),
		mainUnreadCount: () => pendingCount(options.layout.mainMailboxDir),
		agentUnreadCount: (address) => {
			const parts = address.split("/");
			return parts.length === 2 ? pendingCount(options.layout.mailboxDir(parts[0]!, parts[1]!)) : 0;
		},
		archived: () => (runtime as InProcessRuntime).archived(),
		whenIdle: () => (runtime as InProcessRuntime).whenIdle(),
		dispose: () => runtime.dispose(),
		availableTypes(): AvailableType[] {
			return listTypeDefs(options.layout, { projectTrusted: projectTrusted() }).map((source) => {
				const resolved = resolveTypeDef(options.layout, source.name, { projectTrusted: projectTrusted() });
				if (resolved.ok) {
					return { name: source.name, source: source.origin, description: resolved.resolved.definition.config.description };
				}
				return { name: source.name, source: source.origin, invalid: resolved.error };
			});
		},
	};
}
