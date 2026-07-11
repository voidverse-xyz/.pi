import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_TYPE = "notify-user";
const PADDING = 1;

type Severity = "success" | "warning" | "error";

interface NoticeData {
	successes: string[];
	warnings: string[];
	errors: string[];
}

interface NoticeDetails extends NoticeData {
	queued: boolean;
	displayed: boolean;
	counts: {
		successes: number;
		warnings: number;
		errors: number;
	};
}

const NotifyUserParams = Type.Object(
	{
		successes: Type.Optional(Type.Array(Type.String(), { description: "Completed or succeeded items" })),
		warnings: Type.Optional(Type.Array(Type.String(), { description: "Warnings, risks, or caveats" })),
		errors: Type.Optional(Type.Array(Type.String(), { description: "Failures or blocking errors" })),
		urgent: Type.Optional(
			Type.Boolean({
				description: "Also show the highest-priority item as an immediate toast before the turn finishes",
			}),
		),
	},
	{ additionalProperties: false },
);

export default function notifyUser(pi: ExtensionAPI): void {
	const pendingNotices: NoticeData[] = [];

	pi.registerMessageRenderer<NoticeDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const data = normalizeNotice(message.details);
		return {
			render: (width: number) => renderNoticeLines(data, Math.max(1, width)),
			invalidate: () => undefined,
		};
	});

	// agent_settled is the first reliable point at which Pi will not continue with
	// tools, retries, compaction, or queued follow-ups. It avoids the old polling
	// timer, which could outlive a session and inject a notice into the next one.
	pi.on("agent_settled", () => {
		if (pendingNotices.length === 0) return;
		for (const data of pendingNotices.splice(0)) {
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: "Notice",
					display: true,
					details: buildDetails(data, false, true),
				},
				{ triggerTurn: false },
			);
		}
	});

	pi.on("session_shutdown", () => {
		pendingNotices.length = 0;
	});

	pi.registerTool({
		name: "notify_user",
		label: "Notify User",
		description:
			"Show a visible end-of-turn notice containing concise successes, warnings, and/or errors. " +
			"Set urgent: true to also show the highest-priority item as an immediate toast. " +
			"Use this only for important outcomes, risks, or failures, not routine narration.",
		promptSnippet: "notify_user — surface important successes, warnings, or errors to the user",
		promptGuidelines: [
			"Use notify_user only when an important success, warning, or error should be visually distinct from the normal response.",
			"Set urgent: true only when the user should see a blocking error or significant warning before the turn finishes.",
			"Keep notify_user items concise and do not duplicate the full response.",
		],
		parameters: NotifyUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const data = normalizeNotice(params);
			if (!hasContent(data)) {
				return {
					content: [{ type: "text" as const, text: "No notice content was provided." }],
					details: buildDetails(data, false, false),
				};
			}

			const urgent = (params as { urgent?: unknown }).urgent === true;
			if (urgent && ctx.hasUI) {
				const severity = resolveSeverity(data);
				const line = data.errors[0] ?? data.warnings[0] ?? data.successes[0] ?? "Notice from agent";
				ctx.ui.notify(line, severity === "success" ? "info" : severity);
			}

			pendingNotices.push(data);
			return {
				content: [
					{
						type: "text" as const,
						text: urgent
							? "Urgent toast shown; full notice queued for the end of the turn."
							: "Notice queued for the end of the turn.",
					},
				],
				details: buildDetails(data, true, false),
			};
		},

		renderCall(args, theme) {
			const data = normalizeNotice(args);
			const countText = formatCounts(noticeCounts(data)) || "empty";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("notify_user "))}${theme.fg("muted", `(${countText})`)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as NoticeDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}
			const severity = resolveSeverity(details);
			const status = details.displayed ? "displayed" : details.queued ? "queued" : "not queued";
			return new Text(
				`${theme.fg(details.displayed ? "success" : details.queued ? "warning" : "dim", status)} ` +
					theme.fg(severity, `${severity} (${formatCounts(details.counts) || "empty"})`),
				0,
				0,
			);
		},
	});
}

function normalizeNotice(raw: unknown): NoticeData {
	const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		successes: normalizeList(value.successes),
		warnings: normalizeList(value.warnings),
		errors: normalizeList(value.errors),
	};
}

function normalizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function hasContent(data: NoticeData): boolean {
	return data.successes.length > 0 || data.warnings.length > 0 || data.errors.length > 0;
}

function resolveSeverity(data: NoticeData): Severity {
	if (data.errors.length > 0) return "error";
	if (data.warnings.length > 0) return "warning";
	return "success";
}

function noticeCounts(data: NoticeData): NoticeDetails["counts"] {
	return {
		successes: data.successes.length,
		warnings: data.warnings.length,
		errors: data.errors.length,
	};
}

function formatCounts(counts: NoticeDetails["counts"]): string {
	const parts: string[] = [];
	if (counts.successes) parts.push(`${counts.successes} success${counts.successes === 1 ? "" : "es"}`);
	if (counts.warnings) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
	if (counts.errors) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function buildDetails(data: NoticeData, queued: boolean, displayed: boolean): NoticeDetails {
	return { ...data, queued, displayed, counts: noticeCounts(data) };
}

function renderNoticeLines(data: NoticeData, width: number): string[] {
	const lines: string[] = [];
	addBand(lines, width, "Successes", data.successes, rgbBg(16, 42, 24));
	addBand(lines, width, "Warnings", data.warnings, rgbBg(50, 40, 20));
	addBand(lines, width, "Errors", data.errors, rgbBg(52, 24, 28));
	return lines.length > 0 ? lines : ["Notice"];
}

function addBand(
	lines: string[],
	width: number,
	title: string,
	items: string[],
	bg: (text: string) => string,
): void {
	if (items.length === 0) return;
	lines.push(applyBackgroundToLine("", width, bg));
	lines.push(applyBackgroundToLine(`${" ".repeat(PADDING)}${truncateToWidth(title, Math.max(1, width - PADDING), "…")}`, width, bg));
	for (const item of items) {
		const contentWidth = Math.max(1, width - PADDING * 2 - 2);
		const wrapped = wrapTextWithAnsi(item, contentWidth);
		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? `${" ".repeat(PADDING)}- ` : `${" ".repeat(PADDING + 2)}`;
			lines.push(applyBackgroundToLine(`${prefix}${wrapped[i]}`, width, bg));
		}
	}
	lines.push(applyBackgroundToLine("", width, bg));
}

function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const clipped = truncateToWidth(line, width, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return bgFn(clipped + padding);
}

function rgbBg(red: number, green: number, blue: number): (text: string) => string {
	return (text) => `\x1b[48;2;${red};${green};${blue}m\x1b[38;2;220;224;228m${text}\x1b[0m`;
}
