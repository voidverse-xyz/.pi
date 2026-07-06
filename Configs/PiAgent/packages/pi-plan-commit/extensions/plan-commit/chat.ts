/**
 * Ask → persistent chat panel.
 *
 * From the review panel's "Ask" action the user first picks a target (main agent
 * vs. isolated subagent), then this overlay opens and STAYS open until they close
 * it (Esc / Ctrl+C), so they can ask several follow-up questions in a row.
 *
 *  - subagent: each question spawns a fresh read-only `pi` child grounded with the
 *    group's diff and the running Q&A history (so follow-ups have continuity), and
 *    its answer streams live into the transcript.
 *  - main agent: each question is injected into the current session
 *    (sendUserMessage/followUp); it is answered in the main chat after the panel
 *    closes. The transcript notes that so the behavior isn't surprising.
 *
 * The streaming/parse loop is adapted from pi-changes' ask.ts.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ReviewGroup } from "./classify.ts";

const DIFF_CAP = 24 * 1024;

export type ChatTarget = "sub" | "main";

interface Turn {
	role: "you" | "agent" | "note" | "error";
	text: string;
}

interface AnswerState {
	status: "running" | "done" | "error";
	text: string;
	error?: string;
	onRender?: () => void;
	kill(): void;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function capDiff(diff: string): string {
	if (diff.length <= DIFF_CAP) return diff;
	return `${diff.slice(0, DIFF_CAP)}\n… [diff truncated: ${diff.length - DIFF_CAP} more bytes]`;
}

export function buildMainAgentMessage(group: ReviewGroup, question: string): string {
	return [
		`[plan-commit] Question about review group "${group.title}" (${group.paths.join(", ")}):`,
		"",
		question.trim(),
		"",
		"Answer only about this group's changes. Do not commit or modify any files.",
	].join("\n");
}

/** Task text for the isolated subagent, including diff + prior Q&A for continuity. */
function buildSubagentTask(group: ReviewGroup, diff: string, history: Turn[], question: string): string {
	const parts = [
		"You are reviewing a group of related file changes another agent made.",
		"",
		`Group: ${group.title}`,
		`Files: ${group.paths.join(", ")}`,
	];
	const capped = capDiff(diff.trim());
	if (capped) parts.push("", "--- Unified diff of the changes ---", capped, "--- end diff ---");

	const prior = history.filter((t) => t.role === "you" || t.role === "agent");
	if (prior.length > 0) {
		parts.push("", "--- Earlier in this Q&A ---");
		for (const t of prior) parts.push(`${t.role === "you" ? "Q" : "A"}: ${t.text}`);
		parts.push("--- end earlier ---");
	}

	parts.push(
		"",
		`New question: ${question.trim()}`,
		"",
		"Answer concisely. You may read files in the working directory (read/grep/find/ls) to inform your answer. Do not attempt to modify anything.",
	);
	return parts.join("\n");
}

function spawnSubagentAnswer(
	cwd: string,
	group: ReviewGroup,
	diff: string,
	history: Turn[],
	question: string,
): AnswerState {
	const state: AnswerState = { status: "running", text: "", kill() {} };

	const task = buildSubagentTask(group, diff, history, question);
	const inv = getPiInvocation([
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		"read,grep,find,ls",
		`Task: ${task}`,
	]);

	let proc: ChildProcess;
	try {
		proc = spawn(inv.command, inv.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe", "ignore"],
		});
	} catch (e) {
		state.status = "error";
		state.error = String(e);
		return state;
	}

	let killed = false;
	state.kill = () => {
		if (killed) return;
		killed = true;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (!proc.killed) proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 3000);
	};

	let stderr = "";
	let buffer = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let ev: { type?: string; message?: Record<string, unknown> };
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		if (ev.type !== "message_end" || !ev.message) return;
		const msg = ev.message as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (msg.role !== "assistant") return;
		for (const part of msg.content ?? []) {
			if (part.type === "text" && part.text) state.text += (state.text ? "\n" : "") + part.text;
		}
		state.onRender?.();
	};

	proc.stdout?.on("data", (d: Buffer) => {
		buffer += d.toString();
		const ls = buffer.split("\n");
		buffer = ls.pop() ?? "";
		for (const l of ls) processLine(l);
	});
	proc.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});
	proc.on("close", (code) => {
		if (buffer.trim()) processLine(buffer);
		if (!killed && code && code !== 0 && !state.text) {
			state.status = "error";
			state.error = stderr.trim() || `subagent exited with code ${code}`;
		} else {
			state.status = "done";
			if (!state.text && !killed) state.text = "(no answer)";
		}
		state.onRender?.();
	});
	proc.on("error", (e) => {
		state.status = "error";
		state.error = String(e);
		state.onRender?.();
	});

	return state;
}

