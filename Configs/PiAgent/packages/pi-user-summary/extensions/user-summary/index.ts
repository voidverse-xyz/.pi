/**
 * User Summary - LLM-callable end-of-turn transcript summary.
 *
 * The agent can call `user_summary` with any mix of title, summary, info,
 * warnings, and errors. Every field is optional; empty calls are treated as a
 * no-op rather than a hard failure. Non-empty summaries are appended just after
 * the agent_end hook settles, so the rendered message lands at the end of the
 * transcript instead of being queued as another agent continuation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_TYPE = "user-summary";
const PADDING = 1;

interface SummaryData {
	title?: string;
	summary?: string;
	info: string[];
	warnings: string[];
	errors: string[];
}

interface SummaryDetails extends SummaryData {
	queued: boolean;
	displayed: boolean;
	counts: {
		info: number;
		warnings: number;
		errors: number;
	};
}

const UserSummaryParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional short title for the summary message" })),
	summary: Type.Optional(Type.String({ description: "Optional main summary text shown before message sections" })),
	info: Type.Optional(Type.Array(Type.String(), { description: "Optional informational messages" })),
	warnings: Type.Optional(Type.Array(Type.String(), { description: "Optional warning messages" })),
	errors: Type.Optional(Type.Array(Type.String(), { description: "Optional error messages" })),
});

export default function userSummary(pi: ExtensionAPI): void {
	const pendingSummaries: SummaryData[] = [];

	pi.registerMessageRenderer<SummaryDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as SummaryDetails | undefined;
		const data = details ? normalizeSummary(details) : normalizeSummary({ summary: message.content });
		return {
			render: (width: number) => renderSummaryLines(data, theme, Math.max(30, width)),
			invalidate: () => undefined,
		};
	});

	pi.on("agent_end", (_event, ctx) => {
		if (pendingSummaries.length === 0) return;
		const summaries = pendingSummaries.splice(0);

		const flushWhenIdle = () => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				setTimeout(flushWhenIdle, 50);
				return;
			}

			for (const data of summaries) {
				pi.sendMessage(
					{
						customType: CUSTOM_TYPE,
						content: data.title || "User summary",
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
		name: "user_summary",
		label: "User Summary",
		description:
			"Queue an end-of-turn transcript summary for the user. Use this to report progress, outcomes, " +
			"optional warnings, or errors in a visible way. All fields are optional: title, summary, info, warnings, and errors.",
		promptSnippet: "user_summary - queue a final transcript summary with optional info, warnings, and errors",
		promptGuidelines: [
			"Use user_summary near the end of your response when a short visible status recap is useful for the user.",
			"Keep each message concise. Prefer one to three items per section.",
			"Use warnings for risks or caveats, and errors only for things that failed or blocked work.",
			"Do not use this tool for questions; use user_inputs when you need an answer.",
		],
		parameters: UserSummaryParams,

		async execute(_toolCallId, params) {
			const data = normalizeSummary(params);
			const details = buildDetails(data, false, false);

			if (!hasContent(data)) {
				return {
					content: [{ type: "text" as const, text: "No user summary content was provided." }],
					details,
				};
			}

			pendingSummaries.push(data);
			return {
				content: [{ type: "text" as const, text: "User summary queued for the end of the agent turn." }],
				details: buildDetails(data, true, false),
			};
		},

		renderCall(args, theme) {
			const data = normalizeSummary(args);
			const label = data.title || "User summary";
			const counts = summaryCounts(data);
			const countText = `${counts.info} info, ${counts.warnings} warning, ${counts.errors} error`;
			return new Text(`${theme.fg("toolTitle", theme.bold("user_summary "))}${theme.fg("muted", `${label} (${countText})`)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SummaryDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}

			const status = details.displayed
				? theme.fg("success", "displayed")
				: details.queued
					? theme.fg("warning", "queued")
					: theme.fg("dim", "not queued");
			const title = details.title ? ` ${theme.fg("accent", details.title)}` : "";
			const counts = ` (${details.counts.info} info, ${details.counts.warnings} warning, ${details.counts.errors} error)`;
			return new Text(`${status}${title}${theme.fg("dim", counts)}`, 0, 0);
		},
	});

	pi.registerCommand("user-summary", {
		description: "Add a demo user-summary message to the transcript",
		handler: async (_args, ctx) => {
			const data = {
				title: "User Summary",
				summary: "This is a demo of the user_summary transcript renderer.",
				info: ["Information messages use a blue-ish background."],
				warnings: ["Warnings use a yellow-ish background."],
				errors: ["Errors use a red background."],
			};
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: data.title,
					display: true,
					details: buildDetails(data, false, true),
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify("Added demo user summary to the transcript", "info");
		},
	});
}

function normalizeSummary(raw: unknown): SummaryData {
	const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		title: normalizeText(value.title),
		summary: normalizeText(value.summary),
		info: normalizeList(value.info),
		warnings: normalizeList(value.warnings),
		errors: normalizeList(value.errors),
	};
}

function normalizeText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function hasContent(data: SummaryData): boolean {
	return Boolean(data.title || data.summary || data.info.length || data.warnings.length || data.errors.length);
}

function summaryCounts(data: SummaryData): SummaryDetails["counts"] {
	return {
		info: data.info.length,
		warnings: data.warnings.length,
		errors: data.errors.length,
	};
}

function buildDetails(data: SummaryData, queued: boolean, displayed: boolean): SummaryDetails {
	return {
		...data,
		queued,
		displayed,
		counts: summaryCounts(data),
	};
}

function renderSummaryLines(
	data: SummaryData,
	theme: {
		bg(color: "customMessageBg", text: string): string;
	},
	width: number,
): string[] {
	const renderWidth = Math.max(30, width);
	const contentWidth = Math.max(10, renderWidth - PADDING * 2);
	const lines: string[] = [];

	if (data.title || data.summary) {
		const summaryLines: string[] = [];
		if (data.title) summaryLines.push(...wrapTextWithAnsi(data.title, contentWidth));
		if (data.summary) summaryLines.push(...wrapTextWithAnsi(data.summary, contentWidth));
		addSummaryBand(lines, renderWidth, "Summary", summaryLines, (text) => theme.bg("customMessageBg", text));
	}

	addBand(lines, renderWidth, "Info", data.info, rgbBg(12, 28, 43));
	addBand(lines, renderWidth, "Warnings", data.warnings, rgbBg(50, 40, 20));
	addBand(lines, renderWidth, "Errors", data.errors, rgbBg(52, 24, 28));

	return lines.length > 0 ? lines : [theme.bg("customMessageBg", " User summary ")];
}

function addSummaryBand(
	lines: string[],
	renderWidth: number,
	title: string,
	items: string[],
	bg: (text: string) => string,
): void {
	if (items.length === 0) return;

	lines.push(applyBackgroundToLine(`${" ".repeat(PADDING)}${title}`, renderWidth, bg));

	for (const item of items) {
		lines.push(applyBackgroundToLine(`${" ".repeat(PADDING)}${item}`, renderWidth, bg));
	}
	addPaddingLine(lines, renderWidth, bg);
}

function addBand(
	lines: string[],
	renderWidth: number,
	title: string,
	items: string[],
	bg: (text: string) => string,
): void {
	if (items.length === 0) return;

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

function rgbBg(red: number, green: number, blue: number): (text: string) => string {
	return (text) => `\x1b[48;2;${red};${green};${blue}m\x1b[38;2;220;224;228m${text}\x1b[0m`;
}
