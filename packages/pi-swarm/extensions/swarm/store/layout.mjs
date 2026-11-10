import { join, resolve } from "node:path";
import { invariant, validId } from "./files.mjs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Pure path math, matching Pi's project session-directory encoding. */
export function prepareLayout(workspace, runId, { agentDir = getAgentDir() } = {}) {
	invariant(validId(runId), "Invalid run identifier");
	const root = resolve(workspace);
	const slug = `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const stateRoot = join(agentDir, "sessions", slug, "swarm");
	const runRoot = join(stateRoot, runId);
	return Object.freeze({
		workspaceRoot: root, stateRoot, runId, runRoot,
		sessionDir: join(runRoot, "sessions"), reservationPath: join(stateRoot, "reservation.json"),
		ownerPath: join(stateRoot, "controller.lock"), journalPath: join(runRoot, "events.jsonl")
	});
}
