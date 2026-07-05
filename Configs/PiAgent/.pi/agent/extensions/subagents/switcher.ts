/**
 * Foreground agent switcher — list the available agents and switch which one you
 * are talking to. Switching re-skins THIS session (same conversation thread); it
 * does NOT spin up a separate process.
 *
 * Two entry points:
 *   - Alt+A          — cycle to the next agent (main → …agents… → main).
 *   - /subagent      — open the picker (or /subagent <name> to switch directly).
 *
 * "main" = the plain Pi agent. The active agent shows on the left of the footer
 * status line (via setStatus + the status-line extension) and persists as a
 * session entry, so a resume comes back wearing it.
 *
 * How switching maps onto Pi primitives:
 *   - model  → pi.setModel()        (agent frontmatter `model:`, optional)
 *   - tools  → pi.setActiveTools()  (agent frontmatter `tools:`, optional)
 *   - prompt → returned from the `before_agent_start` event each turn. Mode is
 *     "augment" (default: base prompt + the agent's instructions) unless the agent
 *     file sets `mode: replace` in its frontmatter.
 *
 * (Spinning up an isolated child `pi` is a separate thing — the LLM-callable
 * `subagent` delegation tool in delegate.ts, whose result reports back to the main
 * agent.)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents, getUserAgentsDir } from "./agents.ts";
import { DEPTH_CHOICES, isNested, MAXDEPTH_ENTRY, resolveMaxDepth, saveGlobalDefault } from "./depth.ts";

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

// nf-fa-sitemap (U+F0E8) — the subagent nesting-depth cap for this session.
const ICON_DEPTH = "\u{f0e8}";

export function registerSwitcher(pi: ExtensionAPI): void {
	// Persona switching is a top-level, user-only feature. Inside a spawned subagent
	// (PI_SUBAGENT_DEPTH > 0) it stays inert — don't register the command, shortcut,
	// or prompt injection, so a subagent can never re-skin itself into another persona.
	if (isNested()) return;

	let agents: AgentConfig[] = [];
	let active: ActiveAgent | null = null;
	let original: OriginalState | undefined;

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
		updateStatus(ctx);
	}

	async function restoreMain(ctx: ExtensionContext) {
		await restoreBase();
		active = null;
		updateStatus(ctx);
	}

	// Publish just the ACTIVE agent as a footer status (not the whole roster — the
	// full list lives in the /subagent picker). The status-line extension renders
	// this key on the left of the status line. Cleared when there are no agents.
	function buildStatus(theme: ExtensionContext["ui"]["theme"], maxDepth: number): string {
		const name = active?.agent.name ?? MAIN;
		const chip = theme.bg("selectedBg", theme.fg("text", ` ${name} `));
		const modeTag = active && active.mode === "replace" ? theme.fg("warning", " replace") : "";
		// Subagent nesting cap (the count) — sitemap icon, dim.
		const depthTag = theme.fg("dim", ` ${ICON_DEPTH} ${maxDepth}`);
		return chip + modeTag + depthTag;
	}

	function updateStatus(ctx: ExtensionContext) {
		const status = agents.length > 0 ? buildStatus(ctx.ui.theme, resolveMaxDepth(ctx.sessionManager)) : undefined;
		ctx.ui.setStatus(STATUS_KEY, status);
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

	async function switchToAgentByName(name: string, ctx: ExtensionContext) {
		const agent = agents.find((a) => a.name === name);
		if (!agent) {
			const available = agents.map((a) => a.name).join(", ") || "none";
			ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
			return;
		}
		if (!(await confirmProjectAgent(agent, ctx))) return;
		// Mode is a property of the agent (frontmatter `mode:`), not asked per switch.
		await applyAgent(agent, agent.mode ?? "augment", ctx);
		ctx.ui.notify(`Switched to "${agent.name}"`, "info");
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
			...agents.map((a): SelectItem => ({
				value: a.name,
				label: active?.agent.name === a.name ? `${a.name} (active)` : a.name,
				description: agentDetail(a),
			})),
		];

		const choice = await selectFromList(ctx, "Switch agent", items);

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

	// ---- shared keyboard picker -------------------------------------------

	function selectFromList(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title))));
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
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
	}

	function agentDetail(a: AgentConfig): string {
		const bits = [a.source, a.model ?? "inherit model", a.tools ? `tools: ${a.tools.join(",")}` : "all tools"];
		return `${a.description}  ·  [${bits.join(" · ")}]`;
	}

	// Alt+A steps to the next agent in the ring: main → …agents… → main.
	async function cycleAgent(ctx: ExtensionContext) {
		if (agents.length === 0) {
			ctx.ui.notify(`No agents found. Add markdown files to ${getUserAgentsDir()} (see /subagent new).`, "warning");
			return;
		}
		const order = [MAIN, ...agents.map((a) => a.name)];
		const currentName = active?.agent.name ?? MAIN;
		const idx = order.indexOf(currentName);
		const nextName = order[(idx + 1) % order.length];
		if (nextName === MAIN) {
			await restoreMain(ctx);
			ctx.ui.notify("Switched to main agent", "info");
			return;
		}
		await switchToAgentByName(nextName, ctx);
	}

	// ---- per-session nesting-depth cap (/subagent depth) -------------------

	// `/subagent depth`            → show current + pick a preset (this session)
	// `/subagent depth <N>`        → set this session's cap to N
	// `/subagent depth global <N>` → set the cross-session default file
	async function handleDepth(rest: string, ctx: ExtensionContext) {
		const parts = rest.split(/\s+/).filter(Boolean);

		if (parts[0]?.toLowerCase() === "global") {
			const n = Number(parts[1]);
			if (!Number.isInteger(n) || n < 1) {
				ctx.ui.notify("Usage: /subagent depth global <positive integer>", "error");
				return;
			}
			try {
				saveGlobalDefault(n);
			} catch (err) {
				ctx.ui.notify(`Failed to save global default: ${err}`, "error");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(`Subagent max depth — global default set to ${n}`, "info");
			return;
		}

		if (parts.length > 0) {
			const n = Number(parts[0]);
			if (!Number.isInteger(n) || n < 1) {
				ctx.ui.notify("Usage: /subagent depth <positive integer>", "error");
				return;
			}
			pi.appendEntry(MAXDEPTH_ENTRY, { maxDepth: n });
			updateStatus(ctx);
			ctx.ui.notify(`Subagent max depth set to ${n} for this session`, "info");
			return;
		}

		const eff = resolveMaxDepth(ctx.sessionManager);
		const items: SelectItem[] = DEPTH_CHOICES.map((n) => ({
			value: String(n),
			label: n === 1 ? `${n} (no nesting)` : String(n),
			description: n === eff ? "current" : "",
		}));
		const choice = await selectFromList(ctx, `Subagent max depth (current: ${eff})`, items);
		if (!choice) return;
		const chosen = Number(choice);
		pi.appendEntry(MAXDEPTH_ENTRY, { maxDepth: chosen });
		updateStatus(ctx);
		ctx.ui.notify(`Subagent max depth set to ${chosen} for this session`, "info");
	}

	// ---- command + shortcut ------------------------------------------------

	pi.registerShortcut(OPEN_KEY, {
		description: "Cycle to the next agent",
		handler: async (ctx) => {
			await cycleAgent(ctx);
		},
	});

	pi.registerCommand("subagent", {
		description: "Switch which agent you're talking to; `/subagent depth` sets the subagent nesting cap",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const lower = arg.toLowerCase();

			// No argument → open the picker (list all agents + main, select to switch).
			if (!arg) {
				await showPicker(ctx);
				return;
			}
			if (lower === MAIN || lower === "off" || lower === "none" || lower === "base") {
				await restoreMain(ctx);
				ctx.ui.notify("Switched to main agent", "info");
				return;
			}
			if (lower === "list") {
				await showPicker(ctx);
				return;
			}
			if (lower === "new" || lower === "create") {
				await createAgent(ctx);
				return;
			}
			// `/subagent depth [N | global N]` → the per-session nesting cap.
			const [head, ...tail] = arg.split(/\s+/);
			if (head.toLowerCase() === "depth") {
				await handleDepth(tail.join(" "), ctx);
				return;
			}
			// `/subagent <name>` → switch to that agent directly.
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
