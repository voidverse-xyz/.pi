import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
	ToolExecutionComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const TOOL_PATCH = Symbol.for("void-agent.tool-render-patch");
const SUPPORTED_PI_VERSIONS = new Set(["0.80.10", "0.81.0", "0.81.1", "0.83.0", "0.84.2", "0.85.1", "1.0.4"]);
const WORKING_TICK_MS = 200;
const CONFIG_PATH = join(getAgentDir(), "void-agent.json");

interface ThemeConfig {
	/** Pi owns theme selection; seed the default only on the first run. */
	themeInitialized: boolean;
}

function loadThemeConfig(): ThemeConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
		// Legacy animation settings may remain in this file; they are ignored.
		return { themeInitialized: raw.themeInitialized === true };
	} catch {
		return { themeInitialized: false };
	}
}

function saveThemeConfig(config: ThemeConfig): boolean {
	const temporary = `${CONFIG_PATH}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, CONFIG_PATH);
		return true;
	} catch {
		try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
		return false;
	}
}

const WORKING_LABELS = [
	"working", "thinking", "processing", "building", "checking", "analyzing",
	"running", "crafting", "investigating", "computing", "reviewing", "assembling",
] as const;

// Pi's public loader API owns placement, rendering, and frame timing.
const SPINNERS = [
	{ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
	{ frames: ["▖", "▘", "▝", "▗"], intervalMs: 110 },
	{ frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"], intervalMs: 70 },
	{ frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], intervalMs: 90 },
	{ frames: ["◐", "◓", "◑", "◒"], intervalMs: 120 },
	{ frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"], intervalMs: 90 },
	{ frames: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"], intervalMs: 120 },
] as const;

function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
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
	// Cursor resets must not break the editor's background or leak styling.
	return `${backgroundAnsi}${padded.replaceAll(RESET, `${RESET}${backgroundAnsi}`)}${RESET}`;
}

function isEditorBorder(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

class VoidAgentEditor extends CustomEditor {
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
			"", fillBackground("", width, background), ...content,
			fillBackground("", width, background), "", ...autocomplete,
		];
	}
}

type ToolExecutionLike = {
	isPartial: boolean;
	getRenderShell(): "default" | "self";
};
type RenderFn = (width: number) => string[];
type RenderPatch = { original: RenderFn; patched: RenderFn };
type PiRenderTarget = {
	render: RenderFn;
	[marker: symbol]: RenderPatch | undefined;
};

function patchRenderTarget(
	target: PiRenderTarget | undefined,
	marker: symbol,
	wrap: (original: RenderFn) => RenderFn,
): (() => void) | undefined {
	if (!SUPPORTED_PI_VERSIONS.has(VERSION) || !target || typeof target.render !== "function") return undefined;
	if (target[marker]) return () => {};
	const original = target.render;
	const patched = wrap(original);
	target.render = patched;
	target[marker] = { original, patched };
	return () => {
		const state = target[marker];
		if (!state || target.render !== state.patched) return;
		target.render = state.original;
		delete target[marker];
	};
}

function installToolSeparatorPatch(): (() => void) | undefined {
	return patchRenderTarget(
		ToolExecutionComponent.prototype as unknown as PiRenderTarget,
		TOOL_PATCH,
		(original) => function (this: ToolExecutionLike, width: number): string[] {
			const lines = original.call(this, width);
			const shell = this.getRenderShell();
			// Keep the Box padding, but remove the duplicate outer spacer.
			if (shell === "default" && lines.length > 0 && visibleWidth(lines[0] ?? "") === 0) lines.shift();
			if (this.isPartial || lines.length === 0 || width <= 0) return lines;
			// Self-shell tools lack the default Box's bottom padding.
			if (shell === "self") lines.push("");
			lines.push(`${DIM}${"─".repeat(width)}${RESET}`);
			return lines;
		},
	);
}

export default function voidAgent(pi: ExtensionAPI): void {
	const restoreToolRenderer = installToolSeparatorPatch();
	let { themeInitialized } = loadThemeConfig();
	let activeCtx: ExtensionContext | undefined;
	let workingStartedAt: number | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	// Finalized assistant messages plus the currently streaming one.
	let doneTokens = 0;
	let streamingTokens = 0;
	let workingLabel = "working";

	const renderWorkingMessage = (ctx: ExtensionContext): void => {
		if (workingStartedAt === undefined || ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const capitalizedLabel = `${workingLabel.charAt(0).toUpperCase()}${workingLabel.slice(1)}`;
		const outputTokens = doneTokens + streamingTokens;
		const stats = [formatElapsed(Date.now() - workingStartedAt)];
		if (outputTokens > 0) stats.push(`↓ ${formatTokenCount(outputTokens)} tokens`);
		ctx.ui.setWorkingMessage(
			`${theme.fg("text", `${capitalizedLabel}…`)} ${theme.fg("dim", `(${stats.join(" · ")})`)}`,
		);
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
		doneTokens = 0;
		streamingTokens = 0;
		workingLabel = WORKING_LABELS[Math.floor(Math.random() * WORKING_LABELS.length)]!;
		const spinner = SPINNERS[Math.floor(Math.random() * SPINNERS.length)]!;
		ctx.ui.setWorkingIndicator({
			frames: spinner.frames.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: spinner.intervalMs,
		});
		renderWorkingMessage(ctx);
		workingTimer = setInterval(() => {
			if (activeCtx) renderWorkingMessage(activeCtx);
		}, WORKING_TICK_MS);
		workingTimer.unref?.();
	});

	pi.on("message_update", (event, ctx) => {
		streamingTokens = exactOutputTokens(event.message) ?? estimateMessageTokens(event.message);
		renderWorkingMessage(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		doneTokens += exactOutputTokens(event.message) ?? estimateMessageTokens(event.message);
		streamingTokens = 0;
		renderWorkingMessage(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		stopWorkingTimer();
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode !== "tui") return;
		if (!restoreToolRenderer) ctx.ui.notify("Void Agent could not install its tool separator renderer", "warning");
		if (!themeInitialized) {
			ctx.ui.setTheme("void-agent");
			themeInitialized = true;
			saveThemeConfig({ themeInitialized });
		}
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new VoidAgentEditor(tui, editorTheme, keybindings, ctx.ui.theme),
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
