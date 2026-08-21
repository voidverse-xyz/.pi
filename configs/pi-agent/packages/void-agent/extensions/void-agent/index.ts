import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	InteractiveMode,
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
const RESET_FG = "\x1b[39m";
const TOOL_PATCH = Symbol.for("void-agent.tool-render-patch");
const WORKING_HOST_PATCH = Symbol.for("void-agent.working-host-patch");
const WORKING_INDICATOR_PATCH = Symbol.for("void-agent.working-indicator-patch");
const SUPPORTED_PI_VERSIONS = new Set(["0.80.10", "0.81.0", "0.81.1", "0.83.0", "0.84.2"]);
const WORKING_TICK_MS = 200;
const ANIMATION_CONFIG_PATH = join(getAgentDir(), "void-agent.json");
const DEFAULT_ANIMATION_CONFIG = {
	workingAnimation: false,
	matrix: false,
	themeInitialized: false,
} satisfies AnimationConfig;

interface AnimationConfig {
	workingAnimation: boolean;
	matrix: boolean;
	/**
	 * Whether the one-time default theme has been applied. Pi owns theme
	 * selection + persistence (its native picker writes settings.theme), so we
	 * only seed `void-agent` on the very first run and never override the user's
	 * choice afterwards — see the session_start handler.
	 */
	themeInitialized: boolean;
}

function loadAnimationConfig(): AnimationConfig {
	try {
		const raw = JSON.parse(readFileSync(ANIMATION_CONFIG_PATH, "utf8")) as Record<string, unknown>;
		return {
			workingAnimation: typeof raw.workingAnimation === "boolean" ? raw.workingAnimation : DEFAULT_ANIMATION_CONFIG.workingAnimation,
			matrix: typeof raw.matrix === "boolean" ? raw.matrix : DEFAULT_ANIMATION_CONFIG.matrix,
			themeInitialized: typeof raw.themeInitialized === "boolean" ? raw.themeInitialized : DEFAULT_ANIMATION_CONFIG.themeInitialized,
		};
	} catch {
		return { ...DEFAULT_ANIMATION_CONFIG };
	}
}

