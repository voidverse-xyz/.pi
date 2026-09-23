import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ImageContent,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ModeLifecycle } from "./mode-lifecycle.ts";
import {
	applyPlanSubagentPolicy,
	extractSuccessfulSpawnAddress,
	isToolAllowedInMode,
	nextAgentMode,
	parseAgentModeState,
	parseModeCommand,
	parsePlanCommand,
	PLAN_SUBAGENT_TOOL_NAMES,
	restrictedModeTools,
	SAVE_PLAN_TOOL,
	shouldAbortCurrentRunForModeChange,
	shouldDeferModeTransitionInput,
	type AgentMode,
	type AgentModeState,
	type TrustedCustomToolOwners,
} from "./policy.ts";
import { buildNonPlanModeInstructions, buildPlanModeInstructions } from "./prompts.ts";
import { atomicWritePlan, resolvePlanTarget, validatePlanContent } from "./save.ts";
import {
	buildAutomaticTemplateInstructions,
	discoverPlanTemplates,
	loadSkillBody,
} from "./templates.ts";

const STATE_ENTRY = "plan-mode.state";
const STATUS_KEY = "plan-mode";
const STATUS_TEXT: Record<Exclude<AgentMode, "off">, string> = {
	discuss: "󰍩 discuss mode", // nf-md-forum
	plan: " plan mode", // nf-oct-tasklist
	quick: "󱐋 quick mode", // nf-md-lightning-bolt
};
const PLAN_SKILL_NAME = "pi-plan-mode";
const TASK_START_TIMEOUT_MS = 5 * 60 * 1000;
const DEFERRED_INPUT_START_TIMEOUT_MS = 30 * 1000;
const PLAN_ENTRY_PATH = realpathSync(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = resolve(dirname(PLAN_ENTRY_PATH), "../../..");

interface DeferredModeInput {
	text: string;
	images?: ImageContent[];
}

function canonicalExistingPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function trustedPackageTool(packageName: string, entryRelativePath: string) {
	const packageRoot = canonicalExistingPath(join(PACKAGES_ROOT, packageName));
	return {
		source: packageRoot,
		path: canonicalExistingPath(join(packageRoot, entryRelativePath)),
		scope: "user" as const,
		origin: "package" as const,
	};
}

const TRUSTED_CUSTOM_TOOLS: TrustedCustomToolOwners = {
	ask_user: trustedPackageTool("pi-questions", "extensions/questions/index.ts"),
	show_files: trustedPackageTool("pi-show-files", "extensions/show-files/index.ts"),
	todo_write: trustedPackageTool("pi-todo", "extensions/todo/index.ts"),
	[SAVE_PLAN_TOOL]: trustedPackageTool("pi-plan", "extensions/plan/index.ts"),
	...Object.fromEntries(
		PLAN_SUBAGENT_TOOL_NAMES.map((name) => [
			name,
			trustedPackageTool("pi-subagents", "extensions/subagents/index.ts"),
		]),
	),
};

const FALLBACK_PLAN_INSTRUCTIONS = `Research and design the requested change without implementing it.
Inspect the actual project first, resolve discoverable facts through read-only exploration, and use ask_user only for consequential choices that cannot be derived from the environment.
Do not modify project files. You may delegate bounded research only to fresh ad-hoc one-shot subagents; the host forces their coding tools to read, grep, find, and ls. The only mutation permitted in host-managed Plan mode is saving the complete final Markdown plan through save_plan after its exact project-relative path is authorized. Finish with a concise, decision-complete implementation and test plan.`;

function modeLabel(mode: AgentMode): string {
	return mode === "off" ? "Off" : `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
}

function completions(options: string[]) {
	return (prefix: string) => {
		const matches = options
			.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
			.map((option) => ({ value: option, label: option }));
		return matches.length > 0 ? matches : null;
	};
}

export default function planExtension(pi: ExtensionAPI): void {
	const modeLifecycle = new ModeLifecycle();
	let modeIntentRevision = 0;
	let authorizedPlanPath: string | undefined;
	let authorizedProjectRoot: string | undefined;
	let selectedPlanSkill: string | undefined;
	let planSubagentAddresses = new Set<string>();
	const admittedPlanSpawnCalls = new Set<string>();
	let toolsBeforeRestrictedMode: string[] | undefined;
	let warnedMissingSkill = false;
	let warnedMissingSelectedTemplate = "";
	let saveTail: Promise<void> = Promise.resolve();
	let taskLaunchTail: Promise<void> = Promise.resolve();
	let queuedCommandTaskCount = 0;
	let pendingTaskLaunch: {
		task: string;
		revision: number;
		prepare?: () => void;
		inputAccepted: boolean;
		resolve: (started: boolean) => void;
		timer: ReturnType<typeof setTimeout>;
	} | undefined;
	let deferredModeInputs: DeferredModeInput[] = [];
	let launchingDeferredModeInput: DeferredModeInput | undefined;
	let deferredModeInputAccepted = false;
	let deferredModeInputStartTimer: ReturnType<typeof setTimeout> | undefined;

	async function serializeSave<T>(operation: () => Promise<T>): Promise<T> {
		const previous = saveTail;
		let release!: () => void;
		saveTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async function serializeTaskLaunch(operation: () => Promise<void>): Promise<void> {
		const previous = taskLaunchTail;
		let release!: () => void;
		taskLaunchTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await operation();
		} finally {
			release();
		}
	}

	function finishPendingTaskLaunch(started: boolean): void {
		const pending = pendingTaskLaunch;
		if (!pending) return;
		pendingTaskLaunch = undefined;
		clearTimeout(pending.timer);
		pending.resolve(started);
	}

	function waitForTaskStart(
		task: string,
		revision: number,
		prepare?: () => void,
	): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => finishPendingTaskLaunch(false), TASK_START_TIMEOUT_MS);
			timer.unref?.();
			pendingTaskLaunch = {
				task,
				revision,
				...(prepare ? { prepare } : {}),
				inputAccepted: false,
				resolve,
				timer,
			};
		});
	}

	function deferModeTransitionInput(
		text: string,
		images: ImageContent[] | undefined,
		ctx: ExtensionContext,
	): void {
		const wasEmpty = deferredModeInputs.length === 0;
		deferredModeInputs.push({
			text,
			...(images?.length ? { images: [...images] } : {}),
		});
		if (wasEmpty && ctx.hasUI) {
			ctx.ui.notify(
				"Mode change pending; the queued message will start as a new turn after the current run settles.",
				"info",
			);
		}
	}

	function resetDeferredModeInputLaunch(): void {
		if (deferredModeInputStartTimer) clearTimeout(deferredModeInputStartTimer);
		deferredModeInputStartTimer = undefined;
		launchingDeferredModeInput = undefined;
		deferredModeInputAccepted = false;
	}

	function dispatchDeferredModeInput(ctx: ExtensionContext): void {
		if (launchingDeferredModeInput) return;
		const pending = deferredModeInputs[0];
		if (!pending) return;
		launchingDeferredModeInput = pending;
		deferredModeInputAccepted = false;
		deferredModeInputStartTimer = setTimeout(() => {
			if (launchingDeferredModeInput !== pending) return;
			resetDeferredModeInputLaunch();
			if (ctx.hasUI) {
				ctx.ui.notify(
					"The queued mode-transition message did not start; it remains queued for the next settled turn.",
					"warning",
				);
			}
		}, DEFERRED_INPUT_START_TIMEOUT_MS);
		deferredModeInputStartTimer.unref?.();

		const content = pending.images?.length
			? [{ type: "text" as const, text: pending.text }, ...pending.images]
			: pending.text;
		try {
			pi.sendUserMessage(content);
		} catch (error) {
			resetDeferredModeInputLaunch();
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not start the queued mode-transition message: ${message}`, "warning");
			}
		}
	}

	function currentState(): AgentModeState {
		return {
			mode: modeLifecycle.selectedMode,
			...(authorizedPlanPath && authorizedProjectRoot
				? { authorizedPlanPath, authorizedProjectRoot }
				: {}),
			...(selectedPlanSkill ? { selectedPlanSkill } : {}),
			...(planSubagentAddresses.size > 0
				? { planSubagentAddresses: [...planSubagentAddresses] }
				: {}),
		};
	}

	function persistState(): void {
		pi.appendEntry<AgentModeState>(STATE_ENTRY, currentState());
	}

	function updateStatus(ctx: ExtensionContext): void {
		// Publish the user's selected next-turn mode. pi-status-line owns the
		// dedicated left-side slot and styling.
		const selectedMode = modeLifecycle.selectedMode;
		ctx.ui.setStatus(
			STATUS_KEY,
			selectedMode === "off" ? undefined : STATUS_TEXT[selectedMode],
		);
	}

	function enableRestrictedModeTools(restrictedMode: Exclude<AgentMode, "off">): void {
		if (toolsBeforeRestrictedMode === undefined) {
			toolsBeforeRestrictedMode = pi.getActiveTools().filter((name) => name !== SAVE_PLAN_TOOL);
		}
		pi.setActiveTools(
			restrictedModeTools(
				restrictedMode,
				toolsBeforeRestrictedMode,
				pi.getAllTools(),
				TRUSTED_CUSTOM_TOOLS,
			),
		);
	}

	function restoreNormalTools(): void {
		if (toolsBeforeRestrictedMode !== undefined) {
			pi.setActiveTools(toolsBeforeRestrictedMode.filter((name) => name !== SAVE_PLAN_TOOL));
			toolsBeforeRestrictedMode = undefined;
			return;
		}
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== SAVE_PLAN_TOOL));
	}

	function applyModeTools(targetMode: AgentMode): void {
		if (targetMode === "off") restoreNormalTools();
		else enableRestrictedModeTools(targetMode);
	}

	function restore(ctx: ExtensionContext): void {
		resetDeferredModeInputLaunch();
		deferredModeInputs = [];
		let restored: AgentModeState = { mode: "off" };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			restored = parseAgentModeState(entry.data) ?? { mode: "off" };
		}
		modeLifecycle.restore(restored.mode);
		let currentProjectRoot: string | undefined;
		try {
			currentProjectRoot = realpathSync(ctx.cwd);
		} catch {
			currentProjectRoot = undefined;
		}
		const authorizationMatchesProject =
			restored.authorizedProjectRoot !== undefined
			&& restored.authorizedProjectRoot === currentProjectRoot;
		authorizedPlanPath = authorizationMatchesProject ? restored.authorizedPlanPath : undefined;
		authorizedProjectRoot = authorizationMatchesProject ? restored.authorizedProjectRoot : undefined;
		selectedPlanSkill = restored.selectedPlanSkill;
		planSubagentAddresses = new Set(restored.planSubagentAddresses ?? []);
		applyModeTools(restored.mode);
		updateStatus(ctx);
	}

	function setMode(next: AgentMode, ctx: ExtensionContext): boolean {
		const changed = modeLifecycle.select(next);
		if (ctx.isIdle() && modeLifecycle.runMode === undefined) {
			applyModeTools(modeLifecycle.selectedMode);
		}
		if (!changed) return false;
		persistState();
		updateStatus(ctx);
		return true;
	}

	function requestMode(next: AgentMode, ctx: ExtensionContext): { changed: boolean; revision: number } {
		modeIntentRevision += 1;
		const changed = setMode(next, ctx);
		if (shouldAbortCurrentRunForModeChange(changed, ctx.isIdle())) ctx.abort();
		return { changed, revision: modeIntentRevision };
	}

	function toggleMode(target: Exclude<AgentMode, "off">, ctx: ExtensionContext): void {
		requestMode(modeLifecycle.selectedMode === target ? "off" : target, ctx);
	}

	function cycleMode(ctx: ExtensionContext): void {
		requestMode(nextAgentMode(modeLifecycle.selectedMode), ctx);
	}

	async function sendTaskOnNextRun(
		task: string,
		revision: number,
		ctx: ExtensionCommandContext,
		prepare?: () => void,
	): Promise<void> {
		queuedCommandTaskCount += 1;
		try {
			await serializeTaskLaunch(async () => {
				if (!ctx.isIdle()) await ctx.waitForIdle();
				if (revision !== modeIntentRevision) {
					ctx.ui.notify("Queued mode task cancelled because a newer mode change took precedence.", "info");
					return;
				}
				applyModeTools(modeLifecycle.selectedMode);
				const started = waitForTaskStart(task, revision, prepare);
				try {
					pi.sendUserMessage(task);
				} catch (error) {
					finishPendingTaskLaunch(false);
					throw error;
				}
				if (!(await started) && revision === modeIntentRevision) {
					ctx.ui.notify("Could not confirm that the queued mode task started.", "warning");
				}
			});
		} finally {
			queuedCommandTaskCount -= 1;
		}
	}

	function reportStatus(ctx: ExtensionContext): void {
		const selectedMode = modeLifecycle.selectedMode;
		const pending = modeLifecycle.hasPendingChange
			? ` Current run: ${modeLabel(modeLifecycle.runMode!)}; next turn: ${modeLabel(selectedMode)}.`
			: "";
		ctx.ui.notify(
			`Mode: ${modeLabel(selectedMode)}.${pending} Plan template: ${selectedPlanSkill ?? "automatic"}.${authorizedPlanPath ? ` Authorized path: ${authorizedPlanPath}.` : ""}`,
			"info",
		);
	}

	async function handleConversationCommand(
		target: "discuss" | "quick",
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const command = parseModeCommand(args);
		if (command.kind === "toggle") {
			toggleMode(target, ctx);
			return;
		}
		if (command.kind === "status") {
			reportStatus(ctx);
			return;
		}
		if (command.kind === "invalid") {
			ctx.ui.notify(command.message, "error");
			return;
		}
		if (command.kind === "set") {
			requestMode(command.enabled ? target : "off", ctx);
			return;
		}
		const { revision } = requestMode(target, ctx);
		await sendTaskOnNextRun(command.task, revision, ctx);
	}

	pi.registerTool({
		name: SAVE_PLAN_TOOL,
		label: "Save Plan",
		description:
			"Save the complete final Plan-mode document to an authorized project-relative Markdown path. This is the only project-file mutation allowed in Plan mode.",
		promptSnippet: "Save the complete final plan to an authorized project-relative Markdown file",
		promptGuidelines: [
			"Use save_plan only in host-managed Plan mode, only after the plan is decision-complete, and pass the complete replacement Markdown document.",
		],
		parameters: Type.Object({
			path: Type.String({
				description: "Project-relative .md path chosen from project instructions and conventions",
			}),
			content: Type.String({ description: "Complete replacement Markdown plan" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return serializeSave(async () => {
				if (modeLifecycle.enforcedMode !== "plan") {
					throw new Error("save_plan is available only while Plan mode is active");
				}
				if (signal?.aborted) throw new Error("Plan save cancelled");
				const bytes = validatePlanContent(params.content);
				const target = await resolvePlanTarget(ctx.cwd, params.path);

				const pathIsAuthorized =
					target.relativePath === authorizedPlanPath
					&& target.projectRoot === authorizedProjectRoot;
				if (!pathIsAuthorized) {
					if (!ctx.hasUI) {
						throw new Error("save_plan requires user confirmation before authorizing a new path");
					}
					const action = target.exists ? "replace the existing file" : "create the file";
					const confirmed = await ctx.ui.confirm(
						"Authorize Plan path?",
						`Allow save_plan to ${action}?\n\n${target.relativePath}\n\nFuture revisions to this exact path on the current session branch will not ask again.`,
						{ ...(signal ? { signal } : {}), timeout: 120_000 },
					);
					if (!confirmed) throw new Error("Plan path was not authorized by the user");
				}

				await withFileMutationQueue(target.absolutePath, async () => {
					if (signal?.aborted) throw new Error("Plan save cancelled");
					await atomicWritePlan(target, params.content);
				});
				authorizedPlanPath = target.relativePath;
				authorizedProjectRoot = target.projectRoot;
				persistState();
				return {
					content: [{ type: "text", text: `Plan saved to ${target.relativePath}` }],
					details: { path: target.relativePath, bytes, replaced: target.exists },
				};
			});
		},
	});

	function registerConversationCommand(target: "discuss" | "quick"): void {
		pi.registerCommand(target, {
			description: `${target === "quick" ? "Toggle brief Quick" : "Toggle normal-response Discuss"} mode, or enable it and send a message`,
			getArgumentCompletions: completions(["on", "off", "exit", "toggle", "status"]),
			handler: (args, ctx) => handleConversationCommand(target, args, ctx),
		});
	}

	registerConversationCommand("discuss");

	pi.registerCommand("plan", {
		description: "Toggle Plan mode, or enable it and plan a task",
		getArgumentCompletions: completions(["on", "off", "exit", "toggle", "status", "--skill "]),
		handler: async (args, ctx) => {
			const command = parsePlanCommand(args);
			if (command.kind === "toggle") {
				toggleMode("plan", ctx);
				return;
			}
			if (command.kind === "status") {
				reportStatus(ctx);
				return;
			}
			if (command.kind === "invalid") {
				ctx.ui.notify(command.message, "error");
				return;
			}
			if (command.kind === "set") {
				requestMode(command.enabled ? "plan" : "off", ctx);
				return;
			}

			if (command.skillName) {
				const templates = discoverPlanTemplates(
					ctx.getSystemPromptOptions().skills,
					PLAN_SKILL_NAME,
					{ includeDisabled: true },
				);
				const selected = templates.find((template) => template.name === command.skillName);
				if (!selected || !loadSkillBody(selected)) {
					const names = templates.map((template) => template.name).join(", ") || "(none)";
					ctx.ui.notify(`Unknown, untagged, unreadable, or oversized Plan skill "${command.skillName}". Available: ${names}`, "error");
					return;
				}
			}
			const requestedPlanSkill = command.skillName;
			const { revision } = requestMode("plan", ctx);
			await sendTaskOnNextRun(command.task, revision, ctx, () => {
				selectedPlanSkill = requestedPlanSkill;
				persistState();
			});
		},
	});

	registerConversationCommand("quick");

	function installTerminalShortcut(ctx: ExtensionContext): void {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.shift("tab"))) return undefined;
			cycleMode(ctx);
			return { consume: true };
		});
	}

	pi.on("input", (event, ctx) => {
		const isIdle = ctx.isIdle();
		const isTopLevelPrompt = isIdle && event.streamingBehavior === undefined;
		if (
			launchingDeferredModeInput
			&& isTopLevelPrompt
			&& event.source === "extension"
			&& event.text === launchingDeferredModeInput.text
		) {
			deferredModeInputAccepted = true;
		}
		if (
			!event.text.trimStart().startsWith("/")
			&& shouldDeferModeTransitionInput(
				event.source,
				isIdle,
				modeLifecycle.hasPendingChange,
			)
		) {
			deferModeTransitionInput(event.text, event.images, ctx);
			return { action: "handled" as const };
		}

		if (isTopLevelPrompt) {
			// Reconcile before Pi rebuilds the base system prompt and selected-tool
			// metadata for this new top-level prompt.
			applyModeTools(modeLifecycle.selectedMode);
		}
		const pending = pendingTaskLaunch;
		if (
			pending
			&& isTopLevelPrompt
			&& event.source === "extension"
			&& event.text === pending.task
		) {
			if (pending.revision !== modeIntentRevision) {
				finishPendingTaskLaunch(false);
				ctx.ui.notify("Queued mode task cancelled because a newer mode change took precedence.", "info");
				return { action: "handled" as const };
			}
			pending.prepare?.();
			pending.prepare = undefined;
			pending.inputAccepted = true;
		}
	});

	pi.on("agent_start", () => {
		// Custom triggerTurn wakes do not emit input/before_agent_start. Latch a
		// run snapshot here when no normal prompt already created one.
		if (modeLifecycle.runMode === undefined) modeLifecycle.startRun();
		if (launchingDeferredModeInput && deferredModeInputAccepted) {
			if (deferredModeInputs[0] === launchingDeferredModeInput) deferredModeInputs.shift();
			resetDeferredModeInputLaunch();
		}
		if (pendingTaskLaunch?.inputAccepted) finishPendingTaskLaunch(true);
	});

	pi.on("tool_call", (event) => {
		const enforcedMode = modeLifecycle.enforcedMode;
		if (enforcedMode === "off") return;
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		if (!isToolAllowedInMode(enforcedMode, tool, TRUSTED_CUSTOM_TOOLS)) {
			return {
				block: true,
				reason: `${modeLabel(enforcedMode)} mode blocked untrusted or disallowed tool "${event.toolName}".`,
			};
		}
		if (enforcedMode !== "plan") return;

		const decision = applyPlanSubagentPolicy(
			event.toolName,
			event.input,
			planSubagentAddresses,
		);
		if (!decision.allowed) return { block: true, reason: decision.reason };
		if (decision.normalizedInput) {
			const mutableInput = event.input as Record<string, unknown>;
			for (const key of Object.keys(mutableInput)) delete mutableInput[key];
			Object.assign(mutableInput, decision.normalizedInput);
		}
		if (event.toolName === "subagent_spawn") {
			admittedPlanSpawnCalls.add(event.toolCallId);
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "subagent_spawn") {
			if (!admittedPlanSpawnCalls.delete(event.toolCallId)) return;
			const address = extractSuccessfulSpawnAddress(event.content, event.isError);
			if (address && !planSubagentAddresses.has(address)) {
				planSubagentAddresses.add(address);
				persistState();
			}
			return;
		}
		if (modeLifecycle.enforcedMode !== "plan") return;
		if (event.toolName === "subagent_retire" && !event.isError) {
			const target = (event.input as { to?: unknown }).to;
			if (typeof target === "string" && planSubagentAddresses.delete(target)) persistState();
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const runMode = modeLifecycle.startRun();
		if (runMode !== "plan") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildNonPlanModeInstructions(runMode)}`,
			};
		}

		const skills = event.systemPromptOptions.skills ?? [];
		const loadedSkillBody = loadSkillBody(skills.find((candidate) => candidate.name === PLAN_SKILL_NAME));
		if (!loadedSkillBody && !warnedMissingSkill) {
			warnedMissingSkill = true;
			ctx.ui.notify("Plan mode could not load the plan skill; using its read-only fallback instructions.", "warning");
		}
		if (loadedSkillBody) warnedMissingSkill = false;
		const skillBody = loadedSkillBody ?? FALLBACK_PLAN_INSTRUCTIONS;
		const automaticTemplates = discoverPlanTemplates(skills, PLAN_SKILL_NAME);
		const explicitTemplates = discoverPlanTemplates(
			skills,
			PLAN_SKILL_NAME,
			{ includeDisabled: true },
		);

		let templateInstructions: string;
		if (selectedPlanSkill) {
			const selected = explicitTemplates.find((template) => template.name === selectedPlanSkill);
			const selectedBody = loadSkillBody(selected);
			if (selected && selectedBody) {
				warnedMissingSelectedTemplate = "";
				templateInstructions = `The user explicitly selected ${JSON.stringify(selected.name)}. Follow this template; do not auto-select another.\n\n<selected_plan_template name=${JSON.stringify(selected.name)}>\n${selectedBody}\n</selected_plan_template>`;
			} else {
				const unavailableSelection = selectedPlanSkill;
				if (warnedMissingSelectedTemplate !== unavailableSelection) {
					warnedMissingSelectedTemplate = unavailableSelection;
					ctx.ui.notify(`Selected Plan skill "${unavailableSelection}" is unavailable; using automatic selection.`, "warning");
				}
				selectedPlanSkill = undefined;
				persistState();
				templateInstructions = buildAutomaticTemplateInstructions(automaticTemplates);
			}
		} else {
			warnedMissingSelectedTemplate = "";
			templateInstructions = buildAutomaticTemplateInstructions(automaticTemplates);
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanModeInstructions(skillBody, templateInstructions)}`,
		};
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Run snapshots are FIFO so an older settlement cannot clear a newer
		// overlapping prompt preflight that already latched its mode.
		const settledMode = modeLifecycle.settleRun();
		if (modeLifecycle.runMode !== undefined) return;
		if (!ctx.isIdle()) {
			// An earlier agent_settled handler started a custom triggerTurn wake,
			// which skips before_agent_start. Snapshot it before commands can alter
			// the selected mode during that run.
			modeLifecycle.startRun();
			return;
		}
		if (settledMode !== modeLifecycle.selectedMode) {
			applyModeTools(modeLifecycle.selectedMode);
		}
		if (queuedCommandTaskCount === 0) dispatchDeferredModeInput(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		installTerminalShortcut(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		modeIntentRevision += 1;
		finishPendingTaskLaunch(false);
		resetDeferredModeInputLaunch();
		deferredModeInputs = [];
		// Reload/session replacement inherits the current active-tool set. Restore
		// the pre-restricted snapshot so the next extension instance can capture
		// the real baseline again.
		restoreNormalTools();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
