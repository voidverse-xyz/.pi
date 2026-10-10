import { existsSync } from "node:fs";
import { recipientId } from "./messaging.mjs";
import { join, resolve, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory } from "./store/files.mjs";
import { makeSessionTools } from "./session-tools.mjs";
import { failureDiagnostic, requireCondition as check } from "./errors.mjs";
import { pendingMail, turnMail, sessionWorker } from "./session-state.mjs";
import { assertProviderSelection } from "./provider-capability.mjs";
import { createSdkSession, readSessionHistory } from "./sdk-session.mjs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { buildSpecialistPrompt, buildTurnPrompt } from "./specializations.mjs";
import { effectiveWorkerSelection, resolveModelSettings } from "./model-settings.mjs";

import { workerStatus, taskRows } from "./worker-context.mjs";
import { usageLimitReason, measuredUsage } from "./usage.mjs";
import { coordinationHandoffs } from "./coordination.mjs";

const attached = new WeakSet();
const terminal = new Set(["paused", "stopped", "completed", "failed"]);
const draining = new Set(["pausing", "stopping", "failing"]);

/** Host-owned native SDK worker lifecycle and admission. */
export class SwarmSessions {
	static async attach(controller, { workspace, modelRuntime, mainModel, thinkingLevel = "off", override, codingTools = ["read", "edit", "write", "bash"], instructions = "", tickIntervalMs = 1000, admission, providerCapability, workerModels, resolveProviderCapability, settlementOnly = false } = {}) {
		controller.assertOwned();
		check(!attached.has(controller), "OWNERSHIP", "Controller already has an SDK driver");
		const state = controller.snapshot();
		check(state.workspace && workspace && (terminal.has(state.status) || draining.has(state.status)), "STATE", "Attach to a paused, workspace-enabled controller");
		const selected = override?.model ?? mainModel;
		const selection = state.sessions?.selection ?? { provider: selected?.provider, modelId: selected?.id, thinkingLevel: override?.thinkingLevel ?? thinkingLevel };
		check(resolveProviderCapability === undefined || typeof resolveProviderCapability === "function", "INPUT", "Invalid provider capability resolver");
		const configuredModels = state.sessions?.workerModels ?? workerModels;
		resolveModelSettings(selection, configuredModels ?? [], selection);
		check(typeof settlementOnly === "boolean" && (!settlementOnly || state.sessions), "STATE", "Settlement-only attachment requires recorded sessions");
		// Recovery must remain possible when the provider is unavailable. Attachment
		// starts no SDK session; later entries still require host admission and an exact
		// provider capability before model execution or credential lookup.
		for (const configured of settlementOnly ? [] : [selection, ...(configuredModels ?? []).map(item => item.selection)]) {
			const capability = (await resolveProviderCapability?.(configured)) ?? providerCapability;
			const model = capability ? assertProviderSelection(capability, configured, modelRuntime) : modelRuntime?.getModel(configured.provider, configured.modelId);
			check(capability || (configured.provider === "swarm-mock" && model?.provider === "swarm-mock" && model.api === "swarm-mock" && model.id === configured.modelId), "MODEL", "A native provider agreement or explicit offline mock is required");
			check(getSupportedThinkingLevels(model).includes(configured.thinkingLevel), "MODEL", "Selected thinking level is unsupported");
		}
		check(Number.isSafeInteger(tickIntervalMs) && tickIntervalMs >= 0, "INPUT", "Invalid tick interval");
		makeSessionTools(async () => { }, state.sessions?.codingTools ?? codingTools);
		attached.add(controller);
		try {
			if (!state.sessions) await controller.owner("sessions.configure", { selection, instructions, codingTools, ...(workerModels !== undefined ? { workerModels } : {}) });
			return new SwarmSessions(controller, workspace, modelRuntime, tickIntervalMs, admission, providerCapability, resolveProviderCapability);
		} catch (error) {
			attached.delete(controller);
			throw error;
		}
	}

