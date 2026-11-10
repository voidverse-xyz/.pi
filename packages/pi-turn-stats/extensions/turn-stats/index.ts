import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INPUT_ICON = "\uf062"; // nf-fa-arrow_up
const OUTPUT_ICON = "\uf063"; // nf-fa-arrow_down
const ELAPSED_ICON = "\uf017"; // nf-fa-clock_o

export interface TurnStatsState {
	startedAt: number;
	inputTokens: number;
	outputTokens: number;
}

export interface TurnStats {
	input: string;
	output: string;
	elapsed: string;
}

export interface TurnStatsTheme {
	fg(color: string, text: string): string;
}

/** Match Pi's compact footer token formatting. */
export function formatTokens(count: number): string {
	const safe = Math.max(0, Math.round(count));
	if (safe < 1_000) return String(safe);
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`;
	if (safe < 10_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${Math.round(safe / 1_000_000)}M`;
}

/** Format elapsed wall time as a compact human-readable duration. */
export function formatDuration(milliseconds: number): string {
	const safe = Math.max(0, milliseconds);
	if (safe > 0 && safe < 1_000) return "<1s";

	const totalSeconds = Math.floor(safe / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildTurnStats(turn: TurnStatsState, finishedAt: number): TurnStats {
	return {
		input: formatTokens(turn.inputTokens),
		output: formatTokens(turn.outputTokens),
		elapsed: formatDuration(finishedAt - turn.startedAt),
	};
}

/** Render understated telemetry with theme-owned hierarchy instead of fixed ANSI colors. */
export function renderTurnStats(stats: TurnStats, theme: TurnStatsTheme): string {
	const separator = theme.fg("dim", "·");
	const segments = [
		`${theme.fg("dim", INPUT_ICON)} ${theme.fg("muted", stats.input)}`,
		`${theme.fg("dim", OUTPUT_ICON)} ${theme.fg("muted", stats.output)}`,
		`${theme.fg("dim", ELAPSED_ICON)} ${theme.fg("muted", stats.elapsed)}`,
	];
	return segments.join(` ${separator} `);
}

export default function turnStats(pi: ExtensionAPI): void {
	let currentTurn: TurnStatsState | undefined;

	pi.on("agent_start", () => {
		// Retries and queued continuations remain in one accumulator because Pi
		// does not emit agent_settled until no automatic continuation remains.
		currentTurn ??= {
			startedAt: Date.now(),
			inputTokens: 0,
			outputTokens: 0,
		};
	});

	pi.on("agent_end", (event) => {
		if (!currentTurn) return;
		const messages = event.messages.filter((message): message is AssistantMessage => message.role === "assistant");
		for (const message of messages) {
			const usage = (message as AssistantMessage & { usage?: AssistantMessage["usage"] }).usage;
			// Match Pi's footer semantics: input excludes cache reads/writes, and
			// this compact notice intentionally shows only input and output.
			currentTurn.inputTokens += tokenCount(usage?.input);
			currentTurn.outputTokens += tokenCount(usage?.output);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!currentTurn || !ctx.isIdle()) return;

		const finishedTurn = currentTurn;
		currentTurn = undefined;
		if (ctx.mode !== "tui") return;

		const stats = buildTurnStats(finishedTurn, Date.now());
		ctx.ui.notify(renderTurnStats(stats, ctx.ui.theme), "info");
	});

	pi.on("session_shutdown", () => {
		currentTurn = undefined;
	});
}
