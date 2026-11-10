import {
	providerDescriptor,
	assertProviderSelection,
} from "./provider-capability.mjs";
import {
	inPhase,
	SwarmError,
	failureDiagnostic,
	requireCondition as check,
} from "./errors.mjs";
import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { validId } from "./store/files.mjs";
import { SwarmController } from "./core.mjs";
import { recipientId } from "./messaging.mjs";
import { SwarmSessions } from "./sessions.mjs";
import { prepareLayout } from "./store/layout.mjs";
import { WorkspaceRuntime } from "./workspace.mjs";
import { releaseStaleLease } from "./store/lease.mjs";
import { readSessionHistory } from "./sdk-session.mjs";
import { DEFAULT_LIMITS, reduceEvent } from "./state.mjs";
import { ModeGate, requestSafety, DEFAULT_SAFETY_TIMEOUT_MS } from "./host-gates.mjs";
import { inspectRecovery } from "./recovery-inspection.mjs";
import { validateWorkerContext } from "./context/fork.mjs";
import { inspectCheckout, specificationFingerprint } from "./host-approval.mjs";
import { resolveModelSettings, providerAgreements } from "./model-settings.mjs";
import { createNativeSelection, nativeModelRuntime } from "./native-provider.mjs";

function freeze(value) {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Host-only approval orchestration; provider execution requires explicit capability injection. */
export class SwarmHost {
	#listeners = new Set();
	#unsubscribe;
	#events;
	#sessionId;
	#ask;
	#modelRuntime;
	#defaults;
	#mode;
	#controller;
	#workspace;
	#driver;
	#location;
	#permit;
	#pending;
	#operation;
	#epoch = 0;
	#modePause;
	#lifetime = new AbortController();
	#denied = AbortSignal.abort();
	#approvalTimeout;
	#safetyTimeout;
	#tickInterval;
	#errors = [];
	#closing;
	#runner;
	#beforePrompt;
	#pendingSafety = 0;
	#safetySeen = false;
	#providerCapability;
	#approvedModels = new Map();
	#providerRuntimeBindings = new Map();
	#capabilities = new Map();
	#nativeModels;
	#recovery;
	#transition;

	constructor({ events, sessionId, requestApproval, modelRuntime, mainModel, thinkingLevel = "off", codingTools = ["read", "edit", "write", "bash"], instructions = "", approvalTimeoutMs = 120000, safetyTimeoutMs = DEFAULT_SAFETY_TIMEOUT_MS, tickIntervalMs = 1000, runner, beforePrompt = async () => { }, providerCapability, nativeModels = false }) {
		check(typeof requestApproval === "function", "INPUT", "Human approval callback required");
		for (const timeout of [approvalTimeoutMs, safetyTimeoutMs]) check(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 600000, "INPUT", "Invalid approval timeout");
		const descriptor = providerCapability === undefined ? undefined : providerDescriptor(providerCapability);
		this.#nativeModels = nativeModels;
		if (nativeModels) nativeModelRuntime({ modelRuntime });
		else if (descriptor?.transport === "pi-native") {
			// Explicit test adapters keep their single branded capability; only a public
			// Pi runtime can resolve additional physical models from the host catalog.
			try { nativeModelRuntime({ modelRuntime }); this.#nativeModels = true; } catch { }
		}
		if (descriptor) this.#capabilities.set(this.#modelKey(descriptor), providerCapability);
		this.#providerCapability = providerCapability;
		this.#runner = runner;
		this.#beforePrompt = beforePrompt;
		this.#events = events;
		this.#sessionId = sessionId;
		this.#ask = requestApproval;
		this.#modelRuntime = modelRuntime;
		this.#defaults = structuredClone({ model: { provider: mainModel?.provider, modelId: mainModel?.id, thinkingLevel }, codingTools, instructions });
		this.#approvalTimeout = approvalTimeoutMs;
		this.#safetyTimeout = safetyTimeoutMs;
		this.#tickInterval = tickIntervalMs;
		this.#mode = new ModeGate({
			events, sessionId, onRevoke: () => {
				this.#invalidate();
				if (!this.#lifetime.signal.aborted) {
					this.#modePause = this.pause().catch(error => this.#errors.push(failureDiagnostic(error)));
				}
			}
		});
	}

	snapshot() {
		let ownershipHeld = false;
		try { if (this.#controller) { this.#controller.assertOwned(); ownershipHeld = true; } } catch { /* Observation cannot repair lost ownership. */ }
		return { run: this.#controller?.snapshot() ?? null, driver: this.#driver?.snapshot() ?? null, workspace: this.#workspace?.snapshot() ?? null, ownershipHeld, transition: this.#transition ? { ...this.#transition } : null, pendingApproval: Boolean(this.#pending) || this.#pendingSafety > 0, errors: [...this.#errors], recovery: this.#recovery ? { ...this.#recovery, completed: [...this.#recovery.completed] } : null };
	}

	/** Observation conveys no owner or worker capability. */
	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#publish(type) {
		for (const listener of this.#listeners) {
			try { listener(type); } catch { /* Presentation cannot affect admission or settlement. */ }
		}
	}

	/** Detached inspection only; no session construction, dispatch, or owner capabilities. */
	history(workerId) {
		const run = this.#controller?.snapshot();
		check(run?.workers.some(worker => worker.id === workerId), "NOT_FOUND", "Worker does not exist");
		const binding = run.sessions?.workers.find(worker => worker.workerId === workerId);
		if (!binding) return [];
		return this.#driver?.liveHistory(workerId) ?? readSessionHistory(join(this.#controller.layout.sessionDir, binding.sessionFile), run.workspaceRoot, binding.sessionId);
	}

	#invalidate() {
		this.#epoch += 1;
		this.#operation?.cancel.abort();
		this.#pending?.abort();
		this.#permit?.cancel.abort();
		this.#permit = undefined;
	}

	#modelKey(selection) { return JSON.stringify([selection.provider, selection.modelId]); }

	#capability(selection) {
		const key = this.#modelKey(selection);
		if (!this.#capabilities.has(key) && this.#nativeModels) {
			this.#capabilities.set(key, createNativeSelection(this.#modelRuntime, selection).providerCapability);
		}
		return this.#capabilities.get(key) ?? this.#providerCapability;
	}

	#selections(specification) {
		return [specification.model, ...(specification.workerModels ?? []).map(worker => worker.selection)];
	}

	#assertProvider(selection) {
		const capability = this.#capability(selection);
		if (!capability) return;
		const model = assertProviderSelection(capability, selection, this.#modelRuntime);
		if (this.#nativeModels) createNativeSelection(this.#modelRuntime, selection);
		const key = this.#modelKey(selection);
		const fingerprint = specificationFingerprint(model);
		if (!this.#approvedModels.has(key)) this.#approvedModels.set(key, fingerprint);
		check(this.#approvedModels.get(key) === fingerprint, "PROVIDER", "Model catalog metadata changed; create a new host and approve again");
		const provider = this.#modelRuntime.getProvider?.(model.provider);
		check(provider, "PROVIDER", "Explicit provider implementation required");
		const references = [provider, provider.stream, provider.streamSimple, this.#modelRuntime.getModel,
			this.#modelRuntime.getProvider, this.#modelRuntime.stream, this.#modelRuntime.streamSimple,
			this.#modelRuntime.complete, this.#modelRuntime.completeSimple];
		if (!this.#providerRuntimeBindings.has(key)) this.#providerRuntimeBindings.set(key, references);
		check(references.every((reference, index) => reference === this.#providerRuntimeBindings.get(key)[index]),
			"PROVIDER", "Provider implementation replacement requires a new host and fresh approval");
	}

	#providerPacket(specification, { validate = true } = {}) {
		const descriptors = new Map();
		for (const selection of this.#selections(specification)) {
			if (validate) this.#assertProvider(selection);
			const capability = this.#capability(selection);
			if (capability) descriptors.set(this.#modelKey(selection), providerDescriptor(capability));
		}
		const defaultCapability = this.#capability(specification.model);
		return {
			...(defaultCapability ? { provider: providerDescriptor(defaultCapability) } : {}),
			...(specification.workerModels !== undefined && descriptors.size ? { providers: [...descriptors.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, descriptor]) => descriptor) } : {})
		};
	}

	#assertAdmission() {
		check(!this.#closing && !this.#lifetime.signal.aborted && this.#permit && !this.#permit.signal.aborted, "HOST_DENIED", "Explicit current host approval is required");
		this.#mode.assert(this.#permit.grant.token);
		if (this.#nativeModels || this.#providerCapability) {
			try { for (const selection of this.#selections(this.#specification())) this.#assertProvider(selection); }
			catch (error) {
				this.#invalidate();
				this.#modePause = this.pause().catch(failure => this.#errors.push(failureDiagnostic(failure)));
				throw error;
			}
		}
	}

	#setPermit(grant, operation) {
		this.#assertOperation(operation);
		this.#mode.assert(grant.token);
		this.#permit?.cancel.abort();
		const cancel = new AbortController();
		this.#permit = { grant, cancel, signal: AbortSignal.any([grant.signal, cancel.signal, this.#lifetime.signal]) };
	}

	#draft(input) {
		const settings = resolveModelSettings(input.model, input.workerModels, this.#defaults.model);
		return structuredClone({ objective: input.objective, criteria: input.criteria, scope: input.scope, limits: { ...DEFAULT_LIMITS, ...input.limits }, model: settings.model, codingTools: input.codingTools ?? this.#defaults.codingTools, instructions: input.instructions ?? this.#defaults.instructions,
			...(input.workerModels !== undefined ? { workerModels: settings.workerModels } : {}),
			...(input.initialWorker !== undefined ? { initialWorker: input.initialWorker } : {}),
			...(input.workerContext !== undefined ? { workerContext: input.workerContext } : {}),
			...(input.workerContexts !== undefined ? { workerContexts: input.workerContexts } : {}) });
	}

	#validate(draft, root, runId) {
		const fields = ["codingTools", "criteria", "instructions", "limits", "model", "objective", "scope", ...(draft?.workerModels !== undefined ? ["workerModels"] : []), ...(draft?.initialWorker !== undefined ? ["initialWorker"] : []), ...(draft?.workerContext !== undefined ? ["workerContext"] : []), ...(draft?.workerContexts !== undefined ? ["workerContexts"] : [])].sort().join();
		check(draft && Object.keys(draft).sort().join() === fields, "INPUT", "Invalid approval specification");
		reduceEvent(null, { version: 1, operationId: "approval-preflight", actor: "owner", expectedRevision: 0, cycle: 1, generation: 0, atMs: 0, type: "run.create", payload: { runId, ownerSessionId: this.#sessionId, workspaceRoot: root, objective: draft.objective, criteria: draft.criteria, scope: draft.scope, limits: draft.limits } });
		if (draft.workerContext !== undefined) validateWorkerContext(draft.workerContext);
		if (draft.workerContexts !== undefined) {
			check(draft.workerContext && Array.isArray(draft.workerContexts) && new Set(draft.workerContexts.map(item => item.workerId)).size === draft.workerContexts.length, "INPUT", "Invalid worker context overrides");
			for (const item of draft.workerContexts) check(item && Object.keys(item).sort().join() === "mode,workerId" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.workerId) && ["focus", "fork"].includes(item.mode), "INPUT", "Invalid worker context override");
		}
		if (draft.initialWorker !== undefined) {
			const worker = draft.initialWorker;
			check(worker && Object.keys(worker).sort().join() === "brief,id,specialization" && typeof worker.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(worker.id) && !["owner", "system"].includes(worker.id), "INPUT", "Invalid initial worker");
			for (const key of ["specialization", "brief"]) check(typeof worker[key] === "string" && worker[key].trim().length > 0 && worker[key].length <= 32768, "INPUT", "Invalid initial worker description");
		}
		check(draft.model && Object.keys(draft.model).sort().join() === "modelId,provider,thinkingLevel", "MODEL", "Explicit model selection required");
		resolveModelSettings(draft.model, draft.workerModels, draft.model);
		for (const selection of this.#selections(draft)) {
			this.#assertProvider(selection);
			check(this.#capability(selection) || (selection.provider === "swarm-mock" && this.#modelRuntime?.getModel(selection.provider, selection.modelId)?.api === "swarm-mock"), "MODEL", "Live model execution remains disabled");
			check(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(selection.thinkingLevel), "MODEL", "Invalid thinking level");
		}
		check(Array.isArray(draft.codingTools) && new Set(draft.codingTools).size === draft.codingTools.length && draft.codingTools.every(name => ["read", "edit", "write", "bash"].includes(name)), "INPUT", "Unsupported coding tool selection");
		check(typeof draft.instructions === "string" && draft.instructions.length <= 32768, "INPUT", "Invalid host instructions");
	}

	#assertOperation(operation) {
		check(this.#operation === operation && !operation.cancel.signal.aborted && operation.epoch === this.#epoch && !this.#lifetime.signal.aborted, "CANCELLED", "Host operation was superseded");
	}

	#runOperation(phase, fn) {
		check(!this.#closing && !this.#operation && !this.#lifetime.signal.aborted, "BUSY", "Host operation already pending or closed");
		check(typeof SwarmController.assertStorageRuntime === "function", "RUNTIME_STALE", "Controller modules are stale; cold-restart Pi and resume the same session");
		SwarmController.assertStorageRuntime();
		const operation = { cancel: new AbortController(), epoch: this.#epoch };
		this.#operation = operation;
		operation.promise = inPhase(phase, () => Promise.resolve().then(() => fn(operation))).finally(() => {
			if (this.#operation === operation) this.#operation = undefined;
		});
		return operation.promise;
	}

	#approval(action, inspection, specification, recovery) {
		return inPhase("approval", () => this.#requestApproval(action, inspection, specification, recovery));
	}

	async #requestApproval(action, inspection, specification, recovery) {
		check(!this.#pending && !this.#lifetime.signal.aborted, "BUSY", "Approval already pending or host closed");
		const grant = this.#mode.capture();
		const pending = new AbortController();
		this.#pending = pending;
		this.#publish("approval.pending");
		const signal = AbortSignal.any([pending.signal, grant.signal, this.#lifetime.signal]);
		const deadline = performance.now() + this.#approvalTimeout;
		let timer;
		let abort;
		try {
			const cancelled = new Promise((_, reject) => {
				abort = () => reject(new SwarmError("CANCELLED", "Approval was cancelled"));
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				timer = setTimeout(() => pending.abort(), this.#approvalTimeout);
			});
			// Settlement attestation must remain available after a provider failure;
			// it discloses the recorded pins but grants no model execution authority.
			const settlementOnly = action === "reconcile" || action === "recover" && recovery.outcome === "paused";
			const providers = settlementOnly && action === "recover" ? recovery.providerPacket : this.#providerPacket(specification, { validate: !settlementOnly });
			const safety = await requestSafety({ events: this.#events, request: { agent: "swarm", tool: "write", path: "capability probe" }, signal, probe: true });
			check(safety.claimed || safety.unclaimed && !this.#safetySeen, "AUTHORITY", "Safety provider is malformed, duplicated, or disappeared");
			if (safety.claimed) this.#safetySeen = true;
			const integrations = Object.freeze({
				mode: this.#mode.current().instanceId === "absent" ? "none installed (runs as Off)" : "pi-plan",
				confirmations: safety.claimed
					? "pi-safety policy remains enforced and may ask for operation confirmation"
					: "Selected coding tools are authorized within this bounded run; no Swarm operation prompts"
			});
			const request = Object.freeze({ action, ...providers, integrations, repository: inspection.repository, specification: freeze(structuredClone(specification)), changes: freeze(structuredClone(inspection.changes)), fingerprintScope: inspection.fingerprintScope, workspaceFingerprint: inspection.fingerprint, runRevision: this.#controller?.snapshot().revision ?? recovery?.runRevision ?? null, ...(action === "launch" ? { workerContexts: "fresh", previousRunId: this.#controller?.snapshot().runId ?? null } : {}), existingChanges: "preserve", requiresReconciliation: action !== "launch", recovery: recovery && freeze(structuredClone(recovery)), signal });
			const answer = structuredClone(await Promise.race([Promise.resolve().then(() => {
				check(!signal.aborted, "CANCELLED", "Approval cancelled before presentation");
				return this.#ask(request);
			}), cancelled]));
			check(!signal.aborted && performance.now() < deadline, "CANCELLED", "Approval expired");
			this.#mode.assert(grant.token);
			check(answer?.approved === true, "AUTHORITY", "User did not approve this action");
			// Preservation is the only disposition; approval never grants cleanup authority.
			check(action === "launch" || action === "reconcile" || action === "recover" || answer.reconciled === true, "UNSETTLED", "Explicit workspace reconciliation is required");
			check(answer.provider === undefined && answer.providers === undefined, "PROVIDER", "Approval cannot replace the host provider binding");
			// Settlement attestation grants no model authority and must remain available after provider failure.
			if (!settlementOnly) for (const selection of this.#selections(specification)) this.#assertProvider(selection);
			const approved = answer.specification ?? specification;
			if (action !== "launch") check(specificationFingerprint(approved) === specificationFingerprint(specification), "SCOPE", "Continuation cannot silently change the approved scope");
			if (action === "recover") check((answer.outcome === undefined || answer.outcome === recovery.outcome) && (answer.resume === undefined || answer.resume === (recovery.outcome === "resume")), "SCOPE", "Recovery outcome cannot change during approval");
			if (action === "reconcile" || action === "recover") check(answer.attestation?.kind === "user-established-settlement" && typeof answer.attestation.evidence === "string" && answer.attestation.evidence.trim().length > 0 && answer.attestation.evidence.length <= 4096, "UNSETTLED", "Describe independently established process/session settlement; a boolean is not evidence");
			return { grant, specification: approved, attestation: answer.attestation, approval: { id: randomUUID(), action, workspaceFingerprint: inspection.fingerprint, specificationFingerprint: specificationFingerprint(approved), existingChanges: inspection.changes.length ? "preserve" : "clean", ...providers } };
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (this.#pending === pending) this.#pending = undefined;
			this.#publish("approval.finished");
		}
	}

	async #inspect(workspace, operation) {
		this.#assertOperation(operation);
		const signal = AbortSignal.any([operation.cancel.signal, this.#lifetime.signal]);
		const inspection = await inspectCheckout(workspace, { signal });
		this.#assertOperation(operation);
		return inspection;
	}

	async #unchanged(inspection, grant, operation) {
		this.#mode.assert(grant.token);
		const current = await this.#inspect(inspection.root, operation);
		this.#mode.assert(grant.token);
		check(current.fingerprint === inspection.fingerprint, "STALE", "Workspace changed while approval was pending; inspect and approve again");
	}

	#wire(options) { return inPhase("attachment", () => this.#attachRuntimes(options)); }

	async #attachRuntimes({ settlementOnly = false } = {}) {
		this.#unsubscribe?.();
		this.#unsubscribe = this.#controller.subscribe(event => this.#publish(event.type));
		const specification = this.#specification();
		const recorded = providerAgreements(this.#controller.snapshot().hostApprovals.at(-1));
		const configured = settlementOnly ? recorded : providerAgreements(this.#providerPacket(specification));
		check(specificationFingerprint(recorded) === specificationFingerprint(configured), "PROVIDER", "Restore requires the recorded Swarm provider agreements");
		const admission = { assert: () => this.#assertAdmission(), signal: () => this.#permit?.signal ?? this.#denied };
		if (!this.#workspace) this.#workspace = await WorkspaceRuntime.attach(this.#controller, {
			signal: AbortSignal.any([this.#lifetime.signal, ...(this.#operation ? [this.#operation.cancel.signal] : [])]),
			admission, runner: this.#runner, authorize: async request => {
				this.#assertAdmission();
				const permit = this.#permit;
				const signal = AbortSignal.any([request.signal, permit.signal]);
				const shell = ["shell", "final"].includes(request.kind);
				const value = { agent: request.workerId ?? "swarm final verification", tool: shell ? "bash" : request.kind };
				check(this.#specification().codingTools.includes(value.tool), "AUTHORITY", "Operation requires an approved coding tool");
				if (shell) value.command = request.command;
				else value.path = resolve(this.#location.workspace, request.paths[0]);
				let result;
				this.#pendingSafety++;
				this.#publish("approval.pending");
				try {
					await this.#beforePrompt();
					this.#assertAdmission();
					result = await requestSafety({ events: this.#events, request: value, signal, timeoutMs: this.#safetyTimeout });
					if (result.unclaimed && !this.#safetySeen) {
						// The owner approved the disclosed bounded tool policy for this run.
						// A previously observed or malformed Safety provider never falls back.
						result = { approved: !signal.aborted };
					} else if (!result.unclaimed) this.#safetySeen = true;
				} finally { this.#pendingSafety--; this.#publish("approval.finished"); }
				this.#assertAdmission();
				check(this.#permit === permit && !signal.aborted, "HOST_DENIED", "Approval belongs to an expired host admission");
				return result.approved === true;
			}
		});
		if (!this.#driver) this.#driver = await SwarmSessions.attach(this.#controller, {
			workspace: this.#workspace, modelRuntime: this.#modelRuntime,
			mainModel: settlementOnly ? undefined : this.#modelRuntime.getModel(specification.model.provider, specification.model.modelId), thinkingLevel: specification.model.thinkingLevel, settlementOnly,
			codingTools: specification.codingTools, instructions: specification.instructions,
			...(specification.workerModels !== undefined ? { workerModels: specification.workerModels } : {}),
			...(specification.workerContext !== undefined ? { workerContext: specification.workerContext } : {}),
			...(specification.workerContexts !== undefined ? { workerContexts: specification.workerContexts } : {}),
			tickIntervalMs: this.#tickInterval, admission, providerCapability: settlementOnly ? undefined : this.#capability(specification.model),
			resolveProviderCapability: selection => this.#capability(selection)
		});
	}

	#launchSpecification;
	#specification() {
		const state = this.#controller.snapshot();
		return state.sessions ? { objective: state.objective, criteria: state.criteria, scope: state.scope, limits: state.limits, model: state.sessions.selection, codingTools: state.sessions.codingTools, instructions: state.sessions.instructions,
			...(state.sessions.workerModels !== undefined ? { workerModels: state.sessions.workerModels } : {}),
			...(state.sessions.workerContext !== undefined ? { workerContext: state.sessions.workerContext } : {}),
			...(state.sessions.workerContexts !== undefined ? { workerContexts: state.sessions.workerContexts } : {}) } : this.#launchSpecification;
	}

	#assertFreshObjective(workspace) {
		if (!this.#controller) return;
		this.#controller.assertReplaceable(this.#sessionId);
		check(this.#controller.snapshot().workspaceRoot === workspace, "OWNERSHIP", "New objective must use the attached workspace");
		this.#driver?.assertReplaceable();
		const workspaceState = this.#workspace?.snapshot();
		const coordination = workspaceState?.coordination;
		check(!workspaceState?.uncertain.length && !coordination?.claims.length && !coordination?.pending.length && !coordination?.active.length && !this.#pendingSafety,
			"UNSETTLED", "Workspace operations and held coordination claims must settle before a new objective");
	}

	launch(input) { return this.#runOperation("launch", operation => this.#launch(input, operation)); }
	async #launch({ workspace, runId, specification }, operation) {
		this.#assertOperation(operation);
		check(!this.#pending, "STATE", "Host already owns an approval");
		this.#assertFreshObjective(resolve(workspace));
		check(validId(runId), "INPUT", "Invalid run identifier");
		this.#mode.capture();
		const inspection = await this.#inspect(workspace, operation);
		const runPath = prepareLayout(inspection.root, runId).runRoot;
		try { lstatSync(runPath); throw new SwarmError("DUPLICATE", "Run already exists; restore it instead"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		const draft = this.#draft(specification);
		this.#validate(draft, inspection.root, runId);
		const accepted = await this.#approval("launch", inspection, draft);
		this.#validate(accepted.specification, inspection.root, runId);
		await this.#unchanged(inspection, accepted.grant, operation);
		this.#assertFreshObjective(inspection.root);
		const previous = this.#controller;
		const revision = previous?.snapshot().revision;
		const location = { workspace: inspection.root, runId, ownerSessionId: this.#sessionId };
		try {
			if (previous) {
				this.#permit?.cancel.abort();
				this.#permit = undefined;
				// Keep the previous attachment until new storage opens successfully. No
				// retirement occurs during proposal inspection or rejected approval.
				this.#transition = { previousRunId: previous.snapshot().runId, runId, stage: "retiring", workerContexts: "fresh" };
				await this.#driver?.close();
				this.#assertOperation(operation);
				this.#assertFreshObjective(inspection.root);
				check(previous.snapshot().revision === revision, "STALE", "Prior run changed before transition");
				await previous.close();
				this.#transition.stage = "opening";
			}
			const controller = await inPhase("storage", () => SwarmController.open({ ...location, create: accepted.specification, createOnly: true }));
			this.#unsubscribe?.();
			this.#driver = undefined;
			this.#workspace = undefined;
			this.#controller = controller;
			this.#location = location;
			this.#launchSpecification = accepted.specification;
			this.#recovery = undefined;
			if (this.#transition) this.#transition.stage = "attached";
			this.#assertOperation(operation);
			await this.#unchanged(inspection, accepted.grant, operation);
			await this.#controller.owner("host.approve", { approval: accepted.approval });
			await this.#wire();
			this.#assertOperation(operation);
			await this.#unchanged(inspection, accepted.grant, operation);
			this.#setPermit(accepted.grant, operation);
			await this.#driver.resume({ reconciled: true });
			if (this.#transition) this.#transition.stage = "completed";
			return this.snapshot();
		} catch (error) {
			this.#invalidate();
			if (this.#driver) await this.#driver.pause().catch(() => { });
			else if (this.#controller !== previous) await this.#pauseUnwired().catch(() => { });
			throw error;
		}
	}

	restore(input) { return this.#runOperation("restore", operation => this.#restore(input, operation)); }
	async #restore({ workspace, runId, settlementOnly = false, expectedState, recoveryAttestation }, operation) {
		this.#assertOperation(operation);
		check(!this.#controller && !this.#pending, "STATE", "Host already owns a run");
		const grant = this.#mode.capture();
		this.#location = { workspace, runId, ownerSessionId: this.#sessionId };
		this.#controller = await SwarmController.open({ ...this.#location, adopt: true, expectedState, recoveryAttestation });
		this.#assertOperation(operation);
		check(this.#controller.snapshot().sessions, "STATE", "Only configured SDK runs can be restored");
		const restored = this.#controller.snapshot();
		if (recoveryAttestation && ["stopped", "failed"].includes(restored.status) && !restored.tasks.some(task => task.assignment) && !restored.workspace.operations.length && !restored.sessions.turns.length) {
			this.#mode.assert(grant.token);
			this.#publish("run.restored");
			return this.snapshot(); // Terminal recovery already settled and released ownership.
		}
		await this.#wire({ settlementOnly });
		this.#assertOperation(operation);
		this.#mode.assert(grant.token);
		this.#publish("run.restored");
		return this.snapshot(); // Restoring does not grant execution authority.
	}

	/** One approved recovery transaction; interrupted operations are never replayed. */
	recover(input) { return this.#runOperation("recovery", operation => this.#recover(input, operation)); }
	async #recover({ workspace, runId, resume = false }, operation) {
		check(validId(runId) && typeof resume === "boolean", "INPUT", "Invalid recovery arguments");
		const outcome = resume ? "resume" : "paused";
		this.#recovery = { runId, outcome, stage: "inspection", completed: [], settled: false, resumed: false };
		const stage = value => {
			this.#recovery.stage = value;
			this.#publish("recovery.progress");
		};
		const completed = value => { this.#recovery.completed.push(value); this.#publish("recovery.progress"); };
		stage("inspection");
		this.#mode.capture();
		const attached = Boolean(this.#controller);
		const saved = attached ? null : inspectRecovery(workspace, runId);
		const state = attached ? this.#controller.snapshot() : saved.state;
		check(state.runId === runId && resolve(workspace) === state.workspaceRoot, "OWNERSHIP", "Recovery must target the attached workspace and run");
		check(state.sessions && (attached ? ["paused", "pausing", "stopping", "failing"] : ["running", "verifying", "paused", "pausing", "stopping", "failing"]).includes(state.status), "STATE", "Pause a live run before recovery; closed runs require restart");
		if (saved?.lease) check(saved.lease.ownerSessionId === this.#sessionId, "OWNERSHIP", "Only the original owning session may reclaim a stale lease");
		if (resume) {
			check(!["stopping", "failing"].includes(state.status), "STATE", "Recovery cannot resume terminal intent");
			check(state.elapsedMs < state.limits.durationMs, "TIME_LIMIT", "Recovery cannot reset exhausted allowances");
		}
		const specification = { objective: state.objective, criteria: state.criteria, scope: state.scope, limits: state.limits, model: state.sessions.selection, codingTools: state.sessions.codingTools, instructions: state.sessions.instructions,
			...(state.sessions.workerModels !== undefined ? { workerModels: state.sessions.workerModels } : {}),
			...(state.sessions.workerContext !== undefined ? { workerContext: state.sessions.workerContext } : {}),
			...(state.sessions.workerContexts !== undefined ? { workerContexts: state.sessions.workerContexts } : {}) };
		const live = attached ? this.#workspace?.snapshot().uncertain ?? [] : [];
		if (attached) check((this.#driver?.snapshot().active ?? []).every(workerId => state.workspace.operations.some(item => item.workerId === workerId && live.includes(item.id))), "UNSETTLED", "Live SDK turns must settle normally before recovery");
		const previousApproval = state.hostApprovals.at(-1);
		const providerPacket = { ...(previousApproval?.provider ? { provider: previousApproval.provider } : {}), ...(previousApproval?.providers ? { providers: previousApproval.providers } : {}) };
		const expectedFinalState = resume ? "running" : state.status === "stopping" ? "stopped" : state.status === "failing" ? "failed" : "paused";
		const allowances = {
			cycle: state.cycle, elapsedMs: state.elapsedMs, remainingDurationMs: Math.max(0, state.limits.durationMs - state.elapsedMs),
			remainingWorkerIdentities: Math.max(0, state.limits.agents - state.workers.length),
			remainingTaskCreations: Math.max(0, state.limits.tasks - state.tasksCreated),
			taskAttempts: state.tasks.map(task => ({ taskId: task.id, remainingAttempts: Math.max(0, state.limits.attempts - task.failures) }))
		};
		const recoveryPlan = { runId, outcome, allowances, journalOwnerSessionId: state.ownerSessionId, previousLease: saved?.lease ?? null, operations: state.workspace.operations, turns: state.sessions.turns, liveUncertainIds: live, expectedFinalState,
			steps: ["inspect", "approve settlement", ...(saved?.lease ? ["release stale lease"] : []), ...(!attached || !this.#workspace || !this.#driver ? ["restore fenced"] : []), "attest", "reconcile without replay", ...(resume ? ["resume within existing allowances"] : [])],
			journalFingerprint: saved?.journalFingerprint ?? null, leaseFingerprint: saved?.leaseIdentity ? specificationFingerprint(saved.leaseIdentity) : null, reservationFingerprint: saved?.reservationFingerprint ?? null, runRevision: state.revision, providerPacket };
		const inspection = await this.#inspect(state.workspaceRoot, operation);
		stage("approval");
		const accepted = await this.#approval("recover", inspection, specification, recoveryPlan);
		await this.#unchanged(inspection, accepted.grant, operation);
		this.#assertOperation(operation);
		if (attached) {
			this.#controller.assertOwned();
			check(this.#controller.snapshot().revision === state.revision && specificationFingerprint(this.#workspace?.snapshot().uncertain ?? []) === specificationFingerprint(live), "STALE", "Execution changed during recovery approval");
			if (!this.#workspace || !this.#driver) {
				stage("restore");
				await this.#wire({ settlementOnly: !resume });
				completed("restore");
			}
		} else {
			const current = inspectRecovery(workspace, runId);
			check(specificationFingerprint(current) === specificationFingerprint(saved), "STALE", "Recovery journal or ownership changed during approval");
			this.#mode.assert(accepted.grant.token);
			this.#assertOperation(operation);
			if (saved.lease) {
				stage("lease");
				releaseStaleLease(prepareLayout(state.workspaceRoot, runId), saved.lease, { settled: true, identity: saved.leaseIdentity });
				completed("lease");
			}
			stage("restore");
			await this.#restore({ workspace: state.workspaceRoot, runId, settlementOnly: !resume, expectedState: saved.state,
				recoveryAttestation: { evidence: accepted.attestation.evidence, operationIds: [], turnIds: [], fingerprint: inspection.fingerprint } }, operation);
			completed("restore");
		}
		check(specificationFingerprint(this.#specification()) === specificationFingerprint(specification), "STALE", "Restored specification changed");
		const restored = this.#controller.snapshot();
		check(specificationFingerprint(restored.workspace.operations) === specificationFingerprint(recoveryPlan.operations) && specificationFingerprint(restored.sessions.turns) === specificationFingerprint(recoveryPlan.turns), "STALE", "Restored unresolved execution changed");
		if (!resume && ["stopped", "failed"].includes(restored.status) && !restored.tasks.some(task => task.assignment) && !restored.workspace.operations.length && !restored.sessions.turns.length) {
			this.#recovery.settled = true;
			completed("reconciliation");
			stage("completed");
			return this.snapshot();
		}
		await this.#unchanged(inspection, accepted.grant, operation);
		stage("reconciliation");
		await this.#controller.owner("host.attest", { evidence: accepted.attestation.evidence, operationIds: recoveryPlan.operations.map(item => item.id), turnIds: recoveryPlan.turns.map(item => item.id), fingerprint: inspection.fingerprint }, { expectedRevision: restored.revision });
		this.#assertOperation(operation);
		for (const id of live) this.#workspace.confirmSettled(id, { settled: true });
		if (this.#driver.snapshot().active.length || live.length) {
			const settlement = await this.#driver.pause({ timeoutMs: 5000 });
			this.#assertOperation(operation);
			if (!settlement.settled) {
				stage("awaiting-settlement");
				return this.snapshot();
			}
		}
		const unresolved = this.#controller.snapshot();
		if (unresolved.workspace.operations.length || unresolved.sessions.turns.length) await this.#driver.reconcile({ settled: true });
		else await this.#driver.pause({ timeoutMs: 5000 }); // Drain assignments, without orphan reconciliation or host invalidation.
		this.#assertOperation(operation);
		const settled = this.#controller.snapshot();
		check(["paused", "stopped", "failed"].includes(settled.status) && !settled.workspace.operations.length && !settled.sessions.turns.length && !this.#driver.snapshot().active.length, "UNSETTLED", "Recovery remains unsettled");
		this.#recovery.settled = true;
		completed("reconciliation");
		if (resume) {
			stage("continuation");
			await inPhase("continuation", async () => {
				await this.#unchanged(inspection, accepted.grant, operation);
				this.#controller.assertOwned();
				check(this.#controller.snapshot().revision === settled.revision && specificationFingerprint(this.#specification()) === specificationFingerprint(specification), "STALE", "Run changed before recovery continuation");
				check(settled.status === "paused" && settled.elapsedMs < settled.limits.durationMs, "STATE", "Recovery cannot continue this run");
				for (const selection of this.#selections(specification)) this.#assertProvider(selection);
				this.#assertOperation(operation);
				this.#mode.assert(accepted.grant.token);
				await this.#controller.owner("host.continue", { restart: false, reconciled: true, approval: { ...accepted.approval, action: "resume" } }, { expectedRevision: settled.revision });
				this.#setPermit(accepted.grant, operation);
			});
			this.#recovery.resumed = true;
			completed("continuation");
		}
		stage("completed");
		return this.snapshot();
	}

	resume(options = {}) { return this.#runOperation(options.restart ? "restart" : "resume", operation => this.#resume(options, operation)); }
	async #resume({ restart = false }, operation) {
		this.#assertOperation(operation);
		check(this.#controller && !this.#pending, "STATE", "No run or approval already pending");
		const state = this.#controller.snapshot();
		check((restart ? ["paused", "stopped", "completed", "failed"] : ["paused"]).includes(state.status), "STATE", "Settle the run before continuation");
		check(!state.sessions.turns.length && !state.workspace.operations.length && !this.#driver?.snapshot().active.length, "UNSETTLED", "Execution remains unsettled");
		const inspection = await this.#inspect(state.workspaceRoot, operation);
		const accepted = await this.#approval(restart ? "restart" : "resume", inspection, this.#specification());
		await this.#unchanged(inspection, accepted.grant, operation);
		check(this.#controller.snapshot().revision === state.revision, "STALE", "Run changed during approval");
		if (["stopped", "completed", "failed"].includes(state.status)) {
			await this.#driver?.close();
			this.#driver = undefined;
			this.#workspace = undefined;
			this.#controller = await SwarmController.open({ ...this.#location, adopt: true });
			this.#assertOperation(operation);
			await this.#wire();
		} else if (!this.#driver) await this.#wire();
		this.#assertOperation(operation);
		await this.#unchanged(inspection, accepted.grant, operation);
		await this.#controller.owner("host.continue", { restart, reconciled: true, approval: accepted.approval });
		this.#setPermit(accepted.grant, operation);
		return this.snapshot();
	}

	configure(settings = {}) {
		return this.#runOperation("configure", async operation => {
			check(settings && Object.keys(settings).every(key => ["model", "workerModels"].includes(key)) && Object.keys(settings).length > 0, "INPUT", "Supply Swarm model settings");
			const state = this.#controller?.snapshot();
			check(state?.sessions && this.#driver && ["running", "paused"].includes(state.status), "STATE", "Configure a running or paused Swarm");
			const release = await this.#driver.quiesce({ signal: operation.cancel.signal });
			let changed = false;
			try {
				this.#assertOperation(operation);
				const current = this.#controller.snapshot();
				check(current.status === state.status && !current.sessions.turns.length && !current.workspace.operations.length, "UNSETTLED", "Worker turns and operations must settle before configuring");
				const resolved = resolveModelSettings(settings.model, settings.workerModels, current.sessions.selection, current.sessions.workerModels ?? []);
				const specification = { ...this.#specification(), ...resolved };
				this.#validate(specification, current.workspaceRoot, current.runId);
				const inspection = await this.#inspect(current.workspaceRoot, operation);
				const accepted = await this.#approval("configure", inspection, specification);
				await this.#unchanged(inspection, accepted.grant, operation);
				check(this.#controller.snapshot().revision === current.revision, "STALE", "Run changed during configuration approval");
				await this.#controller.owner("host.configure", { selection: resolved.model, workerModels: resolved.workerModels, approval: accepted.approval });
				changed = true;
				await this.#driver.refreshModels();
				this.#assertOperation(operation);
				this.#mode.assert(accepted.grant.token);
				// Model settings do not change assignment identity or tool scope. Keep the
				// running permit so idle file claims are not cancelled beneath their owner.
				if (current.status === "running") this.#assertAdmission();
				return this.snapshot();
			} catch (error) {
				if (changed) {
					this.#invalidate();
					await this.#driver.pause().catch(() => {});
				}
				throw error;
			} finally { release(); }
		});
	}

	/** A partial attachment has no SDK driver to publish its lifecycle brakes. */
	async #pauseUnwired({ stop = false } = {}) {
		if (!this.#controller) return { settled: true };
		let state = this.#controller.snapshot();
		if (["stopped", "completed", "failed"].includes(state.status)) return { settled: true };
		this.#controller.assertOwned();
		if (stop && ["running", "verifying", "paused", "pausing"].includes(state.status)) await this.#controller.owner("run.stop");
		else if (["running", "verifying"].includes(state.status)) await this.#controller.owner("run.pause");
		state = this.#controller.snapshot();
		const coordination = this.#workspace?.snapshot().coordination;
		const unsettled = state.tasks.some(task => task.assignment) || state.workspace?.operations.length || state.sessions?.turns.length
			|| coordination?.claims.length || coordination?.pending.length || coordination?.active.length || this.#workspace?.snapshot().uncertain.length;
		if (unsettled) return { settled: false };
		if (["pausing", "stopping", "failing"].includes(state.status)) await this.#controller.system("run.settle");
		return { settled: ["paused", "stopped", "completed", "failed"].includes(this.#controller.snapshot().status) };
	}

	async pause(options = {}) {
		this.#invalidate();
		const pending = this.#operation?.promise;
		const timeoutMs = options.timeoutMs ?? 5000;
		check(Number.isFinite(timeoutMs) && timeoutMs >= 0, "INPUT", "Invalid settlement timeout");
		let timer;
		// Do not let a stalled launch/resume inspection delay the durable stop or
		// native session/process cancellation for an already attached driver.
		const driver = this.#driver;
		const draining = driver?.pause(options);
		const settle = (async () => {
			const result = await draining;
			if (pending) await pending.catch(() => { });
			// Preparation may have attached a driver before observing cancellation.
			if (this.#driver && this.#driver !== driver) return this.#driver.pause(options);
			return result ?? await this.#pauseUnwired(options);
		})();
		try {
			return await Promise.race([settle, new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs); })]);
		} finally { clearTimeout(timer); }
	}
	/** Human attestation retires uncertainty, never certifies successful execution. */
	reconcile() {
		return this.#runOperation("reconcile", async operation => {
			const state = this.#controller?.snapshot();
			check(state && this.#workspace && this.#driver && ["paused", "pausing", "stopping", "failing"].includes(state.status), "STATE", "Pause before reconciliation");
			const live = this.#workspace.snapshot().uncertain;
			check(this.#driver.snapshot().active.every(workerId => state.workspace.operations.some(item => item.workerId === workerId && live.includes(item.id))), "UNSETTLED", "Live SDK turns must settle normally unless waiting on an identified uncertain operation");
			const recovery = { operations: state.workspace.operations, turns: state.sessions.turns, liveUncertainIds: live };
			check(recovery.operations.length || recovery.turns.length, "STATE", "No interrupted execution to reconcile");
			const inspection = await this.#inspect(state.workspaceRoot, operation);
			const accepted = await this.#approval("reconcile", inspection, this.#specification(), recovery);
			this.#assertOperation(operation);
			await this.#unchanged(inspection, accepted.grant, operation);
			check(this.#controller.snapshot().revision === state.revision, "STALE", "Execution changed during reconciliation; inspect again");
			// Record exactly what the user attested before releasing any live lease.
			await this.#controller.owner("host.attest", { evidence: accepted.attestation.evidence, operationIds: recovery.operations.map(item => item.id), turnIds: recovery.turns.map(item => item.id), fingerprint: inspection.fingerprint }, { expectedRevision: state.revision });
			this.#assertOperation(operation);
			for (const id of live) this.#workspace.confirmSettled(id, { settled: true });
			// Live SDK/tool frames must unwind themselves. Never retire them as orphans.
			if (this.#driver.snapshot().active.length || live.length) return { settled: false, awaitingLiveSettlement: true };
			await this.#driver.reconcile({ settled: true });
			const current = this.#controller.snapshot();
			return { settled: ["paused", "stopped", "completed", "failed"].includes(current.status) && !current.workspace.operations.length && !current.sessions.turns.length };
		});
	}

	send(workerId, text, topic) {
		this.#assertAdmission();
		check(recipientId(workerId, this.#controller.snapshot().workers) === "@board" || this.#controller.snapshot().workers.some(worker => worker.id === workerId), "INPUT", "Use a worker or board recipient");
		return this.#driver.send(workerId, text, topic);
	}

	wake(workerId, reason) { this.#assertAdmission(); return this.#driver.wake(workerId, reason); }
	recruit(specification) {
		return this.#runOperation("control", async operation => {
			this.#assertAdmission();
			const result = await this.#driver.recruit(specification);
			this.#assertOperation(operation);
			return result;
		});
	}
	compact(workerId) { this.#assertAdmission(); return this.#driver.compact(workerId); }
	finalCheck(command) { this.#assertAdmission(); return this.#workspace.finalCheck(command); }
	redirect(text) { this.#pending?.abort(); return this.#driver.redirect(text); }
	async idle() {
		await this.#driver?.idle();
		if (this.#modePause) await this.#modePause;
	}
	close() {
		if (this.#closing) return this.#closing;
		this.#closing = (async () => {
			const result = await this.pause();
			check(result.settled, "UNSETTLED", "Host cannot close before actual execution settlement");
			await this.#driver?.close();
			await this.#controller?.close();
			this.#lifetime.abort();
			this.#mode.dispose();
			this.#unsubscribe?.();
			this.#listeners.clear();
		})().finally(() => { this.#closing = undefined; });
		return this.#closing;
	}
}
