/**
 * codex-core plan + review — behavior only.
 * update_plan validates and emits a cpx.plan card; Plan Mode injects Codex's
 * collaboration template and broadcasts the mode; /review runs a nested
 * read-only session over the diff and emits a cpx.review card.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CARD, EVT, type CodexState, type PlanData, type ReviewData } from "./contract.ts";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

export function registerPlan(pi: ExtensionAPI, state: CodexState) {
	let planMode = false;

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
		async execute(_id, params) {
			if (planMode) {
				return { content: [{ type: "text", text: "Error: update_plan cannot be used in Plan Mode." }], isError: true };
			}
			if (params.plan.filter((p) => p.status === "in_progress").length > 1) {
				return { content: [{ type: "text", text: "Error: at most one step can be in_progress at a time." }], isError: true };
			}
			pi.sendMessage<PlanData>({ customType: CARD.plan, content: "", display: true, details: params }, { triggerTurn: false });
			return { content: [{ type: "text", text: "Plan updated." }], details: params };
		},
	});

	pi.registerCommand("plan", {
		description: "switch to Plan mode",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off" || arg === "exit") {
				planMode = false;
				state.mode = "default";
				pi.events.emit(EVT.mode, "default");
				ctx.ui.notify("Exited Plan Mode.", "info");
				return;
			}
			planMode = true;
			state.mode = "plan";
			pi.events.emit(EVT.mode, "plan");
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

export function registerReview(pi: ExtensionAPI, deps = { createSession: createAgentSession }) {
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
					tools: ["read", "grep", "find", "ls"],
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
				const last = collected.filter((m) => m.role === "assistant").pop();
				const text = (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
				session.dispose?.();
				pi.sendMessage<ReviewData>(
					{ customType: CARD.review, content: "", display: true, details: { text: text || "(no findings returned)" } },
					{ triggerTurn: false },
				);
			} catch (err: any) {
				ctx.ui.notify(`Review failed: ${err?.message ?? err}`, "error");
			}
		},
	});
}
