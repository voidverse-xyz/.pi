import {
	getAgentDir,
	Theme,
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const THEME_NAME = "groovebox";
const CONFIG_PATH = join(getAgentDir(), "groovebox-cycle.json");
const TICK_MS = 250;
const CYCLE_MS = 12_000;

const FG_KEYS: ThemeColor[] = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
];

const BG_KEYS = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;
type BgKey = (typeof BG_KEYS)[number];

// Gruvbox rainbow, interpolated continuously and rotated across related tokens.
const GRADIENT = ["#fabd2f", "#fe8019", "#fb4934", "#d3869b", "#83a598", "#8ec07c", "#b8bb26"];

const OFFSETS: Partial<Record<ThemeColor, number>> = {
	accent: 0,
	borderAccent: 0.06,
	customMessageLabel: 0.12,
	toolTitle: 0.18,
	mdHeading: 0.24,
	mdLink: 0.36,
	mdCode: 0.48,
	mdListBullet: 0.58,
	syntaxKeyword: 0.08,
	syntaxFunction: 0.22,
	syntaxVariable: 0.36,
	syntaxString: 0.5,
	syntaxNumber: 0.64,
	syntaxType: 0.78,
	syntaxOperator: 0.92,
	bashMode: 0.52,
};

interface RawTheme {
	vars?: Record<string, string | number>;
	colors?: Record<string, string | number>;
}

interface ResolvedPalette {
	fg: Record<ThemeColor, string | number>;
	bg: Record<BgKey, string | number>;
}

function loadEnabled(): boolean {
	try {
		const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { enabled?: unknown };
		return value.enabled !== false;
	} catch {
		return true;
	}
}

function saveEnabled(enabled: boolean): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`);
	} catch {
		// The in-memory toggle still applies if persistence is unavailable.
	}
}

function resolveValue(value: string | number, vars: Record<string, string | number>, seen = new Set<string>()): string | number {
	if (typeof value !== "string" || value.startsWith("#") || value === "") return value;
	if (seen.has(value) || !(value in vars)) return value;
	seen.add(value);
	return resolveValue(vars[value]!, vars, seen);
}

function loadPalette(ctx: ExtensionContext): ResolvedPalette | null {
	const path = ctx.ui.getAllThemes().find((item) => item.name === THEME_NAME)?.path;
	if (!path || !existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as RawTheme;
		const vars = raw.vars ?? {};
		const colors = raw.colors ?? {};
		const fg = {} as Record<ThemeColor, string | number>;
		const bg = {} as Record<BgKey, string | number>;
		for (const key of FG_KEYS) {
			if (!(key in colors)) return null;
			fg[key] = resolveValue(colors[key]!, vars);
		}
		for (const key of BG_KEYS) {
			if (!(key in colors)) return null;
			bg[key] = resolveValue(colors[key]!, vars);
		}
		return { fg, bg };
	} catch {
		return null;
	}
}

function parseHex(hex: string): [number, number, number] {
	return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function toHex(value: number): string {
	return Math.round(value).toString(16).padStart(2, "0");
}

function gradientAt(position: number): string {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * GRADIENT.length;
	const index = Math.floor(scaled) % GRADIENT.length;
	const next = (index + 1) % GRADIENT.length;
	const mix = scaled - Math.floor(scaled);
	const a = parseHex(GRADIENT[index]!);
	const b = parseHex(GRADIENT[next]!);
	return `#${toHex(a[0] + (b[0] - a[0]) * mix)}${toHex(a[1] + (b[1] - a[1]) * mix)}${toHex(a[2] + (b[2] - a[2]) * mix)}`;
}

function animatedTheme(ctx: ExtensionContext, palette: ResolvedPalette, phase: number): Theme {
	const fg = { ...palette.fg };
	for (const [key, offset] of Object.entries(OFFSETS) as Array<[ThemeColor, number]>) {
		fg[key] = gradientAt(phase + offset);
	}
	const base = ctx.ui.getTheme(THEME_NAME);
	return new Theme(fg, { ...palette.bg }, base?.getColorMode() ?? "truecolor", { name: "groovebox-cycle" });
}

export default function grooveboxCycle(pi: ExtensionAPI): void {
	let enabled = loadEnabled();
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | undefined;
	let palette: ResolvedPalette | null = null;
	let restoreTheme: Theme | undefined;

	const stop = (restore: boolean): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (restore && activeCtx?.mode === "tui") activeCtx.ui.setTheme(restoreTheme ?? THEME_NAME);
		if (restore) restoreTheme = undefined;
	};

	const paint = (): void => {
		if (!enabled || !activeCtx || !palette || activeCtx.mode !== "tui") return;
		const phase = (Date.now() % CYCLE_MS) / CYCLE_MS;
		activeCtx.ui.setTheme(animatedTheme(activeCtx, palette, phase));
	};

	const start = (ctx: ExtensionContext): boolean => {
		stop(false);
		activeCtx = ctx;
		restoreTheme = ctx.ui.theme;
		palette = loadPalette(ctx);
		if (!palette) {
			ctx.ui.notify("Groovebox cycle could not load the groovebox theme palette", "error");
			restoreTheme = undefined;
			return false;
		}
		paint();
		timer = setInterval(paint, TICK_MS);
		timer.unref?.();
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode === "tui" && enabled) start(ctx);
	});

	pi.on("session_shutdown", () => {
		// A disabled cycle never replaced the active theme, so do not force
		// Groovebox back over a separately selected theme during shutdown.
		stop(enabled);
		activeCtx = undefined;
		palette = null;
	});

	pi.registerCommand("groovebox-cycle", {
		description: "Toggle animated Groovebox colors: /groovebox-cycle [on|off]",
		getArgumentCompletions: (prefix) => ["on", "off"]
			.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Groovebox cycling requires interactive TUI mode", "error");
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg && arg !== "on" && arg !== "off") {
				ctx.ui.notify("Usage: /groovebox-cycle [on|off]", "error");
				return;
			}
			enabled = arg ? arg === "on" : !enabled;
			saveEnabled(enabled);
			if (enabled) {
				if (start(ctx)) ctx.ui.notify("Groovebox color cycling enabled", "info");
			} else {
				stop(true);
				ctx.ui.notify("Groovebox color cycling disabled", "info");
			}
		},
	});
}
