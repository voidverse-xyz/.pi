import { isBoardMessage } from "./messaging.mjs";
import { nativeTranscript } from "./native-transcript.mjs";
import { effectiveWorkerSelection } from "./model-settings.mjs";
import { conversationText, messageText, topicsFor } from "./conversations.mjs";
import { matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Escape terminal controls before applying trusted theme styles. Preserve ordinary Unicode.
export function displayText(value) {
	return String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\t/g, "    ");
}

import { usageTotals } from "./usage.mjs";

const sections = ["Messages", "Agents", "Topics", "Steer"];

/** Only receives read capabilities. Actions are returned to the owning command after disposal. */
export class SwarmDashboard {
	constructor({ source, tui, theme, keybindings, done, signal, selectAgent, schedule = setInterval, unschedule = clearInterval }) {
		Object.assign(this, { source, tui, theme, keybindings, done, signal, selectAgent, unschedule });
		this.section = 0;
		this.offset = 0;
		this.workerIndex = 0;
		this.closed = false;
		this.history = [];
		this.query = "";
		this.follow = false;
		this.refresh();
		this.abort = () => this.finish();
		signal.addEventListener("abort", this.abort, { once: true });
		if (signal.aborted) queueMicrotask(this.abort);
		else this.timer = schedule(() => {
			if (this.closed) return;
			this.refresh();
			this.tui.requestRender();
		}, 500);
	}

	refresh() {
		if (this.closed) return;
		try {
			this.snapshot = this.source.snapshot();
			this.error = undefined;
			const workers = this.snapshot?.run?.workers ?? [];
			const retained = workers.findIndex(worker => worker.id === this.workerId);
			this.workerIndex = this.workerId === "owner" || this.workerId && retained < 0 ? -1 : retained >= 0 ? retained : Math.max(-1, Math.min(this.workerIndex, workers.length - 1));
			this.workerId = workers[this.workerIndex]?.id ?? "owner";
			const topics = topicsFor(this.snapshot?.run);
			const retainedTopic = topics.findIndex(topic => topic.name === this.selectedTopic);
			this.topicIndex = retainedTopic >= 0 ? retainedTopic : Math.max(0, Math.min(this.topicIndex ?? 0, topics.length - 1));
			this.selectedTopic = topics[this.topicIndex]?.name;
			if ((this.isConversation || this.isSteer) && this.workerId !== "owner") {
				const worker = workers[this.workerIndex];
				const key = `${worker?.id}:${this.snapshot?.run?.revision}`;
				if (this.isSteer || key !== this.historyKey) {
					const history = worker ? this.source.history(worker.id) : [];
					// Native finalized messages can arrive without a controller revision.
					const contentKey = this.isSteer ? JSON.stringify(history) : key;
					if (contentKey !== this.nativeHistoryKey) this.nativeComponents = undefined;
					this.nativeHistoryKey = contentKey;
					this.history = history;
					this.historyKey = key;
				}
			}
		} catch {
			this.error = "Inspection unavailable; preserved evidence was not changed. Close and inspect status.";
		}
	}

	finish(action) {
		if (this.closed) return;
		this.dispose();
		this.done(this.signal.aborted ? undefined : action);
	}

	dispose() {
		if (this.closed) return;
		this.closed = true;
		if (this.timer !== undefined) this.unschedule(this.timer);
		this.signal.removeEventListener("abort", this.abort);
	}

	invalidate() { this.nativeComponents = undefined; }

