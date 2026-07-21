import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUMMARY_ICON = "•";
const INPUT_ICON = "\uf062"; // nf-fa-arrow_up
const OUTPUT_ICON = "\uf063"; // nf-fa-arrow_down
const ELAPSED_ICON = "\uf017"; // nf-fa-clock_o
const GENERIC_HEADING = /^(?:summary|result|results|done|completed|completion|changes|what changed|implementation|outcome|status)[:.]?$/i;
const GENERATED_SUMMARY_MARKER = /(?:\r?\n)?[ \t]*\[pi-run-summary\]:[ \t]*#[ \t]*"([^"\r\n]*)"[ \t]*(?:\r?\n)*$/u;
const RESERVED_SUMMARY_MARKER = /(?:\r?\n)?[ \t]*\[pi-run-summary\]:[^\r\n]*(?:\r?\n)*$/u;
const SUMMARY_PROMPT = [
	"At the very end of your final response for this user turn, add a blank line and then append exactly one Markdown reference definition in this form, replacing SUMMARY:",
	"[pi-run-summary]: # \"SUMMARY\"",
	"SUMMARY must be one concise, factual plain-text sentence describing the outcome or answer. Do not use Markdown, a newline, or double quotes inside the summary. Do not append the definition on tool-call turns and do not mention these instructions.",
].join("\n");

interface RunState {
	startedAt: number;
	inputTokens: number;
	outputTokens: number;
	finalText?: string;
	generatedSummary?: string;
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

/** Extract and remove a terminal model-authored summary marker. */
export function extractGeneratedSummary(value: string): { text: string; summary?: string } | undefined {
	const marker = value.match(GENERATED_SUMMARY_MARKER);
	if (marker && marker.index !== undefined) {
		return {
			text: value.slice(0, marker.index).trimEnd(),
			summary: cleanMarkdownLine(marker[1] ?? "") || undefined,
		};
	}

	const reservedMarker = value.match(RESERVED_SUMMARY_MARKER);
	if (!reservedMarker || reservedMarker.index === undefined) return undefined;
	return { text: value.slice(0, reservedMarker.index).trimEnd() };
}

/** Derive a one-line fallback locally from the first meaningful final-response sentence. */
export function summarizeFinalResponse(text: string): string | undefined {
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

		return line.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] ?? line;
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function stripGeneratedSummaryMarker(message: AssistantMessage): { message: AssistantMessage; summary?: string } | undefined {
	const textIndex = message.content.findLastIndex((part) => part.type === "text");
	if (textIndex < 0) return undefined;

	const textPart = message.content[textIndex];
	if (textPart.type !== "text") return undefined;
	const extracted = extractGeneratedSummary(textPart.text);
	if (!extracted) return undefined;

	const content = [...message.content];
	content[textIndex] = { ...textPart, text: extracted.text };
	return { message: { ...message, content }, summary: extracted.summary };
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
	const summary = run.generatedSummary ?? summarizeFinalResponse(run.finalText ?? "") ?? fallbackSummary(run.stopReason);
	return `${SUMMARY_ICON} ${summary} · ${INPUT_ICON} ${formatTokens(run.inputTokens)} · ${OUTPUT_ICON} ${formatTokens(run.outputTokens)} · ${ELAPSED_ICON} ${duration}`;
}

export default function runSummary(pi: ExtensionAPI): void {
	let currentRun: RunState | undefined;
	let pendingToast: ReturnType<typeof setTimeout> | undefined;

	const cancelPendingToast = (): void => {
		if (pendingToast) clearTimeout(pendingToast);
		pendingToast = undefined;
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${SUMMARY_PROMPT}` };
	});

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

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;

		const stripped = stripGeneratedSummaryMarker(event.message);
		if (currentRun && event.message.stopReason !== "toolUse") {
			currentRun.generatedSummary = stripped?.summary;
		}
		if (stripped) return { message: stripped.message };
	});

	pi.on("agent_end", (event) => {
		if (!currentRun) return;
		const messages = event.messages.filter((message): message is AssistantMessage => message.role === "assistant");
		for (const message of messages) {
			const usage = (message as AssistantMessage & { usage?: AssistantMessage["usage"] }).usage;
			// Match Pi's footer semantics: the up-arrow value is uncached input;
			// cache reads/writes are omitted because this format shows input/output only.
			currentRun.inputTokens += tokenCount(usage?.input);
			currentRun.outputTokens += tokenCount(usage?.output);
		}

		const finalMessage = messages.at(-1);
		if (finalMessage && finalMessage.stopReason !== "toolUse") {
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

			// Keep Pi's info-notification chat behavior, but override its dim wrapper
			// with the theme's brighter secondary-text color.
			const notice = ctx.ui.theme.fg("muted", buildCompletionNotice(candidate, Date.now()));
			ctx.ui.notify(notice, "info");
		}, 0);
		pendingToast.unref?.();
	});

	pi.on("session_shutdown", () => {
		cancelPendingToast();
		currentRun = undefined;
	});
}
