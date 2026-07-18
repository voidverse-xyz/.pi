/**
 * pi-workflow — Claude Code-style workflow orchestration for Pi.
 *
 * The `workflow` tool runs a deterministic JS script that fans out one-shot
 * subagents via agent()/parallel()/pipeline()/phase()/log(). Each agent() call
 * is a fresh in-process AgentSession with sandboxed coding tools (pi-safety
 * gated over "workflow:confirm-request"). Runs journal to
 * ~/.pi/agent/sessions/<cwd-slug>/workflows/<runId>/ and are resumable via
 * resumeFromRunId (unchanged agent() calls replay from the journal).
 *
 * Surfaces: `workflow` tool · /workflows [name|stop] · alt+w stop brake ·
 * live progress tree above the editor.
 *
 * Install as a package: packages/pi-workflow. Reload: /reload
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createWorkflowLayout, type WorkflowLayout } from "./workflow/journal/layout.ts";
import { listWorkflows, resolveByName, resolveByPath } from "./workflow/library/resolve.ts";
import { runAgent } from "./workflow/runner/agent-runner.ts";
import { DEFAULT_MAX_CONCURRENT, Scheduler } from "./workflow/runner/scheduler.ts";
import { makeSafetyConfirm } from "./workflow/sandbox/safety-bridge.ts";
import { makeCommandDenyCheck, makeSystemDenyCheck } from "./workflow/sandbox/system-deny.ts";
import { extractMeta } from "./workflow/script/meta.ts";
import { AgentFailure } from "./workflow/script/semantics.ts";
import { WorkflowRun } from "./workflow/run.ts";
import { createWorkflowTool, type WorkflowToolHost } from "./workflow/tool.ts";
import { createTreeWidget, STOP_KEY, type TreeWidgetController } from "./workflow/tui/tree-widget.ts";

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

const COMMAND_ENTRY_TYPE = "workflow-command-output";

type CommandOutputLevel = "info" | "warning" | "error";

interface CommandOutputEntry {
	text: string;
	level: CommandOutputLevel;
}

export default function workflow(pi: ExtensionAPI) {
	let layout: WorkflowLayout | null = null;
	let scheduler = new Scheduler();
	let widget: TreeWidgetController | null = null;
	const active: WorkflowToolHost["active"] = { run: null };
	const lastRunId: WorkflowToolHost["lastRunId"] = { value: null };
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

	const requireLayout = (ctx: ExtensionContext): WorkflowLayout => {
		if (!layout || layout.cwd !== ctx.cwd) layout = createWorkflowLayout(ctx.cwd);
		return layout;
	};

	const stopActive = (ctx: ExtensionContext): void => {
		if (!active.run) {
			ctx.ui.notify("No workflow is running.", "info");
			return;
		}
		active.run.stop();
		ctx.ui.notify(`Stopping workflow ${active.run.name} [${active.run.runId}]…`, "warning");
	};

	const host: WorkflowToolHost = {
		resolveSource(request, ctx) {
			const l = requireLayout(ctx);
			if (typeof request.script === "string" && request.script.trim()) return { source: request.script };
			if (typeof request.name === "string" && request.name.trim()) return resolveByName(request.name.trim(), l, ctx.isProjectTrusted());
			return resolveByPath(String(request.scriptPath).trim(), ctx.cwd);
		},
		createRun(input, ctx, onChange) {
			const l = requireLayout(ctx);
			const protectedDirs = [l.workflowsStateRoot, l.globalWorkflowsDir, l.projectWorkflowsDir];
			return WorkflowRun.create({
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

	pi.registerTool(createWorkflowTool(host));

	pi.registerShortcut(STOP_KEY, {
		description: "Stop the active workflow run",
		handler: (ctx) => stopActive(ctx),
	});

	pi.registerCommand("workflows", {
		description: `List saved workflows and the active run; "stop" halts it (${STOP_KEY})`,
		getArgumentCompletions: (prefix) => {
			if (!layout) return null;
			const names = listWorkflows(layout, true).map((w) => w.name);
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
			const saved = listWorkflows(l, ctx.isProjectTrusted());
			if (arg !== "") {
				const match = saved.find((w) => w.name === arg);
				if (!match) {
					showCommandOutput(ctx, `No saved workflow named "${arg}".`, "error");
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
				lines.push(`ACTIVE: ${snap.name} [${snap.runId}] — ${snap.rows.length} agents${snap.currentPhase ? `, phase ${snap.currentPhase}` : ""} (/workflows stop)`);
			}
			if (lastRunId.value) lines.push(`last run: ${lastRunId.value} (resumable via resumeFromRunId)`);
			if (saved.length === 0) {
				lines.push(`No saved workflows. Add <name>.js with an \`export const meta\` header to ${l.globalWorkflowsDir} or ${l.projectWorkflowsDir}.`);
			} else {
				for (const w of saved) {
					lines.push(w.invalid ? `${w.name} (${w.origin}) — INVALID: ${w.invalid}` : `${w.name} (${w.origin}) — ${w.description || "(no description)"}`);
				}
			}
			showCommandOutput(ctx, lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		layout = createWorkflowLayout(ctx.cwd);
		scheduler = new Scheduler(readMaxConcurrent(layout.settingsFile));
		widget?.dispose();
		widget = null;
		if (ctx.mode === "tui") {
			widget = createTreeWidget(() => (active.run ? active.run.snapshot() : null), ctx.ui);
		}
	});

	pi.on("session_shutdown", () => {
		active.run?.stop();
		widget?.dispose();
		widget = null;
	});
}
