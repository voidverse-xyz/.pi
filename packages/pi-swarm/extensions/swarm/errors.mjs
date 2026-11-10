export class SwarmError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "SwarmError";
		this.code = code;
	}
}

export function requireCondition(condition, code, message) {
	if (!condition) throw new SwarmError(code, message);
}

/** Attach a trusted phase without exposing filesystem or SDK exception text. */
export async function inPhase(phase, operation) {
	try { return await operation(); }
	catch (error) {
		const failure = error instanceof SwarmError ? error : new SwarmError(["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code) ? "PATH" : "FAILED", "Swarm operation failed");
		failure.phase ??= phase;
		if (failure !== error) failure.cause = error;
		throw failure;
	}
}

const FAILURE_MESSAGES = {
	INPUT: "Check the tool arguments and agreement fields.",
	UI: "Interactive owner chat confirmation is required for this action.",
	SESSION: "A persisted owning session is required.",
	MODEL: "Select an available physical model before starting.",
	MODE_DENIED: "Use unrestricted mode and wait for policy readiness.",
	AUTHORITY: "Approval was declined, unavailable, or revoked.",
	PROPOSAL_REQUIRED: "The proposal is absent, replaced, or revoked. Prepare a fresh proposal, let its turn finish, then obtain exact owner confirmation. No work has launched.",
	PROPOSAL_UNCONFIRMED: "The current proposal still needs explicit owner confirmation in the owning chat. Do not retry the launch or create a replacement proposal to infer consent.",
	CANCELLED: "The request was cancelled; fresh approval is required to continue.",
	INSPECTION_TIMEOUT: "Workspace inspection reached its deadline.",
	INSPECTION_LIMIT: "Git inspection output exceeded its bounded limit.",
	INSPECTION: "Workspace inspection could not complete.",
	STALE: "Workspace or run state changed; inspect and approve again.",
	PATH: "Workspace path or file identity is unsupported.",
	PROVIDER: "The selected provider no longer matches the approved configuration.",
	OWNERSHIP: "Session or controller ownership changed or is unavailable.",
	RESERVED: "This project is reserved by an existing Swarm. Restore that run and explicitly stop it before launching another; do not delete its reservation.",
	UNSETTLED: "Execution remains unsettled; inspect before recovery.",
	BUSY: "Another Swarm operation is still active.",
	STATE: "This action is unavailable in the current run state.",
	RUNTIME_STALE: "Reload retained incompatible Swarm storage modules. Exit Pi, cold-start it and resume this same session; do not clear it or delete ownership metadata. No workers will resume automatically; request a fresh proposal and approval.",
	USAGE_LIMIT: "Worker model allowance is exhausted or unmeasured. New requests are fenced; inspect usage and settle before any approved continuation.",
	TIME_LIMIT: "The saved run allowance is exhausted; recovery cannot reset it.",
	DUPLICATE: "This run already exists; restore it instead.",
	FAILED: "The Swarm operation failed; inspect status before continuing.",
};
const FAILURE_PHASES = new Set(["setup", "launch", "inspection", "approval", "storage", "attachment", "resume", "restart", "restore", "reconcile", "recovery", "continuation", "control", "history"]);

/** Only constant messages, codes and phases are safe for model-facing results. */
export function failureDiagnostic(error, fallback = "control") {
	const trusted = error instanceof SwarmError;
	const code = trusted && Object.hasOwn(FAILURE_MESSAGES, error.code) ? error.code : "FAILED";
	const phase = trusted && FAILURE_PHASES.has(error.phase) ? error.phase : fallback;
	return { code, phase: FAILURE_PHASES.has(phase) ? phase : "control", message: FAILURE_MESSAGES[code] };
}
