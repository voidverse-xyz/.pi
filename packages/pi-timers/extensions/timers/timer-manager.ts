export const MAX_TIMERS = 5;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INSTRUCTION_CHARS = 4_000;
export const MAX_LABEL_CHARS = 80;

export interface CreateTimerInput {
	instruction: string;
	intervalMs: number;
	maxRuns?: number;
	label?: string;
}

export interface TimerSnapshot {
	id: string;
	label: string;
	instruction: string;
	intervalMs: number;
	maxRuns?: number;
	runCount: number;
	remainingRuns?: number;
	pending: boolean;
	skippedTicks: number;
	wakeFailures: number;
	createdAt: number;
	nextRunAt: number;
}

export interface TimerWake {
	id: string;
	label: string;
	instruction: string;
	intervalMs: number;
	run: number;
	maxRuns?: number;
	finalRun: boolean;
	skippedTicks: number;
}

export interface TimerScheduler {
	now(): number;
	scheduleEvery(callback: () => void, intervalMs: number): unknown;
	clear(handle: unknown): void;
}

export interface TimerManagerPorts {
	onWake(wake: TimerWake): void;
	onWakeError?(error: unknown, timer: TimerSnapshot): void;
	onChange?(): void;
	scheduler?: TimerScheduler;
}

interface ActiveTimer {
	id: string;
	label: string;
	instruction: string;
	intervalMs: number;
	maxRuns?: number;
	runCount: number;
	pending: boolean;
	skippedTicks: number;
	wakeFailures: number;
	createdAt: number;
	nextRunAt: number;
	handle: unknown;
}

const SYSTEM_SCHEDULER: TimerScheduler = {
	now: () => Date.now(),
	scheduleEvery(callback, intervalMs) {
		const handle = setInterval(callback, intervalMs);
		handle.unref?.();
		return handle;
	},
	clear(handle) {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
};

export class TimerManager {
	private readonly ports: TimerManagerPorts;
	private readonly scheduler: TimerScheduler;
	private readonly timers = new Map<string, ActiveTimer>();
	private nextId = 1;
	private disposed = false;

	constructor(ports: TimerManagerPorts) {
		this.ports = ports;
		this.scheduler = ports.scheduler ?? SYSTEM_SCHEDULER;
	}

	create(input: CreateTimerInput): TimerSnapshot {
		if (this.disposed) throw new Error("Timer manager is shut down.");
		if (this.timers.size >= MAX_TIMERS) {
			throw new Error(`At most ${MAX_TIMERS} timers may be active at once.`);
		}

		const instruction = input.instruction.trim();
		if (!instruction) throw new Error("Timer instruction must not be empty.");
		if (instruction.length > MAX_INSTRUCTION_CHARS) {
			throw new Error(`Timer instruction must be at most ${MAX_INSTRUCTION_CHARS} characters.`);
		}
		if (!Number.isInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS || input.intervalMs > MAX_INTERVAL_MS) {
			throw new Error(
				`Timer interval must be a whole number between ${MIN_INTERVAL_MS / 1000} and ${MAX_INTERVAL_MS / 1000} seconds.`,
			);
		}
		if (input.maxRuns !== undefined && (!Number.isInteger(input.maxRuns) || input.maxRuns < 1)) {
			throw new Error("Timer maxRuns must be a whole number of at least 1 when provided.");
		}

		const id = `timer-${this.nextId++}`;
		const label = normalizeLabel(input.label, id);
		const createdAt = this.scheduler.now();
		const timer: ActiveTimer = {
			id,
			label,
			instruction,
			intervalMs: input.intervalMs,
			...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
			runCount: 0,
			pending: false,
			skippedTicks: 0,
			wakeFailures: 0,
			createdAt,
			nextRunAt: createdAt + input.intervalMs,
			handle: undefined,
		};
		timer.handle = this.scheduler.scheduleEvery(() => this.handleTick(id), input.intervalMs);
		this.timers.set(id, timer);
		this.ports.onChange?.();
		return snapshot(timer);
	}

	list(): TimerSnapshot[] {
		return [...this.timers.values()].map(snapshot);
	}

	cancel(id: string): TimerSnapshot | undefined {
		const timer = this.timers.get(id);
		if (!timer) return undefined;
		const previous = snapshot(timer);
		this.remove(timer);
		this.ports.onChange?.();
		return previous;
	}

	cancelAll(): TimerSnapshot[] {
		const cancelled = this.list();
		for (const timer of this.timers.values()) this.scheduler.clear(timer.handle);
		this.timers.clear();
		if (cancelled.length > 0) this.ports.onChange?.();
		return cancelled;
	}

	markAgentSettled(): void {
		let changed = false;
		for (const timer of this.timers.values()) {
			if (!timer.pending) continue;
			timer.pending = false;
			changed = true;
		}
		if (changed) this.ports.onChange?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelAll();
	}

	private handleTick(id: string): void {
		if (this.disposed) return;
		const timer = this.timers.get(id);
		if (!timer) return;
		timer.nextRunAt = this.scheduler.now() + timer.intervalMs;

		if (timer.pending) {
			timer.skippedTicks += 1;
			this.ports.onChange?.();
			return;
		}

		const run = timer.runCount + 1;
		const finalRun = timer.maxRuns !== undefined && run === timer.maxRuns;
		const wake: TimerWake = {
			id: timer.id,
			label: timer.label,
			instruction: timer.instruction,
			intervalMs: timer.intervalMs,
			run,
			...(timer.maxRuns !== undefined ? { maxRuns: timer.maxRuns } : {}),
			finalRun,
			skippedTicks: timer.skippedTicks,
		};

		// Commit the pending state before injection so a synchronously re-entrant
		// tick cannot queue the same timer twice. A successful return from onWake is
		// the acceptance boundary; Pi's sendMessage API is fire-and-forget.
		timer.pending = true;
		try {
			this.ports.onWake(wake);
		} catch (error) {
			timer.pending = false;
			timer.wakeFailures += 1;
			this.ports.onWakeError?.(error, snapshot(timer));
			this.ports.onChange?.();
			return;
		}

		timer.runCount = run;
		if (wake.finalRun) {
			this.remove(timer);
		}
		this.ports.onChange?.();
	}

	private remove(timer: ActiveTimer): void {
		this.scheduler.clear(timer.handle);
		this.timers.delete(timer.id);
	}
}

function normalizeLabel(value: string | undefined, fallback: string): string {
	if (value === undefined) return fallback;
	const label = value.replace(/\s+/g, " ").trim();
	if (!label) throw new Error("Timer label must not be empty when provided.");
	if (label.length > MAX_LABEL_CHARS) {
		throw new Error(`Timer label must be at most ${MAX_LABEL_CHARS} characters.`);
	}
	return label;
}

function snapshot(timer: ActiveTimer): TimerSnapshot {
	return {
		id: timer.id,
		label: timer.label,
		instruction: timer.instruction,
		intervalMs: timer.intervalMs,
		...(timer.maxRuns === undefined
			? {}
			: { maxRuns: timer.maxRuns, remainingRuns: timer.maxRuns - timer.runCount }),
		runCount: timer.runCount,
		pending: timer.pending,
		skippedTicks: timer.skippedTicks,
		wakeFailures: timer.wakeFailures,
		createdAt: timer.createdAt,
		nextRunAt: timer.nextRunAt,
	};
}