	handleInput(data) {
		if (this.closed) return;
		// Bracketed paste is data, never a command, even when delivered in chunks.
		if (data.includes("\x1b[200~") || this.pasting) {
			this.pasting = !data.includes("\x1b[201~");
			if (this.searching) this.draft += displayText(data.replace(/\x1b\[20[01]~/g, "")).replace(/\n/g, " ");
			this.tui.requestRender();
			return;
		}
		if (this.searching) {
			if (matchesKey(data, "escape")) this.searching = false;
			else if (matchesKey(data, "return")) {
				this.query = this.draft;
				this.searching = false;
				this.seekMatch(1, true);
			} else if (matchesKey(data, "backspace")) this.draft = Array.from(this.draft).slice(0, -1).join("");
			else if (!/[\x00-\x1f\x7f-\x9f]/.test(data)) this.draft += displayText(data);
			this.tui.requestRender();
			return;
		}
		if (data === "?" || (this.help && (data === "q" || matchesKey(data, "escape")))) {
			this.help = !this.help;
			if (this.help) { this.savedOffset = this.offset; this.offset = 0; }
			else this.offset = this.savedOffset;
			this.tui.requestRender();
			return;
		}
		if (this.help) {
			if (data === "j" || matchesKey(data, "down")) this.offset++;
			else if (data === "k" || matchesKey(data, "up")) this.offset--;
			else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.offset += this.pageSize ?? 1;
			else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.offset -= this.pageSize ?? 1;
			else if (data === "G" || matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
			else if (data === "g" || matchesKey(data, "home")) this.offset = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "q" || this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.isSteer) this.openSection(3);
			else if (this.isConversation) this.openSection(1);
			else if (this.section === 0 && this.topic) this.openSection(2);
			else return this.finish();
		} else if (data === "/" && this.section === 0) {
			this.searching = true; this.draft = "";
		} else if ((data === "n" || data === "N") && this.section === 0) this.seekMatch(data === "n" ? 1 : -1);
		else if (data === "f" && this.section === 0) this.follow = !this.follow;
		if (/^[1-4]$/.test(data)) this.openSection(Number(data) - 1);
		else if (matchesKey(data, "tab") || data === "l") this.openSection(this.isSteer ? 3 : (this.section + 1) % sections.length);
		else if (data === "h") this.openSection(this.isConversation ? 1 : Math.max(0, this.section - 1));
		else if (this.section === 2 && this.keybindings.matches(data, "tui.select.confirm")) {
			this.openTopic(this.selectedTopic);
		}
		else if (this.section === 3 && !this.isSteer && this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.workerId === "owner") { if (this.selectAgent?.("owner")) return; }
			else this.openSteer();
		}
		else if (data === "a" && this.section === 0) { this.topic = undefined; this.openSection(0); }
		else if ((data === "c" && (!this.messageEditor || this.section === 1)) || (this.section === 1 && this.keybindings.matches(data, "tui.select.confirm"))) {
			if (this.selectAgent?.(this.workerId)) return;
			this.openConversation();
		}
		else if (this.section === 2 && (data === "j" || data === "k" || matchesKey(data, "up") || matchesKey(data, "down"))) {
			const direction = data === "k" || matchesKey(data, "up") ? -1 : 1;
			const topics = topicsFor(this.snapshot?.run);
			this.topicIndex = Math.max(0, Math.min((this.topicIndex ?? 0) + direction, topics.length - 1));
			this.selectedTopic = topics[this.topicIndex]?.name;
			this.revealTopic = true;
		}
		else if ((this.section === 1 || this.section === 3 && !this.isSteer) && (data === "j" || data === "k" || matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "up") || matchesKey(data, "down"))) {
			const direction = data === "k" || matchesKey(data, "left") || matchesKey(data, "up") ? -1 : 1;
			this.workerIndex = Math.max(-1, Math.min(this.workerIndex + direction, (this.snapshot?.run?.workers.length ?? 1) - 1));
			this.workerId = this.snapshot?.run?.workers[this.workerIndex]?.id ?? "owner";
			this.revealWorker = true;
		} else if (data === "k" || this.keybindings.matches(data, "tui.select.up")) this.scroll(-1);
		else if (data === "j" || this.keybindings.matches(data, "tui.select.down")) this.scroll(1);
		else if (matchesKey(data, "ctrl+u")) this.scroll(-Math.max(1, Math.floor((this.pageSize ?? 2) / 2)));
		else if (matchesKey(data, "ctrl+d")) this.scroll(Math.max(1, Math.floor((this.pageSize ?? 2) / 2)));
		else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scroll(-(this.pageSize ?? 1));
		else if (this.keybindings.matches(data, "tui.select.pageDown")) this.scroll(this.pageSize ?? 1);
		else if (matchesKey(data, "home") || (data === "g" && this.lastKey === "g")) { this.offset = 0; this.follow = false; }
		else if (matchesKey(data, "end") || data === "G") { this.offset = Number.MAX_SAFE_INTEGER; this.follow = false; }
		this.lastKey = data === "g" && this.lastKey !== "g" ? "g" : undefined;
		this.refresh();
		this.tui.requestRender();
	}

	get isSteer() { return this.section === 3 && this.steerOpen === true; }

	openSteer(workerId = this.workerId) {
		this.openSection(3);
		this.workerId = workerId;
		this.steerOpen = true;
		this.follow = true;
		this.historyKey = undefined;
		this.refresh();
	}

	get isConversation() { return this.section === 0 && this.conversationOpen === true; }

	openConversation(workerId = this.workerId) {
		this.openSection(0);
		this.workerId = workerId;
		this.conversationOpen = true;
		this.history = [];
		this.historyKey = undefined;
		this.refresh();
	}

	openTopic(topic) {
		this.openSection(0);
		this.topic = topic;
	}

	openSection(section) {
		this.section = section;
		this.conversationOpen = false;
		this.steerOpen = false;
		this.topic = undefined;
		this.offset = 0;
		this.query = "";
		this.matchOffset = undefined;
		this.follow = false;
		this.revealWorker = section === 1 || section === 3;
		this.revealTopic = section === 2;
	}

	scroll(amount) { this.offset += amount; this.follow = false; this.matchOffset = undefined; }

	seekMatch(direction, first = false) {
		if (!this.query || !this.lines) return;
		const query = this.query.toLocaleLowerCase();
		const matches = [];
		let row = 0;
		for (const logicalLine of displayText(this.body()).split("\n")) {
			const wrapped = wrapTextWithAnsi(logicalLine, this.width ?? 80);
			const searchable = logicalLine.toLocaleLowerCase();
			const position = searchable.indexOf(query);
			if (position >= 0) {
				// Map the actual wrapped rows back to the sanitized source. Wrapping a
				// prefix loses word-wrap decisions, wide graphemes and exact boundaries.
				let end = 0;
				let matchRow = wrapped.length - 1;
				for (let index = 0; index < wrapped.length; index++) {
					const text = wrapped[index].toLocaleLowerCase();
					end = searchable.indexOf(text, end) + text.length;
					if (position < end) { matchRow = index; break; }
				}
				matches.push(row + matchRow);
			}
			row += wrapped.length;
		}
		this.matchCount = matches.length;
		if (!matches.length) return;
		this.follow = false;
		const anchor = first ? -1 : this.matchOffset ?? this.offset;
		this.offset = first ? matches[0] : direction > 0 ? matches.find(index => index > anchor) ?? matches[0] : matches.findLast(index => index < anchor) ?? matches.at(-1);
		this.matchOffset = this.offset;
	}

	body() {
		const { run, driver } = this.snapshot ?? {};
		if (!run) return "No run attached. Ask the main agent to start or restore Swarm.";
		if (this.error) return this.error;
		const worker = run.workers[this.workerIndex];
		if (this.isConversation) {
			const mail = (run.messages ?? []).filter(message => message.from === this.workerId || message.to === this.workerId || isBoardMessage(message, run.workers));
			return `${this.workerId === "owner" ? "Main agent" : worker?.specialization || this.workerId || "Agent"} · Messages\n\n${[messageText(mail, run.workers), this.workerId === "owner" ? "" : conversationText(this.history)].filter(Boolean).join("\n\n") || "No messages yet."}`;
		}
		switch (this.section) {
			case 0: {
				const messages = (run.messages ?? []).filter(message => !this.topic || message.topic === this.topic);
				return `${this.topic ? `Topic: ${this.topic} · a shows all messages\n\n` : ""}${messageText(messages, run.workers) || "No messages yet. Ask the main agent to coordinate this team."}`;
			}
			case 1: return this.agentRoster(run, driver);
			case 3: return this.isSteer ? "No native messages yet." : `Select a worker and press Enter for its native Pi transcript.\nMessaging is available only here; Agents shows inter-agent mail.\n\n${this.agentRoster(run, driver)}`;
			case 2: {
				const topics = topicsFor(run);
				if (!topics.length) return "No topics yet. Ask the main agent to start a named discussion.";
				const latest = new Map();
				for (const message of run.messages ?? []) if (message.topic) latest.set(message.topic, message);
				return topics.map((topic, index) => {
					const selected = index === (this.topicIndex ?? 0);
					const width = this.width ?? 80;
					const title = singleLine(topic.title || topic.name);
					const status = singleLine(topic.status || "discussion");
					const label = `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
					const name = singleLine(topic.name);
					const heading = topicHeading(name, label, selected, width);
					const names = topic.participants.slice(0, 3).map(singleLine).join(", ");
					const participants = names ? names + (topic.participants.length > 3 ? ` +${topic.participants.length - 3} more` : "") : "No participants yet";
					const count = `${topic.messages} ${topic.messages === 1 ? "message" : "messages"}`;
					const rows = [heading];
					if (title !== name) rows.push(selected ? `  ${title}` : clipTopicLine(`  ${title}`, width));
					rows.push(clipTopicLine(`  ${count} · ${participants}`, width));
					const message = latest.get(topic.name);
					if (selected && message) {
						const from = message.from === "owner" ? "Main agent" : singleLine(message.from);
						rows.push(clipTopicLine(`  Latest · ${from}: ${singleLine(message.text)}`, width));
					}
					return rows.join("\n");
				}).join("\n\n");
			}

		}

	}

	agentRoster(run, driver) {
		const rows = [`${this.workerIndex === -1 ? ">" : " "} Main agent · coordinates this team`, ""];
		for (const [index, worker] of run.workers.entries()) {
			const selected = index === this.workerIndex;
			const activity = !driver ? "activity unavailable" : driver.active.includes(worker.id) ? "working" : driver.queued.includes(worker.id) ? "queued" : "idle";
			rows.push(`${selected ? ">" : " "} ${worker.id} · ${activity} · ${worker.specialization}`);
			rows.push(`  ${workerModelLines(run, worker.id).join(" · ")}`);
			const usage = usageTotals(run).workers.find(row => row.workerId === worker.id);
			if (usage) rows.push(`  Requests: ${usage.requests} · Input: ${usage.input} · Cached: ${usage.cacheRead} · Output: ${usage.output} · Unknown: ${usage.unknownResponses}`);
			// Keep the roster scannable; only the selected agent reveals its detail.
			if (selected) {
				const tasks = run.tasks.filter(task => task.assignment?.workerId === worker.id);
				const assignments = tasks.map(task => `${task.title || task.id} [${task.status}]`).join(", ");
				rows.push(`  ${worker.brief}`);
				if (assignments) rows.push(`  Tasks: ${assignments}`);
			}
			rows.push("");
		}
		if (!run.workers.length) rows.push("No agents recruited yet.");
		rows.push(usageTotals(run).measured ? "Recorded worker usage above; owner usage excluded. Cost: unknown." : "Worker usage unavailable; cost: unknown.");
		return rows.join("\n");
	}

	render(width, height = this.tui.terminal.rows ?? 24) {
		if (width <= 0) return [""];
		const rows = Math.max(1, height);
		if (rows < 4) return this.shortViewport(width, rows);
		const framed = width >= 16 && rows >= 10;
		const contentWidth = Math.max(1, width - (framed ? 4 : 0));
		this.width = contentWidth;
		const status = this.snapshot?.run?.status ?? "unattached";
		const identity = this.isConversation || this.isSteer ? ` · ${this.workerId === "owner" ? "Main agent" : this.workerId}` : "";
		const heading = `${this.focusCounter ?? ""}Swarm · ${status}${identity} · ${this.isSteer ? "native Pi transcript" : "read-only"}`;
		const hints = this.searching ? "SEARCH · Enter find | Esc cancel" : this.help ? "HELP · j/k scroll | ? back" : this.focusNavigation ? this.messageEditor && this.isSteer ? "Alt+N next · Esc main · PgUp/PgDn history · Tab panes · /swarm stop" : "Alt+N next · Esc main · PgUp/PgDn history · q back · ? help · /swarm stop" : `q/Esc ${this.isConversation || this.topic ? "back" : "close"} · Tab pane · j/k move · ? help · /swarm stop`;
		const header = [this.styledLine(heading, width, "accent"), this.styledLine(hints, width, "dim")];
		if (rows >= 6) header.push(this.isSteer
			? this.styledLine(`Steer · native Pi transcript · ${this.snapshot?.driver?.active?.includes(this.workerId) ? "working" : this.snapshot?.driver?.queued?.includes(this.workerId) ? "queued" : "idle"} · Tab selects worker`, width, "muted")
			: this.isConversation
			? this.styledLine("Agent conversation · Tab opens Agents", width, "muted")
			: this.tabLine(width));
		if (rows >= 10 && (this.isConversation || this.isSteer) && this.workerId !== "owner") {
			for (const line of workerModelLines(this.snapshot?.run, this.workerId)) header.push(this.styledLine(line, width, "muted"));
		}
		const help = "NAVIGATION\nj/k or arrows: workers / scroll\nh/l: previous / next pane; Tab: next pane\ngg/G or Home/End: top / bottom\nCtrl-u/d: half page; PgUp/PgDn: page\nEnter on Agents: mail; Steer: native transcript\n4: Steer; Tab from transcript: select worker\nq/Esc: conversation back; otherwise close\nCONVERSATION\n/: local literal search; Enter applies; Esc cancels\nEmpty search clears; n/N: next / previous match\nf: toggle follow tail; scrolling stops following\nCONTROL\nAsk the main agent to change Swarm state.\nClose this view and use /swarm stop for an emergency stop.\nCtrl-c: unchanged Pi global control\nInspection never starts a worker. ? closes help.";
		const native = this.isSteer && !this.help && !this.error;
		if (native && !this.nativeComponents) this.nativeComponents = nativeTranscript(this.history, this.tui, this.snapshot?.run?.workspaceRoot ?? process.cwd());
		const nativeLines = native ? this.nativeComponents.flatMap(component => component.render(contentWidth)) : [];
		const renderedRows = native && nativeLines.length ? nativeLines.map(text => ({ text, native: true })) : this.contentRows(this.help ? help : this.body(), contentWidth);
		const lines = renderedRows.map(row => row.text);
		this.lines = lines;
		// Reserve heading, hints, tabs, two frame rules and the footer first.
		this.pageSize = Math.max(1, rows - header.length - (framed ? 2 : 0) - 1);
		if (!this.help && (((this.section === 1 || this.section === 3 && !this.isSteer) && this.revealWorker) || (this.section === 2 && this.revealTopic))) {
			const selected = lines.findIndex(line => line.startsWith("> "));
			if (selected >= 0) {
				const separator = lines.indexOf("", selected);
				const end = separator < 0 ? lines.length : separator;
				// Reveal details when they fit, without jumping every selection to the top.
				const visibleEnd = Math.min(end, selected + this.pageSize);
				if (selected < this.offset) this.offset = selected;
				else if (visibleEnd > this.offset + this.pageSize) this.offset = visibleEnd - this.pageSize;
			}
			this.revealWorker = false; this.revealTopic = false;
		}
		if (this.follow && (this.section === 0 || this.isSteer) && !this.help) this.offset = lines.length;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, lines.length - this.pageSize)));
		const page = lines.slice(this.offset, this.offset + this.pageSize);
		if (this.query && !this.help) {
			this.matchCount = displayText(this.body()).split("\n").filter(line => line.toLocaleLowerCase().includes(this.query.toLocaleLowerCase())).length;
		}
		const listFooter = this.section === 1 ? `Agent ${this.workerIndex + 2}/${(this.snapshot?.run?.workers.length ?? 0) + 1} · Enter messages` : this.section === 2 && this.selectedTopic ? `Topic ${(this.topicIndex ?? 0) + 1}/${topicsFor(this.snapshot?.run).length} · Enter discussion` : undefined;
		const position = `${this.offset + 1}-${Math.min(lines.length, this.offset + this.pageSize)} / ${lines.length} lines`;
		const footer = this.searching ? `/${this.draft} | Enter find · Esc cancel` : `${!this.help && this.snapshot?.run && listFooter ? `${listFooter} | ` : ""}${position}${this.isConversation || this.isSteer ? ` | follow ${this.follow ? "ON" : "off"}` : ""}${this.query ? ` | /${this.query}: ${this.matchCount ?? 0} matches` : ""}`;
		const body = page.map((line, index) => {
			const matched = this.query && !this.help && line.toLocaleLowerCase().includes(this.query.toLocaleLowerCase());
			if (renderedRows[this.offset + index].native) return truncateToWidth(line, contentWidth, "");
			return this.styledLine(line, contentWidth, matched ? "warning" : renderedRows[this.offset + index].color);
		});
		while (body.length < this.pageSize) body.push("");
		if (!framed) return [...header, ...body, this.styledLine(footer, width, "dim")];
		const caption = this.help ? " Help " : this.isSteer ? ` Steer · ${this.workerId} ` : this.isConversation ? ` Agent · ${this.workerId} ` : ` ${sections[this.section]}${this.topic ? ` · ${this.topic}` : ""} `;
		return [...header, this.frameRule("╭", caption, "╮", width),
			...body.map(line => this.frameRow(line, contentWidth)),
			this.frameRule("╰", "", "╯", width), this.styledLine(footer, width, "dim")];
	}

	contentRows(text, width) {
		const list = !this.help && this.section !== 0 && this.snapshot?.run && !this.error;
		const rows = [];
		let withinItem = false;
		for (const line of displayText(text).split("\n")) {
			// Style logical lines before wrapping so selected headings remain prominent.
			// Metadata stays quieter than headings in every list pane.
			const color = !list ? "text" : withinItem ? "muted" : line.startsWith("> ") ? "accent" : "text";
			for (const wrapped of wrapTextWithAnsi(line, width)) rows.push({ text: wrapped, color });
			withinItem = line.length > 0;
		}
		return rows;
	}

	tabLine(width) {
		const tabs = sections.map((section, index) => this.theme.fg(index === this.section ? "accent" : "muted", `${index + 1} ${section}`));
		const line = truncateToWidth(tabs.join("  "), width, "");
		return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	}

	styledLine(text, width, color) {
		const line = truncateToWidth(displayText(text), width, "");
		return this.theme.fg(color, line + " ".repeat(Math.max(0, width - visibleWidth(line))));
	}

	frameRule(left, caption, right, width) {
		const label = truncateToWidth(displayText(caption), width - 2, "");
		return this.theme.fg("border", left + label + "─".repeat(Math.max(0, width - 2 - visibleWidth(label))) + right);
	}

	frameRow(line, contentWidth) {
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
		return this.theme.fg("border", "│ ") + line + padding + this.theme.fg("border", " │");
	}

	shortViewport(width, rows) {
		const lines = ["Swarm · read-only", "Esc/q back · Alt+N next", "/swarm stop"];
		if (rows === 1) return [this.styledLine("Esc/q back", width, "dim")];
		return lines.slice(0, rows).map(line => this.styledLine(line, width, "dim"));
	}
}

export async function showDashboard(ctx, source, signal, onMount = () => { }) {
	if (signal.aborted) return undefined;
	let component;
	try {
		return await ctx.ui.custom((tui, theme, keybindings, done) => {
			onMount();
			component = new SwarmDashboard({ source, tui, theme, keybindings, done, signal });
			return component;
		}, { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%" } });
	} finally { component?.dispose(); }
}

/** Use the run's effective worker selection, never the main chat's ambient model. */
function workerModelLines(run, workerId) {
	const selection = effectiveWorkerSelection(run?.sessions, workerId);
	const model = selection?.modelId ? singleLine(selection.modelId) : "unavailable";
	const thinking = selection?.thinkingLevel ? singleLine(selection.thinkingLevel) : "unavailable";
	return [`Model: ${model}`, `Thinking: ${thinking}`];
}

function singleLine(value) {
	return displayText(value).replace(/\s+/g, " ").trim();
}

function clipTopicLine(text, width) {
	// Callers sanitize fields first. Remove only the SDK truncator's generated SGR
	// resets so the plain-text body does not escape them into visible control text.
	return truncateToWidth(text, width, "…").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Keep topic identity first and reserve the right edge for status when space permits. */
function topicHeading(name, status, selected, width) {
	const prefix = `${selected ? ">" : " "} `;
	if (width < 16) return clipTopicLine(`${prefix}${name} [${status}]`, width);
	const badge = clipTopicLine(`[${status}]`, Math.floor(width / 2));
	const heading = clipTopicLine(`${prefix}${name}`, width - visibleWidth(badge) - 1);
	return heading + " ".repeat(width - visibleWidth(heading) - visibleWidth(badge)) + badge;
}
