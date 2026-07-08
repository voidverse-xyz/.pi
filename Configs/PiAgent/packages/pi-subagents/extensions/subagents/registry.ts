/**
 * Live delegation registry — the in-process roster of currently-running
 * delegated children, shared between delegate.ts (writes) and switcher.ts
 * (reads: the `/agents` "Running tasks" cancel picker + the footer count).
 *
 * While the delegate tool call runs, the parent LLM is frozen — it cannot cancel
 * anything. The USER can: `/agents running` lists the in-flight children and
 * cancelling one kills just that child. delegate.ts marks the task's result
 * "cancelled by user" and, in parallel mode, the sibling tasks keep going.
 * (A background/detached mode with an LLM-callable cancel is a possible
 * follow-up; this registry is deliberately UI-facing only.)
 *
 * Everything here is same-process, module scope: delegate and switcher are both
 * registered from index.ts, so a plain Map + subscriber list is enough.
 */

export interface RunningDelegation {
	id: number;
	agent: string;
	/** First line of the task, for display. */
	task: string;
	startedAt: number;
	/** Live cumulative token count (input+output), read at render time. */
	tokens: () => number;
	/** Kill this child and mark its result cancelled-by-user. Idempotent. */
	cancel: () => void;
}

const running = new Map<number, RunningDelegation>();
const subscribers = new Set<() => void>();
let nextId = 1;

function notify(): void {
	for (const fn of subscribers) {
		try {
			fn();
		} catch {
			// A broken subscriber must never break delegation itself.
		}
	}
}

/** Register a starting child; returns its id. delegate.ts calls this on spawn. */
export function registerRunning(entry: Omit<RunningDelegation, "id">): number {
	const id = nextId++;
	running.set(id, { ...entry, id });
	notify();
	return id;
}

/** Remove a finished child (however it ended). Safe to call twice. */
export function unregisterRunning(id: number): void {
	if (running.delete(id)) notify();
}

export function listRunning(): RunningDelegation[] {
	return Array.from(running.values());
}

export function runningCount(): number {
	return running.size;
}

/** Subscribe to roster changes (for the footer status). Returns unsubscribe. */
export function onRunningChange(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}
