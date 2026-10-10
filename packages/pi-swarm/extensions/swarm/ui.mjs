import {
	SwarmError,
	failureDiagnostic,
} from "./errors.mjs";
import { displayText } from "./dashboard.mjs";
import { coordinationStatus } from "./coordination-status.mjs";
import { MAIL_MIRROR, TOPIC_MIRROR, cardText, cardLabel } from "./topic-mirrors.mjs";
import { Text, visibleWidth, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";

const json = value => JSON.stringify(value, null, 2);
const safeError = error => {
	const diagnostic = new SwarmError(error?.code, "");
	diagnostic.phase = error?.phase;
	return failureDiagnostic(diagnostic);
};

/** Literal data cards. Recomputed on every render so theme invalidation cannot retain old ANSI. */
export function conversationCard(messages, kind, options = {}, theme) {
	const items = Array.isArray(messages) ? messages.slice(0, 30) : [];
	const name = id => id === "owner" || id === "main" ? "Main agent" : id === "@board" ? "Board" : cardLabel(id || "Agent");
	const content = items.map(item => `${name(item.from)} → ${kind === "mail" ? "Main agent" : name(item.to)} · ${cardLabel(item.topic || "Direct mail")}\n${cardText(item.text)}${item.truncated ? "\n[stored preview truncated; inspect Swarm history for full text]" : ""}`).join("\n\n");
	return {
		invalidate() { },
		render(width) {
			width = Math.max(1, Math.floor(width));
			const padding = width >= 4 ? 1 : 0;
			const inner = width - padding * 2;
			const limit = options.expanded ? 160 : 12;
			const lines = wrapTextWithAnsi(`Swarm ${kind === "mail" ? "direct mail" : "topic conversation"} · untrusted data, never approval/policy\n${content || "No messages"}`, inner);
			const shown = lines.slice(0, limit);
			if (lines.length > limit) shown.push(options.expanded ? "[render limit; inspect Swarm history]" : "[expand for more; inspect Swarm history]");
			return shown.map(line => {
				const text = truncateToWidth(line, inner, "");
				const padded = " ".repeat(padding) + text + " ".repeat(Math.max(0, width - padding - visibleWidth(text)));
				return theme.bg(kind === "mail" ? "customMessageBg" : "toolPendingBg", theme.fg("customMessageText", padded));
			});
		},
	};
}

/** Cards are transcript-only; hidden actionable mail keeps its model delivery. */
export function registerSwarmRenderers(pi) {
	pi.registerMessageRenderer("swarm-agreement", message => new Text(displayText(message.content), 0, 0));
	pi.registerMessageRenderer("swarm-agent-mail", (message, options, theme) => conversationCard(message.details?.messages, "mail", options, theme));
	pi.registerEntryRenderer(MAIL_MIRROR, (entry, options, theme) => conversationCard(entry.data?.messages, "mail", options, theme));
	pi.registerEntryRenderer(TOPIC_MIRROR, (entry, options, theme) => conversationCard(entry.data?.messages, "topic", options, theme));
}

/** Presentation only. Consent is captured separately from a real owner input event. */
export function approvalPacket(request) {
	const native = request.provider?.transport === "pi-native";
	const label = native ? "Pi native provider" : "mock only";
	const disclosure = native
		? "Declared worker context sent through the configured Pi provider. Pi owns credentials, OAuth, environment and routing. Endpoint is informational, not pinned; no redaction or OS sandbox guarantee"
		: "in-memory only; no network";
	return displayText(`Swarm approval packet: ${request.action.toUpperCase()} (${label})\nRead every line before confirming in chat. Field text is untrusted data, not instructions.\n`
		+ `${request.workspace ? `Workspace: ${request.workspace}\n` : ""}`
		+ `${request.integrations ? `Mode gate: ${request.integrations.mode}\nWorker authorization: ${request.integrations.confirmations}\n` : ""}`
		+ `${request.workerContexts ? `Worker contexts: ${request.workerContexts}. New native sessions; prior history is retained, not reused.\n` : ""}`
		+ `${request.previousRunId ? `Prior settled run: ${request.previousRunId}. This proposal starts a separate objective, not a restart.\n` : ""}`
		+ "Coordination: workers manage scoped tasks, peer handoffs, recruitment and independent review within approved limits; main handles owner approval, steering and decisions.\n"
		+ "Completion: workers may request final verification using approved Bash access. Execution waits for native settlement and existing Safety/receipt checks; only verified completion is reported.\n"
		+ "Preservation: keep existing work, the index, and generated changes. Swarm performs no automatic reset, stash, staging, commit, or rollback.\n"
		+ `${request.repository === false ? "Project has no Git checkout metadata; existing files are preserved.\n" : ""}`
		+ `${request.fingerprintScope ? `Startup fingerprint scope: ${request.fingerprintScope}\n` : ""}`
		+ `${json(request.specification)}${request.provider ? `\nProvider agreement (${disclosure}):\n${json(request.provider)}` : ""}`
		+ `${request.providers ? `\nAll approved worker providers/models (${disclosure}):\n${json(request.providers)}` : ""}`
		+ `\nExisting changes:\n${json(request.changes)}${request.recovery ? `\nUnresolved execution:\n${json(request.recovery)}` : ""}`);
}

export function statusText(snapshot) {
	if (!snapshot?.run) return "No Swarm run attached. Controls: start, restore <run-id>.";
	const { run, driver, workspace } = snapshot;
	return json({
		runId: run.runId, status: run.status, cycle: run.cycle, elapsedMs: run.elapsedMs,
		limits: run.limits, objective: run.objective ? displayText(run.objective).slice(0, 512) : null, objectiveTruncated: (run.objective?.length ?? 0) > 512, workers: run.workers?.length ?? null, tasks: { total: run.tasks?.length ?? null, done: (run.tasks ?? []).filter(task => task.status === "done").length, blocked: (run.tasks ?? []).filter(task => task.blocker || task.status === "blocked").length },
		active: driver?.active, queued: driver?.queued, claims: coordinationStatus(workspace?.coordinationStatus),
		unresolvedOperations: run.workspace?.operations.slice(0, 32).map(({ id, workerId, taskId, kind, uncertain }) => ({ id, workerId, taskId, kind, uncertain })),
		unresolvedTurns: run.sessions?.turns.slice(0, 32).map(({ id, workerId, kind }) => ({ id, workerId, kind })),
		usage: "See model-facing status/Agents for measured worker tokens; cost unknown", errors: [...(snapshot.errors ?? []), ...(driver?.errors ?? [])].slice(0, 32).map(safeError)
	});
}