function saveAnimationConfig(config: AnimationConfig): boolean {
	const temporary = `${ANIMATION_CONFIG_PATH}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(ANIMATION_CONFIG_PATH), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, ANIMATION_CONFIG_PATH);
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

// Indicator options for the built-in working loader — one is picked at random
// per agent run.
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

/** `62.3k`-style token count: one decimal up to 1M, then an M suffix. */
function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `21m 29s`-style elapsed time with hours support, whole seconds throughout. */
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

type Rgb = [number, number, number];

/** Extract the RGB channels from a truecolor `38;2;r;g;b` / `48;2;r;g;b` ANSI sequence. */
function parseAnsiRgb(ansi: string): Rgb | undefined {
	const match = ansi.match(/[34]8;2;(\d+);(\d+);(\d+)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function bgAnsi([r, g, b]: Rgb): string {
	return `\x1b[48;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
}

function fgAnsi([r, g, b]: Rgb): string {
	return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
}

const BLACK: Rgb = [0, 0, 0];
const MATRIX_ROWS = 3;
const MATRIX_GLYPHS = ["0", "1", "ｱ", "ｲ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｸ", "ｹ", "ｺ", "ｻ", "ｼ", "ｽ", "ｾ", "ｿ"] as const;

interface MatrixCell {
	glyph: string;
	foreground: string;
}

interface MatrixRain {
	cell(t: number, col: number, row: number): MatrixCell | undefined;
}

function hashUnit(value: number): number {
	const hashed = Math.sin(value * 12.9898) * 43_758.5453;
	return hashed - Math.floor(hashed);
}

function makeMatrixRain(theme: Theme): MatrixRain {
	const seed = Math.floor(Math.random() * 1_000_000);
	const green = parseAnsiRgb(theme.getFgAnsi("success"));
	const foregrounds = green
		? [fgAnsi(green), fgAnsi(mixRgb(BLACK, green, 0.58)), fgAnsi(mixRgb(BLACK, green, 0.3))]
		: [theme.getFgAnsi("success"), theme.getFgAnsi("success"), theme.getFgAnsi("success")];

	return {
		cell(t, col, row) {
			const key = col + seed;
			// Keep the rain sparse enough that the status remains the visual focus.
			if (hashUnit(key * 0.754_877_666) > 0.34) return undefined;
			const step = 90 + Math.floor(hashUnit(key * 1.317) * 100);
			const cycle = MATRIX_ROWS + 3 + Math.floor(hashUnit(key * 2.417) * 3);
			const offset = Math.floor(hashUnit(key * 3.137) * cycle * step);
			const frame = Math.floor((t + offset) / step);
			const head = frame % cycle;
			const trail = head - row;
			if (trail < 0 || trail > 2) return undefined;
			const glyphIndex = Math.floor(hashUnit(key * 5.713 + frame * 0.371) * MATRIX_GLYPHS.length);
			return {
				glyph: MATRIX_GLYPHS[glyphIndex]!,
				foreground: foregrounds[trail]!,
			};
		},
	};
}

const TAU = Math.PI * 2;

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

/** Interpolate through a color list, wrapping smoothly at the ends. */
function gradientAt(colors: Rgb[], position: number): Rgb {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * colors.length;
	const index = Math.floor(scaled) % colors.length;
	return mixRgb(colors[index]!, colors[(index + 1) % colors.length]!, scaled - Math.floor(scaled));
}

interface LineBgStyle {
	/** Uniform background under the text portion of the line. */
	text(t: number): Rgb;
	/** Per-column background for the empty runway to the right of the text. */
	pad(t: number, col: number, textWidth: number, width: number): Rgb;
	/** Sparse green character rain layered over the animated background. */
	matrix?: MatrixRain;
}

/**
 * Build a random full-line background animation, or undefined when the theme
 * is not truecolor. One style is picked per agent run; every style moves over
 * the full range from black to the theme's prompt-field gray (`userMessageBg`).
 * If that background is unavailable, use a darkened accent as a safe fallback.
 */
function makeLineBgStyle(theme: Theme, matrixEnabled: boolean): LineBgStyle | undefined {
	// 256-color themes cannot render smooth per-column blends.
	if (theme.getColorMode() !== "truecolor") return undefined;
	const themeAccent = parseAnsiRgb(theme.getFgAnsi("accent"));
	const gray = parseAnsiRgb(theme.getBgAnsi("userMessageBg"))
		?? (themeAccent ? mixRgb(BLACK, themeAccent, 0.35) : undefined);
	if (!gray) return undefined;

	const breathe = ((): LineBgStyle => {
		const period = randomBetween(2_200, 3_400);
		const level = (t: number) => mixRgb(BLACK, gray, 0.5 - 0.5 * Math.cos((t / period) * TAU));
		return { text: level, pad: (t) => level(t) };
	})();

	const aurora = ((): LineBgStyle => {
		const period = randomBetween(7_000, 11_000);
		const spread = randomBetween(0.25, 0.6);
		// gradientAt wraps, so [black, gray] cycles black → gray → black.
		const at = (t: number, offset: number) => gradientAt([BLACK, gray], t / period + offset);
		return {
			text: (t) => at(t, 0),
			pad: (t, col, _textWidth, width) => at(t, (col / Math.max(1, width)) * spread),
		};
	})();

	const comet = ((): LineBgStyle => {
		const period = randomBetween(2_400, 3_600);
		const reverse = Math.random() < 0.5;
		return {
			text: () => BLACK,
			pad: (t, col, textWidth, width) => {
				const runway = Math.max(1, width - textWidth);
				const phase = (t % period) / period;
				const center = textWidth + (reverse ? 1 - phase : phase) * runway;
				const glow = Math.exp(-(((col - center) / 6) ** 2));
				return mixRgb(BLACK, gray, glow);
			},
		};
	})();

	const shimmer = ((): LineBgStyle => {
		const wavelength = randomBetween(10, 18);
		const speed = randomBetween(140, 220);
		return {
			text: (t) => mixRgb(BLACK, gray, 0.5 + 0.5 * Math.sin(t / speed)),
			pad: (t, col) => mixRgb(BLACK, gray, 0.5 + 0.5 * Math.sin(col / wavelength - t / speed)),
		};
	})();

	const styles = [breathe, aurora, comet, shimmer];
	const matrix = matrixEnabled ? makeMatrixRain(theme) : undefined;
	return { ...styles[Math.floor(Math.random() * styles.length)]!, matrix };
}

function trimRenderPadding(line: string): string {
	// Pi's Text renderer pads every content row to the requested width. Remove
	// only those trailing cells so the animated runway remains measurable.
	return line.replace(/ +$/u, "");
}

function collapseStatusLines(lines: string[]): string {
	// Loader text may wrap before this patch sees it. Rejoin wrapped rows, dropping
	// only each continuation row's renderer-added left margin, then let the final
	// paint step truncate the status to one row so the block stays three lines.
	return lines
		.map(trimRenderPadding)
		.filter((line) => visibleWidth(line) > 0)
		.map((line, index) => index === 0 ? line : line.replace(/^ +/u, ""))
		.join(" ");
}

/**
 * Paint animated background cells for columns `startCol..width`: one space (or
 * matrix glyph) per column over the per-column background from `bgFor`,
 * emitting each bg code only when it changes from the previous column.
 */
function paintCellRun(
	style: LineBgStyle,
	t: number,
	row: 0 | 1 | 2,
	startCol: number,
	width: number,
	bgFor: (col: number) => Rgb,
): string {
	let out = "";
	let previous = "";
	for (let col = startCol; col < width; col++) {
		const code = bgAnsi(bgFor(col));
		const prefix = code === previous ? "" : code;
		const matrix = style.matrix?.cell(t, col, row);
		out += matrix
			? `${prefix}${matrix.foreground}${matrix.glyph}${RESET_FG}`
			: `${prefix} `;
		previous = code;
	}
	return out;
}

/**
 * Repaint one rendered working-indicator line with a full-width animated
 * background: a uniform tint under the text, per-column animation across the
 * empty remainder. Inner full resets re-apply the text tint so embedded
 * styling (label pill, dim stats) stays visually continuous.
 */
function paintStatusLine(line: string, width: number, style: LineBgStyle, t: number): string {
	const fitted = truncateToWidth(trimRenderPadding(line), width, "");
	const textWidth = visibleWidth(fitted);
	const textBg = bgAnsi(style.text(t));
	const text = `${textBg}${fitted.replaceAll(RESET, `${RESET}${textBg}`)}`;
	const runway = paintCellRun(style, t, 1, textWidth, width, (col) => style.pad(t, col, textWidth, width));
	return `${text}${runway}${RESET}`;
}

/**
 * A text-free padding row for above/below the status text. Uses the text tint
 * over the first `textWidth` columns so the animated runway lines up
 * vertically with the painted text row.
 */
function paintPaddingLine(width: number, style: LineBgStyle, t: number, textWidth: number, row: 0 | 2): string {
	const cells = paintCellRun(style, t, row, 0, width, (col) =>
		col < textWidth ? style.text(t) : style.pad(t, col, textWidth, width),
	);
	return `${cells}${RESET}`;
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

// Current full-line background animation; set per agent run, cleared when the
// run settles. The patched render below reads it on every frame. This state is
// process-global because Pi exposes one shared InteractiveMode class to all
// extensions, including through the standalone binary's virtual module.
let activeLineBg: LineBgStyle | undefined;
let activeLineBgStartedAt = 0;

type RenderFn = (width: number) => string[];
type RenderPatch = { original: RenderFn; patched: RenderFn };

type PiRenderTarget = {
	render: RenderFn;
	[marker: symbol]: RenderPatch | undefined;
};

type WorkingIndicatorLike = PiRenderTarget & {
	kind?: unknown;
};

type ShowStatusIndicatorFn = (this: unknown, indicator: WorkingIndicatorLike) => void;

type InteractiveModeInternals = {
	showStatusIndicator?: ShowStatusIndicatorFn;
	[WORKING_HOST_PATCH]?: {
		original: ShowStatusIndicatorFn;
		patched: ShowStatusIndicatorFn;
		indicators: Set<WorkingIndicatorLike>;
	};
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

function wrapWorkingRender(original: RenderFn): RenderFn {
	return function (this: unknown, width: number): string[] {
		const lines = original.call(this, width);
		const style = activeLineBg;
		if (!style || width <= 0) return lines;
		const t = Math.max(0, Date.now() - activeLineBgStartedAt);
		// Repaint the content rows and wrap them in tinted padding rows so the
		// indicator becomes a three-line background block with the status text
		// centered. The loader's leading blank spacer row stays untinted.
		const content = collapseStatusLines(lines.filter((line) => line !== ""));
		const textWidth = visibleWidth(truncateToWidth(content, width, ""));
		const top = paintPaddingLine(width, style, t, textWidth, 0);
		const bottom = paintPaddingLine(width, style, t, textWidth, 2);
		return ["", top, paintStatusLine(content, width, style, t), bottom];
	};
}

/**
 * Pi does not export WorkingStatusIndicator, but it does export the exact
 * InteractiveMode class used by both npm and standalone builds. Intercept each
 * working indicator as the host installs it, then patch that instance's render
 * method. This preserves Pi's native status-container placement without
 * resolving private files beside the executable.
 */
function installWorkingBgPatch(): (() => void) | undefined {
	if (!SUPPORTED_PI_VERSIONS.has(VERSION)) return undefined;
	const prototype = InteractiveMode.prototype as unknown as InteractiveModeInternals;
	if (prototype[WORKING_HOST_PATCH]) return () => {};

	const original = prototype.showStatusIndicator;
	if (typeof original !== "function") return undefined;

	const indicators = new Set<WorkingIndicatorLike>();
	const patched: ShowStatusIndicatorFn = function (indicator): void {
		if (indicator?.kind === "working" && typeof indicator.render === "function") {
			const restore = patchRenderTarget(indicator, WORKING_INDICATOR_PATCH, wrapWorkingRender);
			if (restore) indicators.add(indicator);
		}
		original.call(this, indicator);
	};

	prototype.showStatusIndicator = patched;
	prototype[WORKING_HOST_PATCH] = { original, patched, indicators };

	return () => {
		const state = prototype[WORKING_HOST_PATCH];
		if (!state || prototype.showStatusIndicator !== state.patched) return;
		prototype.showStatusIndicator = state.original;
		for (const indicator of state.indicators) {
			const renderState = indicator[WORKING_INDICATOR_PATCH];
			if (!renderState || indicator.render !== renderState.patched) continue;
			indicator.render = renderState.original;
			delete indicator[WORKING_INDICATOR_PATCH];
		}
		delete prototype[WORKING_HOST_PATCH];
	};
}

function installToolSeparatorPatch(): (() => void) | undefined {
	return patchRenderTarget(
		ToolExecutionComponent.prototype as unknown as PiRenderTarget,
		TOOL_PATCH,
		(original) => function (this: ToolExecutionLike, width: number): string[] {
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
		},
	);
}

export default function voidAgent(pi: ExtensionAPI): void {
	const restoreToolRenderer = installToolSeparatorPatch();
	const restoreWorkingBg = installWorkingBgPatch();
	const animationConfig = loadAnimationConfig();
	let workingAnimationEnabled = animationConfig.workingAnimation;
	let matrixEnabled = animationConfig.matrix;
	let themeInitialized = animationConfig.themeInitialized;
	let activeCtx: ExtensionContext | undefined;
	let workingStartedAt: number | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	// Output tokens this agent run: finalized assistant messages + the streaming one.
	let doneTokens = 0;
	let streamingTokens = 0;
	let workingLabel = "working";

	const renderWorkingMessage = (ctx: ExtensionContext): void => {
		if (workingStartedAt === undefined || ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const capitalizedLabel = `${workingLabel.charAt(0).toUpperCase()}${workingLabel.slice(1)}`;
		// Accent spinner + text-colored label, stats in dim parentheses:
		// `Building… (21m 29s · ↓ 62.3k tokens)`. Tokens are cumulative for the
		// whole run and hidden until the first ones arrive.
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

	const refreshWorkingAnimation = (ctx: ExtensionContext): void => {
		if (workingStartedAt === undefined) return;
		if (!workingAnimationEnabled || !restoreWorkingBg) {
			activeLineBg = undefined;
			activeLineBgStartedAt = 0;
		} else {
			activeLineBgStartedAt = Date.now();
			activeLineBg = makeLineBgStyle(ctx.ui.theme, matrixEnabled);
		}
		renderWorkingMessage(ctx);
	};

	const refreshMatrix = (ctx: ExtensionContext): void => {
		if (activeLineBg) activeLineBg.matrix = matrixEnabled ? makeMatrixRain(ctx.ui.theme) : undefined;
		renderWorkingMessage(ctx);
	};

	pi.on("agent_start", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode !== "tui" || workingStartedAt !== undefined) return;
		workingStartedAt = Date.now();
		activeLineBgStartedAt = workingStartedAt;
		doneTokens = 0;
		streamingTokens = 0;
		workingLabel = WORKING_LABELS[Math.floor(Math.random() * WORKING_LABELS.length)]!;
		activeLineBg = restoreWorkingBg && workingAnimationEnabled
			? makeLineBgStyle(ctx.ui.theme, matrixEnabled)
			: undefined;
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
		activeLineBg = undefined;
		activeLineBgStartedAt = 0;
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
	});

	const toggleCompletions = (prefix: string) => ["on", "off", "status"]
		.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
		.map((value) => ({ value, label: value }));
	const toggleValue = (args: string, current: boolean): boolean | "status" | undefined => {
		const arg = args.trim().toLowerCase();
		if (!arg) return !current;
		if (arg === "status") return "status";
		if (arg === "on" || arg === "off") return arg === "on";
		return undefined;
	};

	pi.registerCommand("matrix", {
		description: "Toggle Void Agent working-indicator Matrix rain: /matrix [on|off|status]",
		getArgumentCompletions: toggleCompletions,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Matrix rain requires interactive TUI mode", "error");
				return;
			}
			const next = toggleValue(args, matrixEnabled);
			if (next === undefined) {
				ctx.ui.notify("Usage: /matrix [on|off|status]", "error");
				return;
			}
			if (next === "status") {
				const master = workingAnimationEnabled ? "" : " (waiting for /working-animation on)";
				ctx.ui.notify(`Matrix rain is ${matrixEnabled ? "on" : "off"}${master}`, "info");
				return;
			}
			matrixEnabled = next;
			const persisted = saveAnimationConfig({ workingAnimation: workingAnimationEnabled, matrix: matrixEnabled, themeInitialized });
			refreshMatrix(ctx);
			const master = workingAnimationEnabled ? "" : "; working animation remains off";
			const message = `Matrix rain ${matrixEnabled ? "enabled" : "disabled"}${master}`;
			ctx.ui.notify(
				persisted ? message : `${message} for this session, but the setting could not be saved`,
				persisted ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("working-animation", {
		description: "Toggle the Void Agent animated working block: /working-animation [on|off|status]",
		getArgumentCompletions: toggleCompletions,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Working animation requires interactive TUI mode", "error");
				return;
			}
			const next = toggleValue(args, workingAnimationEnabled);
			if (next === undefined) {
				ctx.ui.notify("Usage: /working-animation [on|off|status]", "error");
				return;
			}
			if (next === "status") {
				ctx.ui.notify(
					`Working animation is ${workingAnimationEnabled ? "on" : "off"}; Matrix rain is ${matrixEnabled ? "on" : "off"}`,
					"info",
				);
				return;
			}
			workingAnimationEnabled = next;
			const persisted = saveAnimationConfig({ workingAnimation: workingAnimationEnabled, matrix: matrixEnabled, themeInitialized });
			refreshWorkingAnimation(ctx);
			const message = workingAnimationEnabled
				? `Working animation enabled; Matrix rain is ${matrixEnabled ? "on" : "off"}`
				: "Working animation disabled; using the standard single-row loader";
			ctx.ui.notify(
				persisted ? message : `${message} for this session, but the setting could not be saved`,
				persisted ? "info" : "warning",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode !== "tui") return;

		if (!restoreToolRenderer) {
			ctx.ui.notify("Void Agent could not install its tool separator renderer", "warning");
		}
		if (!restoreWorkingBg) {
			ctx.ui.notify("Void Agent could not install its working-background renderer", "warning");
		}
		// Seed the void-agent theme once on first run so a fresh install looks
		// "void" out of the box, then never override again — Pi's native theme
		// picker owns selection + persistence (settings.theme) from here on, so
		// forcing it every session would silently clobber the user's choice.
		if (!themeInitialized) {
			ctx.ui.setTheme("void-agent");
			themeInitialized = true;
			saveAnimationConfig({ workingAnimation: workingAnimationEnabled, matrix: matrixEnabled, themeInitialized });
		}
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new VoidAgentEditor(tui, editorTheme, keybindings, ctx.ui.theme),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWorkingTimer();
		activeCtx = undefined;
		activeLineBg = undefined;
		activeLineBgStartedAt = 0;
		restoreToolRenderer?.();
		restoreWorkingBg?.();
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setHeader(undefined);
	});
}
