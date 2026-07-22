import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AUDIT_PATH, auditLog, readRecentEntries } from "./audit.ts";
import { CATEGORY_META, type Category, classifyCommand } from "./categories.ts";
import { confirmGatedCommand } from "./confirm.ts";

export type SafetyMode = "off" | "on" | "max";

const MODES: SafetyMode[] = ["off", "on", "max"];
const DEFAULT_MODE: SafetyMode = "max";
const STATUS_KEY = "safety";
const CONFIG_PATH = join(getAgentDir(), "safety.json");
const ICON_SHIELD = ""; // nf-fa-shield — text always names the feature and state

// Name allowlist of mutation tools covered by the opt-in write gate
// (/safety-writes). Mutation tools NOT listed here are not gated. Unknown
// names never match an event, so listing extras is harmless.
const WRITE_TOOLS = ["edit", "write", "multiedit", "apply_patch", "notebook_edit"] as const;

const MODE_CATEGORIES: Record<SafetyMode, ReadonlySet<Category>> = {
	off: new Set(),
	on: new Set<Category>(["destructive"]),
	max: new Set<Category>(["destructive", "network", "exec", "other"]),
};

function isMode(value: unknown): value is SafetyMode {
	return typeof value === "string" && MODES.includes(value as SafetyMode);
}

function loadMode(): { mode: SafetyMode; gateWrites: boolean; warning?: string } {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { mode?: unknown; gateWrites?: unknown };
		const gateWrites = raw?.gateWrites === true;
		if (isMode(raw?.mode)) return { mode: raw.mode, gateWrites };
		return { mode: DEFAULT_MODE, gateWrites, warning: `Invalid safety mode in ${CONFIG_PATH}; using ${DEFAULT_MODE}` };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: DEFAULT_MODE, gateWrites: false };
		return { mode: DEFAULT_MODE, gateWrites: false, warning: `Could not read ${CONFIG_PATH}; using ${DEFAULT_MODE}` };
	}
}

