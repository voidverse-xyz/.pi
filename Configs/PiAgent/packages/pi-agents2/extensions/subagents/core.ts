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
import { InProcessRuntime } from "./runtime/in-process.ts";
import type {
	AgentDetail,
	CollectResult,
	InterruptResult,
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

export interface SubagentsCore {
	spawn(options: SpawnOptions): Promise<SpawnResult>;
	send(options: SendOptions): Promise<SendResult>;
	sendAsUser(options: SendOptions): Promise<SendResult>;
	collect(to: string, schema: unknown): Promise<CollectResult>;
	status(): Promise<RosterEntry[]>;
	peek(address: string, tail?: number): Promise<AgentDetail | null>;
	steer(to: string, text: string): Promise<SteerResult>;
	interrupt(to: string): Promise<InterruptResult>;
	/** The type catalog, for the spawn tool's not-found hint and the picker. */
	availableTypes(): AvailableType[];
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
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	authStorage?: AuthStorage;
	projectTrusted?: () => boolean;
}

export function createCore(options: CoreOptions): SubagentsCore {
	const runtime = new InProcessRuntime({
		layout: options.layout,
		...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
		...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
		...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
		...(options.authStorage ? { authStorage: options.authStorage } : {}),
		...(options.projectTrusted ? { projectTrusted: options.projectTrusted } : {}),
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
		onEvent: (listener) => runtime.onEvent(listener),
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
