/**
 * tui/viewer.ts — the full-screen session viewer (05-tui-spec §3, D8/D17).
 *
 * Header strip:  refactorer/auth · billing-refactor · running · ctx 61% ·
 *                142k · $0.84 · ↻9
 * Transcript:    the agent's REAL Pi session JSONL replayed with Pi's own
 *                components (AssistantMessageComponent / UserMessageComponent
 *                / ToolExecutionComponent), then live-tailed: appended JSONL
 *                is re-read from a byte offset on runtime events + a cheap
 *                1s size poll while the viewer is open.
 * Envelopes:     inter-agent traffic renders as distinct compact entries —
 *                inbound wake digests collapse to `📨 ← main: question "..."`
 *                lines instead of a wall of digest markdown, and the mail
 *                tools (send_message / report / ask) render as
 *                `📨 → refactorer/api: question "..."` instead of a tool box.
 * Input line:    the human is the SUPERUSER (01-power-matrix): Enter = mail
 *                via core.sendAsUser (turn-boundary delivery; the runtime
 *                already drops the D17 FYI report to main), alt+Enter = steer
 *                (immediate injection) — the keyboard mirrors send/steer
 *                (D11/D16). pi-tui Editor quirk respected: onSubmit uses the
 *                SUBMITTED argument, never a getText() readback.
 * Keys:          Esc back · alt+j next agent · x interrupt (only while the
 *                input line is empty, so `x` stays typeable) · PgUp/PgDn +
 *                ctrl+u/ctrl+d scroll.
 * Archived:      transcript view only — no input line, no actions.
 *
 * Imports: core.ts + pi SDK/pi-tui only (06-architecture structural rule).
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ArchivedAgentInfo, SubagentsCore } from "../core.ts";
import type { AgentDetail } from "../runtime/types.ts";

// ---------------------------------------------------------------------------
// Pure formatting (harness-testable)
// ---------------------------------------------------------------------------

export function formatTokensShort(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Header-strip source values (AgentDetail slice, or archived stand-in). */
export interface HeaderInfo {
	address: string;
	/**
	 * The team slot (05 §3: `refactorer/auth · billing-refactor · …` —
	 * billing-refactor is the TEAM, per D12). Comma-joined for multi-team
	 * membership; empty for a solo agent (the slot is omitted). The archived
	 * viewer reuses this slot for its `retired <date>` note.
	 */
	team: string;
	state: string;
	contextPercent: number;
	tokens: number;
	cost: number;
	turns: number;
}

/** `refactorer/auth · billing-refactor · running · ctx 61% · 142k · $0.84 · ↻9` */
export function headerStripText(info: HeaderInfo): string {
	const parts = [info.address];
	if (info.team) parts.push(info.team);
	parts.push(info.state);
	parts.push(`ctx ${Math.round(info.contextPercent)}%`);
	parts.push(formatTokensShort(info.tokens));
	parts.push(`$${info.cost.toFixed(2)}`);
	parts.push(`↻${info.turns}`);
	return parts.join(" · ");
}

/** One compact envelope-traffic entry. */
export interface EnvelopeEntry {
	direction: "in" | "out";
	/** The other party's address. */
	peer: string;
	type: string;
	/** First line of the payload text. */
	preview: string;
}

const PREVIEW_MAX = 80;

