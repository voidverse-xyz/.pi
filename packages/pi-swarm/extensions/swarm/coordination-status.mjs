/** Diagnostic metadata is an allowlist, not arbitrary worker text or tool arguments. */
const KINDS = new Set(["claim", "mutation", "exclusive"]);
const PURPOSES = new Set(["mutation", "exclusive", "write", "edit", "shell", "submit", "review", "final"]);
const STAGES = new Set(["claims-held", "queued", "approval", "inspection", "execution", "settlement", "unknown-settlement", "recording", "candidate", "review"]);

export const diagnosticId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const ownerId = value => typeof value === "string" && /^\d{1,10}:\d{1,10}:\d{1,10}:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) ? value : null;

export function coordinationEntry(entry) {
	return {
		owner: ownerId(entry?.owner), workerId: diagnosticId(entry?.workerId), taskId: diagnosticId(entry?.taskId),
		...(Number.isSafeInteger(entry?.id) && entry.id > 0 ? { id: entry.id } : {}),
		...(KINDS.has(entry?.kind) ? { kind: entry.kind } : {}),
		...(PURPOSES.has(entry?.purpose) ? { purpose: entry.purpose } : {}),
		stage: STAGES.has(entry?.stage) ? entry.stage : "queued",
		...(typeof entry?.cancellationRequested === "boolean" ? { cancellationRequested: entry.cancellationRequested } : {}),
		...(Number.isSafeInteger(entry?.count) && entry.count >= 0 ? { count: entry.count } : {}),
	};
}

export function coordinationStatus(value) {
	const entries = key => Array.isArray(value?.[key]) ? value[key].slice(0, 32).map(coordinationEntry) : [];
	return {
		claims: entries("claims"), pending: entries("pending"), active: entries("active"),
		counts: { claims: count(value?.counts?.claims), pending: count(value?.counts?.pending), active: count(value?.counts?.active) },
	};
}
