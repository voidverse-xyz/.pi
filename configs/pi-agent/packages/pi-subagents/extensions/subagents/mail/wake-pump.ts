/**
 * mail/wake-pump.ts — the main-mail auto-wake policy. PURE of Pi: no
 * ExtensionAPI, no fs, no SDK — just the state machine and an injected port.
 *
 * The rules it encodes:
 *   - Mail is delivered to the host ONLY while it is idle; mid-turn mail waits for
 *     the turn boundary (mail never interrupts a running turn).
 *   - Draining flips the host to non-idle BEFORE injecting, so the turn started by
 *     the injection cannot re-enter the pump for the same mail.
 *   - Mail is committed (consumed) only AFTER inject() returned — i.e. after the
 *     SDK accepted the message synchronously (pi.sendMessage returns void). If the
 *     SDK's internally-floated delivery later fails, the mail is already consumed:
 *     accepted-synchronously is the durability boundary, not appended-to-transcript.
 *   - After shutdown nothing is ever drained or injected, so pending mail survives
 *     for the next session (at-least-once).
 */

/** What the pump needs from the world. index.ts binds these to core + pi. */
export interface WakePumpPort {
	/**
	 * Compose a digest from pending main mail WITHOUT consuming it, plus a commit()
	 * that consumes it. Null when there is no pending mail.
	 */
	takeDigest(): { digest: string; commit: () => void } | null;
	/** Hand the digest to the host (starts a turn when idle). Must not throw. */
	inject(digest: string): void;
}

export interface WakePump {
	/** The user typed: the host is (about to be) busy. */
	onInput(): void;
	/** A host turn is starting: no longer idle. */
	onBeforeAgentStart(): void;
	/** The host settled: it is idle now — drain anything pending. */
	onSettled(): void;
	/** Mail may have arrived (a subagent reported/retired): drain if idle. */
	onMailArrived(): void;
	/** Session teardown: never drain or inject again. */
	shutdown(): void;
	/** Test/introspection: is the host currently considered idle? */
	readonly hostIdle: boolean;
}

export function createWakePump(port: WakePumpPort): WakePump {
	let hostIdle = false;
	let stopped = false;

	const pump = (): void => {
		if (!hostIdle || stopped) return;
		const drained = port.takeDigest();
		if (!drained) return;
		// Flip BEFORE injecting: the injected turn is not idle, and a re-entrant
		// pump() (via a nested settle/event during injection) must not drain again.
		hostIdle = false;
		port.inject(drained.digest);
		drained.commit();
	};

	return {
		onInput: () => {
			hostIdle = false;
		},
		onBeforeAgentStart: () => {
			hostIdle = false;
		},
		onSettled: () => {
			hostIdle = true;
			pump();
		},
		onMailArrived: pump,
		shutdown: () => {
			stopped = true;
		},
		get hostIdle() {
			return hostIdle;
		},
	};
}
