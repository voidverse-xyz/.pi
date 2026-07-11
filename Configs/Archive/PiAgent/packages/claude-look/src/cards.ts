/**
 * claude-look card renderers — the same codex-core cards (CARD.*), painted
 * Claude-Code style: an orange `⏺` label and `⎿` elbows instead of Codex's
 * bordered boxes.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { diffBand, visibleWidth } from "./ansi.ts";
import { CARD, type AgentResultData, type DiffData, type PlanData, type ReviewData, type StatusData } from "./contract.ts";

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

export function registerCards(pi: ExtensionAPI) {
	pi.registerMessageRenderer<StatusData>(CARD.status, (message, _o, theme: Theme) => {
		const d = message.details as StatusData;
		return {
			render(): string[] {
				const row = (k: string, v: string) => theme.fg("muted", "  ⎿ ") + theme.fg("muted", k.padEnd(11)) + theme.fg("text", v);
				const out = [theme.fg("accent", "⏺ ") + theme.bold("Status")];
				out.push(row("model", d.model + (d.reasoning ? ` ${d.reasoning}` : "")));
				out.push(row("provider", d.provider));
				out.push(row("cwd", d.directory));
				out.push(row("approval", d.approval));
				out.push(row("sandbox", d.sandbox));
				if (d.sessionName) out.push(row("session", d.sessionName));
				out.push(
					d.tokensUsed !== null && d.percentLeft !== null
						? row("context", `${fmt(d.tokensUsed)} / ${fmt(d.contextWindow)} tokens (${d.percentLeft}% left)`)
						: row("context", "no usage yet"),
				);
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerMessageRenderer<DiffData>(CARD.diff, (message, { expanded }, theme: Theme) => {
		const d = message.details as DiffData;
		return {
			render(width: number): string[] {
				const w = Math.max(20, width - 2);
				const lines = d.diff.split("\n");
				const max = expanded ? lines.length : 80;
				const out = [theme.fg("accent", "⏺ ") + theme.bold("Diff")];
				for (const line of lines.slice(0, max)) {
					const body = line.length > w ? line.slice(0, w - 1) + "…" : line;
					if (line.startsWith("+") && !line.startsWith("+++")) out.push("  " + diffBand("add", "", body, w));
					else if (line.startsWith("-") && !line.startsWith("---")) out.push("  " + diffBand("del", "", body, w));
					else if (line.startsWith("@@")) out.push("  " + theme.fg("accent", body));
					else if (line.startsWith("diff --git")) out.push("  " + theme.bold(body));
					else out.push("  " + theme.fg("toolDiffContext", body));
				}
				if (lines.length > max) out.push(theme.fg("dim", `  … +${lines.length - max} lines (ctrl+e)`));
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerMessageRenderer<PlanData>(CARD.plan, (message, _o, theme: Theme) => {
		const d = message.details as PlanData;
		return {
			render(): string[] {
				const out = [theme.fg("accent", "⏺ ") + theme.bold("Update Plan")];
				if (d.explanation?.trim()) out.push(theme.fg("muted", "  ⎿ ") + theme.fg("dim", d.explanation.trim()));
				for (const item of d.plan) {
					const box = item.status === "completed" ? theme.fg("success", "☑")
						: item.status === "in_progress" ? theme.fg("accent", "▣") : theme.fg("dim", "☐");
					const label = item.status === "completed" ? theme.fg("dim", item.step)
						: item.status === "in_progress" ? theme.fg("text", theme.bold(item.step)) : theme.fg("text", item.step);
					out.push(`     ${box} ${label}`);
				}
				if (!d.plan.length) out.push(theme.fg("muted", "  ⎿ ") + theme.fg("dim", "(no steps)"));
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerMessageRenderer<ReviewData>(CARD.review, (message, { expanded }, theme: Theme) => {
		const text = (message.details as ReviewData).text ?? "";
		return {
			render(): string[] {
				const lines = text.split("\n");
				const shown = expanded ? lines : lines.slice(0, 40);
				const out = [theme.fg("accent", "⏺ ") + theme.bold("Code review")];
				for (const l of shown) out.push(theme.fg("muted", "  ") + theme.fg("text", l));
				if (lines.length > shown.length) out.push(theme.fg("dim", `  … +${lines.length - shown.length} lines (ctrl+e)`));
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerMessageRenderer<AgentResultData>(CARD.agentResult, (message, _o, theme: Theme) => {
		const d = message.details as AgentResultData;
		return {
			render(): string[] {
				return [theme.fg("accent", `⏺ ${d.nickname} `) + theme.fg("muted", `(${d.role})`), ...d.result.split("\n").map((l) => theme.fg("muted", "  ") + theme.fg("text", l))];
			},
			invalidate() {},
		};
	});
}
