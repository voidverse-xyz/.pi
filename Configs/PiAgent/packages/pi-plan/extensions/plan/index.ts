import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	isTrustedPlanTool,
	parsePlanCommand,
	parsePlanModeState,
	planModeTools,
	SAVE_PLAN_TOOL,
	type PlanModeState,
	type TrustedCustomToolOwners,
} from "./policy.ts";
import { atomicWritePlan, resolvePlanTarget, validatePlanContent } from "./save.ts";
import {
	buildAutomaticTemplateInstructions,
	discoverPlanTemplates,
	discoverTaggedSkillDirectories,
	loadSkillBody,
} from "./templates.ts";

const STATE_ENTRY = "plan-mode.state";
const STATUS_KEY = "plan-mode";
const PLAN_SKILL_NAME = "plan";
const PLAN_ENTRY_PATH = realpathSync(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = resolve(dirname(PLAN_ENTRY_PATH), "../../..");
const SHARED_SKILLS_ROOT = resolve(PACKAGES_ROOT, "../../../Skills");

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
	[SAVE_PLAN_TOOL]: trustedPackageTool("pi-plan", "extensions/plan/index.ts"),
};
const FALLBACK_PLAN_INSTRUCTIONS = `Research and design the requested change without implementing it.
Inspect the actual project first, resolve discoverable facts through read-only exploration, and use ask_user only for consequential choices that cannot be derived from the environment.
Do not modify project files. The only mutation permitted in host-managed Plan mode is saving the complete final Markdown plan through save_plan after its exact project-relative path is authorized. Finish with a concise, decision-complete implementation and test plan.`;

function buildPlanModeInstructions(skillBody: string, templateInstructions: string): string {
	return `<plan_mode>
Plan mode is active. It is controlled by the host, not by user wording. Remain in Plan mode until the host turns it off. Follow the planning skill below for every request while this mode is active.

The host enforces a default-deny main-agent tool policy. Use only the read-only tools currently exposed. Bash, general file mutation tools, subagent spawning, and unknown custom tools are unavailable.

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

export default function planExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let authorizedPlanPath: string | undefined;
	let authorizedProjectRoot: string | undefined;
	let selectedPlanSkill: string | undefined;
	let toolsBeforePlanMode: string[] | undefined;
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

	pi.on("resources_discover", () => ({
		skillPaths: discoverTaggedSkillDirectories(SHARED_SKILLS_ROOT),
	}));

	function currentState(): PlanModeState {
		return {
			enabled,
			...(authorizedPlanPath && authorizedProjectRoot
				? { authorizedPlanPath, authorizedProjectRoot }
				: {}),
			...(selectedPlanSkill ? { selectedPlanSkill } : {}),
		};
	}

	function persistState(): void {
		pi.appendEntry<PlanModeState>(STATE_ENTRY, currentState());
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_KEY,
			enabled ? ctx.ui.theme.fg("warning", "Plan mode") : undefined,
		);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools().filter((name) => name !== SAVE_PLAN_TOOL);
		}
		pi.setActiveTools(planModeTools(toolsBeforePlanMode, pi.getAllTools(), TRUSTED_CUSTOM_TOOLS));
	}

	function restoreNormalTools(): void {
		if (toolsBeforePlanMode !== undefined) {
			pi.setActiveTools(toolsBeforePlanMode.filter((name) => name !== SAVE_PLAN_TOOL));
			toolsBeforePlanMode = undefined;
			return;
		}
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== SAVE_PLAN_TOOL));
	}

	function applyModeTools(): void {
		if (enabled) enablePlanModeTools();
		else restoreNormalTools();
	}

	function restore(ctx: ExtensionContext): void {
		let restored: PlanModeState = { enabled: false };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const state = parsePlanModeState(entry.data);
			if (state) restored = state;
		}
		enabled = restored.enabled;
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
		applyModeTools();
		updateStatus(ctx);
	}

	function setEnabled(next: boolean, ctx: ExtensionContext, notify = true): boolean {
		if (enabled === next) {
			// Reassert the filtered tool set in case another extension activated a
			// tool while Plan mode was already on. The tool_call guard is still the
			// authoritative fallback between reapplications.
			if (enabled) enablePlanModeTools();
			if (notify) ctx.ui.notify(`Plan mode is already ${enabled ? "on" : "off"}.`, "info");
			return false;
		}
		enabled = next;
		applyModeTools();
		persistState();
		updateStatus(ctx);
		if (notify) {
			ctx.ui.notify(
				enabled
					? "Plan mode enabled. Main-agent tools are read-only except for the authorized save_plan path."
					: "Plan mode disabled. Previous tool access restored.",
				enabled ? "warning" : "info",
			);
		}
		return true;
	}

	function toggle(ctx: ExtensionContext): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Plan mode can only be changed while Pi is idle.", "warning");
			return;
		}
		setEnabled(!enabled, ctx);
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
				if (!enabled) throw new Error("save_plan is available only while Plan mode is active");
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

	pi.registerCommand("plan", {
		description: "Toggle Plan mode, or enable it and plan a task",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "exit", "toggle", "status", "--skill "];
			const matches = options
				.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
				.map((option) => ({ value: option, label: option }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Plan mode can only be changed while Pi is idle.", "warning");
				return;
			}

			const command = parsePlanCommand(args);
			if (command.kind === "toggle") {
				toggle(ctx);
				return;
			}
			if (command.kind === "status") {
				ctx.ui.notify(
					`Plan mode is ${enabled ? "on" : "off"}. Template: ${selectedPlanSkill ?? "automatic"}.${authorizedPlanPath ? ` Authorized path: ${authorizedPlanPath}` : ""}`,
					"info",
				);
				return;
			}
			if (command.kind === "invalid") {
				ctx.ui.notify(command.message, "error");
				return;
			}
			if (command.kind === "set") {
				setEnabled(command.enabled, ctx);
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
			const changed = setEnabled(true, ctx, false);
			if (!changed) persistState();
			pi.sendUserMessage(command.task);
		},
	});

	pi.registerShortcut(Key.shift("tab"), {
		description: "Toggle Plan mode",
		handler: toggle,
	});

	pi.on("tool_call", (event) => {
		if (!enabled) return;
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		if (isTrustedPlanTool(tool, TRUSTED_CUSTOM_TOOLS)) return;
		return {
			block: true,
			reason: `Plan mode blocked untrusted or non-read-only tool "${event.toolName}".`,
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled) return;
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

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		// Reload/session replacement inherits the current active-tool set. Restore
		// the pre-Plan snapshot before this runtime is torn down so the next
		// extension instance can capture the real baseline again.
		restoreNormalTools();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