	#controller;
	#workspace;
	#modelRuntime;
	#providerCapability;
	#resolveProviderCapability;
	#quiescence = null;
	#admission;
	#sessionDir;
	#entries = new Map();
	#queue = new Map();
	#active = new Map();
	#errors = [];
	#timer;
	#closed = false;
	#pumpQueued = false;
	#drain = null;
	#handoffs = new Set();
	#finalRequest;
	#finalizing;
	#finalVerificationFailed = false;

	constructor(controller, workspace, modelRuntime, tickIntervalMs, admission, providerCapability, resolveProviderCapability) {
		this.#controller = controller;
		this.#workspace = workspace;
		this.#modelRuntime = modelRuntime;
		this.#providerCapability = providerCapability;
		this.#resolveProviderCapability = resolveProviderCapability;
		this.#admission = admission;
		const state = controller.snapshot();
		this.#sessionDir = controller.layout.sessionDir;
		privateDirectory(this.#sessionDir);
		if (tickIntervalMs) {
			this.#timer = setInterval(() => {
				if (["running", "verifying"].includes(this.#controller.snapshot().status)) void this.tick().catch(error => this.#recordError(error));
			}, tickIntervalMs);
			this.#timer.unref();
		}
	}

	snapshot() {
		return { queued: [...this.#queue.keys()], active: [...this.#active.keys()],
			sdkIdle: [...this.#entries.values()].every(entry => entry.session?.isIdle === true),
			errors: [...this.#errors], finalVerificationFailed: this.#finalVerificationFailed, sessions: this.#controller.snapshot().sessions };
	}

	#recordError(error) {
		this.#errors.push(failureDiagnostic(error));
	}

	#usageBlocked = false;

	async #entry(workerId) {
		if (this.#entries.has(workerId)) return this.#entries.get(workerId).ready;
		const worker = this.#controller.snapshot().workers.find(worker => worker.id === workerId);
		check(worker, "NOT_FOUND", "Worker does not exist");
		const entry = { workerId, active: null };
		this.#entries.set(workerId, entry);
		entry.ready = (async () => {
			const state = this.#controller.snapshot();
			const binding = sessionWorker(state, workerId);
			const selection = effectiveWorkerSelection(state.sessions, workerId);
			const providerCapability = (await this.#resolveProviderCapability?.(selection)) ?? this.#providerCapability;
			entry.selection = structuredClone(selection);
			const tools = makeSessionTools((name, params, call) => this.#invoke(entry, name, params, call), state.sessions.codingTools, state.workspaceRoot);
			const created = await createSdkSession({
				cwd: state.workspaceRoot, sessionDir: this.#sessionDir, sessionId: binding?.sessionId,
				sessionFile: binding ? join(this.#sessionDir, binding.sessionFile) : undefined,
				modelRuntime: this.#modelRuntime, selection,
				providerCapability,
				admitRequest: async () => {
					await this.#controller.system("run.tick");
					this.#requestGuard(entry);
					if (this.#usageBlocked || usageLimitReason(this.#controller.snapshot())) {
						this.#usageBlocked = true;
						entry.usageDenied = true;
						check(false, "USAGE_LIMIT", "Worker model allowance reached");
					}
					const id = randomUUID();
					try { await this.#controller.system("session.request", { id, workerId }); }
					catch (error) { if (error.code === "USAGE_LIMIT") { this.#usageBlocked = true; entry.usageDenied = true; } throw error; }
					return id;
				},
				observeResponse: async (id, message) => {
					await this.#controller.system("session.usage", { id, workerId, usage: measuredUsage(message) });
					if (usageLimitReason(this.#controller.snapshot())) this.#usageBlocked = true;
				},
				systemPrompt: buildSpecialistPrompt(state, worker), customTools: tools,
			});
			Object.assign(entry, created);
			if (binding) check(created.sessionId === binding.sessionId, "IDENTITY", "Persisted specialist identity changed");
			else await this.#controller.system("session.bind", { workerId, sessionId: created.sessionId, sessionFile: basename(created.sessionFile) });
			return entry;
		})().catch(error => {
			entry.session?.dispose();
			this.#entries.delete(workerId);
			throw error;
		});
		return entry.ready;
	}

	#requestGuard(entry) {
		this.#admission?.assert();
		this.#controller.assertOwned();
		const state = this.#controller.snapshot();
		const turn = entry.active;
		check(turn && !turn.signal.aborted && state.status === "running" && turn.cycle === state.cycle &&
			turn.generation === state.generation && turn.guidanceRevision === state.guidanceRevision &&
			state.sessions.turns.some(item => item.id === turn.id), "FENCED", "Provider request no longer admitted");
	}

	#guard(entry, signal) {
		this.#admission?.assert();
		this.#controller.assertOwned();
		const turn = entry.active;
		const state = this.#controller.snapshot();
		check(turn && !entry.finishing && !turn.signal.aborted && !signal?.aborted && state.status === "running", "FENCED", "Specialist turn is not active");
		check(turn.cycle === state.cycle && turn.generation === state.generation && turn.guidanceRevision === state.guidanceRevision, "FENCED", "Specialist context changed");
		check(state.sessions.turns.some(item => item.id === turn.id && item.kind === "prompt"), "FENCED", "Prompt turn has not been admitted");
		return state;
	}

	async #invoke(entry, name, params, call) {
		const { toolCallId, signal } = call;
		const state = this.#guard(entry, signal);
		const turn = entry.active;
		const operationId = createHash("sha256").update(`${entry.sessionId}:${turn.id}:${toolCallId}:${name}`).digest("hex");
		const dispatch = (type, payload) => turn.worker.dispatch(type, payload, { operationId });
		const currentTask = () => {
			const task = this.#controller.snapshot().tasks.find(task => task.assignment?.workerId === entry.workerId);
			check(task, "OWNERSHIP", "Claim a task before workspace operations");
			return task;
		};
		switch (name) {
			case "swarm_status": {
				// Host agreements and native storage bindings are not worker context.
				return workerStatus(state, entry.workerId, this.#workspace.coordinationStatus());
			}
			case "swarm_tasks": {
				const offset = params.offset ?? 0, limit = params.limit ?? 10;
				check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 20, "INPUT", "Invalid task page");
				const tasks = state.tasks.filter(task => !params.taskId || task.id === params.taskId);
				const page = params.taskId ? tasks.slice(offset, offset + limit).map(task => ({ ...taskRows([task])[0], title: task.title, titleTruncated: false, candidate: task.candidate, reviews: task.reviews, contributors: task.contributors })) : taskRows(tasks, offset, limit);
				return { total: tasks.length, offset, nextOffset: offset + page.length < tasks.length ? offset + page.length : null, tasks: page };
			}
			case "swarm_task": {
				const { action, ...payload } = params;
				if (action === "claim") payload.assignmentId = operationId;
				const types = { create: "task.create", claim: "task.claim", unblock: "task.unblock", yield: "task.yield", fail: "task.fail" };
				check(types[action], "INPUT", "Unsupported task action");
				return dispatch(types[action], payload);
			}
			case "swarm_recruit": {
				const receipt = await dispatch("worker.create", { ...params, workloadRevision: state.revision });
				this.#enqueue(params.id, "Recruited for focused work");
				return receipt;
			}
			case "swarm_message": {
				const to = recipientId(params.to, state.workers);
				const topic = params.topic ?? state.tasks.find(task => task.assignment?.workerId === entry.workerId)?.id;
				const receipt = await dispatch("message.send", { ...params, to, ...(topic !== undefined ? { topic } : {}) });
				if (to === "@board") {
					for (const worker of state.workers) if (worker.id !== entry.workerId) this.#enqueue(worker.id, "New board message");
				} else if (to !== "owner") this.#enqueue(to, "New peer message");
				return receipt;
			}
			case "swarm_history": {
				const history = await this.history(params.workerId, params.limit ?? 20);
				this.#guard(entry, signal);
				return history;
			}
			case "swarm_files": {
				currentTask();
				const worker = this.#workspace.worker(entry.workerId);
				if (params.action === "claim") return worker.claim(params.paths);
				worker.release(); return { released: true };
			}
			case "swarm_report": {
				currentTask();
				const worker = this.#workspace.worker(entry.workerId);
				const result = await (params.action === "submit" ? worker.submit(params.summary, params.receipts) : worker.review(params.approved, params.summary));
				return result;
			}
			case "swarm_finish": {
				check(typeof params.command === "string" && params.command.trim() && params.command.length <= 32768, "INPUT", "Final verification command required");
				check(state.sessions.codingTools.includes("bash"), "AUTHORITY", "Final verification requires approved Bash access");
				check(!this.#finalRequest && !this.#finalizing, "BUSY", "Final verification is already requested");
				check(state.tasks.length > 0 && state.tasks.every(task => task.status === "done" && !task.assignment && !task.pending), "INCOMPLETE", "All tasks must independently complete first");
				check(state.criteria.every((_, index) => state.tasks.some(task => task.criteria.includes(index))), "INCOMPLETE", "All acceptance criteria need completed task coverage");
				check(!state.workspace.operations.length, "UNSETTLED", "Workspace operations must settle first");
				this.#finalRequest = { command: params.command, turnId: turn.id, cycle: state.cycle, generation: state.generation, guidanceRevision: state.guidanceRevision };
				entry.finishing = true;
				return { requested: true, completed: false, settlementRequired: true };
			}
			case "read": currentTask(); return this.#workspace.worker(entry.workerId).read(params.path, call, params);
			case "write":
			case "edit": {
				currentTask();
				this.#guard(entry, signal);
				const worker = this.#workspace.worker(entry.workerId);
				// Pi's native write/edit tools own the file mutation queue. Taking the same
				// queue outside them would deadlock.
				return name === "write" ? worker.write(params.path, params.content, call) : worker.edit(params.path, params.edits, call);
			}
			case "bash": currentTask(); return this.#workspace.worker(entry.workerId).shell(params.command, { ...call, timeout: params.timeout });
			default: check(false, "AUTHORITY", "Tool is not enabled");
		}
	}

	#enqueue(workerId, reason) {
		if (this.#closed || this.#controller.snapshot().status !== "running") return false;
		this.#queue.set(workerId, reason);
		if (!this.#pumpQueued) {
			this.#pumpQueued = true;
			queueMicrotask(() => { this.#pumpQueued = false; this.#pump(); });
		}
		return true;
	}

	#pump() {
		if (this.#quiescence || this.#usageBlocked || this.#finalRequest || this.#finalizing) return;
		try { this.#admission?.assert(); } catch { this.#queue.clear(); return; }
		const state = this.#controller.snapshot();
		if (this.#closed || state.status !== "running") { this.#queue.clear(); return; }
		for (const [workerId, reason] of this.#queue) {
			if (this.#active.size >= state.limits.active) break;
			if (this.#active.has(workerId)) continue;
			this.#queue.delete(workerId);
			this.#launch(workerId, "prompt", reason);
		}
	}

	#launch(workerId, kind, reason) {
		let settled = false;
		const promise = this.#execute(workerId, kind, reason).then(outcome => { settled = outcome === "settled"; }).catch(async error => {
			this.#recordError(error);
			if (error.code === "USAGE_LIMIT") { this.#usageBlocked = true; return; }
			if (["running", "verifying"].includes(this.#controller.snapshot().status)) {
				try { await this.#controller.system("run.pause"); } catch (failure) { this.#recordError(failure); }
			}
		}).finally(async () => {
			this.#active.delete(workerId);
			await this.#settleDrain();
			await this.#finishRequested();
			if (settled && !this.#usageBlocked && this.#controller.snapshot().status === "running" && pendingMail(this.#controller.snapshot(), workerId).length) this.#enqueue(workerId, "Remaining durable mail");
			if (settled && kind === "prompt") this.#coordinate(workerId);
			this.#pump();
		});
		this.#active.set(workerId, promise);
		return promise;
	}

	async #execute(workerId, kind, reason) {
		this.#admission?.assert();
		const requested = this.#controller.snapshot();
		const entry = await this.#entry(workerId);
		const state = this.#controller.snapshot();
		if (state.status !== "running" || state.cycle !== requested.cycle || state.generation !== requested.generation) return;
		const messages = kind === "prompt" ? turnMail(state, workerId) : [];
		const worker = state.workers.find(worker => worker.id === workerId);
		const context = { id: randomUUID(), cycle: state.cycle, generation: state.generation, guidanceRevision: state.guidanceRevision, signal: this.#admission ? AbortSignal.any([this.#controller.executionSignal(), this.#admission.signal()]) : this.#controller.executionSignal(), worker: this.#controller.worker(workerId) };
		try {
			await this.#controller.system("session.turn.start", { id: context.id, workerId, kind, messageIds: messages.map(message => message.id), guidanceRevision: context.guidanceRevision }, { cycle: context.cycle, generation: context.generation });
		} catch (error) {
			const current = this.#controller.snapshot();
			if (["GUIDANCE", "FENCED"].includes(error.code) && context.signal.aborted) {
				if (kind === "prompt" && current.status === "running" && current.cycle === context.cycle && current.generation === context.generation) this.#enqueue(workerId, "Refresh shared guidance before dispatch");
				return;
			}
			throw error;
		}
		entry.active = context;
		entry.finishing = false;
		entry.usageDenied = false;
		let abortPromise;
		const abort = () => { entry.session.abortCompaction(); abortPromise ??= entry.session.abort(); void abortPromise.catch(error => this.#recordError(error)); };
		context.signal.addEventListener("abort", abort, { once: true });
		let failure;
		let outcome = "settled";
		try {
			this.#requestGuard(entry);
			const prompt = buildTurnPrompt(state, worker, { messages, reason });
			if (kind === "compaction") await entry.session.compact(`${buildSpecialistPrompt(state, worker)}\n\nPreserve decisions, questions, references, and focus. Authoritative state:\n${prompt}`);
			else {
				// This packet is the only model input admitted for this generation.
				await context.worker.dispatch("worker.ack", { revision: state.guidanceRevision });
				this.#requestGuard(entry);
				await entry.session.prompt(prompt, { expandPromptTemplates: false });
			}
			await entry.session.waitForIdle();
			await entry.flushUsage?.();
			const last = entry.session.messages.filter(message => message.role === "assistant").at(-1);
			if (last?.stopReason === "error") outcome = entry.usageDenied ? "interrupted" : "failed";
			if (last?.stopReason === "aborted" || context.signal.aborted) outcome = "interrupted";
		} catch (error) {
			failure = error;
			outcome = context.signal.aborted ? "interrupted" : "failed";
		} finally {
			// SDK prompt resolution alone is not tool/process settlement.
			await entry.session.waitForIdle();
			if (abortPromise) await abortPromise;
			context.signal.removeEventListener("abort", abort);
			if (kind === "prompt" && outcome === "failed" && !context.signal.aborted && failure?.code !== "USAGE_LIMIT" && !entry.usageDenied) {
				const task = this.#controller.snapshot().tasks.find(task => task.assignment?.workerId === workerId);
				if (task && !task.pending) {
					try {
						await context.worker.dispatch("task.fail", { taskId: task.id, reason: "Specialist execution failed before reporting" });
					} catch (error) {
						if (context.signal.aborted && ["GUIDANCE", "FENCED", "STATE", "TIME_LIMIT"].includes(error.code)) outcome = "interrupted";
						else failure ??= error;
					}
				}
			}
			if (outcome !== "settled" && this.#finalRequest?.turnId === context.id) this.#finalRequest = undefined;
			await this.#controller.system("session.turn.end", { id: context.id, outcome });
			entry.active = null;
			const task = this.#controller.snapshot().tasks.find(task => task.assignment?.workerId === workerId);
			if (task && (task.pending || draining.has(this.#controller.snapshot().status))) await this.#workspace.settle(task.id);
		}
		if (failure && !context.signal.aborted) throw failure;
		return outcome;
	}

	#coordinate(preferredWorkerId) {
		if (this.#closed || this.#quiescence || this.#usageBlocked || this.#finalRequest || this.#finalizing) return;
		const unavailable = new Set([...this.#active.keys(), ...this.#queue.keys()]);
		const handoffs = coordinationHandoffs(this.#controller.snapshot(), unavailable, this.#handoffs, preferredWorkerId);
		for (const handoff of handoffs) {
			if (this.#enqueue(handoff.workerId, handoff.reason)) this.#handoffs.add(handoff.key);
		}
	}

	async #finishRequested() {
		if (!this.#finalRequest || this.#active.size || this.#finalizing) return;
		const request = this.#finalRequest;
		this.#finalRequest = undefined;
		const state = this.#controller.snapshot();
		if (state.status !== "running" || request.cycle !== state.cycle || request.generation !== state.generation || request.guidanceRevision !== state.guidanceRevision || this.#usageBlocked) return;
		// Deliver new steering/mail before completing; do not discard admitted handoffs.
		if (this.#queue.size || state.workers.some(worker => pendingMail(state, worker.id).length)) {
			this.#handoffs.delete(`${state.cycle}:${state.generation}:${state.guidanceRevision}:final:${state.workspace.fingerprint}`);
			return;
		}
		// Completion is owned by the existing receipt/Safety pipeline after native turns settle.
		this.#finalizing = this.#workspace.finalCheck(request.command);
		try { await this.#finalizing; }
		catch (error) {
			this.#finalVerificationFailed = true;
			this.#recordError(error);
			if (["running", "verifying"].includes(this.#controller.snapshot().status)) {
				try { await this.#controller.system("run.pause"); } catch (failure) { this.#recordError(failure); }
			}
		} finally { this.#finalizing = undefined; }
		await this.#settleDrain();
	}

	async #settleDrain() {
		if (this.#drain) return this.#drain;
		let state = this.#controller.snapshot();
		if (this.#usageBlocked && state.status === "running" && !this.#active.size && !state.sessions.turns.length && !state.workspace.operations.length) {
			await this.#controller.system("run.pause");
			state = this.#controller.snapshot();
		}
		if (!draining.has(state.status) || this.#active.size || state.sessions.turns.length || state.workspace.operations.length) return;
		this.#queue.clear();
		this.#drain = (async () => {
			for (const task of this.#controller.snapshot().tasks.filter(task => task.assignment)) await this.#workspace.settle(task.id);
			await this.#controller.system("run.settle");
		})().catch(error => this.#recordError(error)).finally(() => { this.#drain = null; });
		return this.#drain;
	}

	async recruit(specification) {
		this.#admission?.assert();
		const state = this.#controller.snapshot();
		await this.#controller.owner("worker.create", { ...specification, workloadRevision: state.revision });
		return this.#entry(specification.id).then(entry => ({ workerId: entry.workerId, sessionId: entry.sessionId }));
	}

	wake(workerId, reason = "Continue approved work") {
		this.#admission?.assert();
		check(this.#controller.snapshot().workers.some(worker => worker.id === workerId), "NOT_FOUND", "Worker does not exist");
		check(this.#controller.snapshot().status === "running" && !this.#closed, "STATE", "Resume explicitly before dispatch");
		this.#enqueue(workerId, reason);
	}

	async send(workerId, text, topic) {
		const to = recipientId(workerId, this.#controller.snapshot().workers);
		const receipt = await this.#controller.owner("message.send", { to, text, ...(topic !== undefined ? { topic } : {}) });
		const recipients = to === "@board" ? this.#controller.snapshot().workers.map(worker => worker.id) : [to];
		let enqueued = 0;
		for (const recipient of recipients) {
			if (this.#enqueue(recipient, to === "@board" ? "New main-agent board message" : "New main-agent message")) enqueued++;
		}
		return { operationId: receipt.operationId, revision: receipt.revision, to, persisted: true, dispatch: enqueued === 0 ? "not-enqueued" : "enqueued", enqueuedRecipients: enqueued, acknowledged: false };
	}

	async redirect(text) {
		await this.#controller.owner("run.redirect", { text });
		for (const worker of this.#controller.snapshot().workers) this.#enqueue(worker.id, "New shared user guidance");
	}

	async tick() {
		// Admission still ticks active turns. An idle model-change barrier must not
		// advance the journal revision while its exact agreement is inspected.
		if (this.#quiescence && !this.#active.size) return;
		await this.#controller.system("run.tick");
		await this.#settleDrain();
	}

	async resume({ reconciled = false, restart = false } = {}) {
		this.#admission?.assert();
		check(!this.#active.size && !this.#drain, "UNSETTLED", "Settle session preparation and execution before continuation");
		check(restart || !usageLimitReason(this.#controller.snapshot()), "USAGE_LIMIT", "Explicit restart/fresh objective required for exhausted or unmeasured model allowance");
		await this.#controller.owner(restart ? "run.restart" : "run.resume", { reconciled });
		this.#finalVerificationFailed = false;
		this.#usageBlocked = Boolean(usageLimitReason(this.#controller.snapshot()));
	}

	async pause({ timeoutMs = 5000, stop = false } = {}) {
		check(Number.isFinite(timeoutMs) && timeoutMs >= 0, "INPUT", "Invalid settlement timeout");
		this.#queue.clear();
		const status = this.#controller.snapshot().status;
		if (stop && !["stopping", "stopped", "completed", "failed"].includes(status)) await this.#controller.owner("run.stop");
		else if (!stop && ["running", "verifying"].includes(status)) await this.#controller.owner("run.pause");
		let timer;
		try {
			return await Promise.race([
				this.idle().then(async () => { await this.#settleDrain(); return { settled: terminal.has(this.#controller.snapshot().status) }; }),
				new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs); }),
			]);
		} finally { clearTimeout(timer); }
	}

	async compact(workerId) {
		this.#admission?.assert();
		check(!this.#quiescence, "BUSY", "Model reconfiguration holds new compaction starts");
		check(!this.#active.has(workerId) && !this.#queue.has(workerId), "BUSY", "Compact only an idle specialist");
		check(this.#active.size < this.#controller.snapshot().limits.active, "ACTIVE_LIMIT", "No compaction slot available");
		return this.#launch(workerId, "compaction", "Compact without replacing specialist identity");
	}

	async history(workerId, limit = 20) {
		check(Number.isInteger(limit) && limit > 0 && limit <= 100, "INPUT", "Invalid history limit");
		const state = this.#controller.snapshot();
		const binding = sessionWorker(state, workerId);
		if (!binding) return [];
		const entries = this.liveHistory(workerId) ?? readSessionHistory(join(this.#sessionDir, binding.sessionFile), state.workspaceRoot, binding.sessionId);
		return entries.slice(-limit);
	}

	/** Active branch of an open specialist session, from memory. Reading its file instead could race the
	 * session's own appends: Pi's loader repairs a missing final newline by writing to the file.
	 * Until Pi first writes the file there is no persisted history, matching a restored session. */
	liveHistory(workerId) {
		const manager = this.#entries.get(workerId)?.manager;
		if (!manager) return undefined;
		return existsSync(manager.getSessionFile()) ? structuredClone(manager.getBranch()) : [];
	}

	/** Hold new starts while native turns, retries, compaction and tools settle normally. */
	async quiesce({ signal } = {}) {
		check(!this.#closed && !this.#quiescence, "BUSY", "Driver already quiesced or closed");
		signal?.throwIfAborted();
		const barrier = {};
		this.#quiescence = barrier;
		const release = () => {
			signal?.removeEventListener("abort", release);
			if (this.#quiescence !== barrier) return;
			this.#quiescence = null;
			this.#pump();
		};
		signal?.addEventListener("abort", release, { once: true });
		try {
			while (this.#active.size || this.#controller.snapshot().sessions.turns.length || this.#drain || this.#finalizing) {
				signal?.throwIfAborted();
				check(this.#controller.snapshot().sessions.turns.every(turn => this.#active.has(turn.workerId)),
					"UNSETTLED", "Journaled orphan turns require explicit reconciliation");
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			signal?.throwIfAborted();
			check(!this.#controller.snapshot().workspace.operations.length, "UNSETTLED", "Journaled orphan operations require explicit reconciliation");
			return release;
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Evict only changed model pins; the next wake reopens the same native identity. */
	async refreshModels() {
		check(!this.#active.size && !this.#controller.snapshot().sessions.turns.length && !this.#drain &&
			(this.#quiescence || (!this.#queue.size && !this.#pumpQueued)), "UNSETTLED", "Quiesce or settle before refreshing models");
		// An idle refresh also holds starts across awaiting cache construction.
		const release = this.#quiescence ? null : await this.quiesce();
		try {
			for (const [workerId, entry] of this.#entries) {
				await entry.ready;
				const selection = effectiveWorkerSelection(this.#controller.snapshot().sessions, workerId);
				if (entry.selection.provider === selection.provider && entry.selection.modelId === selection.modelId &&
					entry.selection.thinkingLevel === selection.thinkingLevel) continue;
				check(entry.session.isIdle && !this.#active.size, "UNSETTLED", "SDK session is not idle");
				entry.session.dispose();
				this.#entries.delete(workerId);
			}
		} finally { release?.(); }
	}

	async idle() {
		while (this.#active.size || (!this.#quiescence && this.#queue.size) || this.#pumpQueued || this.#drain || this.#finalizing) {
			this.#pump();
			await Promise.allSettled([...this.#active.values()]);
			if (this.#drain) await this.#drain;
			if (this.#finalizing) await this.#finalizing.catch(() => { });
			await Promise.resolve();
		}
	}

	async reconcile({ settled = false } = {}) {
		check(settled && !this.#active.size, "UNSETTLED", "Establish session/process settlement before recovery");
		await this.#workspace.reconcile({ settled: true });
		await this.#controller.owner("sessions.reconcile", { settled: true });
		await this.#settleDrain();
	}

	/** Read-only settlement check; must not construct, cancel or dispose sessions. */
	assertReplaceable() {
		const state = this.snapshot();
		check(!state.active.length && !state.queued.length && !this.#drain && !this.#pumpQueued && !this.#finalizing && !this.#finalRequest,
			"UNSETTLED", "Queued or live SDK work remains unsettled");
		check(state.sdkIdle, "UNSETTLED", "SDK session preparation or work remains unsettled");
	}

	async close() {
		check(!this.#active.size && !this.#queue.size && !this.#drain && !this.#finalizing, "UNSETTLED", "Pause and settle before closing SDK sessions");
		check(terminal.has(this.#controller.snapshot().status), "STATE", "Pause or stop before close");
		for (const entry of this.#entries.values()) {
			await entry.ready;
			check(entry.session.isIdle, "UNSETTLED", "SDK session is not idle");
			entry.session.dispose();
		}
		clearInterval(this.#timer);
		this.#closed = true;
		await this.#controller.close();
	}
}
