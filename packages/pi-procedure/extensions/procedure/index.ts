/**
 * pi-procedure — Claude Code-style procedure orchestration for Pi.
 *
 * The `procedure` tool runs a deterministic JS script that fans out one-shot
 * subagents via agent()/parallel()/pipeline()/phase()/log(). Each agent() call
 * is a fresh in-process AgentSession with sandboxed coding tools (pi-safety
 * gated over "procedure:confirm-request"). Runs journal to
 * ~/.pi/agent/sessions/<cwd-slug>/procedures/<runId>/ and are resumable via
 * resumeFromRunId (unchanged agent() calls replay from the journal).
 *
 * Surfaces: `procedure` tool · /procedures [name|stop] · alt+w stop brake ·
 * alt+e expand/collapse · live progress tree above the editor.
 *
 * Install as a package: packages/pi-procedure. Reload: /reload
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createProcedureLayout, type ProcedureLayout } from "./journal/layout.ts";
import { listProcedures, resolveByName, resolveByPath } from "./library/resolve.ts";
import { runAgent } from "./runner/agent-runner.ts";
import { DEFAULT_MAX_CONCURRENT, Scheduler } from "./runner/scheduler.ts";
import { makeSafetyConfirm } from "./sandbox/safety-bridge.ts";
import { makeCommandDenyCheck, makeSystemDenyCheck } from "./sandbox/system-deny.ts";
import { extractMeta } from "./script/meta.ts";
import { AgentFailure } from "./script/semantics.ts";
import { ProcedureRun } from "./run.ts";
import { createProcedureTool, type ProcedureToolHost } from "./tool.ts";
import { createTreeWidget, EXPAND_KEY, STOP_KEY, type TreeWidgetController } from "./tui/tree-widget.ts";

export function readMaxConcurrent(settingsFile: string): number {
	try {
		if (!existsSync(settingsFile)) return DEFAULT_MAX_CONCURRENT;
		const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { maxConcurrent?: unknown };
		const n = parsed.maxConcurrent;
		if (typeof n === "number" && Number.isInteger(n)) return Math.min(64, Math.max(1, n));
	} catch {
		// malformed settings — fall through to the default
	}
	return DEFAULT_MAX_CONCURRENT;
}

/** Resolve "provider/id" (or a bare, unambiguous id) via the host registry. */
function resolveModelRef(ctx: ExtensionContext, ref: string) {
	const registry = ctx.modelRegistry;
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const model = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (model) return model;
	} else {
		const matches = registry.getAll().filter((m: { id: string }) => m.id === ref);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) {
			throw new AgentFailure(`model "${ref}" is ambiguous — qualify it as provider/id (candidates: ${matches.map((m: { provider: string }) => m.provider).join(", ")}).`);
		}
	}
	throw new AgentFailure(`unknown model "${ref}" — use "provider/id" as listed by the host's model registry.`);
}

const COMMAND_ENTRY_TYPE = "procedure-command-output";
const STATUS_LINE_PIN_CHANNEL = "status-line:pin-header";

type CommandOutputLevel = "info" | "warning" | "error";

interface CommandOutputEntry {
	text: string;
	level: CommandOutputLevel;
}

