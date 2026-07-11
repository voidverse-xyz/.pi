/**
 * codex-composer — Codex's composer shortcuts, ported to pi.
 *
 * Codex shows a `?`-toggled shortcuts panel (bottom_pane/footer.rs
 * default_bindings). pi already provides the editor, queueing (Tab), history
 * search, and external editor, so this module adds the Codex shortcuts overlay
 * — an at-a-glance key reference styled like Codex — bound to a command and a
 * shortcut. It does NOT replace pi's editor (that stays fully functional).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type KeybindingsManager, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dim } from "./ansi.ts";

const PLACEHOLDER = "Ask Codex to do anything";

interface Shortcut {
	keys: string;
	desc: string;
}

// Mirrors codex-rs/tui/src/bottom_pane/footer.rs default hint set, mapped to
// pi's actual keybindings where they differ.
const SHORTCUTS: Shortcut[] = [
	{ keys: "Enter", desc: "send message" },
	{ keys: "Tab", desc: "queue message while running" },
	{ keys: "Ctrl+J", desc: "insert newline" },
	{ keys: "Esc", desc: "interrupt / edit previous" },
	{ keys: "Ctrl+T", desc: "show transcript" },
	{ keys: "Ctrl+R", desc: "history search" },
	{ keys: "Ctrl+O", desc: "copy last response" },
	{ keys: "Alt+, / Alt+.", desc: "reasoning effort down / up" },
	{ keys: "@", desc: "mention a file" },
	{ keys: "/", desc: "slash commands" },
];

const COMMANDS: Shortcut[] = [
	{ keys: "/status", desc: "session config & token usage" },
	{ keys: "/diff", desc: "git diff incl. untracked" },
	{ keys: "/review", desc: "review current changes" },
	{ keys: "/plan", desc: "enter Plan Mode" },
	{ keys: "/permissions", desc: "approval & sandbox policy" },
	{ keys: "/agents", desc: "inspect sub-agents" },
	{ keys: "/personality", desc: "communication style" },
	{ keys: "/init", desc: "create AGENTS.md" },
];

function renderPanel(theme: Theme, width: number): string[] {
	const keyW = Math.max(...[...SHORTCUTS, ...COMMANDS].map((s) => s.keys.length));
	const line = (s: Shortcut) => `  ${theme.fg("accent", s.keys.padEnd(keyW))}  ${theme.fg("text", s.desc)}`;
	const out: string[] = [];
	out.push(theme.fg("customMessageLabel", "  Keyboard shortcuts"));
	for (const s of SHORTCUTS) out.push(line(s));
	out.push("");
	out.push(theme.fg("customMessageLabel", "  Slash commands"));
	for (const s of COMMANDS) out.push(line(s));
	out.push("");
	out.push(dim("  press esc to close"));
	return out;
}

/**
 * Codex-style composer: a shaded input block (Codex's user_message_bg =
 * white@12% over the terminal bg, i.e. theme `userMessageBg`) with a bold `›`
 * prompt marker and the "Ask Codex to do anything" placeholder — mirrors
 * codex-rs chat_composer.rs, where the whole composer_rect is filled with
 * user_message_style() and the `›` prompt sits at the left.
 *
 * pi's Editor draws top/bottom `───` rules and unshaded content lines; we
 * replace the rules with shaded blank lines and paint every content line with
 * the background so the block reads as one solid panel, exactly like Codex.
 */
function installCodexEditor(pi: ExtensionAPI, ctx: ExtensionContext) {
	const PAD = 2;
	ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
		const appTheme: Theme = ctx.ui.theme;
		const editor = new CustomEditor(tui, editorTheme, keybindings, { paddingX: PAD });

		// Paint a full-width line with the composer background. Any SGR full
		// reset (\x1b[0m) inside would clear the bg, so rewrite resets to
		// attribute-specific offs (\x1b[27m reverse-off, \x1b[39m fg-default)
		// that leave the background intact (pi's cursor uses \x1b[7m…\x1b[0m).
		const bgLine = (inner: string, width: number): string => {
			const safe = inner.replace(/\x1b\[0m/g, "\x1b[27m\x1b[39m");
			const vis = visibleWidth(safe);
			const padded = vis >= width ? truncateToWidth(safe, width) : safe + " ".repeat(width - vis);
			return appTheme.bg("userMessageBg", padded);
		};

		// Strip the leading paddingX literal spaces (editor.js prefixes each
		// content line with `" ".repeat(paddingX)`); never slice into an escape.
		const stripPad = (line: string): string => {
			let n = 0;
			while (n < PAD && line[n] === " ") n++;
			return line.slice(n);
		};

		const baseRender = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const lines = baseRender(width);
			if (lines.length < 3) return lines;
			// Clamp to the live terminal width — pi hard-crashes on any line
			// wider than the terminal, and `width` can lag during a resize.
			const termCols = (tui as any).terminal?.columns ?? width;
			const w = Math.max(1, Math.min(width, termCols));
			const clip = (line: string): string => (visibleWidth(line) > w ? truncateToWidth(line, w) : line);
			const marker = appTheme.fg("accent", appTheme.bold("›"));

			// Slash/file autocomplete open: pi appends popup lines after the box;
			// don't reflow/repaint them — just add the `›` marker to the input row.
			const acActive =
				typeof (editor as any).isShowingAutocomplete === "function" && (editor as any).isShowingAutocomplete();
			if (acActive) {
				lines[1] = clip(`${marker} ${stripPad(lines[1])}`);
				return lines.map(clip);
			}

			// Idle/typing: paint the shaded Codex composer block.
			const out: string[] = [bgLine("", w)];
			for (let i = 1; i < lines.length - 1; i++) {
				if (i === 1 && editor.getText().length === 0) {
					const cursor = "\x1b[7m \x1b[27m";
					out.push(bgLine(`${marker} ${cursor}${appTheme.fg("dim", PLACEHOLDER)}`, w));
				} else if (i === 1) {
					out.push(bgLine(`${marker} ${stripPad(lines[i])}`, w));
				} else {
					out.push(bgLine(`  ${stripPad(lines[i])}`, w));
				}
			}
			out.push(bgLine("", w));
			return out.map(clip);
		};
		return editor;
	});
}

export function registerCodexComposer(pi: ExtensionAPI) {
	pi.registerMessageRenderer("codex-shortcuts", (_message, _o, theme: Theme) => ({
		render(width: number): string[] {
			return renderPanel(theme, width);
		},
		invalidate() {},
	}));

	const show = () => {
		pi.sendMessage(
			{ customType: "codex-shortcuts", content: "", display: true, details: {} },
			{ triggerTurn: false },
		);
	};

	// Codex has no `/shortcuts` slash command — the `?` key is the entry point
	// (below). We keep the panel + renderer, just not a slash command, so the
	// `/` popup stays 1:1 with Codex.

	// Replace the input box with the Codex-style composer (`›` prompt + placeholder).
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") installCodexEditor(pi, ctx);
	});

	// Codex toggles the panel with `?`; bind it, but only act when the editor
	// is empty so `?` typed mid-message still inserts normally.
	pi.registerShortcut("?", {
		description: "show Codex shortcuts",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			const text = ctx.ui.getEditorText?.() ?? "";
			if (text.trim().length === 0) show();
			else ctx.ui.setEditorText?.(text + "?");
		},
	});
}
