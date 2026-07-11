/**
 * codex-look card renderers — turn codex-core's semantic custom messages
 * (CARD.*) into Codex-styled TUI cards. Registered via registerMessageRenderer.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { bold, borderedCard, crossedOut, dim, visibleWidth } from "./ansi.ts";
import { CARD, type AgentResultData, type DiffData, type PlanData, type ReviewData, type StatusData } from "./contract.ts";

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

export function registerCards(pi: ExtensionAPI) {
	// /status card
	pi.registerMessageRenderer<StatusData>(CARD.status, (message, _o, theme: Theme) => {
		const d = message.details as StatusData;
		return {
			render(width: number): string[] {
				const label = (s: string) => dim(s.padEnd(11));
				const rows = [
					dim(">_ ") + bold("OpenAI Codex"),
					"",
					label("model:") + d.model + (d.reasoning ? ` ${d.reasoning}` : ""),
					label("provider:") + d.provider,
					label("directory:") + d.directory,
					label("approval:") + d.approval,
					label("sandbox:") + d.sandbox,
				];
				if (d.sessionName) rows.push(label("session:") + d.sessionName);
				rows.push("");
				rows.push(
					d.tokensUsed !== null && d.percentLeft !== null
						? label("tokens:") + `${fmt(d.tokensUsed)} used ` + dim(`/ ${fmt(d.contextWindow)} `) + `(${d.percentLeft}% left)`
						: label("tokens:") + dim("no usage yet"),
				);
				return [theme.fg("customMessageLabel", "/status"), ...borderedCard(rows, width, 72)];
			},
			invalidate() {},
		};
	});

	// /diff card
	pi.registerMessageRenderer<DiffData>(CARD.diff, (message, { expanded }, theme: Theme) => {
		const d = message.details as DiffData;
		return {
			render(width: number): string[] {
				const lines = d.diff.split("\n");
				const max = expanded ? lines.length : 80;
				const out = [theme.fg("customMessageLabel", "/diff")];
				for (const line of lines.slice(0, max)) {
					const clipped = visibleWidth(line) > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;
					if (line.startsWith("+") && !line.startsWith("+++")) out.push(theme.fg("toolDiffAdded", clipped));
					else if (line.startsWith("-") && !line.startsWith("---")) out.push(theme.fg("toolDiffRemoved", clipped));
					else if (line.startsWith("@@")) out.push(theme.fg("accent", clipped));
					else if (line.startsWith("diff --git")) out.push(bold(clipped));
					else out.push(theme.fg("toolDiffContext", clipped));
				}
				if (lines.length > max) out.push(dim(`… +${lines.length - max} lines (ctrl+e to expand)`));
				return out;
			},
			invalidate() {},
		};
	});

	// update_plan card ("Updated Plan" with ✔/□)
	pi.registerMessageRenderer<PlanData>(CARD.plan, (message, _o, theme: Theme) => {
		const d = message.details as PlanData;
		return {
			render(): string[] {
				const out = [dim("• ") + bold("Updated Plan")];
				if (d.explanation?.trim()) out.push(dim("  └ ") + dim(d.explanation.trim()));
				if (!d.plan.length) out.push(dim("  └ ") + dim("(no steps provided)"));
				d.plan.forEach((item, i) => {
					const prefix = i === 0 && !d.explanation?.trim() ? dim("  └ ") : dim("    ");
					if (item.status === "completed") out.push(prefix + dim(crossedOut(`✔ ${item.step}`)));
					else if (item.status === "in_progress") out.push(prefix + theme.fg("accent", bold(`□ ${item.step}`)));
					else out.push(prefix + dim(`□ ${item.step}`));
				});
				return out;
			},
			invalidate() {},
		};
	});

	// /review card
	pi.registerMessageRenderer<ReviewData>(CARD.review, (message, { expanded }, theme: Theme) => {
		const text = (message.details as ReviewData).text ?? "";
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

	// sub-agent result card
	pi.registerMessageRenderer<AgentResultData>(CARD.agentResult, (message, _o, theme: Theme) => {
		const d = message.details as AgentResultData;
		return {
			render(): string[] {
				return [theme.fg("customMessageLabel", `● ${d.nickname} [${d.role}]`), ...d.result.split("\n").map((l) => theme.fg("text", l))];
			},
			invalidate() {},
		};
	});
}
