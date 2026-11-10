import type { AgentMode } from "./policy.ts";

/**
 * Separates the user's selected mode from the immutable mode enforced for an
 * active agent run. A selection made while a run is active becomes pending and
 * takes effect after that run settles.
 */
export class ModeLifecycle {
	#selectedMode: AgentMode;
	#runModes: AgentMode[] = [];

	constructor(initialMode: AgentMode = "off") {
		this.#selectedMode = initialMode;
	}

	get selectedMode(): AgentMode {
		return this.#selectedMode;
	}

	get runMode(): AgentMode | undefined {
		return this.#runModes.at(-1);
	}

	get enforcedMode(): AgentMode {
		return this.runMode ?? this.#selectedMode;
	}

	get hasPendingChange(): boolean {
		return this.runMode !== undefined && this.runMode !== this.#selectedMode;
	}

	select(mode: AgentMode): boolean {
		if (this.#selectedMode === mode) return false;
		this.#selectedMode = mode;
		return true;
	}

	startRun(): AgentMode {
		this.#runModes.push(this.#selectedMode);
		return this.#selectedMode;
	}

	settleRun(): AgentMode | undefined {
		return this.#runModes.shift();
	}

	restore(mode: AgentMode): void {
		this.#selectedMode = mode;
		this.#runModes = [];
	}
}
