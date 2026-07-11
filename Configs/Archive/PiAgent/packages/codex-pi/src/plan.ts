/**
 * codex-plan — the update_plan tool + "Updated Plan" rendering, plus Plan Mode.
 * Ports codex-rs/core/src/tools/handlers/plan_spec.rs and
 * codex-rs/tui/src/history_cell/plans.rs.
 *
 * Also codex-review: /review runs a nested read-only session over the diff.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { crossedOut, dim } from "./ansi.ts";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

interface PlanItem {
	step: string;
	status: "pending" | "in_progress" | "completed";
}
interface PlanUpdate {
	explanation?: string;
	plan: PlanItem[];
}

export function registerCodexPlan(pi: ExtensionAPI, state?: { mode: string }) {
	let planMode = false;

	// --- update_plan tool + renderer --------------------------------------
	pi.registerMessageRenderer<PlanUpdate>("codex-plan", (message, _o, theme: Theme) => {
		const d = message.details as PlanUpdate;
		return {
			render(): string[] {
				const out: string[] = [dim("• ") + theme.bold("Updated Plan")];
				if (d.explanation?.trim()) {
					out.push(dim("  └ ") + dim(d.explanation.trim()));
				}
				if (!d.plan.length) {
					out.push(dim("  └ ") + dim("(no steps provided)"));
				}
				d.plan.forEach((item, i) => {
					const prefix = i === 0 && !d.explanation?.trim() ? dim("  └ ") : dim("    ");
					if (item.status === "completed") out.push(prefix + dim(crossedOut(`✔ ${item.step}`)));
					else if (item.status === "in_progress") out.push(prefix + theme.fg("accent", theme.bold(`□ ${item.step}`)));
					else out.push(prefix + dim(`□ ${item.step}`));
				});
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerTool({
		name: "update_plan",
		label: "update_plan",
		description:
			"Updates the task plan. Provide an optional explanation and a list of plan items, each with a step and status. At most one step can be in_progress at a time.",
		parameters: Type.Object({
			explanation: Type.Optional(Type.String({ description: "Optional explanation for this plan update." })),
			plan: Type.Array(
				Type.Object({
					step: Type.String({ description: "Task step text." }),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
						description: "Step status.",
					}),
				}),
				{ description: "The list of steps" },
			),
		}),
		renderShell: "self",
		async execute(_id, params) {
			if (planMode) {
				return {
					content: [{ type: "text", text: "Error: update_plan cannot be used in Plan Mode. Finalize with a <proposed_plan> block instead." }],
					isError: true,
				};
			}
			const inProgress = params.plan.filter((p) => p.status === "in_progress").length;
			if (inProgress > 1) {
				return { content: [{ type: "text", text: "Error: at most one step can be in_progress at a time." }], isError: true };
			}
			pi.sendMessage<PlanUpdate>(
				{ customType: "codex-plan", content: "", display: true, details: params },
				{ triggerTurn: false },
			);
			return { content: [{ type: "text", text: "Plan updated." }], details: params };
		},
	});

	// --- /plan — Plan Mode (collaboration mode via system-prompt injection) --
	pi.registerCommand("plan", {
		description: "switch to Plan mode",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off" || arg === "exit") {
				planMode = false;
				if (state) state.mode = "default";
				ctx.ui.setStatus("codex-plan-mode", undefined);
				ctx.ui.notify("Exited Plan Mode.", "info");
				return;
			}
			planMode = true;
			if (state) state.mode = "plan";
			ctx.ui.setStatus("codex-plan-mode", "PLAN");
			ctx.ui.notify("Entered Plan Mode — I'll plan, not execute. `/plan off` to exit.", "info");
			if (arg) pi.sendUserMessage(arg);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!planMode) return;
		const template = fs.readFileSync(path.join(ASSETS, "plan-mode.md"), "utf-8");
		return { systemPrompt: `${ctx.getSystemPrompt()}\n\n<collaboration_mode>\n${template}\n</collaboration_mode>` };
	});
}

// ---------------------------------------------------------------------------
// codex-review — /review over the working diff (core/src/tasks/review.rs)
// ---------------------------------------------------------------------------

interface ReviewFinding {
	nickname?: string;
}

export function registerCodexReview(pi: ExtensionAPI, deps = { createSession: createAgentSession }) {
	pi.registerMessageRenderer("codex-review", (message, { expanded }, theme: Theme) => {
		const text = String((message.details as { text: string }).text ?? "");
		return {
			render(): string[] {
				const lines = text.split("\n");
				const shown = expanded ? lines : lines.slice(0, 40);
				const out = [theme.fg("customMessageLabel", "● Code review")];
				for (const l of shown) out.push(theme.fg("text", l));
				if (lines.length > shown.length) out.push(dim(`… +${lines.length - shown.length} lines (ctrl+e)`));
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerCommand("review", {
		description: "review my current changes and find issues",
		handler: async (args, ctx: ExtensionContext) => {
			const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			if (inRepo.code !== 0) {
				ctx.ui.notify("`/review` — not inside a git repository", "warning");
				return;
			}
			const diff = (await pi.exec("git", ["diff", "HEAD"])).stdout;
			if (!diff.trim() && !args.trim()) {
				ctx.ui.notify("`/review` — no changes to review", "info");
				return;
			}
			ctx.ui.notify("Reviewing changes…", "info");
			try {
				const { session } = await deps.createSession({
					cwd: ctx.cwd,
					model: ctx.model,
					sessionManager: SessionManager.inMemory(ctx.cwd),
					tools: ["read", "grep", "find", "ls"], // read-only reviewer
				});
				const collected: any[] = [];
				const unsub = session.subscribe((ev: any) => {
					if (ev.type === "agent_end" && Array.isArray(ev.messages)) collected.push(...ev.messages);
				});
				const focus = args.trim() ? `\n\nFocus: ${args.trim()}` : "";
				await session.prompt(
					`You are a code reviewer. Review the following diff for correctness bugs, security issues, and regressions. ` +
						`Be concise; list findings by file:line with severity. If nothing is wrong, say so.${focus}\n\n\`\`\`diff\n${diff.slice(0, 60000)}\n\`\`\``,
					{ source: "extension" },
				);
				unsub();
				const assistants = collected.filter((m) => m.role === "assistant");
				const last = assistants[assistants.length - 1];
				const text = (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
				session.dispose?.();
				pi.sendMessage(
					{ customType: "codex-review", content: "", display: true, details: { text: text || "(no findings returned)" } },
					{ triggerTurn: false },
				);
			} catch (err: any) {
				ctx.ui.notify(`Review failed: ${err?.message ?? err}`, "error");
			}
		},
	});
}
