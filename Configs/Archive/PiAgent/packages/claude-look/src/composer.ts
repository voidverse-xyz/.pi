/**
 * claude-look composer — Claude Code's bordered input box:
 *
 *   ╭─────────────────────────────────────────────╮
 *   │ > Try "fix the failing test"                │
 *   ╰─────────────────────────────────────────────╯
 *
 * pi's Editor draws top/bottom `─` rules and unshaded content lines (no side
 * bars). We wrap the content in a rounded box with a `>` prompt. Robustness
 * patterns (clamp to live terminal width, never slice into an ANSI escape,
 * leave the autocomplete popup untouched) match what pi's renderer requires.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type KeybindingsManager, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PLACEHOLDER = 'Try "how does <filepath> work?"';
const PAD = 2;

const SHORTCUTS: [string, string][] = [
	["Enter", "send message"],
	["\\ + Enter", "insert newline"],
	["Tab", "queue message while running"],
	["Esc", "interrupt"],
	["Ctrl+R", "history search"],
	["Ctrl+O", "copy last response"],
	["@", "mention a file"],
	["/", "slash commands"],
];
const COMMANDS: [string, string][] = [
	["/status", "session config & token usage"],
	["/diff", "git diff incl. untracked"],
	["/review", "review current changes"],
	["/plan", "enter Plan Mode"],
	["/permissions", "approval & sandbox policy"],
	["/agent", "inspect sub-agents"],
	["/personality", "communication style"],
	["/init", "create AGENTS.md"],
];

function installClaudeEditor(ctx: ExtensionContext) {
	ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
		const appTheme: Theme = ctx.ui.theme;
		const editor = new CustomEditor(tui, editorTheme, keybindings, { paddingX: PAD });
		const border = (s: string) => appTheme.fg("borderMuted", s);
		editor.borderColor = border;

		const stripPad = (line: string): string => {
			let n = 0;
			while (n < PAD && line[n] === " ") n++;
			return line.slice(n);
		};

		const baseRender = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const lines = baseRender(width);
			if (lines.length < 3) return lines;
			const termCols = (tui as any).terminal?.columns ?? width;
			const w = Math.max(8, Math.min(width, termCols));
			const clip = (s: string) => (visibleWidth(s) > w ? truncateToWidth(s, w) : s);
			const marker = appTheme.fg("accent", appTheme.bold(">"));

			// Claude Code's composer is thin top/bottom rules with a `>` prompt
			// (not a full box). pi's editor already draws the rules; we recolor
			// them gray and inject the `>` marker + placeholder on the input row.
			// This also sidesteps the box-width/ANSI-slicing fragility.
			const injectMarker = (line: string, empty: boolean): string => {
				if (empty) return clip(`${marker} \x1b[7m \x1b[27m${appTheme.fg("dim", PLACEHOLDER)}`);
				return clip(`${marker} ${stripPad(line)}`);
			};
			const acActive = typeof (editor as any).isShowingAutocomplete === "function" && (editor as any).isShowingAutocomplete();
			if (acActive) {
				lines[1] = injectMarker(lines[1], false);
				return lines.map(clip);
			}
			lines[1] = injectMarker(lines[1], editor.getText().length === 0);
			return lines.map(clip);
		};
		return editor;
	});
}

export function registerClaudeComposer(pi: ExtensionAPI) {
	pi.registerMessageRenderer("cpx.shortcuts", (_m, _o, theme: Theme) => ({
		render(): string[] {
			const kw = Math.max(...[...SHORTCUTS, ...COMMANDS].map(([k]) => k.length));
			const line = ([k, d]: [string, string]) => `  ${theme.fg("accent", k.padEnd(kw))}  ${theme.fg("text", d)}`;
			return [
				theme.fg("customMessageLabel", "  Keyboard shortcuts"),
				...SHORTCUTS.map(line),
				"",
				theme.fg("customMessageLabel", "  Slash commands"),
				...COMMANDS.map(line),
				"",
				theme.fg("dim", "  press esc to close"),
			];
		},
		invalidate() {},
	}));

	const show = () => pi.sendMessage({ customType: "cpx.shortcuts", content: "", display: true, details: {} }, { triggerTurn: false });

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") installClaudeEditor(ctx);
	});

	pi.registerShortcut("?", {
		description: "show shortcuts",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			const text = ctx.ui.getEditorText?.() ?? "";
			if (text.trim().length === 0) show();
			else ctx.ui.setEditorText?.(text + "?");
		},
	});
}
