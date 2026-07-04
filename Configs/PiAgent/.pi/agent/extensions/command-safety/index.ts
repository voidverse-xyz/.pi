/**
 * Command Safety
 *
 * Reviews every command the agent tries to run through the `bash` tool and gates
 * it based on category:
 *
 *   - destructive → two confirmations, each with a 3s button-enable countdown
 *   - network     → one confirmation with a 3s countdown
 *   - exec        → one confirmation, confirm button live immediately (no countdown)
 *   - other       → one confirmation, confirm button live immediately (anything that
 *                   isn't a known read-only builtin — see categories.ts)
 *   - known read-only builtins (ls, cat, grep, git status, …) → run with no prompt
 *
 * Only the higher-risk categories (destructive, network) hold the confirm button
 * for 3s; exec/other prompt but can be accepted right away.
 *
 * A `/safety` command switches the enforcement mode, shown as a colored footer
 * indicator:
 *
 *   - max → gate everything except read-only builtins   (green shield — full protection, default)
 *   - on  → gate destructive only                       (yellow shield — partial)
 *   - off → gate nothing                                (red shield — protection off)
 *
 * The mode persists to `<agent-dir>/command-safety.json` (real home, not the
 * workspace copy), so `/safety` changes and the startup default survive restarts.
 * Edit that file's `"mode"` to change the startup default without launching pi.
 *
 * Only agent `bash` tool calls are gated — user-run `!` commands are never
 * intercepted. In non-interactive modes (print/json) a gated command is blocked,
 * since there is no human available to confirm.
 *
 * Requires a Nerd Font for the shield glyph.
 *
 * Install: ~/.pi/agent/extensions/command-safety/index.ts
 * Reload: /reload
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATEGORY_META, type Category, classifyCommand } from "./categories.ts";
import { delayedConfirm } from "./delayed-confirm.ts";

type SafetyMode = "off" | "on" | "max";

const MODES: SafetyMode[] = ["off", "on", "max"];
const DEFAULT_MODE: SafetyMode = "max";

const STATUS_KEY = "command-safety";
const ICON_SHIELD = ""; // nf-fa-shield
const CONFIG_PATH = join(getAgentDir(), "command-safety.json");

// Which categories require confirmation in each mode.
const MODE_CATEGORIES: Record<SafetyMode, ReadonlySet<Category>> = {
	off: new Set(),
	on: new Set<Category>(["destructive"]),
	max: new Set<Category>(["destructive", "network", "exec", "other"]),
};

let currentMode: SafetyMode = loadMode();

function isMode(value: unknown): value is SafetyMode {
	return typeof value === "string" && (MODES as string[]).includes(value);
}

function loadMode(): SafetyMode {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (raw && isMode(raw.mode)) return raw.mode;
	} catch {
		// Missing or malformed config — fall back to the default.
	}
	return DEFAULT_MODE;
}

function saveMode(mode: SafetyMode): void {
	try {
		const dir = dirname(CONFIG_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify({ mode }, null, 2)}\n`);
	} catch {
		// Best effort: if we can't persist, the mode still applies to this session.
	}
}

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	// Dim, matching the rest of the status line: shield glyph, one space, then the
	// mode (max|on|off). Separators between footer segments are owned by the
	// status-line extension, so no leading "| " here.
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${ICON_SHIELD} ${currentMode}`));
}

async function gate(ctx: ExtensionContext, category: Category, command: string): Promise<boolean> {
	const meta = CATEGORY_META[category];
	for (let i = 1; i <= meta.confirmations; i++) {
		const step = meta.confirmations > 1 ? `${i} of ${meta.confirmations}` : undefined;
		const ok = await delayedConfirm(ctx, {
			label: meta.label,
			color: meta.color,
			command,
			delayMs: meta.delayMs,
			step,
		});
		if (!ok) return false;
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	// Registered at module scope so repeated session_start firings (switch/resume
	// within one process) never stack duplicate listeners.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command;
		if (typeof command !== "string" || command.trim() === "") return undefined;

		const category = classifyCommand(command);
		if (!category) return undefined;
		if (!MODE_CATEGORIES[currentMode].has(category)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `command-safety: ${category} command blocked (no interactive UI to confirm)`,
			};
		}

		const approved = await gate(ctx, category, command);
		if (!approved) {
			ctx.ui.notify(`Blocked ${CATEGORY_META[category].label.toLowerCase()} command`, "warning");
			return { block: true, reason: `Blocked by command-safety (${category}; declined by user)` };
		}
		return undefined;
	});

	pi.registerCommand("safety", {
		description: "Command-safety mode: off | on | max (persisted)",
		getArgumentCompletions: (prefix) => {
			const items = MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
				value: m,
				label: `${m}${m === currentMode ? " (current)" : ""}`,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "") {
				const lines = [
					`Command safety: ${currentMode}`,
					`  max — confirm everything except known read-only builtins`,
					`  on  — confirm destructive only`,
					`  off — confirm nothing`,
					`Usage: /safety <off|on|max>`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (!isMode(arg)) {
				ctx.ui.notify(`Unknown mode "${arg}". Use: off | on | max`, "error");
				return;
			}

			currentMode = arg;
			saveMode(arg);
			updateStatus(ctx);
			ctx.ui.notify(`Command safety: ${arg}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Reload from disk in case the file changed between sessions in this process.
		currentMode = loadMode();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
