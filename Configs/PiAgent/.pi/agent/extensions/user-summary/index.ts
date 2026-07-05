/**
 * User Summary - LLM-callable TUI summary panel.
 *
 * The agent can call `user_summary` with any mix of title, summary, info,
 * warnings, and errors. Every field is optional; empty calls are treated as a
 * no-op rather than a hard failure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text, applyBackgroundToLine, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface SummaryData {
	title?: string;
	summary?: string;
	info: string[];
	warnings: string[];
	errors: string[];
}

interface SummaryDetails extends SummaryData {
	shown: boolean;
	cancelled: boolean;
	counts: {
		info: number;
		warnings: number;
		errors: number;
	};
}

const UserSummaryParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional short title for the summary panel" })),
	summary: Type.Optional(Type.String({ description: "Optional main summary text shown before message sections" })),
	info: Type.Optional(Type.Array(Type.String(), { description: "Optional informational messages" })),
	warnings: Type.Optional(Type.Array(Type.String(), { description: "Optional warning messages" })),
	errors: Type.Optional(Type.Array(Type.String(), { description: "Optional error messages" })),
});

export default function userSummary(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "user_summary",
		label: "User Summary",
		description:
			"Show the user a compact TUI summary panel. Use this to report progress, outcomes, optional warnings, " +
			"or errors in a visible way. All fields are optional: title, summary, info, warnings, and errors.",
		promptSnippet: "user_summary - show a TUI summary panel with optional info, warnings, and errors",
		promptGuidelines: [
			"Use user_summary when a short visible status recap is useful for the user.",
			"Keep each message concise. Prefer one to three items per section.",
			"Use warnings for risks or caveats, and errors only for things that failed or blocked work.",
			"Do not use this tool for questions; use user_inputs when you need an answer.",
		],
		parameters: UserSummaryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const data = normalizeSummary(params);
			const details = buildDetails(data, false, false);

			if (!hasContent(data)) {
				return {
					content: [{ type: "text" as const, text: "No user summary content was provided." }],
					details,
				};
			}

			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text" as const, text: formatPlainSummary(data) }],
					details: buildDetails(data, false, false),
				};
			}

			const cancelled = await showSummaryPanel(ctx, data);
			return {
				content: [
					{
						type: "text" as const,
						text: cancelled ? "User dismissed the summary." : "User viewed the summary.",
					},
				],
				details: buildDetails(data, cancelled, true),
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

			const status = details.shown
				? details.cancelled
					? theme.fg("warning", "dismissed")
					: theme.fg("success", "viewed")
				: theme.fg("dim", "not shown");
			const title = details.title ? ` ${theme.fg("accent", details.title)}` : "";
			const counts = ` (${details.counts.info} info, ${details.counts.warnings} warning, ${details.counts.errors} error)`;
			return new Text(`${status}${title}${theme.fg("dim", counts)}`, 0, 0);
		},
	});

	pi.registerCommand("user-summary", {
		description: "Show a demo user-summary panel",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("user-summary demo requires TUI mode", "error");
				return;
			}
			await showSummaryPanel(ctx, {
				title: "User Summary",
				summary: "This is a demo of the user_summary tool panel.",
				info: ["Information messages use a quiet background."],
				warnings: ["Warnings call out caveats or risk."],
				errors: ["Errors call out failures or blocked work."],
			});
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

function buildDetails(data: SummaryData, cancelled: boolean, shown: boolean): SummaryDetails {
	return {
		...data,
		shown,
		cancelled,
		counts: summaryCounts(data),
	};
}

function formatPlainSummary(data: SummaryData): string {
	const lines: string[] = [];
	if (data.title) lines.push(`# ${data.title}`);
	if (data.summary) lines.push(data.summary);
	addPlainSection(lines, "Info", data.info);
	addPlainSection(lines, "Warnings", data.warnings);
	addPlainSection(lines, "Errors", data.errors);
	return lines.join("\n\n");
}

function addPlainSection(lines: string[], title: string, items: string[]): void {
	if (items.length === 0) return;
	lines.push([`${title}:`, ...items.map((item) => `- ${item}`)].join("\n"));
}

async function showSummaryPanel(ctx: Pick<ExtensionContext, "ui">, data: SummaryData): Promise<boolean> {
	const result = await ctx.ui.custom<"closed" | "cancelled">(
		(tui, theme, _kb, done) => {
			let cachedLines: string[] | undefined;

			function refresh(): void {
				cachedLines = undefined;
				tui.requestRender();
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const renderWidth = Math.max(30, width);
				const contentWidth = Math.max(10, renderWidth - 4);
				const lines: string[] = [];

				lines.push(theme.fg("border", "-".repeat(renderWidth)));
				lines.push(` ${theme.fg("accent", theme.bold(data.title || "Summary"))}`);

				if (data.summary) {
					lines.push("");
					for (const line of wrapTextWithAnsi(theme.fg("text", data.summary), contentWidth)) {
						lines.push(`  ${line}`);
					}
				}

				addSection(lines, renderWidth, contentWidth, theme, "Info", data.info, "customMessageBg", "success");
				addSection(lines, renderWidth, contentWidth, theme, "Warnings", data.warnings, "toolPendingBg", "warning");
				addSection(lines, renderWidth, contentWidth, theme, "Errors", data.errors, "toolErrorBg", "error");

				lines.push("");
				lines.push(` ${theme.fg("dim", "Enter to close - Esc to dismiss")}`);
				lines.push(theme.fg("border", "-".repeat(renderWidth)));

				cachedLines = lines;
				return lines;
			}

			function handleInput(data: string): void {
				if (matchesKey(data, Key.enter)) {
					done("closed");
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done("cancelled");
				}
			}

			return {
				render,
				invalidate: refresh,
				handleInput,
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 2,
			},
		},
	);

	return result === "cancelled";
}

function addSection(
	lines: string[],
	renderWidth: number,
	contentWidth: number,
	theme: {
		fg(color: "accent" | "border" | "success" | "warning" | "error" | "muted" | "dim" | "text", text: string): string;
		bg(color: "customMessageBg" | "toolPendingBg" | "toolErrorBg", text: string): string;
		bold(text: string): string;
	},
	title: string,
	items: string[],
	bg: "customMessageBg" | "toolPendingBg" | "toolErrorBg",
	fg: "success" | "warning" | "error",
): void {
	if (items.length === 0) return;

	lines.push("");
	lines.push(applyBackgroundToLine(` ${theme.fg(fg, theme.bold(title))}`, renderWidth, (text) => theme.bg(bg, text)));

	for (const item of items) {
		const wrapped = wrapTextWithAnsi(theme.fg("text", item), contentWidth);
		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? "  - " : "    ";
			lines.push(applyBackgroundToLine(`${prefix}${wrapped[i]}`, renderWidth, (text) => theme.bg(bg, text)));
		}
	}
}
