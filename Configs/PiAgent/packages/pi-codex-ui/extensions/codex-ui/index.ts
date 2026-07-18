import {
	CustomEditor,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const TOOL_PATCH = Symbol.for("pi-codex-ui.tool-render-patch");

// Indicator options for the built-in working loader — one is picked at random
// per agent run. The message next to it is core's default; only the glyph
// animation is themed here.
const SPINNERS = [
	{ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
	{ frames: ["▖", "▘", "▝", "▗"], intervalMs: 110 },
	{ frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"], intervalMs: 70 },
	{ frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], intervalMs: 90 },
	{ frames: ["◐", "◓", "◑", "◒"], intervalMs: 120 },
	{ frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"], intervalMs: 90 },
	// Claude Code-style blinking star pulse.
	{ frames: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"], intervalMs: 120 },
] as const;

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function fillBackground(line: string, width: number, backgroundAnsi: string): string {
	const fitted = truncateToWidth(line, Math.max(0, width), "");
	const padded = `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
	// Editor cursors use a full reset. Reapply the field background after one so
	// the remainder of the line stays visually continuous, then end with a full
	// reset so no foreground/style state can leak into the next row.
	return `${backgroundAnsi}${padded.replaceAll(RESET, `${RESET}${backgroundAnsi}`)}${RESET}`;
}

function isEditorBorder(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

class CodexEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly appTheme: Theme,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
	}

	override render(width: number): string[] {
		if (width <= 2) return super.render(width);

		const innerWidth = width - 2;
		const base = super.render(innerWidth);
		let bottomBorder = -1;
		for (let index = base.length - 1; index > 0; index--) {
			if (isEditorBorder(base[index]!)) {
				bottomBorder = index;
				break;
			}
		}
		if (bottomBorder < 1) {
			return base.map((line) => fillBackground(line, width, this.appTheme.getBgAnsi("userMessageBg")));
		}

		const background = this.appTheme.getBgAnsi("userMessageBg");
		const content = base.slice(1, bottomBorder).map((line, index) => {
			const marker = index === 0 ? `${BOLD}›${RESET} ` : "  ";
			return fillBackground(`${marker}${line}`, width, background);
		});
		const autocomplete = base.slice(bottomBorder + 1).map((line) => `  ${line}`);

		return [
			"",
			fillBackground("", width, background),
			...content,
			fillBackground("", width, background),
			"",
			...autocomplete,
		];
	}
}

type ToolExecutionLike = {
	isPartial: boolean;
	getRenderShell(): "default" | "self";
};

type ToolExecutionPrototype = {
	render(width: number): string[];
	[TOOL_PATCH]?: { original: (this: ToolExecutionLike, width: number) => string[] };
};

async function installToolSeparatorPatch(): Promise<(() => void) | undefined> {
	try {
		const cliPath = realpathSync(process.argv[1] ?? "");
		const moduleUrl = pathToFileURL(join(dirname(cliPath), "modes/interactive/components/tool-execution.js")).href;
		const module = await import(moduleUrl) as { ToolExecutionComponent?: { prototype: ToolExecutionPrototype } };
		const prototype = module.ToolExecutionComponent?.prototype;
		if (!prototype) return undefined;

		const existing = prototype[TOOL_PATCH];
		if (existing) return () => {};

		const original = prototype.render;
		prototype.render = function (this: ToolExecutionLike, width: number): string[] {
			const lines = original.call(this, width);
			const shell = this.getRenderShell();
			// Default rows contain both ToolExecutionComponent's leading spacer and
			// the Box's own top padding. Keep the Box padding and remove the duplicate
			// outer row so adjacent tool separators do not create a two-line gap.
			if (shell === "default" && lines.length > 0 && visibleWidth(lines[0] ?? "") === 0) {
				lines.shift();
			}
			if (this.isPartial || lines.length === 0 || width <= 0) return lines;
			// Default Pi tool boxes already end with one padded blank row. Self-shell
			// tools do not, so supply exactly one before the common divider.
			if (shell === "self") lines.push("");
			lines.push(`${DIM}${"─".repeat(width)}${RESET}`);
			return lines;
		};
		prototype[TOOL_PATCH] = { original };

		return () => {
			if (prototype[TOOL_PATCH]?.original !== original) return;
			prototype.render = original;
			delete prototype[TOOL_PATCH];
		};
	} catch {
		return undefined;
	}
}

export default async function codexUi(pi: ExtensionAPI): Promise<void> {
	const restoreToolRenderer = await installToolSeparatorPatch();

	// The working message is core's default (pi-todo renders its own dynamic
	// header inside the todo widget); this extension only themes the loader's
	// glyph animation, picking a random indicator per agent run.
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const spinner = SPINNERS[Math.floor(Math.random() * SPINNERS.length)]!;
		ctx.ui.setWorkingIndicator({
			frames: spinner.frames.map((frame) => ctx.ui.theme.fg("muted", frame)),
			intervalMs: spinner.intervalMs,
		});
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		if (!restoreToolRenderer) {
			ctx.ui.notify("Codex UI could not install its tool separator renderer", "warning");
		}
		ctx.ui.setTheme("codex");
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new CodexEditor(tui, editorTheme, keybindings, ctx.ui.theme),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		restoreToolRenderer?.();
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setHeader(undefined);
	});
}