function preview(text: string): string {
	const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
	const trimmed = first.trim();
	return trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…` : trimmed;
}

/** `📨 → refactorer/api: question "..."` (05-tui-spec §3). */
export function envelopeEntryText(entry: EnvelopeEntry): string {
	const arrow = entry.direction === "out" ? "→" : "←";
	return `📨 ${arrow} ${entry.peer}: ${entry.type} "${entry.preview}"`;
}

/** True when a user-role prompt is a mail-digest turn, not real user text. */
export function isWakeDigestText(text: string): boolean {
	return text.startsWith("[Wake digest");
}

const DIGEST_ITEM_RE = /^\d+\.\s+(\w+) from `([^`]+)` \((msg_[0-9A-Z]+)\):$/;
const DIGEST_ANSWER_RE = /^`([^`]+)` answered \((msg_[0-9A-Z]+)\):$/;

/**
 * Parse a wake digest (mail/digest.ts composeWakeDigest output) back into
 * compact inbound entries. Best-effort: unrecognized digests still yield the
 * summary entry the caller renders (never throws).
 */
export function parseDigestEntries(text: string): EnvelopeEntry[] {
	const entries: EnvelopeEntry[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		let match = DIGEST_ITEM_RE.exec(line);
		let type: string | undefined;
		let from: string | undefined;
		if (match) {
			type = match[1]!;
			from = match[2]!;
		} else if ((match = DIGEST_ANSWER_RE.exec(line))) {
			type = "answer";
			from = match[1]!;
		}
		if (type === undefined || from === undefined) continue;
		// The payload is the following markdown blockquote.
		const quoted: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const q = lines[j]!;
			if (q.startsWith(">")) quoted.push(q.replace(/^> ?/, ""));
			else break;
		}
		entries.push({ direction: "in", peer: from, type, preview: preview(quoted.join("\n")) });
	}
	return entries;
}

/** The subagent-side mail tools whose calls render as envelope entries. */
export function envelopeEntryForToolCall(name: string, args: Record<string, unknown>): EnvelopeEntry | null {
	if (name === "send_message") {
		return {
			direction: "out",
			peer: typeof args.to === "string" ? args.to : "?",
			type: typeof args.type === "string" ? args.type : "message",
			preview: preview(typeof args.text === "string" ? args.text : ""),
		};
	}
	if (name === "report" || name === "ask") {
		return {
			direction: "out",
			peer: "main",
			type: name === "ask" ? "question" : "report",
			preview: preview(typeof args.text === "string" ? args.text : ""),
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Transcript building
// ---------------------------------------------------------------------------

/** A minimal always-safe line component (envelope entries, notices). */
class LineComponent implements Component {
	private readonly _text: string;
	private readonly _color: (text: string) => string;
	constructor(text: string, color: (text: string) => string) {
		this._text = text;
		this._color = color;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return wrapTextWithAnsi(this._text, width).map((line) => this._color(line));
	}
}

interface TranscriptState {
	components: Component[];
	/** toolCallId → live component, so toolResult entries can attach. */
	toolComponents: Map<string, ToolExecutionComponent>;
}

/**
 * Append the components for ONE parsed session-file line. Exercises the
 * envelope-compaction rules above; everything else goes through Pi's own
 * message components (D7: their session files are real Pi sessions).
 */
export function appendEntryComponents(
	state: TranscriptState,
	raw: unknown,
	tui: TUI,
	theme: Theme,
	cwd: string,
): void {
	const entry = raw as { type?: string; message?: { role?: string; content?: unknown } };
	if (entry.type !== "message" || !entry.message) return;
	const message = entry.message;

	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.map((part) => ((part as { type?: string; text?: string }).type === "text" ? ((part as { text?: string }).text ?? "") : ""))
							.join("")
					: "";
		if (isWakeDigestText(text)) {
			const entries = parseDigestEntries(text);
			if (entries.length === 0) {
				state.components.push(new LineComponent("📨 wake digest", (line) => theme.fg("muted", line)));
			}
			for (const env of entries) {
				state.components.push(new LineComponent(envelopeEntryText(env), (line) => theme.fg("muted", line)));
			}
			return;
		}
		state.components.push(new UserMessageComponent(text));
		return;
	}

	if (message.role === "assistant") {
		// Text/thinking through Pi's own renderer…
		state.components.push(
			new AssistantMessageComponent(message as ConstructorParameters<typeof AssistantMessageComponent>[0]),
		);
		// …tool calls as either envelope entries (mail tools) or tool boxes.
		const content = Array.isArray(message.content) ? message.content : [];
		for (const part of content as Array<Record<string, unknown>>) {
			if (part.type !== "toolCall") continue;
			const name = String(part.name ?? "?");
			const args = (part.arguments ?? {}) as Record<string, unknown>;
			const envelope = envelopeEntryForToolCall(name, args);
			if (envelope) {
				state.components.push(new LineComponent(envelopeEntryText(envelope), (line) => theme.fg("muted", line)));
				continue;
			}
			const tool = new ToolExecutionComponent(name, String(part.id ?? ""), args, undefined, undefined, tui, cwd);
			tool.setArgsComplete();
			state.toolComponents.set(String(part.id ?? ""), tool);
			state.components.push(tool);
		}
		return;
	}

	if (message.role === "toolResult") {
		const result = message as unknown as {
			toolCallId: string;
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError: boolean;
		};
		const tool = state.toolComponents.get(result.toolCallId);
		if (tool) {
			tool.updateResult({ content: result.content, details: result.details, isError: result.isError });
		}
		return;
	}
}

// ---------------------------------------------------------------------------
// Incremental JSONL tail reader
// ---------------------------------------------------------------------------

interface TailReader {
	/** Read any newly-appended complete lines; returns parsed JSON values. */
	poll(): unknown[];
	/** Bytes consumed so far (for the size fast-path check). */
	offset(): number;
}

export function createTailReader(file: string): TailReader {
	let offset = 0;
	let remainder = "";
	return {
		offset: () => offset,
		poll(): unknown[] {
			let size: number;
			try {
				size = statSync(file).size;
			} catch {
				return [];
			}
			if (size <= offset) return [];
			let fd: number;
			try {
				fd = openSync(file, "r");
			} catch {
				return [];
			}
			let chunk: string;
			try {
				const buffer = Buffer.alloc(size - offset);
				const read = readSync(fd, buffer, 0, buffer.length, offset);
				offset += read;
				chunk = buffer.subarray(0, read).toString("utf8");
			} finally {
				closeSync(fd);
			}
			const text = remainder + chunk;
			const lines = text.split("\n");
			remainder = lines.pop() ?? "";
			const parsed: unknown[] = [];
			for (const line of lines) {
				if (line.trim().length === 0) continue;
				try {
					parsed.push(JSON.parse(line));
				} catch {
					// Torn write mid-poll — extremely unlikely given the
					// remainder buffer, but never let it break the viewer.
				}
			}
			return parsed;
		},
	};
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type ViewerResult = { action: "back" } | { action: "next" };

export interface ViewerOptions {
	core: SubagentsCore;
	tui: TUI;
	theme: Theme;
	/** Live agent address (`<type>/<id>`)… */
	address?: string;
	/** …or an archived agent (read-only transcript, no input). */
	archived?: ArchivedAgentInfo;
	onDone: (result: ViewerResult) => void;
}

interface ViewerComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

export function createViewer(options: ViewerOptions): ViewerComponent {
	const { core, tui, theme, onDone } = options;
	const archived = options.archived;
	const address = archived ? archived.address : (options.address ?? "");

	let detail: AgentDetail | null = null;
	let sessionFile: string | null = archived?.sessionFile ?? null;
	let tail: TailReader | null = sessionFile ? createTailReader(sessionFile) : null;
	const transcript: TranscriptState = { components: [], toolComponents: new Map() };
	/** Lines scrolled up from the bottom; 0 = follow the tail. */
	let scrollBack = 0;
	let closed = false;

	// --- input line (live agents only) ---------------------------------------
	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
	const editor = archived ? null : new Editor(tui, editorTheme);
	let notice: string | null = null;

	if (editor) {
		editor.onSubmit = (text) => {
			// QUIRK: submitValue() fires onChange("") BEFORE onSubmit — use the
			// submitted argument only; the editor is already cleared.
			const trimmed = text.trim();
			if (trimmed.length === 0) return;
			void core
				.sendAsUser({ to: address, text: trimmed })
				.then((result) => {
					notice = result.delivery === "delivered" ? "sent (woke a turn)" : "queued for the turn boundary";
					tui.requestRender();
				})
				.catch((error: unknown) => {
					notice = `send failed: ${error instanceof Error ? error.message : String(error)}`;
					tui.requestRender();
				});
		};
	}

	// --- data refresh ---------------------------------------------------------
	const refreshTranscript = (): void => {
		if (!tail) return;
		const entries = tail.poll();
		if (entries.length === 0) return;
		for (const entry of entries) {
			appendEntryComponents(transcript, entry, tui, theme, core.layout.cwd);
		}
		tui.requestRender();
	};

	const refreshDetail = (): void => {
		if (archived) {
			refreshTranscript();
			return;
		}
		// tail:0 = vitals/header + sessionFile ONLY (readTranscriptTail contract:
		// tail <= 0 never reads the transcript). The viewer renders the
		// transcript through its own incremental TailReader, so asking peek for
		// any tail here would be pure wasted I/O on every 1s poll/event.
		void core
			.peek(address, 0)
			.then((next) => {
				if (closed) return;
				detail = next;
				const file = next?.sessionFile ?? null;
				if (file !== null && file !== sessionFile) {
					// New session file (fresh wake): restart the tail.
					sessionFile = file;
					tail = createTailReader(file);
					transcript.components = [];
					transcript.toolComponents.clear();
				}
				refreshTranscript();
				tui.requestRender();
			})
			.catch(() => {});
	};

	const offEvents = archived
		? () => {}
		: core.runtime.onEvent((event) => {
				if ("address" in event && event.address !== address) return;
				refreshDetail();
			});
	const poll = setInterval(() => {
		if (archived) refreshTranscript();
		else refreshDetail();
	}, 1000);
	poll.unref?.();
	refreshDetail();
	refreshTranscript();

	// --- rendering --------------------------------------------------------------
	function headerInfo(): HeaderInfo {
		if (archived) {
			return {
				address,
				team: archived.retiredAt ? `retired ${archived.retiredAt.slice(0, 10)}` : "retired",
				state: "archived",
				contextPercent: 0,
				tokens: 0,
				cost: 0,
				turns: 0,
			};
		}
		return {
			address,
			// D12/05 §3: the slot after the address is the TEAM (solo agents —
			// empty teams — simply omit it; purview is NOT shown here).
			team: (detail?.teams ?? []).join(", "),
			state: detail?.state ?? "…",
			contextPercent: detail?.vitals.contextPercent ?? 0,
			tokens: detail?.vitals.tokens ?? 0,
			cost: detail?.vitals.cost ?? 0,
			turns: detail?.vitals.turns ?? 0,
		};
	}

	function transcriptLines(width: number): string[] {
		const lines: string[] = [];
		for (const component of transcript.components) {
			try {
				lines.push(...component.render(width));
			} catch {
				// One bad entry never blanks the viewer.
			}
		}
		return lines;
	}

	function finish(result: ViewerResult): void {
		if (closed) return;
		closed = true;
		clearInterval(poll);
		offEvents();
		onDone(result);
	}

	function scrollPage(delta: number, page: number): void {
		scrollBack = Math.max(0, scrollBack + delta * page);
		tui.requestRender();
	}

	return {
		invalidate() {},
		dispose() {
			closed = true;
			clearInterval(poll);
			offEvents();
		},
		handleInput(data: string) {
			if (data === "\x1b") {
				finish({ action: "back" });
				return;
			}
			if (matchesKey(data, Key.alt("j"))) {
				finish({ action: "next" });
				return;
			}
			const page = Math.max(4, tui.terminal.rows - 8);
			if (data === "\x1b[5~") return scrollPage(1, page); // PgUp
			if (data === "\x1b[6~") return scrollPage(-1, page); // PgDn
			if (matchesKey(data, Key.ctrl("u"))) return scrollPage(1, Math.floor(page / 2));
			if (matchesKey(data, Key.ctrl("d"))) return scrollPage(-1, Math.floor(page / 2));

			if (archived || !editor) return;

			if (matchesKey(data, Key.alt("enter"))) {
				// Steer: immediate mid-turn injection (D11) — read + clear here;
				// this path never goes through submitValue, so no quirk.
				const text = editor.getText().trim();
				if (text.length === 0) return;
				editor.setText("");
				void core
					.steer(address, text)
					.then((result) => {
						notice = result.steered ? "steered" : "not running — steer dropped (use Enter to mail)";
						tui.requestRender();
					})
					.catch((error: unknown) => {
						notice = `steer failed: ${error instanceof Error ? error.message : String(error)}`;
						tui.requestRender();
					});
				return;
			}
			if (data === "x" && editor.getText().length === 0) {
				void core
					.interrupt(address)
					.then((result) => {
						notice = result.interrupted ? "interrupted" : "not running";
						tui.requestRender();
					})
					.catch(() => {});
				return;
			}
			editor.handleInput(data);
			tui.requestRender();
		},
		render(width: number): string[] {
			const rows = Math.max(12, tui.terminal.rows);
			const lines: string[] = [];
			// Header strip (fg-only, one style wrap per line).
			lines.push(theme.fg("accent", truncateToWidth(` ${headerStripText(headerInfo())}`, width)));
			lines.push(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));

			const editorLines = editor ? editor.render(width) : [];
			const hintText = archived
				? " archived · read-only · esc back · alt+j next"
				: " enter mail · alt+enter steer · x interrupt · esc back · alt+j next";
			const hint = notice
				? theme.fg("warning", truncateToWidth(` ${notice}`, width))
				: theme.fg("dim", truncateToWidth(hintText, width));
			const bodyHeight = Math.max(3, rows - 2 - editorLines.length - 1);

			const all = transcriptLines(width);
			scrollBack = Math.min(scrollBack, Math.max(0, all.length - bodyHeight));
			const end = all.length - scrollBack;
			const start = Math.max(0, end - bodyHeight);
			const body = all.slice(start, end);
			while (body.length < bodyHeight) body.push("");
			lines.push(...body);

			lines.push(...editorLines);
			lines.push(hint);
			return lines;
		},
	};
}
