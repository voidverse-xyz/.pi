/** Idle mail coalescing and persisted-transcript acknowledgement, independent of Pi. */
export interface WakeDigest {
	digest: string;
	envelopeIds: string[];
	begin(): void;
	commit(): void;
}

export interface WakePumpPort {
	/** Reconcile previously persisted deliveries before taking a fresh snapshot. */
	takeDigest(): WakeDigest | null;
	/** Cheap pending check; must not compose or consume a snapshot. */
	hasMail(): boolean;
	isIdle(): boolean;
	/** Void acceptance is NOT acknowledgement. */
	inject(digest: string, envelopeIds: string[]): void;
	isPersisted(envelopeIds: string[]): boolean;
}

export interface WakeClock {
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(timer: unknown): void;
}

const clock: WakeClock = {
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface WakePump {
	onInput(): void;
	onBeforeAgentStart(): void;
	onSettled(): void;
	onMailArrived(): void;
	/** Call after message persistence, never from message_end itself. */
	onPersistence(): void;
	shutdown(): void;
	readonly hostIdle: boolean;
}

export function createWakePump(port: WakePumpPort, timers: WakeClock = clock): WakePump {
	let hostIdle = false;
	let stopped = false;
	let timer: unknown;
	let inFlight: WakeDigest | null = null;

	const cancelTimer = (): void => {
		if (timer !== undefined) timers.clearTimeout(timer);
		timer = undefined;
	};
	const acknowledge = (): boolean => {
		try {
			if (!inFlight || !port.isPersisted(inFlight.envelopeIds)) return false;
			inFlight.commit();
			inFlight = null;
			return true;
		} catch {
			return false; // failed inspection/commit is not an acknowledgement
		}
	};
	const schedule = (): void => {
		if (stopped || !hostIdle || inFlight || timer !== undefined) return;
		try {
			if (!port.hasMail()) return;
		} catch {
			return;
		}
		// First-event deadline: subsequent completions cannot postpone this wake.
		timer = timers.setTimeout(() => {
			timer = undefined;
			if (stopped || !hostIdle || inFlight) return;
			try {
				if (!port.isIdle()) return;
				// Snapshot at fire, not at the first event: all completions in the window join.
				const snapshot = port.takeDigest();
				if (!snapshot) return;
				inFlight = snapshot;
				hostIdle = false;
				snapshot.begin();
				port.inject(snapshot.digest, snapshot.envelopeIds);
				acknowledge();
			} catch {
				// A synchronous error may occur after persistence. Never duplicate that mail.
				acknowledge();
				inFlight = null;
				hostIdle = true; // the next attempt still rechecks the actual host state
				// Preserve pending mail; retry on the next lifecycle/mail event, not a hot loop.
			}
		}, 300);
	};
	const busy = (): void => {
		cancelTimer();
		hostIdle = false;
	};
	return {
		onInput: busy,
		onBeforeAgentStart: busy,
		onPersistence: () => {
			if (!stopped) acknowledge();
		},
		onSettled: () => {
			if (stopped) return;
			hostIdle = true;
			if (inFlight && !acknowledge()) {
				// The run failed/interrupted before append. Keep mail and wait for another event.
				inFlight = null;
				return;
			}
			schedule();
		},
		onMailArrived: schedule,
		shutdown: () => {
			stopped = true;
			cancelTimer();
		},
		get hostIdle() {
			return hostIdle;
		},
	};
}

/** Custom-message details are durable proof, unlike sendMessage's void return. */
export function persistedMailIds(entries: readonly unknown[], customType: string): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (raw === null || typeof raw !== "object") continue;
		const entry = raw as { type?: string; customType?: string; details?: { envelopeIds?: unknown } };
		if (entry.type !== "custom_message" || entry.customType !== customType) continue;
		const values = entry.details?.envelopeIds;
		if (!Array.isArray(values)) continue;
		for (const id of values) {
			if (typeof id === "string") ids.add(id);
		}
	}
	return ids;
}
