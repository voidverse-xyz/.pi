import { displayText } from "./dashboard.mjs";
import { Editor, matchesKey, CURSOR_MARKER } from "@earendil-works/pi-tui";

/** Native text editor for a focused worker; list and topic views remain read-only. */
export class AgentComposer {
	constructor({ dashboard, ui, send, drafts, pending, runId, navigate }) {
		Object.assign(this, { dashboard, ui, send, drafts, pending, runId, navigate });
		const { tui, theme } = dashboard;
		this.editor = new Editor(tui, {
			borderColor: text => theme.fg("border", text),
			selectList: { selectedPrefix: text => text, selectedText: text => text, description: text => text,
				scrollInfo: text => text, noMatch: text => text }
		});
		this.editor.onSubmit = text => { void this.submit(text); };
		this.syncRecipient(); this.syncSubmission();
	}

	get composing() { return this.dashboard.isSteer && this.dashboard.workerId !== "owner"; }
	get focused() { return this.editor.focused; }
	set focused(value) { this.editor.focused = value; }

	syncRecipient() {
		const recipient = this.composing ? this.dashboard.workerId : undefined;
		if (recipient === this.recipient) return;
		this.saveDraft();
		this.recipient = recipient;
		this.feedback = undefined;
		this.submittedText = undefined;
		this.editor.setText(recipient ? this.drafts.get(recipient) ?? "" : "");
	}

	syncSubmission() {
		const sending = this.pending.get(this.recipient);
		if (sending !== undefined) this.submittedText = sending;
		else if (this.submittedText !== undefined) {
			if (this.drafts.get(this.recipient) !== this.submittedText && this.editor.getText() === this.submittedText) this.editor.setText("");
			this.submittedText = undefined;
		}
	}

	saveDraft() {
		if (!this.recipient) return;
		// Settlement can occur between the last redraw and disposal/pane navigation.
		this.syncSubmission();
		const text = this.editor.getText();
		if (text) this.drafts.set(this.recipient, text);
		else this.drafts.delete(this.recipient);
	}

	feedbackContext(run = this.dashboard.snapshot?.run, recipient = this.recipient) {
		return JSON.stringify([recipient, run?.runId, run?.status, run?.workers?.some(worker => worker.id === recipient)]);
	}

	handleEditorInput(data) {
		const before = this.editor.getText();
		this.editor.handleInput(data);
		if (this.editor.getText() !== before) this.feedback = undefined;
	}

	report(text, level, context = this.feedbackContext()) {
		if (this.closed) return;
		this.feedback = { text, context, color: level === "error" ? "error" : level === "warning" ? "warning" : "success" };
		this.ui.notify(text, level);
		this.dashboard.tui.requestRender();
	}

	async submit(text) {
		const to = this.recipient;
		if (this.closed || !this.composing || !to || !text.trim() || this.pending.has(to)) return;
		this.feedback = undefined;
		if (/^\s*[\/!]/.test(text)) {
			this.editor.setText(""); this.drafts.delete(to);
			this.navigate("back");
			this.ui.setEditorText(text);
			this.ui.notify("Command moved to the main editor. Press Enter to run it.", "info");
			return;
		}
		// Editor clears itself before onSubmit; retain the draft until delivery settles.
		this.editor.setText(text);
		this.drafts.set(to, text);
		let run;
		let ownershipHeld;
		try { const snapshot = this.dashboard.source.snapshot(); run = snapshot?.run; ownershipHeld = snapshot?.ownershipHeld; }
		catch { this.report("Agent availability could not be checked; draft retained.", "error"); return; }
		const context = this.feedbackContext(run, to);
		if (ownershipHeld === false || run?.runId !== this.runId || run?.status !== "running" || !run.workers.some(worker => worker.id === to)) {
			this.report("This agent cannot receive mail now. Resume the approved Swarm first; draft retained.", "warning", context);
			return;
		}
		if (text.length > 32768) {
			this.report("Agent mail is limited to 32768 characters. Shorten the draft before sending.", "warning", context);
			return;
		}
		this.pending.set(to, text);
		this.dashboard.tui.requestRender();
		try {
			await this.send(to, text, this.runId);
			if (this.drafts.get(to) === text) this.drafts.delete(to);
			if (!this.closed && this.recipient === to && this.editor.getText() === text) this.editor.setText("");
			if (!this.closed) this.report(`Message queued to ${displayText(to)}.`, "info", context);
		} catch {
			// Delivery may be uncertain after a storage failure. Never retry or echo raw errors.
			if (!this.closed) this.report("Message delivery could not be confirmed. Inspect Swarm status before retrying; draft retained.", "error", context);
		} finally {
			this.pending.delete(to);
			if (!this.closed) this.dashboard.tui.requestRender();
		}
	}

