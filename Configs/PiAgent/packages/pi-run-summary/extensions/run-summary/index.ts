import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_SUMMARY_CHARS = 140;
const GENERIC_HEADING = /^(?:summary|result|results|done|completed|completion|changes|what changed|implementation|outcome|status)[:.]?$/i;

interface RunState {
	startedAt: number;
	inputTokens: number;
	outputTokens: number;
	finalText?: string;
	stopReason?: StopReason;
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

function truncateSummary(value: string, maxCharacters: number): string {
	const characters = Array.from(value);
	if (characters.length <= maxCharacters) return value;
	const clipped = characters.slice(0, Math.max(1, maxCharacters - 1)).join("").trimEnd().replace(/[,:;\-]+$/u, "");
	return `${clipped}…`;
}

function cleanMarkdownLine(raw: string): string {
	return raw
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)+/u, "")
		.replace(/^\s*\[[ xX]\]\s+/u, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/[*_~`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Derive a one-line outcome locally from the first meaningful final-response sentence. */
export function summarizeFinalResponse(text: string, maxCharacters = MAX_SUMMARY_CHARS): string | undefined {
	let insideFence = false;
	for (const rawLine of text.split(/\r?\n/)) {
		if (/^\s*(?:```|~~~)/u.test(rawLine)) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence) continue;

		const line = cleanMarkdownLine(rawLine);
		if (!line || GENERIC_HEADING.test(line)) continue;
		if (line.endsWith(":") && line.split(/\s+/).length <= 4) continue;

		const sentence = line.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] ?? line;
		return truncateSummary(sentence, Math.max(16, maxCharacters));
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function fallbackSummary(stopReason: StopReason | undefined): string {
	switch (stopReason) {
		case "aborted": return "The agent run was stopped.";
		case "error": return "The agent stopped with an error.";
		case "length": return "The response reached its token limit.";
		default: return "Completed the run.";
	}
}

export function buildCompletionNotice(run: RunState, finishedAt: number): string {
	const duration = formatDuration(finishedAt - run.startedAt);
	const summary = summarizeFinalResponse(run.finalText ?? "") ?? fallbackSummary(run.stopReason);
	return `Done in ${duration} · ↑${formatTokens(run.inputTokens)} · ↓${formatTokens(run.outputTokens)} — ${summary}`;
}

export default function runSummary(pi: ExtensionAPI): void {
	let currentRun: RunState | undefined;
	let pendingToast: ReturnType<typeof setTimeout> | undefined;

	const cancelPendingToast = (): void => {
		if (pendingToast) clearTimeout(pendingToast);
		pendingToast = undefined;
	};

	pi.on("agent_start", () => {
		cancelPendingToast();
		// A retry, queued continuation, or extension-triggered wake can start before
		// the overall activity settles. Keep one state object for that whole span.
		currentRun ??= {
			startedAt: Date.now(),
			inputTokens: 0,
			outputTokens: 0,
		};
	});

	pi.on("agent_end", (event) => {
		if (!currentRun) return;
		const messages = event.messages.filter((message): message is AssistantMessage => message.role === "assistant");
		for (const message of messages) {
			const usage = (message as AssistantMessage & { usage?: AssistantMessage["usage"] }).usage;
			// Match Pi's footer semantics: ↑ is uncached input; cache reads/writes are
			// deliberately omitted because this extension's selected format is ↑/↓.
			currentRun.inputTokens += tokenCount(usage?.input);
			currentRun.outputTokens += tokenCount(usage?.output);
		}

		const finalMessage = messages.at(-1);
		if (finalMessage) {
			// agent_end observes the messages after the full message_end middleware
			// chain. Clear stale prose when the latest response has no text.
			currentRun.finalText = assistantText(finalMessage).trim() || undefined;
			currentRun.stopReason = finalMessage.stopReason;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		cancelPendingToast();
		if (!currentRun || !ctx.isIdle()) return;

		const candidate = currentRun;
		// Yield until every agent_settled handler and its immediate microtasks have
		// run. A subsequent agent_start cancels this finalization, preventing a
		// toast between an immediate extension-triggered wake and its agent run.
		pendingToast = setTimeout(() => {
			pendingToast = undefined;
			if (currentRun !== candidate || !ctx.isIdle()) return;
			currentRun = undefined;
			if (ctx.mode !== "tui") return;

			// Pi renders info notifications with theme.fg("dim"), which gives the
			// requested muted treatment without patching private TUI internals.
			ctx.ui.notify(buildCompletionNotice(candidate, Date.now()), "info");
		}, 0);
		pendingToast.unref?.();
	});

	pi.on("session_shutdown", () => {
		cancelPendingToast();
		currentRun = undefined;
	});
}
