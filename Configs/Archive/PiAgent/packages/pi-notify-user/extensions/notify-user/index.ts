/**
 * Notify User - LLM-callable user notice: successes, warnings, errors, and status updates.
 *
 * The agent calls `notify_user` with any mix of title, severity,
 * successes, info, warnings, and errors. Every field is optional; empty calls
 * are treated as a no-op rather than a hard failure. Non-empty notices are
 * appended just after the agent_end hook settles, so the rendered block lands
 * at the end of the transcript instead of being queued as another agent
 * continuation. (Mid-stream transcript injection is not possible from an
 * extension — sendMessage is rerouted into steer while streaming — hence the
 * queue.) `urgent: true` additionally fires an immediate ctx.ui.notify toast
 * so the user sees it before the turn finishes.
 *
 * Severity (explicit, or inferred from which sections are non-empty) colors
 * the title band — green/yellow/red for success/warning/error, the
 * neutral theme background for info — and sets the urgent-toast level.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_TYPE = "notify-user";
const PADDING = 1;

type Severity = "success" | "info" | "warning" | "error";

const SEVERITIES: readonly Severity[] = ["success", "info", "warning", "error"];

interface NoticeData {
	title?: string;
	severity?: Severity;
	successes: string[];
	info: string[];
	warnings: string[];
	errors: string[];
}

interface NoticeDetails extends NoticeData {
	queued: boolean;
	displayed: boolean;
	counts: {
		successes: number;
		info: number;
		warnings: number;
		errors: number;
	};
}

const NotifyUserParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional short title for the notice" })),
	severity: Type.Optional(
		Type.Union(
			[Type.Literal("success"), Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")],
			{
				description:
					"Overall severity of the notice; colors the block and sets the urgent-toast level. " +
					"Inferred from errors/warnings/successes when omitted.",
			},
		),
	),
	successes: Type.Optional(Type.Array(Type.String(), { description: "Optional completed/succeeded items" })),
	info: Type.Optional(Type.Array(Type.String(), { description: "Optional informational messages" })),
	warnings: Type.Optional(Type.Array(Type.String(), { description: "Optional warning messages" })),
	errors: Type.Optional(Type.Array(Type.String(), { description: "Optional error messages" })),
	urgent: Type.Optional(
		Type.Boolean({
			description:
				"Also show an immediate toast notification now, instead of only the end-of-turn block. Use for warnings/errors the user should see before the turn finishes.",
		}),
	),
}, { additionalProperties: false });

export default function notifyUser(pi: ExtensionAPI): void {
	const pendingNotices: NoticeData[] = [];

	pi.registerMessageRenderer<NoticeDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as NoticeDetails | undefined;
		const data = details ? normalizeNotice(details) : normalizeNotice({ title: message.content });
		return {
			render: (width: number) => renderNoticeLines(data, theme, Math.max(30, width)),
			invalidate: () => undefined,
		};
	});

	pi.on("agent_end", (_event, ctx) => {
		if (pendingNotices.length === 0) return;
		const notices = pendingNotices.splice(0);

		const flushWhenIdle = () => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				setTimeout(flushWhenIdle, 50);
				return;
			}

			for (const data of notices) {
				pi.sendMessage(
					{
						customType: CUSTOM_TYPE,
						content: data.title || "Notice",
						display: true,
						details: buildDetails(data, false, true),
					},
					{ triggerTurn: false },
				);
			}
		};

		setTimeout(flushWhenIdle, 0);
	});

	pi.registerTool({
		name: "notify_user",
		label: "Notify User",
		description:
			"Show the user a highly visible notice block: a status update, completed work (successes), warnings " +
			"about risks or caveats, or errors for things that failed. The block renders at the end of the turn and " +
			"is color-banded by severity (explicit via severity, or inferred from the sections); set urgent: true to " +
			"also pop an immediate toast now. All fields are optional: title, severity, successes, info, " +
			"warnings, errors, urgent.",
		promptSnippet: "notify_user — surface a visible notice to the user: successes, warnings, or errors",
		promptGuidelines: [
			"Use notify_user to make sure the user actually sees something important: a completed-work recap (severity: 'success' with successes), a risk or caveat (warnings), or a failure (errors). Prose in your response can be skimmed past; this block is visually distinct.",
			"Set severity explicitly when the overall outcome differs from what the sections imply — e.g. severity: 'success' for a recap that includes a minor warning. When omitted, severity is inferred: errors > warnings > successes > info.",
			"Set urgent: true when the user should see it before the turn finishes — e.g. a destructive action you are about to take, or an error that blocks the rest of the work.",
			"Keep each item concise; prefer one to three items per section. Do not duplicate your whole response into the notice.",
			"Do not use this tool for questions; use ask_user when you need an answer.",
		],
		parameters: NotifyUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const data = normalizeNotice(params);
			const details = buildDetails(data, false, false);

			if (!hasContent(data)) {
				return {
					content: [{ type: "text" as const, text: "No notice content was provided." }],
					details,
				};
			}

			// Urgent path: pop a toast immediately (works mid-stream, unlike transcript
			// injection). The full block still lands at end of turn below.
			const urgent = (params as { urgent?: unknown }).urgent === true;
			if (urgent) {
				const severity = resolveSeverity(data);
				// The toast API has no success level; success rides as info.
				const level = severity === "success" ? "info" : severity;
				const line =
					data.title ||
					data.errors[0] ||
					data.warnings[0] ||
					data.successes[0] ||
					data.info[0] ||
					"Notice from agent";
				try {
					ctx.ui.notify(line, level);
				} catch {
					/* headless mode — toast unavailable, block still queues */
				}
			}

			pendingNotices.push(data);
			return {
				content: [
					{
						type: "text" as const,
						text: urgent
							? "Notice shown to the user now; full block will render at the end of the turn."
							: "Notice queued for the end of the agent turn.",
					},
				],
				details: buildDetails(data, true, false),
			};
		},

		renderCall(args, theme) {
			const data = normalizeNotice(args);
			const label = data.title || "Notice";
			const countText = formatCounts(noticeCounts(data));
			const detail = countText ? `${label} (${countText})` : label;
			return new Text(`${theme.fg("toolTitle", theme.bold("notify_user "))}${theme.fg("muted", detail)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as NoticeDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}

			const data = normalizeNotice(details);
			const severity = resolveSeverity(data);
			const status = details.displayed
				? theme.fg("success", "displayed")
				: details.queued
					? theme.fg("warning", "queued")
					: theme.fg("dim", "not queued");
			const severityWord = theme.fg(severityColorName(severity), severity);
			const title = data.title ? ` ${theme.fg("accent", data.title)}` : "";
			const countText = formatCounts(noticeCounts(data));
			const counts = countText ? theme.fg("dim", ` (${countText})`) : "";
			return new Text(`${status} ${severityWord}${title}${counts}`, 0, 0);
		},
	});

}

function normalizeNotice(raw: unknown): NoticeData {
	const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		title: normalizeText(value.title),
		severity: normalizeSeverity(value.severity),
		successes: normalizeList(value.successes),
		info: normalizeList(value.info),
		warnings: normalizeList(value.warnings),
		errors: normalizeList(value.errors),
	};
}

function normalizeText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSeverity(value: unknown): Severity | undefined {
	return SEVERITIES.includes(value as Severity) ? (value as Severity) : undefined;
}

function normalizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function hasContent(data: NoticeData): boolean {
	return Boolean(
		data.title || data.successes.length || data.info.length || data.warnings.length || data.errors.length,
	);
}

/** Explicit severity wins; otherwise the worst non-empty section decides. */
function resolveSeverity(data: NoticeData): Severity {
	if (data.severity) return data.severity;
	if (data.errors.length) return "error";
	if (data.warnings.length) return "warning";
	if (data.successes.length) return "success";
	return "info";
}

function severityColorName(severity: Severity): "success" | "muted" | "warning" | "error" {
	return severity === "info" ? "muted" : severity;
}

function noticeCounts(data: NoticeData): NoticeDetails["counts"] {
	return {
		successes: data.successes.length,
		info: data.info.length,
		warnings: data.warnings.length,
		errors: data.errors.length,
	};
}

/** Only non-zero sections, pluralized: "3 done, 1 info, 2 warnings, 1 error". Empty string when all are zero. */
function formatCounts(counts: NoticeDetails["counts"]): string {
	const parts: string[] = [];
	if (counts.successes) parts.push(`${counts.successes} done`);
	if (counts.info) parts.push(`${counts.info} info`);
	if (counts.warnings) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
	if (counts.errors) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function buildDetails(data: NoticeData, queued: boolean, displayed: boolean): NoticeDetails {
	return {
		...data,
		queued,
		displayed,
		counts: noticeCounts(data),
	};
}

function renderNoticeLines(
	data: NoticeData,
	theme: {
		bg(color: "customMessageBg", text: string): string;
	},
	width: number,
): string[] {
	const renderWidth = Math.max(30, width);
	const contentWidth = Math.max(10, renderWidth - PADDING * 2);
	const lines: string[] = [];
	const severity = resolveSeverity(data);

	if (data.title) {
		// Severity colors the title band; plain info keeps the neutral theme background.
		const bg = severity === "info" ? (text: string) => theme.bg("customMessageBg", text) : severityBandBg(severity);
		const tag = severity === "info" ? "" : `[${severity}]`;
		const headingLines = wrapTextWithAnsi(data.title, contentWidth);
		addTitleBand(lines, renderWidth, headingLines[0] ?? "Notice", tag, headingLines.slice(1), bg);
	}

	addBand(lines, renderWidth, "Done", data.successes, severityBandBg("success"));
	addBand(lines, renderWidth, "Info", data.info, rgbBg(12, 28, 43));
	addBand(lines, renderWidth, "Warnings", data.warnings, severityBandBg("warning"));
	addBand(lines, renderWidth, "Errors", data.errors, severityBandBg("error"));

	return lines.length > 0 ? lines : [theme.bg("customMessageBg", " Notice ")];
}

function addTitleBand(
	lines: string[],
	renderWidth: number,
	heading: string,
	tag: string,
	items: string[],
	bg: (text: string) => string,
): void {
	// Symmetric vertical padding: one blank bg row above AND below the content.
	addPaddingLine(lines, renderWidth, bg);
	lines.push(applyBackgroundToLine(composeHeadingLine(heading, tag, renderWidth), renderWidth, bg));

	for (const item of items) {
		lines.push(applyBackgroundToLine(`${" ".repeat(PADDING)}${item}`, renderWidth, bg));
	}
	addPaddingLine(lines, renderWidth, bg);
}

/**
 * Heading text left, severity tag right-aligned on the same band row.
 * The tag is plain text — the band fill (rgbBg) owns fg/bg for the whole
 * line, so no nested SGR codes are allowed here. Dropped when too narrow.
 */
function composeHeadingLine(heading: string, tag: string, renderWidth: number): string {
	const left = `${" ".repeat(PADDING)}${heading}`;
	if (!tag) return left;
	const right = `${tag}${" ".repeat(PADDING)}`;
	const gap = renderWidth - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return left;
	return `${left}${" ".repeat(gap)}${right}`;
}

function addBand(
	lines: string[],
	renderWidth: number,
	title: string,
	items: string[],
	bg: (text: string) => string,
): void {
	if (items.length === 0) return;

	// Symmetric vertical padding: one blank bg row above AND below the content.
	addPaddingLine(lines, renderWidth, bg);
	lines.push(applyBackgroundToLine(`${" ".repeat(PADDING)}${title}`, renderWidth, bg));

	for (const item of items) {
		const wrapped = wrapTextWithAnsi(item, Math.max(10, renderWidth - PADDING * 2 - 2));
		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? `${" ".repeat(PADDING)}- ` : `${" ".repeat(PADDING + 2)}`;
			lines.push(applyBackgroundToLine(`${prefix}${wrapped[i]}`, renderWidth, bg));
		}
	}
	addPaddingLine(lines, renderWidth, bg);
}

function addPaddingLine(lines: string[], width: number, bg: (text: string) => string): void {
	lines.push(applyBackgroundToLine("", width, bg));
}

function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
	return bgFn(line + padding);
}

/** Muted band backgrounds per severity, same brightness family as the Info band. */
function severityBandBg(severity: Exclude<Severity, "info">): (text: string) => string {
	switch (severity) {
		case "success":
			return rgbBg(16, 42, 24);
		case "warning":
			return rgbBg(50, 40, 20);
		case "error":
			return rgbBg(52, 24, 28);
	}
}

function rgbBg(red: number, green: number, blue: number): (text: string) => string {
	return (text) => `\x1b[48;2;${red};${green};${blue}m\x1b[38;2;220;224;228m${text}\x1b[0m`;
}
