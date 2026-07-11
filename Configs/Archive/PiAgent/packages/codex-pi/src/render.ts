/**
 * codex-render — clone of Codex's tool-call display
 * (codex-rs/tui/src/exec_cell/render.rs + diff_render.rs).
 *
 * Layout rules taken from the Rust source:
 *  - exec header:  "•" bullet (green success / red failure / dim while running)
 *                  + bold title ("Ran" / "Running") + command
 *  - output block: first line prefixed "  └ " dim, continuations "    "
 *  - patches:      "• " + bold verb (Edited/Added/Deleted) + path + "(+a -r)"
 *                  with +green / -red counts, diff body indented 4 spaces
 *  - reads/searches/lists: "• " + bold verb + target (codex's parsed-command view)
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as os from "node:os";

const COLLAPSED_OUTPUT_LINES = 5;
const EXPANDED_OUTPUT_LINES = 50;

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** "•" colored by execution state, matching exec_cell/render.rs bullets. */
function bullet(theme: Theme, ctx: { isError: boolean; isPartial: boolean; executionStarted: boolean }): string {
	if (ctx.isPartial || !ctx.executionStarted) return theme.fg("dim", "•");
	return ctx.isError ? theme.fg("error", "•") : theme.fg("success", "•");
}

function header(theme: Theme, ctx: any, verb: string, runningVerb: string, rest: string): Text {
	const title = ctx.isPartial ? runningVerb : verb;
	return new Text(`${bullet(theme, ctx)} ${theme.bold(title)} ${rest}`, 0, 0);
}

/** Codex output block: "  └ " first line, "    " continuations, dim text. */
function outputBlock(theme: Theme, lines: string[], expanded: boolean): string {
	const max = expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES;
	const shown = lines.slice(0, max);
	const out = shown.map((line, i) =>
		i === 0 ? theme.fg("dim", "  └ ") + theme.fg("dim", line) : theme.fg("dim", `    ${line}`),
	);
	if (lines.length > max) {
		out.push(theme.fg("muted", `    … +${lines.length - max} lines`));
	}
	return out.join("\n");
}

function textLines(result: { content: { type: string; text?: string }[] }): string[] {
	const content = result.content.find((c) => c.type === "text");
	const text = content?.text ?? "";
	return text.length === 0 ? [] : text.split("\n");
}

function diffCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** "(+a -r)" with green/red counts — diff_render.rs render_line_count_summary. */
function countSummary(theme: Theme, added: number, removed: number): string {
	return `(${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)})`;
}

function coloredDiffBlock(theme: Theme, diff: string, expanded: boolean): string {
	const lines = diff.split("\n");
	const max = expanded ? 200 : COLLAPSED_OUTPUT_LINES;
	const shown = lines.slice(0, max);
	const out = shown.map((line) => {
		if (line.startsWith("+") && !line.startsWith("+++")) return "    " + theme.fg("toolDiffAdded", line);
		if (line.startsWith("-") && !line.startsWith("---")) return "    " + theme.fg("toolDiffRemoved", line);
		return "    " + theme.fg("toolDiffContext", line);
	});
	if (lines.length > max) out.push(theme.fg("muted", `    … +${lines.length - max} lines`));
	return out.join("\n");
}

const EMPTY = () => new Text("", 0, 0);

