/**
 * tui/escalation-modal.ts — the D10 human gate's prompt (05-tui-spec §4).
 *
 *   ⚠ refactorer/auth requests approval
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
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { EscalationRecord } from "../sandbox/escalation.ts";

export type EscalationDecision =
	| { action: "approve" }
	| { action: "deny"; note?: string }
	| { action: "view" }
	| { action: "dismissed" };

/** Plain-text modal body (harness asserts on these). */
export function escalationLines(record: EscalationRecord): string[] {
	return [
		`⚠ ${record.agent} requests approval`,
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
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

export function createEscalationModal(options: EscalationModalOptions): ModalComponent {
	const { record, tui, theme, onDone } = options;
	let noteMode = false;
	let closed = false;
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
			const body = escalationLines(record);
			// Full-screen overlay (top-left, 100%×100%, like the viewer/siblings):
			// a leading blank line lifts the approval prompt off the top edge.
			const lines: string[] = [""];
			lines.push(theme.fg("warning", truncateToWidth(body[0]!, width)));
			lines.push(theme.fg("text", truncateToWidth(body[1]!, width)));
			lines.push(theme.fg("muted", truncateToWidth(body[2]!, width)));
			lines.push(theme.fg("dim", truncateToWidth(body[3]!, width)));
			if (options.queuedBehind > 0) {
				lines.push(theme.fg("dim", truncateToWidth(`  (+${options.queuedBehind} more pending)`, width)));
			}
			if (noteMode) {
				lines.push(theme.fg("text", truncateToWidth("  deny note (enter to send, esc to cancel):", width)));
				lines.push(...noteInput.render(Math.max(10, width - 4)).map((line) => `  ${line}`));
			}
			return lines;
		},
	};
}
