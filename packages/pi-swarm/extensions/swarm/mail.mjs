import { readFileSync } from "node:fs";

/** Complete native session lines are the only acknowledgement of durable mail. */
export function persistedMessageIds(context, runId) {
	const path = context?.sessionManager?.getSessionFile?.();
	if (!path) return new Set();
	let text;
	try { text = readFileSync(path, "utf8"); }
	catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
	const ids = new Set();
	const lines = text.split("\n"); lines.pop();
	for (const line of lines) {
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== "custom_message" || entry.customType !== "swarm-agent-mail" || entry.details?.runId !== runId) continue;
		for (const id of Array.isArray(entry.details.messageIds) ? entry.details.messageIds : []) if (typeof id === "string") ids.add(id);
	}
	return ids;
}