	handleInput(data) {
		if (this.closed) return;
		this.syncRecipient(); this.syncSubmission();
		if (!this.composing) { this.dashboard.handleInput(data); this.syncRecipient(); return; }
		// Native editor paste owns all pasted characters, including tabs and escape sequences.
		if (data.includes("\x1b[200~") || this.pasting) {
			// If the opening marker was suppressed during a send, suppress the whole
			// paste even if delivery settles mid-paste. CR must never become Submit.
			if (!this.pasting) this.suppressPaste = this.pending.has(this.recipient);
			this.pasting = !data.includes("\x1b[201~");
			if (!this.suppressPaste) this.handleEditorInput(data);
			if (!this.pasting) this.suppressPaste = false;
		} else if (matchesKey(data, "tab")) {
			this.dashboard.handleInput(data); this.syncRecipient();
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.dashboard.scroll((matchesKey(data, "pageUp") ? -1 : 1) * (this.dashboard.pageSize ?? 1));
		} else if (matchesKey(data, "ctrl+end")) {
			this.dashboard.follow = true;
		} else if (matchesKey(data, "ctrl+v")) {
			this.report("Agent mail supports text only. Return to the main chat for image attachments.", "warning");
		} else if (!this.pending.has(this.recipient)) this.handleEditorInput(data);
		this.dashboard.tui.requestRender();
	}

	render(width) {
		this.syncRecipient(); this.syncSubmission();
		if (!this.composing || width <= 0) return this.dashboard.render(width);
		const { tui } = this.dashboard;
		const rows = Math.max(1, tui.terminal.rows ?? 24);
		// Native Editor needs two layout columns for wide graphemes plus its cursor.
		// Tiny terminals keep the draft untouched instead of entering its width-one wrapper.
		if (width < 4) return this.dashboard.shortViewport(width, rows);
		const bordered = width >= 8 && rows >= 8;
		const contentWidth = Math.max(3, width - (bordered ? 4 : 0));
		const editorLines = this.editor.render(contentWidth);
		const labelRows = rows >= 8 ? 1 : 0;
		const borderRows = bordered ? 2 : 0;
		const inputBudget = Math.max(1, Math.min(8, rows - labelRows - borderRows - 4));
		const cursorRow = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
		const start = cursorRow < 0 ? Math.max(0, editorLines.length - inputBudget)
			: Math.max(0, Math.min(editorLines.length - inputBudget, cursorRow - inputBudget + 1));
		const input = editorLines.slice(start, start + inputBudget);
		const historyRows = Math.max(0, rows - labelRows - borderRows - input.length);
		const history = historyRows ? this.dashboard.render(width, historyRows) : [];
		const run = this.dashboard.snapshot?.run;
		if (this.feedback?.context !== this.feedbackContext(run)) this.feedback = undefined;
		const state = this.pending.has(this.recipient) ? "Sending…" : run?.status === "running" ? "Enter send · / or ! to main · Ctrl+End follow · Tab panes" : "Paused/unavailable · draft retained · Tab panes";
		const feedback = !this.pending.has(this.recipient) && this.feedback;
		const labels = labelRows ? [this.dashboard.styledLine(feedback ? feedback.text : state, width, feedback ? feedback.color : "dim")] : [];
		const field = bordered ? [this.dashboard.frameRule("╭", " Message agent ", "╮", width),
			...input.map(line => this.dashboard.frameRow(line, contentWidth)), this.dashboard.frameRule("╰", "", "╯", width)] : input;
		return [...history, ...labels, ...field].slice(-rows);
	}

	invalidate() { this.dashboard.invalidate(); this.editor.invalidate(); }
	dispose() {
		if (this.closed) return;
		this.saveDraft(); this.closed = true;
		this.dashboard.dispose();
	}
}