function saveMode(mode: SafetyMode, gateWrites: boolean): string | null {
	const temp = `${CONFIG_PATH}.tmp-${process.pid}-${randomUUID()}`;
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(temp, `${JSON.stringify({ mode, gateWrites }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, CONFIG_PATH);
		return null;
	} catch (error) {
		if (existsSync(temp)) {
			try {
				unlinkSync(temp);
			} catch {
				// Best effort cleanup.
			}
		}
		return error instanceof Error ? error.message : String(error);
	}
}

function updateStatus(ctx: ExtensionContext, mode: SafetyMode): void {
	if (ctx.mode !== "tui") return;
	const color = mode === "off" ? "dim" : mode === "on" ? "text" : "error";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `${ICON_SHIELD} ${mode}`));
}

export default function safetyExtension(pi: ExtensionAPI): void {
	const initialConfig = loadMode();
	let currentMode = initialConfig.mode;
	/** Opt-in (default off): also gate the MAIN agent's edit/write tool calls. */
	let gateWrites = initialConfig.gateWrites;
	let confirmationTail: Promise<void> = Promise.resolve();
	// Captured at session_start so the pi.events confirmation provider can render
	// on this process's TUI when a pi-teams subagent forwards a guarded tool call.
	let currentCtx: ExtensionContext | undefined;

	async function confirmSerial(ctx: ExtensionContext, category: Category, command: string): Promise<boolean> {
		const previous = confirmationTail;
		let release!: () => void;
		confirmationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await confirmGatedCommand(ctx, category, command);
		} finally {
			release();
		}
	}

	/**
	 * The single confirmation gate: serialize the prompt, audit the outcome, and
	 * fail closed if confirmation itself errors. `display` is both what the user
	 * confirms and what gets audited. All three gated paths (main-agent bash,
	 * main-agent writes, subagent confirm provider) route through here so
	 * confirm/audit/error handling can never diverge; callers only phrase their
	 * own block/decline messages. `reason` is set only on a confirmation error
	 * (the raw error message); a plain decline is `{ approved: false }`.
	 */
	async function gate(ctx: ExtensionContext, category: Category, display: string): Promise<{ approved: boolean; reason?: string }> {
		let approved: boolean;
		try {
			approved = await confirmSerial(ctx, category, display);
		} catch (error) {
			auditLog({ rawCommand: display, category, mode: currentMode, decision: "denied", source: "auto" });
			return { approved: false, reason: error instanceof Error ? error.message : String(error) };
		}
		auditLog({ rawCommand: display, category, mode: currentMode, decision: approved ? "approved" : "denied", source: "user" });
		return { approved };
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		if (typeof command !== "string" || !command.trim()) return;

		const category = classifyCommand(command);
		if (!category) {
			auditLog({ rawCommand: command, category: "read-only", mode: currentMode, decision: "auto-allowed", source: "auto" });
			return;
		}
		if (!MODE_CATEGORIES[currentMode].has(category)) {
			auditLog({ rawCommand: command, category, mode: currentMode, decision: "auto-allowed", source: "auto" });
			return;
		}

		if (!ctx.hasUI) {
			auditLog({ rawCommand: command, category, mode: currentMode, decision: "denied", source: "auto" });
			return {
				block: true,
				reason: `pi-safety blocked a ${category} command because no confirmation UI is available`,
			};
		}

		const verdict = await gate(ctx, category, command);
		if (verdict.reason !== undefined) {
			ctx.ui.notify("Safety confirmation failed; command blocked", "error");
			return { block: true, reason: `pi-safety confirmation failed: ${verdict.reason}` };
		}
		if (verdict.approved) return;
		ctx.ui.notify(`Blocked ${CATEGORY_META[category].label.toLowerCase()} command`, "warning");
		return { block: true, reason: `Blocked by pi-safety (${category}; declined by user)` };
	});

	// Opt-in: also gate the MAIN agent's edit/write (D20a-C). Off by default so it
	// never surprises normal editing; enable with /safety-writes on.
	pi.on("tool_call", async (event, ctx) => {
		if (!gateWrites || currentMode === "off") return;
		const writeTool = WRITE_TOOLS.find((name) => isToolCallEventType(name, event)) ?? null;
		if (!writeTool) return;
		const rawPath = (event.input as { path?: unknown }).path;
		const path = typeof rawPath === "string" ? rawPath : "";
		const category = "other"; // file mutation: confirmed in max mode
		if (!MODE_CATEGORIES[currentMode].has(category)) return;
		if (!ctx.hasUI) {
			auditLog({ rawCommand: `${writeTool} ${path}`, category, mode: currentMode, decision: "denied", source: "auto" });
			return { block: true, reason: `pi-safety blocked a ${writeTool} because no confirmation UI is available` };
		}
		const verdict = await gate(ctx, category, `${writeTool} ${path}`);
		if (verdict.reason !== undefined) {
			return { block: true, reason: `pi-safety confirmation failed: ${verdict.reason}` };
		}
		if (verdict.approved) return;
		return { block: true, reason: `Blocked by pi-safety (${writeTool}; declined by user)` };
	});

	// pi-teams / pi-subagents confirmation provider: a subagent's guarded
	// bash/edit/write call is forwarded here over pi.events (the synchronous-claim
	// idiom). Both extensions emit the SAME request shape on their own channel; we
	// reuse the same classifier, modes, and confirmation UI as main-agent Bash.
	// Claim only when we can actually confirm (a live TUI); otherwise don't claim,
	// and the requester fails closed (denies). Confirmations stay human (D10).
	const handleConfirmRequest = (data: unknown): void => {
		const { method, claim } = data as {
			method: string;
			claim: (fn: (req: { agent?: string; tool?: string; command?: string; path?: string }) => Promise<{ approved: boolean; note?: string }>) => void;
		};
		if (method !== "confirm") return;
		const ctx = currentCtx;
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return; // can't confirm → don't claim → requester fails closed
		claim(async (req) => {
			const agent = typeof req.agent === "string" ? req.agent : "subagent";
			let category: Category;
			let display: string;
			if (req.tool === "bash") {
				const command = typeof req.command === "string" ? req.command : "";
				const classified = classifyCommand(command);
				if (!classified) {
					auditLog({ rawCommand: `[${agent}] ${command}`, category: "read-only", mode: currentMode, decision: "auto-allowed", source: "auto" });
					return { approved: true };
				}
				category = classified;
				display = command;
			} else {
				// edit/write: a subagent file mutation. Gate as "other" (confirmed in max mode).
				category = "other";
				display = `${req.tool ?? "write"} ${req.path ?? ""}`.trim();
			}
			if (!MODE_CATEGORIES[currentMode].has(category)) {
				auditLog({ rawCommand: `[${agent}] ${display}`, category, mode: currentMode, decision: "auto-allowed", source: "auto" });
				return { approved: true };
			}
			const verdict = await gate(ctx, category, `[${agent}] ${display}`);
			if (verdict.reason !== undefined) return { approved: false, note: `confirmation failed: ${verdict.reason}` };
			return verdict.approved ? { approved: true } : { approved: false, note: "declined by the human" };
		});
	};
	pi.events.on("teams:confirm-request", handleConfirmRequest);
	pi.events.on("subagents:confirm-request", handleConfirmRequest);
	pi.events.on("procedure:confirm-request", handleConfirmRequest);

	pi.registerCommand("safety", {
		description: "Set main-agent Bash safety: off | on | max",
		getArgumentCompletions: (prefix) => {
			const items = MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({
				value: mode,
				label: `${mode}${mode === currentMode ? " (current)" : ""}`,
			}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(
					[
						`Main-agent Bash safety: ${currentMode}`,
						"  max — confirm everything except commands proven read-only",
						"  on  — confirm destructive commands only",
						"  off — do not confirm",
						"Note: on gates only clearly-destructive commands (best-effort; shell obfuscation can evade it); max gates everything not provably read-only and is the only fail-closed mode.",
						"Usage: /safety <off|on|max>",
					].join("\n"),
					"info",
				);
				return;
			}
			if (!isMode(arg)) {
				ctx.ui.notify(`Unknown mode "${arg}". Use: off | on | max`, "error");
				return;
			}
			currentMode = arg;
			const saveError = saveMode(arg, gateWrites);
			updateStatus(ctx, currentMode);
			ctx.ui.notify(
				saveError ? `Bash safety is ${arg} for this process, but could not save it: ${saveError}` : `Main-agent Bash safety: ${arg}`,
				saveError ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("safety-writes", {
		description: "Also gate the main agent's edit/write tool calls: on | off (default off)",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify(
					[`Main-agent edit/write gating: ${gateWrites ? "on" : "off"}`, "When on, the main agent's file edits/writes are confirmed (in on/max mode), like subagents.", "Usage: /safety-writes <on|off>"].join("\n"),
					"info",
				);
				return;
			}
			gateWrites = arg === "on";
			const saveError = saveMode(currentMode, gateWrites);
			ctx.ui.notify(
				saveError ? `Edit/write gating is ${arg} for this process, but could not save it: ${saveError}` : `Main-agent edit/write gating: ${arg}`,
				saveError ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("safety-log", {
		description: "Show recent pi-safety decisions (arguments are never logged)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /safety-log", "error");
				return;
			}
			const entries = readRecentEntries(20);
			if (!entries.length) {
				ctx.ui.notify(`No safety decisions yet.\nLog: ${AUDIT_PATH}`, "info");
				return;
			}
			const lines = entries.map((entry) => {
				const timestamp = entry.ts.replace("T", " ").replace(/\.\d+Z?$/, "");
				return `${timestamp}  ${entry.decision.padEnd(12)} ${entry.category}/${entry.mode}  ${entry.command}  #${entry.commandHash}`;
			});
			lines.push("", `Log: ${AUDIT_PATH} (arguments omitted; rotates at 1 MiB)`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		const loaded = loadMode();
		currentMode = loaded.mode;
		gateWrites = loaded.gateWrites;
		updateStatus(ctx, currentMode);
		if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		currentCtx = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