export default function procedure(pi: ExtensionAPI) {
	let layout: ProcedureLayout | null = null;
	let scheduler = new Scheduler();
	let widget: TreeWidgetController | null = null;
	const active: ProcedureToolHost["active"] = { run: null };
	const lastRunId: ProcedureToolHost["lastRunId"] = { value: null };
	const confirm = makeSafetyConfirm(pi);

	pi.registerEntryRenderer(COMMAND_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as CommandOutputEntry;
		const color = data.level === "error" ? "error" : data.level === "warning" ? "warning" : "text";
		return new Text(theme.fg(color, data.text), 1, 0);
	});

	const showCommandOutput = (ctx: ExtensionContext, text: string, level: CommandOutputLevel): void => {
		if (ctx.mode === "tui") {
			pi.appendEntry(COMMAND_ENTRY_TYPE, { text, level } satisfies CommandOutputEntry);
			return;
		}
		ctx.ui.notify(text, level);
	};

	const requireLayout = (ctx: ExtensionContext): ProcedureLayout => {
		if (!layout || layout.cwd !== ctx.cwd) layout = createProcedureLayout(ctx.cwd, { agentDir: getAgentDir() });
		return layout;
	};

	const stopActive = (ctx: ExtensionContext): void => {
		if (!active.run) {
			ctx.ui.notify("No procedure is running.", "info");
			return;
		}
		active.run.stop();
		ctx.ui.notify(`Stopping procedure ${active.run.name} [${active.run.runId}]…`, "warning");
	};

	const host: ProcedureToolHost = {
		resolveSource(request, ctx) {
			const l = requireLayout(ctx);
			if (typeof request.script === "string" && request.script.trim()) return { source: request.script };
			if (typeof request.name === "string" && request.name.trim()) return resolveByName(request.name.trim(), l, ctx.isProjectTrusted());
			return resolveByPath(String(request.scriptPath).trim(), ctx.cwd, ctx.isProjectTrusted());
		},
		createRun(input, ctx, onChange) {
			const l = requireLayout(ctx);
			const protectedDirs = [l.proceduresStateRoot, l.globalProceduresDir, l.projectProceduresDir];
			return ProcedureRun.create({
				source: input.source,
				...(input.fallbackName !== undefined ? { fallbackName: input.fallbackName } : {}),
				args: input.args,
				...(input.resumeFromRunId !== undefined ? { resumeFromRunId: input.resumeFromRunId } : {}),
				layout: l,
				scheduler,
				confirm,
				systemDeny: makeSystemDenyCheck(protectedDirs, realpathSync),
				systemDenyCommand: makeCommandDenyCheck(protectedDirs, realpathSync, homedir()),
				defaultModel: ctx.model,
				resolveModel: (ref) => resolveModelRef(ctx, ref),
				onChange,
				runAgentImpl: runAgent,
			});
		},
		active,
		lastRunId,
		onRunChanged() {
			widget?.refresh();
		},
	};

	pi.registerTool(createProcedureTool(host));

	pi.registerShortcut(STOP_KEY, {
		description: "Stop the active procedure run",
		handler: (ctx) => stopActive(ctx),
	});

	pi.registerShortcut(EXPAND_KEY, {
		description: "Expand or collapse a truncated procedure widget",
		handler: (ctx) => {
			if (!widget?.toggleExpanded()) ctx.ui.notify("No truncated procedure widget to expand.", "info");
		},
	});

	pi.registerCommand("procedures", {
		description: `List saved procedures and the active run; "stop" halts it (${STOP_KEY})`,
		getArgumentCompletions: (prefix) => {
			if (!layout) return null;
			const names = listProcedures(layout, true).map((w) => w.name);
			const items = ["stop", ...names]
				.filter((v, i, arr) => arr.indexOf(v) === i)
				.filter((v) => v.startsWith(prefix.trim()))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const l = requireLayout(ctx);
			const arg = args.trim();
			if (arg === "stop") {
				stopActive(ctx);
				return;
			}
			const saved = listProcedures(l, ctx.isProjectTrusted());
			if (arg !== "") {
				const match = saved.find((w) => w.name === arg);
				if (!match) {
					showCommandOutput(ctx, `No saved procedure named "${arg}".`, "error");
					return;
				}
				if (match.invalid) {
					showCommandOutput(ctx, `${match.name} (${match.origin}) is invalid: ${match.invalid}`, "error");
					return;
				}
				const { meta } = extractMeta(readFileSync(match.file, "utf8"));
				const phases = meta?.phases.length ? `\nphases: ${meta.phases.join(" → ")}` : "";
				showCommandOutput(ctx, `${match.name} (${match.origin}) — ${meta?.description || "(no description)"}${phases}\n${match.file}`, "info");
				return;
			}
			const lines: string[] = [];
			if (active.run) {
				const snap = active.run.snapshot();
				lines.push(`ACTIVE: ${snap.name} [${snap.runId}] — ${snap.rows.length} agents${snap.currentPhase ? `, phase ${snap.currentPhase}` : ""} (/procedures stop)`);
			}
			if (lastRunId.value) lines.push(`last run: ${lastRunId.value} (resumable via resumeFromRunId)`);
			if (saved.length === 0) {
				lines.push(`No saved procedures. Add <name>.js with an \`export const meta\` header to ${l.globalProceduresDir} or ${l.projectProceduresDir}.`);
			} else {
				for (const w of saved) {
					lines.push(w.invalid ? `${w.name} (${w.origin}) — INVALID: ${w.invalid}` : `${w.name} (${w.origin}) — ${w.description || "(no description)"}`);
				}
			}
			showCommandOutput(ctx, lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		layout = createProcedureLayout(ctx.cwd, { agentDir: getAgentDir() });
		scheduler = new Scheduler(readMaxConcurrent(layout.settingsFile));
		widget?.dispose();
		widget = null;
		if (ctx.mode === "tui") {
			widget = createTreeWidget(() => (active.run ? active.run.snapshot() : null), ctx.ui, {
				onMounted: () => pi.events.emit(STATUS_LINE_PIN_CHANNEL, {}),
			});
		}
	});

	pi.on("session_shutdown", () => {
		active.run?.stop();
		widget?.dispose();
		widget = null;
	});
}
