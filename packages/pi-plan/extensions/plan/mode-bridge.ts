import { randomUUID } from "node:crypto";
import type { ModeLifecycle } from "./mode-lifecycle.ts";
import type { AgentMode } from "./policy.ts";

export const QUERY_MODE_EVENT = "pi-plan:query-mode";
export const MODE_CHANGED_EVENT = "pi-plan:mode-changed";

export interface ModeSnapshot {
	readonly version: 1;
	readonly instanceId: string;
	readonly revision: number;
	readonly contextRevision: number;
	readonly ready: boolean;
	readonly sessionId: string | null;
	readonly selectedMode: AgentMode;
	readonly enforcedMode: AgentMode;
	readonly runMode: AgentMode | null;
	readonly pendingChange: boolean;
}

/** In-memory observation only: the lifecycle remains the mode authority. */
export class ModeBridge {
	#lifecycle: ModeLifecycle;
	#emit: (snapshot: ModeSnapshot) => void;
	#snapshot: ModeSnapshot;

	constructor(
		lifecycle: ModeLifecycle,
		emit: (snapshot: ModeSnapshot) => void,
		instanceId: string = randomUUID(),
	) {
		this.#lifecycle = lifecycle;
		this.#emit = emit;
		this.#snapshot = Object.freeze({
			version: 1,
			instanceId,
			revision: 0,
			contextRevision: 0,
			ready: false,
			sessionId: null,
			...this.#modeFields(),
		});
	}

	#modeFields() {
		return {
			selectedMode: this.#lifecycle.selectedMode,
			enforcedMode: this.#lifecycle.enforcedMode,
			runMode: this.#lifecycle.runMode ?? null,
			pendingChange: this.#lifecycle.hasPendingChange,
		};
	}

	/** Respond inline; malformed/unsupported requests have no effect. */
	query(request: unknown): void {
		if (!request || typeof request !== "object") return;
		const { version, respond } = request as { version?: unknown; respond?: unknown };
		if (version !== 1 || typeof respond !== "function") return;
		respond(this.#snapshot);
	}

	publish(): void {
		this.#update({});
	}

	restored(sessionId: string): void {
		this.#update({
			ready: true,
			sessionId,
			contextRevision: this.#snapshot.contextRevision + 1,
		});
	}

	shutdown(): void {
		this.#update({
			ready: false,
			contextRevision: this.#snapshot.contextRevision + 1,
		});
	}

	#update(context: Partial<Pick<ModeSnapshot, "ready" | "sessionId" | "contextRevision">>): void {
		const previous = this.#snapshot;
		const next = { ...previous, ...context, ...this.#modeFields() };
		if (
			next.ready === previous.ready
			&& next.sessionId === previous.sessionId
			&& next.contextRevision === previous.contextRevision
			&& next.selectedMode === previous.selectedMode
			&& next.enforcedMode === previous.enforcedMode
			&& next.runMode === previous.runMode
			&& next.pendingChange === previous.pendingChange
		) return;
		this.#snapshot = Object.freeze({ ...next, revision: previous.revision + 1 });
		this.#emit(this.#snapshot);
	}
}
