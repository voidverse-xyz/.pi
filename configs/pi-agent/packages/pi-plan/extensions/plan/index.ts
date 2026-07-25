import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
	type AgentMode,
	type AgentModeState,
	type TrustedCustomToolOwners,
} from "./policy.ts";
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
const PLAN_SKILL_NAME = "plan";
const PLAN_ENTRY_PATH = realpathSync(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = resolve(dirname(PLAN_ENTRY_PATH), "../../..");

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

function buildQuickModeInstructions(): string {
	return `<quick_mode>
Quick mode is active. It is controlled by the host, not by user wording. Remain in Quick mode until the host changes modes.

Treat this as quick chat with the user:
- Answer directly in 1–4 short sentences.
- Use plain language and put the answer first.
- Do not add headings, recaps, background, caveats, or next steps unless they are essential to understanding the answer.
- If intent is unclear, ask one concise clarification instead of giving a long conditional answer.

You may use the exposed read-only lookup tools when project facts are needed. Do not modify files, run shell commands, implement work, create plans, or delegate to other agents.
</quick_mode>`;
}

function buildDiscussModeInstructions(): string {
	return `<discuss_mode>
Discuss mode is active. It is controlled by the host, not by user wording. Remain in Discuss mode until the host changes modes.

Discuss the user's topic normally and with whatever response length and structure best serves the question. You may inspect the project with the exposed read-only lookup and companion user-interface tools. Do not modify files, run shell commands, implement work, save plans, or delegate to other agents.
</discuss_mode>`;
}

function buildPlanModeInstructions(skillBody: string, templateInstructions: string): string {
	return `<plan_mode>
Plan mode is active. It is controlled by the host, not by user wording. Remain in Plan mode until the host changes modes. Follow the planning skill below for every request while this mode is active.

The host enforces a default-deny main-agent tool policy. Use only the project-read-only, companion UI/session, Plan-save, and Plan-subagent tools currently exposed. Bash, general file mutation tools, teams, procedures, and unknown custom tools are unavailable.

<plan_subagents>
You may delegate independent research when it materially improves the plan. Spawn only ad-hoc subagents with prompt (never type or id). The host forces every Plan-spawned worker to lifetime=oneshot and tools=[read, grep, find, ls], regardless of the requested tool list. These workers cannot edit files or run shell commands. Send, steer, await, inspect, cancel, or retire only workers created during Plan mode, and pass explicit targets to subagent_await.
</plan_subagents>

<plan_template_selection>
${templateInstructions}
</plan_template_selection>

When the plan is decision-complete:
- Determine its project-relative Markdown path from the project's instructions and conventions.
- If the correct path is genuinely ambiguous, ask the user with ask_user.
- Call save_plan with the complete replacement document and the chosen path.
- The host will ask the user to authorize a new or changed path. Never use another tool to save the plan.
- After save_plan succeeds, report the saved path in the final response.

${skillBody}
</plan_mode>`;
}

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
	let mode: AgentMode = "off";
	let authorizedPlanPath: string | undefined;
	let authorizedProjectRoot: string | undefined;
	let selectedPlanSkill: string | undefined;
	let planSubagentAddresses = new Set<string>();
	let toolsBeforeRestrictedMode: string[] | undefined;
	let warnedMissingSkill = false;
	let warnedMissingSelectedTemplate = "";
	let saveTail: Promise<void> = Promise.resolve();

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

	function currentState(): AgentModeState {
		return {
			mode,
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
		// Publish plain text; pi-status-line owns the dedicated left-side slot and styling.
		ctx.ui.setStatus(STATUS_KEY, mode === "off" ? undefined : STATUS_TEXT[mode]);
	}

	function enableRestrictedModeTools(): void {
		if (mode === "off") return;
		if (toolsBeforeRestrictedMode === undefined) {
			toolsBeforeRestrictedMode = pi.getActiveTools().filter((name) => name !== SAVE_PLAN_TOOL);
		}
		pi.setActiveTools(
			restrictedModeTools(mode, toolsBeforeRestrictedMode, pi.getAllTools(), TRUSTED_CUSTOM_TOOLS),
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

	function applyModeTools(): void {
		if (mode === "off") restoreNormalTools();
		else enableRestrictedModeTools();
	}

	function restore(ctx: ExtensionContext): void {
		let restored: AgentModeState = { mode: "off" };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			restored = parseAgentModeState(entry.data) ?? { mode: "off" };
		}
		mode = restored.mode;
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
		applyModeTools();
		updateStatus(ctx);
	}

	function setMode(next: AgentMode, ctx: ExtensionContext): boolean {
		if (mode === next) {
			if (mode !== "off") enableRestrictedModeTools();
			return false;
		}
		mode = next;
		applyModeTools();
		persistState();
		updateStatus(ctx);
		return true;
	}

	function requireIdle(ctx: ExtensionContext): boolean {
		if (ctx.isIdle()) return true;
		ctx.ui.notify("Agent mode can only be changed while Pi is idle.", "warning");
		return false;
	}

	function toggleMode(target: Exclude<AgentMode, "off">, ctx: ExtensionContext): void {
		setMode(mode === target ? "off" : target, ctx);
	}

	function cycleMode(ctx: ExtensionContext): void {
		if (!requireIdle(ctx)) return;
		setMode(nextAgentMode(mode), ctx);
	}

	function reportStatus(ctx: ExtensionContext): void {
		ctx.ui.notify(
			`Mode: ${modeLabel(mode)}. Plan template: ${selectedPlanSkill ?? "automatic"}.${authorizedPlanPath ? ` Authorized path: ${authorizedPlanPath}.` : ""}`,
			"info",
		);
	}

	async function handleConversationCommand(
		target: "discuss" | "quick",
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!requireIdle(ctx)) return;
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
			setMode(command.enabled ? target : "off", ctx);
			return;
		}
		setMode(target, ctx);
		pi.sendUserMessage(command.task);
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
				if (mode !== "plan") throw new Error("save_plan is available only while Plan mode is active");
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
			if (!requireIdle(ctx)) return;

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
				setMode(command.enabled ? "plan" : "off", ctx);
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
				selectedPlanSkill = command.skillName;
			} else {
				selectedPlanSkill = undefined;
			}
			const changed = setMode("plan", ctx);
			if (!changed) persistState();
			pi.sendUserMessage(command.task);
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

	pi.on("tool_call", (event) => {
		if (mode === "off") return;
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		if (!isToolAllowedInMode(mode, tool, TRUSTED_CUSTOM_TOOLS)) {
			return {
				block: true,
				reason: `${modeLabel(mode)} mode blocked untrusted or disallowed tool "${event.toolName}".`,
			};
		}
		if (mode !== "plan") return;

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
	});

	pi.on("tool_result", (event) => {
		if (mode !== "plan") return;
		if (event.toolName === "subagent_spawn") {
			const address = extractSuccessfulSpawnAddress(event.content, event.isError);
			if (address && !planSubagentAddresses.has(address)) {
				planSubagentAddresses.add(address);
				persistState();
			}
			return;
		}
		if (event.toolName === "subagent_retire" && !event.isError) {
			const target = (event.input as { to?: unknown }).to;
			if (typeof target === "string" && planSubagentAddresses.delete(target)) persistState();
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (mode === "off") return;
		if (mode === "quick") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildQuickModeInstructions()}` };
		}
		if (mode === "discuss") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildDiscussModeInstructions()}` };
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

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		installTerminalShortcut(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		// Reload/session replacement inherits the current active-tool set. Restore
		// the pre-restricted snapshot so the next extension instance can capture
		// the real baseline again.
		restoreNormalTools();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
