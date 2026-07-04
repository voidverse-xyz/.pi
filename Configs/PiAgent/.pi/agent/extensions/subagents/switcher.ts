/**
 * Foreground agent switcher — the Claude-style "which agent am I talking to" picker.
 *
 * A row under the input editor shows every available agent as a chip, with the
 * active one highlighted (▪ main is the plain Pi agent). Alt+A — or the
 * `/subagent` command — opens a keyboard picker; choosing an agent swaps the
 * SESSION's model, tools, and system prompt to that agent for your subsequent
 * turns. Choosing "main" restores the state Pi started with.
 *
 * The agent chips render on the left of the shared footer status line (via
 * setStatus + the status-line extension), so the active agent and the other
 * footer statuses sit on one line — no separate row, no duplicate indicator.
 *
 * How switching maps onto Pi primitives:
 *   - model  → pi.setModel()        (agent frontmatter `model:`, optional)
 *   - tools  → pi.setActiveTools()  (agent frontmatter `tools:`, optional)
 *   - prompt → returned from the `before_agent_start` event each turn
 *
 * Prompt mode is chosen in the TUI at switch time (the user's call):
 *   - "augment" — keep Pi's base system prompt, append the agent's instructions
 *   - "replace" — the agent's markdown body becomes the entire system prompt
 *
 * The active agent + mode are persisted as a session entry, so a resumed session
 * comes back wearing the same agent.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents, getUserAgentsDir } from "./agents.ts";

type PromptMode = "augment" | "replace";

interface ActiveAgent {
	agent: AgentConfig;
	mode: PromptMode;
}

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	tools: string[];
}

// Shared with the status-line extension, which special-cases this key onto the
// left of the footer status line.
const STATUS_KEY = "subagent";
const STATE_ENTRY = "subagent-switch";
// Alt+A, matching the Alt-based convention used by the other extensions
// (steer-queue's alt+x / alt+q).
const OPEN_KEY = Key.alt("a");
// Agents that mutate the repo shouldn't run under a persona the user didn't vet;
// project-scope agents are surfaced but confirmed before activation.
const SCOPE: AgentScope = "both";

const MAIN = "main";

export function registerSwitcher(pi: ExtensionAPI): void {
	let agents: AgentConfig[] = [];
	let active: ActiveAgent | null = null;
	let original: OriginalState | undefined;
	let lastMode: PromptMode = "augment";

	// ---- model resolution --------------------------------------------------

	// Agent frontmatter carries a bare id ("gpt-5.5") or "provider/id". Resolve to
	// a concrete Model, preferring one that actually has auth configured.
	function resolveModel(modelStr: string, ctx: ExtensionContext): Model<Api> | undefined {
		const all = ctx.modelRegistry.getAll();
		let candidates: Model<Api>[];
		if (modelStr.includes("/")) {
			const slash = modelStr.indexOf("/");
			const provider = modelStr.slice(0, slash);
			const id = modelStr.slice(slash + 1);
			candidates = all.filter((m) => m.provider === provider && m.id === id);
		} else {
			candidates = all.filter((m) => m.id === modelStr);
		}
		if (candidates.length === 0) return undefined;
		return candidates.find((m) => ctx.modelRegistry.hasConfiguredAuth(m)) ?? candidates[0];
	}

	// ---- apply / restore ---------------------------------------------------

	function snapshotOriginal(ctx: ExtensionContext) {
		original = { model: ctx.model, thinkingLevel: pi.getThinkingLevel(), tools: pi.getActiveTools() };
	}

	async function restoreBase() {
		if (!original) return;
		if (original.model) await pi.setModel(original.model);
		pi.setThinkingLevel(original.thinkingLevel);
		pi.setActiveTools(original.tools);
	}

	// Apply an agent's config on top of the base state. Every switch first rolls
	// back to base, so agents never stack (switching A→B applies B relative to
	// the plain session, not on top of A's overrides).
	async function applyAgent(agent: AgentConfig, mode: PromptMode, ctx: ExtensionContext, silent = false) {
		if (active === null) snapshotOriginal(ctx);
		await restoreBase();

		if (agent.model) {
			const model = resolveModel(agent.model, ctx);
			if (!model) {
				if (!silent) ctx.ui.notify(`Agent "${agent.name}": model "${agent.model}" not found; keeping current`, "warning");
			} else {
				const ok = await pi.setModel(model);
				if (!ok && !silent) {
					ctx.ui.notify(`Agent "${agent.name}": no API key for "${agent.model}"; keeping current`, "warning");
				}
			}
		}

		if (agent.tools && agent.tools.length > 0) {
			const allNames = pi.getAllTools().map((t) => t.name);
			const valid = agent.tools.filter((t) => allNames.includes(t));
			const invalid = agent.tools.filter((t) => !allNames.includes(t));
			if (invalid.length > 0 && !silent) {
				ctx.ui.notify(`Agent "${agent.name}": unknown tools ignored: ${invalid.join(", ")}`, "warning");
			}
			if (valid.length > 0) pi.setActiveTools(valid);
		}

		active = { agent, mode };
		lastMode = mode;
		updateStatus(ctx);
	}

	async function restoreMain(ctx: ExtensionContext) {
		await restoreBase();
		active = null;
		updateStatus(ctx);
	}

	// Publish the agent chips as a footer status. The status-line extension renders
	// this key on the left of the status line, so the chips share a line with the
	// context/token/other-extension statuses. Cleared when there are no agents.
	function buildChips(theme: ExtensionContext["ui"]["theme"]): string {
		const chip = (label: string, isActive: boolean) =>
			isActive ? theme.bg("selectedBg", theme.fg("text", ` ${label} `)) : theme.fg("dim", label);
		const parts = [chip(MAIN, active === null), ...agents.map((a) => chip(a.name, active?.agent.name === a.name))];
		const modeTag =
			active && active.mode === "replace" ? theme.fg("warning", " replace") : active ? theme.fg("dim", " augment") : "";
		return theme.fg("dim", "agent ") + parts.join(theme.fg("dim", " · ")) + modeTag;
	}

	function updateStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, agents.length > 0 ? buildChips(ctx.ui.theme) : undefined);
	}

	// ---- prompt injection --------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (!active) return;
		if (active.mode === "replace") {
			return { systemPrompt: active.agent.systemPrompt };
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n---\n\n# Active agent: ${active.agent.name}\n\n${active.agent.systemPrompt}`,
		};
	});

	// ---- picker UI ---------------------------------------------------------

	// Ask the user how the agent's prompt should combine with Pi's base prompt.
	async function pickMode(ctx: ExtensionContext): Promise<PromptMode | undefined> {
		const augmentLabel = `Augment base prompt${lastMode === "augment" ? " (default)" : ""}`;
		const replaceLabel = `Replace base prompt${lastMode === "replace" ? " (default)" : ""}`;
		const choice = await ctx.ui.select("How should this agent's instructions apply?", [augmentLabel, replaceLabel]);
		if (choice === undefined) return undefined;
		return choice === replaceLabel ? "replace" : "augment";
	}

	async function switchToAgentByName(name: string, ctx: ExtensionContext) {
		const agent = agents.find((a) => a.name === name);
		if (!agent) {
			const available = agents.map((a) => a.name).join(", ") || "none";
			ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
			return;
		}
		if (!(await confirmProjectAgent(agent, ctx))) return;
		const mode = await pickMode(ctx);
		if (mode === undefined) return;
		await applyAgent(agent, mode, ctx);
		ctx.ui.notify(`Switched to "${agent.name}" (${mode})`, "info");
	}

	async function confirmProjectAgent(agent: AgentConfig, ctx: ExtensionContext): Promise<boolean> {
		if (agent.source !== "project") return true;
		return ctx.ui.confirm(
			"Activate project-local agent?",
			`"${agent.name}" is defined in this repository (${agent.filePath}).\n` +
				"Project agents are repo-controlled instructions. Only continue for trusted repositories.",
		);
	}

	async function showPicker(ctx: ExtensionContext) {
		if (agents.length === 0) {
			ctx.ui.notify(`No agents found. Add markdown files to ${getUserAgentsDir()} (see /subagent new).`, "warning");
			return;
		}

		const items: SelectItem[] = [
			{
				value: MAIN,
				label: active === null ? `${MAIN} (active)` : MAIN,
				description: "The plain Pi agent — restore the model, tools, and prompt you started with",
			},
			...agents.map((a): SelectItem => {
				const isActive = active?.agent.name === a.name;
				const bits = [a.source, a.model ?? "inherit model", a.tools ? `tools: ${a.tools.join(",")}` : "all tools"];
				return {
					value: a.name,
					label: isActive ? `${a.name} (active)` : a.name,
					description: `${a.description}  ·  [${bits.join(" · ")}]`,
				};
			}),
		];

		const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Switch agent"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!choice) return;
		if (choice === MAIN) {
			if (active === null) return;
			await restoreMain(ctx);
			ctx.ui.notify("Switched to main agent", "info");
			return;
		}
		await switchToAgentByName(choice, ctx);
	}

	// ---- create a new agent (/subagent new) --------------------------------

	async function createAgent(ctx: ExtensionContext) {
		const rawName = await ctx.ui.input("New agent name", "e.g. debugger");
		if (!rawName?.trim()) return;
		const name = rawName.trim();
		const fileName = `${name.replace(/[^\w.-]+/g, "-").toLowerCase()}.md`;
		const dir = getUserAgentsDir();
		const filePath = join(dir, fileName);
		if (existsSync(filePath)) {
			ctx.ui.notify(`Agent file already exists: ${filePath}`, "error");
			return;
		}

		const description = (await ctx.ui.input("One-line description", "What this agent is for"))?.trim() || name;
		const body =
			(await ctx.ui.editor(`System prompt for "${name}"`, `You are ${name}. \n\nDescribe how this agent works.`)) ?? "";
		if (!body.trim()) {
			ctx.ui.notify("Cancelled: empty system prompt", "info");
			return;
		}

		const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
		try {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(filePath, content, { encoding: "utf-8" });
		} catch (err) {
			ctx.ui.notify(`Failed to write ${filePath}: ${err}`, "error");
			return;
		}

		agents = discoverAgents(ctx.cwd, SCOPE).agents;
		updateStatus(ctx);
		ctx.ui.notify(`Created agent "${name}" at ${filePath}`, "info");
	}

	// ---- command + shortcut ------------------------------------------------

	pi.registerShortcut(OPEN_KEY, {
		description: "Switch subagent",
		handler: async (ctx) => {
			await showPicker(ctx);
		},
	});

	pi.registerCommand("subagent", {
		description: "Switch the active agent (persona) for this session, or manage agents",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				await showPicker(ctx);
				return;
			}
			const lower = arg.toLowerCase();
			if (lower === MAIN || lower === "off" || lower === "none" || lower === "base") {
				await restoreMain(ctx);
				ctx.ui.notify("Switched to main agent", "info");
				return;
			}
			if (lower === "new") {
				await createAgent(ctx);
				return;
			}
			if (lower === "list") {
				const list = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				ctx.ui.notify(`Agents: ${list}`, "info");
				return;
			}
			await switchToAgentByName(arg, ctx);
		},
	});

	// ---- lifecycle ---------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		agents = discoverAgents(ctx.cwd, SCOPE).agents;
		active = null;
		original = undefined;

		// Restore the agent this session was last wearing.
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === STATE_ENTRY)
			.pop() as { data?: { name: string; mode: PromptMode } } | undefined;

		if (last?.data?.name) {
			const agent = agents.find((a) => a.name === last.data!.name);
			if (agent) await applyAgent(agent, last.data.mode ?? "augment", ctx, true);
		}
		updateStatus(ctx);
	});

	// Persist the active agent so a resume re-enters it.
	pi.on("turn_start", async () => {
		if (active) pi.appendEntry(STATE_ENTRY, { name: active.agent.name, mode: active.mode });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
