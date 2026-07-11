/**
 * claude-look tool rendering — Claude Code's style: a filled `⏺` bullet
 * (colored by state) + `Tool(args)` header, and results under an `⎿` elbow.
 * Re-registers pi's built-in tools, delegating execution unchanged.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { diffBand } from "./ansi.ts";

const COLLAPSED = 4;
const EXPANDED = 40;

function shorten(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function bullet(theme: Theme, ctx: { isError: boolean; isPartial: boolean; executionStarted: boolean }): string {
	if (ctx.isPartial || !ctx.executionStarted) return theme.fg("dim", "⏺");
	return ctx.isError ? theme.fg("error", "⏺") : theme.fg("success", "⏺");
}

function header(theme: Theme, ctx: any, tool: string, arg: string): Text {
	return new Text(`${bullet(theme, ctx)} ${theme.bold(tool)}${theme.fg("muted", "(")}${arg}${theme.fg("muted", ")")}`, 0, 0);
}

/** Result block under an `⎿` elbow, dim, indented. */
function elbow(theme: Theme, lines: string[], expanded: boolean, summary?: string): string {
	const out: string[] = [];
	if (summary) out.push(theme.fg("muted", "  ⎿ ") + theme.fg("text", summary));
	const max = expanded ? EXPANDED : COLLAPSED;
	const start = summary ? 0 : 0;
	const body = lines.slice(start, max);
	body.forEach((l, i) => {
		if (!summary && i === 0) out.push(theme.fg("muted", "  ⎿ ") + theme.fg("dim", l));
		else out.push(theme.fg("dim", "     " + l));
	});
	if (lines.length > max) out.push(theme.fg("muted", `     … +${lines.length - max} lines`));
	return out.join("\n");
}

function textLines(result: { content: { type: string; text?: string }[] }): string[] {
	const c = result.content.find((x) => x.type === "text");
	return (c?.text ?? "").length === 0 ? [] : (c!.text as string).split("\n");
}

function diffCounts(diff: string) {
	let added = 0, removed = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added++;
		else if (l.startsWith("-") && !l.startsWith("---")) removed++;
	}
	return { added, removed };
}

const EMPTY = () => new Text("", 0, 0);

export function registerClaudeRendering(pi: ExtensionAPI) {
	const cache = new Map<string, any>();
	const built = (cwd: string) => {
		let t = cache.get(cwd);
		if (!t) {
			t = { read: createReadTool(cwd), bash: createBashTool(cwd), edit: createEditTool(cwd), write: createWriteTool(cwd), grep: createGrepTool(cwd), find: createFindTool(cwd), ls: createLsTool(cwd) };
			cache.set(cwd, t);
		}
		return t;
	};
	const override = (name: keyof ReturnType<typeof built>, rc: any, rr: any) => {
		const proto = built(process.cwd())[name];
		pi.registerTool({
			name, label: proto.label ?? name, description: proto.description, parameters: proto.parameters, renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) { return built(ctx.cwd)[name].execute(id, params, signal, onUpdate); },
			renderCall: rc, renderResult: rr,
		});
	};

	override("bash",
		(a: any, t: Theme, c: any) => header(t, c, "Bash", t.fg("accent", String(a.command ?? "").split("\n").join(" "))),
		(r: any, o: any, t: Theme) => o.isPartial || textLines(r).length === 0 ? EMPTY() : new Text(elbow(t, textLines(r), o.expanded), 0, 0));

	override("read",
		(a: any, t: Theme, c: any) => header(t, c, "Read", t.fg("accent", shorten(String(a.path ?? "")))),
		(r: any, o: any, t: Theme) => {
			if (o.isPartial) return EMPTY();
			const n = textLines(r).length;
			return new Text(elbow(t, o.expanded ? textLines(r) : [], o.expanded, `Read ${n} line${n === 1 ? "" : "s"}`), 0, 0);
		});

	override("edit",
		(a: any, t: Theme, c: any) => header(t, c, "Update", t.fg("accent", shorten(String(a.path ?? "")))),
		(r: any, o: any, t: Theme, c: any) => {
			if (o.isPartial) return EMPTY();
			const diff: string | undefined = r.details?.diff;
			if (!diff) return r.isError ? new Text(elbow(t, textLines(r), o.expanded), 0, 0) : EMPTY();
			const { added, removed } = diffCounts(diff);
			const summary = `Updated with ${added} addition${added === 1 ? "" : "s"} and ${removed} removal${removed === 1 ? "" : "s"}`;
			if (!o.expanded) return new Text(t.fg("muted", "  ⎿ ") + t.fg("text", summary), 0, 0);
			const W = 76;
			const body = diff.split("\n").slice(0, 200).map((l) =>
				l.startsWith("+") && !l.startsWith("+++") ? diffBand("add", "", l.length > W ? l.slice(0, W) : l, W)
					: l.startsWith("-") && !l.startsWith("---") ? diffBand("del", "", l.length > W ? l.slice(0, W) : l, W)
						: t.fg("toolDiffContext", l));
			return new Text([t.fg("muted", "  ⎿ ") + t.fg("text", summary), ...body.map((l) => "     " + l)].join("\n"), 0, 0);
		});

	override("write",
		(a: any, t: Theme, c: any) => header(t, c, "Write", t.fg("accent", shorten(String(a.path ?? "")))),
		(r: any, o: any, t: Theme) => {
			if (o.isPartial) return EMPTY();
			if (r.isError) return new Text(elbow(t, textLines(r), o.expanded), 0, 0);
			const n = String((r.details as any)?.bytes ?? "").length;
			return new Text(t.fg("muted", "  ⎿ ") + t.fg("text", "Wrote file"), 0, 0);
		});

	const searchTool = (name: "grep" | "find", verb: string) =>
		override(name,
			(a: any, t: Theme, c: any) => header(t, c, verb, t.fg("accent", String(a.pattern ?? "")) + (a.path ? t.fg("muted", " in ") + shorten(String(a.path)) : "")),
			(r: any, o: any, t: Theme) => {
				if (o.isPartial) return EMPTY();
				const lines = textLines(r);
				if (lines.length === 0) return new Text(t.fg("muted", "  ⎿ ") + t.fg("dim", "No matches"), 0, 0);
				if (!o.expanded) return new Text(t.fg("muted", "  ⎿ ") + t.fg("text", `${lines.length} result${lines.length === 1 ? "" : "s"}`), 0, 0);
				return new Text(elbow(t, lines, true), 0, 0);
			});
	searchTool("grep", "Search");
	searchTool("find", "Search");

	override("ls",
		(a: any, t: Theme, c: any) => header(t, c, "List", t.fg("accent", shorten(String(a.path ?? ".")))),
		(r: any, o: any, t: Theme) => {
			if (o.isPartial) return EMPTY();
			const lines = textLines(r);
			if (!o.expanded) return new Text(t.fg("muted", "  ⎿ ") + t.fg("text", `${lines.length} item${lines.length === 1 ? "" : "s"}`), 0, 0);
			return new Text(elbow(t, lines, true), 0, 0);
		});
}
