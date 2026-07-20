/**
 * tui/viewer.ts — full-screen session viewer (D22). Replays a subagent's
 * Pi-native JSONL through Pi's OWN transcript components (D7), with a header
 * strip of live vitals and a superuser input line (Enter = mail at the turn
 * boundary; alt+Enter = steer — the send/steer split, D11/D17). A quiet FYI
 * report goes to main on every superuser send (handled in the runtime).
 *
 * v2 is deliberately leaner than v1's byte-offset live-tail: it re-reads the
 * session file on a poll + on runtime events and rebuilds components. Robust
 * (no torn-line handling), at the cost of redundant parse work on large
 * sessions — fine for a human-driven overlay.
 */

import { readFileSync } from "node:fs";
import {
	AssistantMessageComponent,
	parseSessionEntries,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { SubagentsCore } from "../core.ts";
import { flattenMessageContent } from "../text.ts";

interface Component {
	render(width: number): string[];
}

export type ViewerResult = { action: "back" } | { action: "next" };

export interface ViewerOptions {
	core: SubagentsCore;
	tui: TUI;
	theme: Theme;
	address: string;
	cwd: string;
	onDone: (result: ViewerResult) => void;
}

interface ViewerComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

/** Build transcript components from a session file's message entries. */
function buildComponents(sessionFile: string | null, tui: TUI, cwd: string): Component[] {
	if (!sessionFile) return [];
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const components: Component[] = [];
	const toolComponents = new Map<string, ToolExecutionComponent>();
	for (const raw of parseSessionEntries(content)) {
		const entry = raw as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			components.push(new UserMessageComponent(flattenMessageContent(message.content)));
		} else if (message.role === "assistant") {
			components.push(new AssistantMessageComponent(message as ConstructorParameters<typeof AssistantMessageComponent>[0]));
			for (const part of Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []) {
				if (part.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(String(part.name ?? "?"), String(part.id ?? ""), (part.arguments ?? {}) as Record<string, unknown>, undefined, undefined, tui, cwd);
				tool.setArgsComplete();
				toolComponents.set(String(part.id ?? ""), tool);
				components.push(tool);
			}
		} else if (message.role === "toolResult") {
			const result = message as unknown as { toolCallId: string; content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean };
			toolComponents.get(result.toolCallId)?.updateResult({ content: result.content, details: result.details, isError: result.isError });
		}
	}
	return components;
}

export function createViewer(options: ViewerOptions): ViewerComponent {
	const { core, tui, theme, address, cwd, onDone } = options;
	let components: Component[] = [];
	let header = address;
	let input = "";
	let closed = false;

	let headerMeta = "";

	const reload = (): void => {
		void core.peek(address, 500).then((detail) => {
			if (closed || !detail) return;
			components = buildComponents(detail.sessionFile, tui, cwd);
			const v = detail.vitals;
			const pct = v.ctxPercent !== null ? ` · ctx ${Math.round(v.ctxPercent)}%` : "";
			header = detail.label ? `${detail.address} “${detail.label}”` : detail.address;
			headerMeta = ` · ${detail.state}${pct} · ${v.tokens} tok · ${v.turns} turns`;
			tui.requestRender();
		}).catch(() => {});
	};

	const offEvents = core.onEvent(() => reload());
	const timer = setInterval(reload, 1000);
	timer.unref?.();
	reload();

	function finish(result: ViewerResult): void {
		if (closed) return;
		closed = true;
		offEvents();
		clearInterval(timer);
		onDone(result);
	}

	function submit(steer: boolean): void {
		const text = input.trim();
		input = "";
		if (text.length === 0) return tui.requestRender();
		if (steer) void core.steer(address, text).catch(() => {});
		else void core.sendAsUser({ to: address, text }).catch(() => {});
		reload();
	}

	return {
		invalidate() {},
		dispose() {
			closed = true;
			offEvents();
			clearInterval(timer);
		},
		render(width: number): string[] {
			// Muted codex treatment: bold address (like a selected row), dim metadata,
			// full-width rules in Pi's own separator color ("border" — dim in codex).
			const rule = theme.fg("border", "─".repeat(Math.max(0, width)));
			const lines: string[] = [theme.bold(theme.fg("text", header)) + theme.fg("dim", headerMeta), rule];
			for (const component of components) lines.push(...component.render(width));
			lines.push(rule);
			lines.push(`${theme.fg("accent", "› ")}${input}${theme.fg("dim", "▏")}`);
			lines.push(theme.fg("dim", "  enter message · alt+enter steer · alt+j next · esc back"));
			return lines;
		},
		handleInput(data: string) {
			if (data === "\x1b") return finish({ action: "back" });
			if (data === "\x1bj") return finish({ action: "next" }); // alt+j
			if (data === "\x1b\r" || data === "\x1b\n") return submit(true); // alt+Enter = steer
			if (data === "\r" || data === "\n") return submit(false);
			if (data === "\x7f" || data === "\b") {
				input = input.slice(0, -1);
				return tui.requestRender();
			}
			// Printable input only (ignore other escape sequences).
			// eslint-disable-next-line no-control-regex
			if (!/^[\x00-\x1f]/.test(data)) {
				input += data;
				tui.requestRender();
			}
		},
	};
}