export function registerCodexRendering(pi: ExtensionAPI) {
	const toolCache = new Map<string, any>();
	const builtIns = (cwd: string) => {
		let t = toolCache.get(cwd);
		if (!t) {
			t = {
				read: createReadTool(cwd),
				bash: createBashTool(cwd),
				edit: createEditTool(cwd),
				write: createWriteTool(cwd),
				grep: createGrepTool(cwd),
				find: createFindTool(cwd),
				ls: createLsTool(cwd),
			};
			toolCache.set(cwd, t);
		}
		return t;
	};

	/** Re-register a built-in with codex renderers, delegating execution. */
	function override(
		name: keyof ReturnType<typeof builtIns>,
		renderCall: (args: any, theme: Theme, ctx: any) => Text,
		renderResult: (result: any, opts: { expanded: boolean; isPartial: boolean }, theme: Theme, ctx: any) => Text,
	) {
		const proto = builtIns(process.cwd())[name];
		pi.registerTool({
			name,
			label: proto.label ?? name,
			description: proto.description,
			parameters: proto.parameters,
			renderShell: "self",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return builtIns(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate);
			},
			renderCall,
			renderResult,
		});
	}

	// --- bash: "• Ran <command>" -----------------------------------------
	override(
		"bash",
		(args, theme, ctx) => {
			const cmd = String(args.command ?? "").split("\n").join("\n    ");
			return header(theme, ctx, "Ran", "Running", cmd);
		},
		(result, { expanded, isPartial }, theme) => {
			if (isPartial) return EMPTY();
			const lines = textLines(result);
			if (lines.length === 0) return EMPTY();
			return new Text(outputBlock(theme, lines, expanded), 0, 0);
		},
	);

	// --- read: "• Read <path>" -------------------------------------------
	override(
		"read",
		(args, theme, ctx) => {
			let extra = "";
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`from ${args.offset}`);
				if (args.limit) parts.push(`${args.limit} lines`);
				extra = " " + theme.fg("dim", `(${parts.join(", ")})`);
			}
			return header(theme, ctx, "Read", "Reading", shortenPath(String(args.path ?? "")) + extra);
		},
		(result, { expanded, isPartial }, theme) => {
			if (isPartial || !expanded) return EMPTY();
			return new Text(outputBlock(theme, textLines(result), true), 0, 0);
		},
	);

	// --- edit: "• Edited <path> (+a -r)" -----------------------------------
	override(
		"edit",
		(args, theme, ctx) => {
			const counts = ctx.state?.counts;
			const suffix = counts ? " " + countSummary(theme, counts.added, counts.removed) : "";
			return header(theme, ctx, "Edited", "Editing", shortenPath(String(args.path ?? "")) + suffix);
		},
		(result, { expanded, isPartial }, theme, ctx) => {
			if (isPartial) return EMPTY();
			const diff: string | undefined = result.details?.diff;
			if (!diff) {
				if (result.isError) return new Text(outputBlock(theme, textLines(result), expanded), 0, 0);
				return EMPTY();
			}
			if (ctx.state && !ctx.state.counts) {
				ctx.state.counts = diffCounts(diff);
				ctx.invalidate();
			}
			return new Text(coloredDiffBlock(theme, diff, expanded), 0, 0);
		},
	);

	// --- write: "• Added <path> (+n -0)" ------------------------------------
	override(
		"write",
		(args, theme, ctx) => {
			const n = String(args.content ?? "").split("\n").length;
			return header(theme, ctx, "Added", "Adding", `${shortenPath(String(args.path ?? ""))} ${countSummary(theme, n, 0)}`);
		},
		(result, { expanded, isPartial }, theme) => {
			if (isPartial) return EMPTY();
			if (result.isError) return new Text(outputBlock(theme, textLines(result), expanded), 0, 0);
			return EMPTY();
		},
	);

	// --- grep: "• Searched <pattern> in <path>" ------------------------------
	override(
		"grep",
		(args, theme, ctx) => {
			const where = args.path ? theme.fg("dim", " in ") + shortenPath(String(args.path)) : "";
			return header(theme, ctx, "Searched", "Searching", `${String(args.pattern ?? "")}${where}`);
		},
		(result, { expanded, isPartial }, theme) => {
			if (isPartial) return EMPTY();
			const lines = textLines(result);
			if (lines.length === 0) return EMPTY();
			if (!expanded) {
				return new Text(theme.fg("dim", "  └ ") + theme.fg("dim", `${lines.length} matches`), 0, 0);
			}
			return new Text(outputBlock(theme, lines, true), 0, 0);
		},
	);

	// --- find: "• Searched <pattern>" ----------------------------------------
	override(
		"find",
		(args, theme, ctx) => header(theme, ctx, "Searched", "Searching", String(args.pattern ?? "")),
		(result, { expanded, isPartial }, theme) => {
			if (isPartial) return EMPTY();
			const lines = textLines(result);
			if (lines.length === 0) return EMPTY();
			if (!expanded) {
				return new Text(theme.fg("dim", "  └ ") + theme.fg("dim", `${lines.length} results`), 0, 0);
			}
			return new Text(outputBlock(theme, lines, true), 0, 0);
		},
	);

	// --- ls: "• Listed <path>" -----------------------------------------------
	override(
		"ls",
		(args, theme, ctx) => header(theme, ctx, "Listed", "Listing", shortenPath(String(args.path ?? ".")), ),
		(result, { expanded, isPartial }, theme) => {
			if (isPartial) return EMPTY();
			const lines = textLines(result);
			if (lines.length === 0) return EMPTY();
			if (!expanded) {
				return new Text(theme.fg("dim", "  └ ") + theme.fg("dim", `${lines.length} entries`), 0, 0);
			}
			return new Text(outputBlock(theme, lines, true), 0, 0);
		},
	);
}
