import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
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
const WORKING_TICK_MS = 200;

const WORKING_LABELS = [
	"working", "thinking", "processing", "building", "checking", "analyzing",
	"running", "crafting", "investigating", "computing", "reviewing", "assembling",
] as const;

const SPINNERS = [
	{ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
	{ frames: ["▖", "▘", "▝", "▗"], intervalMs: 110 },
	{ frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"], intervalMs: 70 },
	{ frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], intervalMs: 90 },
	{ frames: ["◐", "◓", "◑", "◒"], intervalMs: 120 },
	{ frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"], intervalMs: 90 },
] as const;

function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count / 1_000)}k`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, ms) / 1_000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function estimateMessageTokens(message: unknown): number {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return 0;
	let characters = 0;
	for (const part of content) {
		const item = part as { type?: unknown; text?: unknown; thinking?: unknown; arguments?: unknown };
		if (item.type === "text" && typeof item.text === "string") characters += item.text.length;
		else if (item.type === "thinking" && typeof item.thinking === "string") characters += item.thinking.length;
		else if (item.type === "toolCall" && item.arguments !== undefined) {
			try { characters += JSON.stringify(item.arguments).length; } catch { /* best-effort estimate */ }
		}
	}
	return Math.ceil(characters / 4);
}

function exactOutputTokens(message: unknown): number | undefined {
	const output = (message as { usage?: { output?: unknown } })?.usage?.output;
	return typeof output === "number" && output > 0 ? output : undefined;
}

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
	let activeCtx: ExtensionContext | undefined;
	let workingStartedAt: number | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let turnOutputTokens = 0;
	let tokenCountIsExact = false;
	let workingLabel = "working";

	const renderWorkingMessage = (ctx: ExtensionContext): void => {
		if (workingStartedAt === undefined || ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const capitalizedLabel = `${workingLabel.charAt(0).toUpperCase()}${workingLabel.slice(1)}`;
		const label = theme.fg("muted", capitalizedLabel);
		const separator = theme.fg("borderMuted", "·");
		const elapsed = theme.fg("dim", formatElapsed(Date.now() - workingStartedAt));
		let tokenSuffix = "";
		if (turnOutputTokens >= 1) {
			const estimateMark = tokenCountIsExact ? "" : "~";
			const tokens = theme.fg("thinkingText", `${estimateMark}${formatTokenCount(turnOutputTokens)} token`);
			tokenSuffix = ` ${separator} ${tokens}`;
		}
		ctx.ui.setWorkingMessage(`${label} ${separator} ${elapsed}${tokenSuffix}`);
	};

	const stopWorkingTimer = (): void => {
		if (workingTimer) clearInterval(workingTimer);
		workingTimer = undefined;
		workingStartedAt = undefined;
		workingLabel = "working";
	};

	pi.on("agent_start", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode !== "tui" || workingStartedAt !== undefined) return;
		workingStartedAt = Date.now();
		turnOutputTokens = 0;
		tokenCountIsExact = false;
		workingLabel = WORKING_LABELS[Math.floor(Math.random() * WORKING_LABELS.length)]!;
		const spinner = SPINNERS[Math.floor(Math.random() * SPINNERS.length)]!;
		ctx.ui.setWorkingIndicator({
			frames: spinner.frames.map((frame) => ctx.ui.theme.fg("muted", frame)),
			intervalMs: spinner.intervalMs,
		});
		renderWorkingMessage(ctx);
		workingTimer = setInterval(() => {
			if (activeCtx) renderWorkingMessage(activeCtx);
		}, WORKING_TICK_MS);
		workingTimer.unref?.();
	});

	pi.on("turn_start", (_event, ctx) => {
		turnOutputTokens = 0;
		tokenCountIsExact = false;
		renderWorkingMessage(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		const exact = exactOutputTokens(event.message);
		turnOutputTokens = exact ?? estimateMessageTokens(event.message);
		tokenCountIsExact = exact !== undefined;
		renderWorkingMessage(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const exact = exactOutputTokens(event.message);
		if (exact !== undefined) {
			turnOutputTokens = exact;
			tokenCountIsExact = true;
			renderWorkingMessage(ctx);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		stopWorkingTimer();
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
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
		stopWorkingTimer();
		activeCtx = undefined;
		restoreToolRenderer?.();
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setHeader(undefined);
	});
}
