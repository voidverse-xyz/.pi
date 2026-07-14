/**
 * tui/escalation-modal.ts — the D10 human gate's editor-local prompt (05-tui-spec §4).
 *
 *    refactorer/auth requests approval
 *     bash: git push origin main
 *     blocked by: writePaths (mutation outside src/auth/**)
 *     [a]pprove once  [d]eny  [D]eny with note  [v]iew session
 *
 * The modal only DECIDES — index.ts calls core.escalations.approve/deny with
 * the result (keeping the human-only approve call in exactly one place) and
 * opens the viewer on [v]. Esc dismisses without resolving: the escalation
 * stays pending behind the widget's ⚠ segment (the agent keeps waiting; that
 * is the designed absent-user behavior).
 *
 * APPROVE-ONCE ONLY (D22): there is deliberately no "always allow" key —
 * repeat escalations are fixed by editing the type's frontmatter.
 *
 * Deny-with-note uses pi-tui Input; Enter resolves with the note argument
 * (Input.onSubmit passes the value — no readback needed).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EscalationRecord } from "../sandbox/escalation.ts";

export type EscalationDecision =
	| { action: "approve" }
	| { action: "deny"; note?: string }
	| { action: "view" }
	| { action: "dismissed" };

/** Plain-text modal body (harness asserts on these). */
export function escalationLines(record: EscalationRecord): string[] {
	return [
		` ${record.agent} requests approval`,
		`  ${record.tool}: ${record.inputSummary}`,
		`  blocked by: ${record.reason}`,
		"  [a]pprove once  [d]eny  [D]eny with note  [v]iew session",
	];
}

export interface EscalationModalOptions {
	record: EscalationRecord;
	/** How many more are queued behind this one (0 = just this). */
	queuedBehind: number;
	tui: TUI;
	theme: Theme;
	onDone: (decision: EscalationDecision) => void;
}

interface ModalComponent {
	focused?: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

export function createEscalationModal(options: EscalationModalOptions): ModalComponent {
	const { record, tui, theme, onDone } = options;
	let noteMode = false;
	let closed = false;
	let focused = true;
	const noteInput = new Input();

	const finish = (decision: EscalationDecision): void => {
		if (closed) return;
		closed = true;
		onDone(decision);
	};

	noteInput.onSubmit = (value) => {
		// Input.onSubmit passes the submitted value — use the argument.
		finish({ action: "deny", ...(value.trim().length > 0 ? { note: value.trim() } : {}) });
	};
	noteInput.onEscape = () => {
		noteMode = false;
		noteInput.setValue("");
		tui.requestRender();
	};

	return {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			noteInput.focused = value;
		},
		invalidate() {},
		dispose() {
			closed = true;
		},
		handleInput(data: string) {
			if (noteMode) {
				noteInput.handleInput(data);
				tui.requestRender();
				return;
			}
			switch (data) {
				case "a":
					finish({ action: "approve" });
					return;
				case "d":
					finish({ action: "deny" });
					return;
				case "D":
					noteMode = true;
					tui.requestRender();
					return;
				case "v":
					finish({ action: "view" });
					return;
				case "\x1b":
				case "\x03":
				case "q":
					finish({ action: "dismissed" });
					return;
			}
		},
		render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];
			const divider = theme.fg("warning", "─".repeat(renderWidth));
			const addWrapped = (prefix: string, text: string, color: Parameters<Theme["fg"]>[0] | undefined, maxRows = 4) => {
				const prefixWidth = visibleWidth(prefix);
				const usablePrefix = prefixWidth < renderWidth ? prefix : "";
				const usableWidth = visibleWidth(usablePrefix);
				const styled = color ? theme.fg(color, text) : text;
				const wrapped = wrapTextWithAnsi(styled, Math.max(1, renderWidth - usableWidth)).slice(0, maxRows);
				const pad = " ".repeat(usableWidth);
				for (const [index, line] of wrapped.entries()) lines.push(`${index === 0 ? usablePrefix : pad}${line}`);
			};

			// Same visual grammar as pi-safety confirmations: colored divider,
			// warning header, padded command/reason body, actions, closing divider.
			lines.push(divider);
			addWrapped("", ` ${record.agent} requests approval`, "warning", 2);
			lines.push("");
			const toolPrefix = record.tool === "bash" ? "  $ " : `  ${record.tool}: `;
			addWrapped(theme.fg("dim", toolPrefix), record.inputSummary, "text", 6);
			addWrapped(theme.fg("dim", "  blocked by: "), record.reason, "muted", 4);
			lines.push("");
			addWrapped(
				"  ",
				theme.fg("success", "a approve once") +
					theme.fg("dim", "   ") +
					theme.fg("warning", "d deny   D deny with note") +
					theme.fg("dim", "   v view session   Esc dismiss"),
				undefined,
				3,
			);
			if (options.queuedBehind > 0) addWrapped("  ", `+${options.queuedBehind} more pending`, "dim", 1);
			if (noteMode) {
				addWrapped("  ", "Deny note (Enter send · Esc cancel)", "text", 2);
				lines.push(...noteInput.render(Math.max(1, renderWidth - 2)).map((line) => truncateToWidth(`  ${line}`, renderWidth)));
			}
			lines.push(divider);
			return lines.map((line) => visibleWidth(line) > renderWidth ? truncateToWidth(line, renderWidth) : line);
		},
	};
}