interface ChatPanelOptions {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	group: ReviewGroup;
	diffText: string;
	target: ChatTarget;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	onDone: (result: void) => void;
}

function createChatPanel(opts: ChatPanelOptions): Component {
	const { pi, ctx, group, diffText, target, tui, theme, keybindings, onDone } = opts;

	const turns: Turn[] = [];
	let streaming: AnswerState | null = null;
	let scroll = 0;
	let follow = true;
	let contentH = 8;
	let cachedWidth: number | undefined;
	let cachedHeight: number | undefined;
	let cachedLines: string[] | undefined;

	const input = new Input();
	input.focused = true;

	function invalidate() {
		cachedWidth = undefined;
		cachedHeight = undefined;
		cachedLines = undefined;
		input.invalidate();
	}
	function rerender() {
		invalidate();
		tui.requestRender();
	}

	function close() {
		streaming?.kill();
		streaming = null;
		onDone();
	}

	function submit(raw: string) {
		const q = raw.trim();
		if (!q) return;
		if (streaming && streaming.status === "running") {
			// One subagent at a time; ignore until the current answer finishes.
			return;
		}
		input.setValue("");
		turns.push({ role: "you", text: q });
		follow = true;

		if (target === "main") {
			pi.sendUserMessage(buildMainAgentMessage(group, q), { deliverAs: "followUp" });
			turns.push({
				role: "note",
				text: "Sent to the main agent — it will answer in the main chat after you close this panel.",
			});
			rerender();
			return;
		}

		const history = turns.slice(0, -1); // exclude the just-pushed question
		const answer = spawnSubagentAnswer(ctx.cwd, group, diffText, history, q);
		streaming = answer;
		answer.onRender = () => {
			follow = true;
			rerender();
		};
		rerender();

		// Finalize into the transcript once the child closes.
		const finalize = () => {
			if (answer.status === "running") return;
			if (streaming === answer) streaming = null;
			if (answer.status === "error") {
				turns.push({ role: "error", text: answer.error ?? "subagent failed" });
			} else {
				turns.push({ role: "agent", text: answer.text || "(no answer)" });
			}
			rerender();
		};
		const prevOnRender = answer.onRender;
		answer.onRender = () => {
			prevOnRender?.();
			finalize();
		};
	}

	input.onSubmit = (value) => submit(value);
	input.onEscape = () => close();

	function panelRows(): number {
		return Math.max(14, tui.terminal.rows);
	}
	function rule(width: number): string {
		const border = new DynamicBorder((s: string) => theme.fg("borderMuted", s));
		return border.render(Math.max(1, width))[0] ?? "";
	}
	function pad(content: string, width: number): string {
		const vis = visibleWidth(content);
		return content + " ".repeat(Math.max(0, width - vis));
	}

	function roleLabel(role: Turn["role"]): string {
		switch (role) {
			case "you":
				return theme.fg("accent", "you ");
			case "agent":
				return theme.fg("success", "sub ");
			case "note":
				return theme.fg("dim", "·   ");
			case "error":
				return theme.fg("toolDiffRemoved", "err ");
		}
	}

	function styleBody(role: Turn["role"], text: string): string {
		if (role === "note") return theme.fg("dim", text);
		if (role === "error") return theme.fg("toolDiffRemoved", text);
		return theme.fg("text", text);
	}

	function transcriptLines(width: number): string[] {
		const innerW = Math.max(20, width - 2);
		const out: string[] = [];
		const renderTurn = (role: Turn["role"], text: string) => {
			const label = roleLabel(role);
			const raws = text.split("\n");
			for (let i = 0; i < raws.length; i++) {
				const wrapped = wrapTextWithAnsi(styleBody(role, raws[i] ?? ""), innerW - 4);
				for (let j = 0; j < wrapped.length; j++) {
					const lead = i === 0 && j === 0 ? label : "    ";
					out.push(pad(` ${lead}${wrapped[j]}`, innerW));
				}
			}
		};
		for (const t of turns) renderTurn(t.role, t.text);
		if (streaming) {
			renderTurn("agent", streaming.text || (streaming.status === "running" ? "…thinking…" : ""));
			if (streaming.status === "running") {
				out.push(pad(` ${theme.fg("dim", "    ▌ streaming…")}`, innerW));
			}
		}
		if (out.length === 0) {
			out.push(pad(` ${theme.fg("muted", "Ask a question about this group's changes.")}`, innerW));
		}
		return out;
	}

	function handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			close();
			return;
		}
		// Transcript scrolling on keys the single-line Input doesn't consume.
		if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.ctrl("b"))) {
			scroll = Math.max(0, scroll - contentH);
			follow = false;
			rerender();
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.ctrl("f"))) {
			const max = maxScroll();
			scroll = Math.min(max, scroll + contentH);
			follow = scroll >= max;
			rerender();
			return;
		}
		input.handleInput(data);
		invalidate();
		tui.requestRender();
	}

	let lastContentLen = 0;
	function maxScroll(): number {
		return Math.max(0, lastContentLen - contentH);
	}

	function render(width: number): string[] {
		const targetH = panelRows();
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		const innerW = Math.max(20, width);

		const header: string[] = [];
		header.push(rule(innerW));
		const targetLabel = target === "sub" ? "subagent" : "main agent";
		const title =
			theme.bold("Ask · ") +
			theme.fg("text", group.title) +
			theme.fg("dim", `  (${group.paths.length} file${group.paths.length === 1 ? "" : "s"})  ·  ${targetLabel}`);
		for (const h of wrapTextWithAnsi(title, innerW)) header.push(pad(h, innerW));
		header.push(rule(innerW));

		const inputLines = input.render(Math.max(1, innerW - 3));
		const inputRows = Math.max(1, inputLines.length);
		const footerRows = 1;
		const overhead = header.length + 1 /*input divider*/ + inputRows + footerRows;
		contentH = Math.max(1, targetH - overhead);

		const content = transcriptLines(innerW);
		lastContentLen = content.length;
		if (follow) scroll = Math.max(0, content.length - contentH);
		const max = Math.max(0, content.length - contentH);
		scroll = Math.min(Math.max(0, scroll), max);
		const visible = content.slice(scroll, scroll + contentH);

		const lines: string[] = [...header];
		for (let i = 0; i < contentH; i++) {
			lines.push(visible[i] !== undefined ? pad(truncateToWidth(visible[i]!, innerW, "…"), innerW) : pad("", innerW));
		}

		lines.push(rule(innerW));
		for (let i = 0; i < inputRows; i++) {
			const prompt = i === 0 ? theme.fg("accent", "> ") : "  ";
			lines.push(pad(`${prompt}${inputLines[i] ?? ""}`, innerW));
		}

		const hint =
			streaming && streaming.status === "running"
				? "answering… · Enter queues after · Esc close"
				: "type a question · Enter send · PgUp/PgDn scroll · Esc close";
		lines.push(pad(theme.fg("dim", ` ${hint}`), innerW));

		if (lines.length < targetH) {
			const insertAt = header.length + contentH;
			const missing = targetH - lines.length;
			for (let i = 0; i < missing; i++) lines.splice(insertAt, 0, pad("", innerW));
		} else if (lines.length > targetH) {
			lines.length = targetH;
		}

		cachedWidth = width;
		cachedHeight = targetH;
		cachedLines = lines;
		return lines;
	}

	return { render, handleInput, invalidate };
}

export async function runGroupChat(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	group: ReviewGroup,
	diffText: string,
	target: ChatTarget,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			createChatPanel({ pi, ctx, group, diffText, target, tui, theme, keybindings, onDone: done }),
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}
