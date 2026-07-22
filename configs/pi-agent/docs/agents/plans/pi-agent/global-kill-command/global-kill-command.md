# Global `/kill` Command Implementation Plan

## 1. Context

Pi currently has several independent stop mechanisms: `ctx.abort()` for the main run, fleet brakes for subagents and teams, `ProcedureRun.stop()`, queue editing, and per-panel child-process cancellation. They are not coordinated. A main abort can therefore be followed by a queued continuation, mail auto-wake, scheduled child turn, procedure waiter, or isolated review/merge LLM.

The chosen implementation is a TUI-only `/kill` coordinator plus an event-bus cancellation protocol. It will synchronously latch every participating subsystem against new automatic work, discard every currently dispatch-capable prompt queue, request cancellation concurrently, abort the main run, and report a bounded result. The latches release on the next ordinary interactive prompt; explicit later commands may start only the work they directly request.

### Confirmed requirements

1. `/kill` is an immediate human command with no arguments and no second confirmation.
2. It stops the ordinary main-agent run, running/queued/waiting subagents, teams, an active procedure and its waiters, and every enabled package-owned LLM job.
3. It discards Pi-native steer/follow-up/compaction queues and all persisted `pi-queue` entries rather than restoring them for later execution.
4. It closes restart races: late mail, queued scheduler callbacks, and auto-wake pumps cannot start another LLM before the next ordinary interactive prompt.
5. It preserves subagent/team identities, durable mail, transcripts, and procedure journals. Killing work is not retirement or deletion.
6. Cancellation is idempotent and bounded: one failed or hung participant does not block the rest, and the user receives a success/warning summary within ten seconds.
7. The first later ordinary interactive prompt releases background automation. Existing durable mail may then be delivered under normal package policy; killed child turns are never silently replayed.
8. Scope is the interactive TUI and the currently enabled local Pi packages. Pi-core retry-delay and already-running compaction cancellation remain a documented limitation of Pi 0.80.10.
9. Automated and live tests cover active, queued, waiting, pre-prompt, auto-wake, repeated kill, participant failure/timeout, reload, durable-state preservation, and orphan-process cleanup.

### Non-goals

- Do not call `shutdown()`, exit Pi, retire agents, delete mail, remove sessions, or erase procedure journals.
- Do not patch the globally installed Pi package or rely on its private object graph.
- Do not promise RPC/print-mode behavior.
- Do not kill unrelated operating-system processes; only sessions/process groups owned by participating extensions are in scope.
- Do not add a persistent `/unkill` mode. The automatic-work latch is intentionally one-shot.
- Do not clear Pi's private `nextTurn` context-aside array. No enabled package produces such messages, and they cannot independently start a run.

## 2. Grounded key findings

### Main-session and TUI contracts

- Command contexts expose `isIdle()`, the current `signal`, `abort()`, `hasPendingMessages()`, and command-only `waitForIdle()`; the TUI UI exposes `setEditorText()` (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:127-132,221-250`).
- Extension commands are checked before input events and execute immediately even while streaming (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:787-817`). The interactive mode also explicitly executes extension commands during compaction and streaming (`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2226-2244`). This makes `/kill` reachable from the normal editor while a main turn is running.
- In TUI mode, `ctx.abort()` calls the interactive abort handler, which clears Pi's session and compaction queues, restores their text to the editor, and aborts the raw agent (`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1193-1203,3207-3222,3243-3261`). Calling `ctx.ui.setEditorText("")` immediately afterward precisely discards that restored text.
- Extension commands bypass the `input` event; an ordinary prompt emits `input` with source `interactive | rpc | extension` (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:803-817`; `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:614-626`). Therefore the release latch should key on the next `source === "interactive"` input event, not on `/kill` itself.
- The public command `abort()` is wired to the TUI abort handler, not to `AgentSession.abort()`. Pi core has private `abortRetry()` and `abortCompaction()` methods, but they are not exposed through extension context (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:1171-1180,1486-1492,1901-1908,2135-2143`). An in-progress retry delay or compaction cannot be guaranteed stopped by a pure extension.
- A `session_before_compact` handler can cancel compaction before it begins and identifies manual, threshold, and overflow/retry causes (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:428-440`). The coordinator should use this to close the post-kill compaction race even though it cannot abort compaction already in progress.

### Cross-package coordination

- `pi.events` is the supported extension-to-extension surface (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:995-999`). Its emitter invokes wrapped handlers but does not await their promises (`@earendil-works/pi-coding-agent/dist/core/event-bus.js:1-20`).
- Existing safety bridges already solve this ordering with a synchronous-claim protocol: emit a request whose `claim()` is called during `emit`, then await the claimed callback separately (`configs/pi-agent/packages/pi-procedure/extensions/procedure/sandbox/safety-bridge.ts:1-14,49-78`). `/kill` should adapt that proven pattern rather than import private package internals.

### Agent fleets and wake pumps

- Current subagent and team stop-all methods first take a status snapshot and then cancel/interrupt only entries in `running | queued | waiting` (`configs/pi-agent/packages/pi-subagents/extensions/subagents/core.ts:61-67,132-138`; `configs/pi-agent/packages/pi-teams/extensions/teams/core.ts:59-65,143-149`). They do not establish a barrier against a turn scheduled after the snapshot.
- Both runtimes already serialize mail turns per address, track active turns, distinguish pre-stream cancellation, and provide `whenIdle()` (`configs/pi-agent/packages/pi-subagents/extensions/subagents/runtime/in-process.ts:152-170,361-403,513-525`; `configs/pi-agent/packages/pi-teams/extensions/teams/runtime/in-process.ts:551-567`). These are the right primitives to adapt into `quiesce(generation)` rather than using `dispose()` or retirement.
- Both main-mail wake pumps commit mail only after injection and currently gate only on host-idle and shutdown (`configs/pi-agent/packages/pi-subagents/extensions/subagents/mail/wake-pump.ts:1-16,37-74`; `configs/pi-agent/packages/pi-teams/extensions/teams/mail/wake-pump.ts:1-24,45-82`). They need a reversible pause state that preserves mail and never drains merely because it was resumed.
- Sandboxed confirmation currently ignores the tool execution `AbortSignal`; its provider timeout is ten minutes (`configs/pi-agent/packages/pi-procedure/extensions/procedure/sandbox/safety-bridge.ts:35-42,49-78`). The tool wrappers must pass their execution signal into confirmation and race it, or a waiting child can outlive the coordinator timeout.

### Procedure and queues

- `ProcedureRun.stop()` is already idempotent, rejects future `agent()` calls, and abandons a script after a five-second grace period (`configs/pi-agent/packages/pi-procedure/extensions/procedure/run.ts:1-14,37-40,167-176,234-237,406-430`).
- Procedure agents wait on a FIFO scheduler before checking `isStopped()`, and running sessions use polling to notice stop (`configs/pi-agent/packages/pi-procedure/extensions/procedure/runner/scheduler.ts:1-48`; `configs/pi-agent/packages/pi-procedure/extensions/procedure/runner/agent-runner.ts:132-151,196-216`). An abortable scheduler acquisition and stop signal will remove queued waiters immediately and replace polling.
- `pi-queue` reconstructs state by replaying custom operations and dispatches by removing/persisting an entry before `sendUserMessage` (`configs/pi-agent/packages/pi-queue/extensions/queue/index.ts:18-31,40-110,190-220`). A single replayable `clear` operation provides crash-safe all-entry deletion; a generation latch closes dispatch races.

### Other owned LLM work

- `pi-changes` already exposes an `AnswerState.kill()` and terminates a detached process group with TERM then KILL (`configs/pi-agent/packages/pi-changes/extensions/changes/ask.ts:85-93,105-166`). It needs only extension-scope registration so `/kill` can reach the active answer.
- `pi-commit` uses a direct `complete()` call with an `AbortSignal` for descriptions (`configs/pi-agent/packages/pi-commit/extensions/commit/describe.ts:13-46`) and a separate child `pi` for review chat, but that child currently terminates only the immediate process (`configs/pi-agent/packages/pi-commit/extensions/commit/chat.ts:116-168`). It should adapt the process-group termination already proven by `pi-changes`.
- `pi-merge` owns a child `pi` with timeout and TERM/KILL logic but no extension-scope handle and no detached process group (`configs/pi-agent/packages/pi-merge/extensions/merge/index.ts:452-492`). It needs a registry plus an epoch guard so a killed synthesis cannot later create a session.
- A repository-wide search found no other enabled TypeScript package calling direct model completion, creating an isolated `AgentSession`, or spawning child `pi` processes beyond subagents, teams, procedure, changes, commit, and merge.

## 3. Design

### 3.1 Coordinator package and protocol

Add a new `pi-kill` package, adapting the command/package skeleton from `configs/pi-agent/packages/pi-clear/` and the synchronous-claim idiom from the procedure safety bridge.

Use two versioned channels:

```ts
const KILL_REQUEST = "pi-kill:request";
const KILL_RELEASE = "pi-kill:release";

interface KillRequest {
  version: 1;
  generation: number;
  reason: "user";
  claim(name: string, stop: () => KillResult | Promise<KillResult>): void;
}

interface KillResult {
  stopped: number;
  detail?: string;
  warnings?: string[];
}
```

Each participant's event handler must be synchronous and call `claim()` before returning. The coordinator stores claims in a `Map` keyed by participant name, treats duplicates as warnings, closes registration when `emit()` returns, and invokes every `stop()` callback immediately in a `try/catch`. Because each callback executes synchronously until its first await, every participant installs its generation latch before the coordinator touches the main session.

`/kill` ordering is fixed:

1. Reject arguments and non-TUI contexts.
2. Increment the generation and mark the coordinator killed.
3. Emit `pi-kill:request` and synchronously collect claims.
4. Invoke all claimed stop callbacks concurrently; participant callbacks latch before awaiting.
5. Call `ctx.abort()` unconditionally.
6. Immediately call `ctx.ui.setEditorText("")` to discard the Pi-native queue text restored by the TUI abort handler.
7. Await all participant results and `ctx.waitForIdle()` under one ten-second deadline using `Promise.allSettled` semantics.
8. Notify one concise summary. Timeouts, duplicate claims, synchronous throws, and rejected participant promises produce warnings but never prevent other cancellation.

Repeated `/kill` increments the generation and reruns cancellation; already-idle participants return zero. A stale release or stale completion cannot affect a newer generation.

The coordinator listens for the first later `input` with `source === "interactive"`, clears its latch, and emits `pi-kill:release` with the matching generation. Slash commands do not emit this event; they may perform explicitly requested foreground work, but they do not revive old background pumps. The coordinator also returns `{ cancel: true }` from `session_before_compact` while latched, preventing a new threshold/overflow/manual compaction from starting after kill.

No session entry is needed for the latch. It is deliberately ephemeral and resets on session start/reload; durable participant data remains in each package's existing store.

### 3.2 Main-run and queue semantics

The command itself is the destructive-intent gate for queue deletion, so it must not add a second confirmation.

- **Pi-native queues:** rely on the documented TUI abort path to clear session steering, follow-up, and compaction queues; blank the restored editor text immediately afterward.
- **`pi-queue`:** add `{ op: "clear" }` to the replay log. The kill participant first sets its generation latch, then appends one clear operation, then empties memory and refreshes the widget. If persistence throws, it leaves the in-memory entries intact and reports failure rather than claiming they were discarded. Dispatch and enqueue paths check the current generation so a callback racing the clear cannot submit old work.
- **Private `nextTurn` asides:** document that they are not clearable through public API. They are not produced by enabled packages and cannot start a turn on their own, so they are outside the dispatch-capable queue guarantee.

### 3.3 Subagent and team quiescence

Implement the same runtime contract independently in both packages:

```ts
quiesce(generation: number): Promise<{ stopped: string[]; failed: string[] }>;
release(generation: number): void;
readonly quiesced: boolean;
```

`quiesce()` performs a barrier, not a status-snapshot brake:

1. Store the newest generation synchronously.
2. Pause the package's main-mail wake pump synchronously.
3. Reject/suppress new work-producing runtime calls and all new `scheduleMailTurn()` attempts while quiesced.
4. Mark every currently queued/running/waiting address for pre-stream cancellation and abort every streaming handle.
5. Check the quiescence generation again after scheduler acquisition, async handle construction, and immediately before prompting; if changed or still killed, return the agent to dormant and leave its triggering mail pending.
6. Await the runtime's existing `whenIdle()` and normalize any remaining working state to dormant.

Do not call `dispose()` or retirement. Handles, registry records, sessions, transcripts, generation IDs, and mailbox files remain. Interrupted delivery follows the package's existing pending/redelivery path. On matching `pi-kill:release`, clear the runtime barrier and resume the wake pump without pumping immediately. The next main prompt marks the host busy; normal `agent_settled` behavior may later drain preserved main mail.

Extend sandbox ports so wrapped `bash`/`edit`/`write` execution passes its tool `AbortSignal` into `ConfirmFn`. `makeSafetyConfirm` races the provider promise against that signal and fails closed on abort. This lets the runtime settle even if a human confirmation provider remains unresolved.

### 3.4 Procedure stop barrier

Give each `ProcedureRun` one `AbortController`:

- `stop()` sets the existing stopped flag and aborts the controller exactly once.
- `Scheduler.acquire(signal)` removes and rejects a queued waiter when aborted rather than waiting for a future slot.
- Running agent sessions subscribe once to the stop signal and abort immediately; remove the current polling interval.
- Sandbox confirmations receive and race the tool signal as in subagents/teams.
- `ProcedureRun.whenSettled()` resolves only after `execute()` has written its terminal journal outcome and disposed running sessions.

The procedure participant latches new procedure tool starts for the kill generation, calls `active.run.stop()`, and awaits `whenSettled()`. It releases on the matching release event. Preserve the existing five-second script-unwind grace and journal a normal `stopped` outcome; do not delete resumable completed calls.

### 3.5 Package-owned child and direct LLM registries

Use small extension-scope registries, not global process scanning:

- **`pi-changes`:** register each active `AnswerState` when spawned and unregister on close. Kill calls every registered `kill()`. Preserve the existing detached process-group TERM → three-second KILL behavior.
- **`pi-commit`:** add a `CommitLlmRegistry` that tracks description `AbortController`s and review-chat answer states. Pass a tracked controller into the review panel instead of creating an unreachable one. Adapt `pi-changes` process-group termination for chat children so descendants cannot survive. Epoch-check description caching and chat completion so a late result after kill is ignored.
- **`pi-merge`:** expose the active synthesis terminator to an extension-scope registry, spawn the child detached on POSIX, terminate its process group with TERM then KILL, and capture an epoch at command start. Check the epoch after synthesis and before labels/session creation so a killed or late child result cannot mutate session state.

These registries only cancel current work. A later explicit `/changes`, `/commit`, or `/merge` starts a fresh epoch and is allowed; no background replay exists in those packages.

### 3.6 User feedback and failure behavior

Use a TUI notification, not a transcript message or extra model call:

```text
Kill complete — main stopped · queues 4 discarded · subagents 3 · teams 2 · procedure 1 · child LLMs 1
```

If any component rejects or exceeds the deadline:

```text
Kill finished with warnings — main still settling; procedure timed out. Pi retry/compaction may require Esc, reload, or waiting for Pi core.
```

Rules:

- `info` when every claimed participant and the main session settle.
- `warning` when any participant/main wait fails or times out.
- Never say “all stopped” when confirmation is incomplete.
- Missing optional packages simply make no claim; the coordinator remains load-order independent.
- The ten-second coordinator deadline exceeds procedure's five-second grace and child processes' three-second TERM grace.

### 3.7 Hardest constraint proof: no automatic restart after kill

1. Extension-command precedence lets `/kill` execute during an ordinary main stream.
2. Every participant installs a generation latch synchronously through the claim callback before any await.
3. Agent/team wake pumps are paused before their interrupted children can report completion.
4. Agent/team runtimes reject new scheduling at entry, after each async boundary, and immediately before prompt.
5. Procedure's stop signal removes FIFO waiters and aborts running sessions; future `agent()` calls see stopped state.
6. `pi-queue` is persistently cleared under a dispatch latch; Pi-native queues are synchronously cleared by `ctx.abort()` and then erased from the editor.
7. The main agent is aborted only after all participant latches are installed.
8. Pre-start compaction is cancelled while the coordinator latch remains active.
9. Late participant completions are generation/epoch checked and cannot schedule new work or commit merge/description results.
10. Only the next ordinary interactive prompt emits the matching release. Resume does not itself pump mail; normal post-prompt settling restores existing wake policy.

The only exception is a retry delay or compaction that was already active inside Pi core before `/kill`; the public extension API cannot reach those controllers. The command must surface a timeout warning rather than overstate success.

## 4. File tree

### New coordinator package

| File | Provenance and contents |
|---|---|
| `configs/pi-agent/packages/pi-kill/package.json` | **Adapted from** `packages/pi-clear/package.json`; package metadata and extension entry. |
| `configs/pi-agent/packages/pi-kill/README.md` | **New**; command semantics, participant protocol, queue destruction, lifecycle, and Pi-core limitations. |
| `configs/pi-agent/packages/pi-kill/extensions/kill/protocol.ts` | **Adapted from** procedure safety-bridge claim types; channels, versioned request/release/result types, timeout error. |
| `configs/pi-agent/packages/pi-kill/extensions/kill/coordinator.ts` | **New** pure coordinator; claim collection, generation state, concurrent bounded settlement, summary formatting. |
| `configs/pi-agent/packages/pi-kill/extensions/kill/index.ts` | **Adapted from** `packages/pi-clear/extensions/clear/index.ts`; `/kill` registration, TUI queue clearing, input release, pre-compaction guard. |
| `configs/pi-agent/packages/pi-kill/test/kill.test.mjs` | **New**; ordering, synchronous claims, duplicate/error/timeout handling, idempotence, release generations, summary truthfulness. |

### Subagents

| File | Provenance and contents |
|---|---|
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/runtime/types.ts` | **Adapted**; expose quiesce/release contract and generation semantics. |
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/runtime/in-process.ts` | **Adapted**; runtime barrier, scheduling guards, fleet abort, dormant normalization. |
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/core.ts` | **Adapted**; route coordinated quiescence without changing the existing human stop command. |
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/mail/wake-pump.ts` | **Adapted**; reversible pause/resume that preserves pending mail and never drains on resume alone. |
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/sandbox/safety-bridge.ts` | **Adapted**; abort-aware confirmation race. |
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/sandbox/tools-filter.ts` | **Adapted**; forward tool execution signals to confirmation. |
| `configs/pi-agent/packages/pi-subagents/extensions/subagents/index.ts` | **Adapted from** its existing stop/wake wiring; kill request/release participants. |
| `configs/pi-agent/packages/pi-subagents/test/e2e/phase5-wake.mjs` | **Adapted**; paused pump and release behavior. |
| `configs/pi-agent/packages/pi-subagents/test/e2e/phase6-control.mjs` | **Adapted**; active/queued/pre-stream quiescence and idempotence. |
| `configs/pi-agent/packages/pi-subagents/test/e2e/phase8-sandbox.mjs` | **Adapted**; waiting confirmation abort. |
| `configs/pi-agent/packages/pi-subagents/README.md` | **Adapted**; coordinated kill semantics and durable-mail behavior. |

### Teams

| File | Provenance and contents |
|---|---|
| `configs/pi-agent/packages/pi-teams/extensions/teams/runtime/types.ts` | **Adapted**; expose quiesce/release contract. |
| `configs/pi-agent/packages/pi-teams/extensions/teams/runtime/in-process.ts` | **Adapted**; generation barrier, scheduling guards, fleet abort, dormant normalization. |
| `configs/pi-agent/packages/pi-teams/extensions/teams/core.ts` | **Adapted**; coordinated quiescence entry point. |
| `configs/pi-agent/packages/pi-teams/extensions/teams/mail/wake-pump.ts` | **Adapted**; reversible pause/resume. |
| `configs/pi-agent/packages/pi-teams/extensions/teams/sandbox/safety-bridge.ts` | **Adapted**; abort-aware confirmation race. |
| `configs/pi-agent/packages/pi-teams/extensions/teams/sandbox/tools-filter.ts` | **Adapted**; forward tool execution signals. |
| `configs/pi-agent/packages/pi-teams/extensions/teams/index.ts` | **Adapted**; kill request/release participants. |
| `configs/pi-agent/packages/pi-teams/test/e2e/phase9-auto-wake.mjs` | **Adapted**; paused pump and release behavior. |
| `configs/pi-agent/packages/pi-teams/test/e2e/phase2-runtime.mjs` | **Adapted**; running/queued/pre-stream barrier and identity preservation. |
| `configs/pi-agent/packages/pi-teams/test/e2e/phase5-sandbox.mjs` | **Adapted**; waiting confirmation abort. |

### Procedure and queue

| File | Provenance and contents |
|---|---|
| `configs/pi-agent/packages/pi-procedure/extensions/index.ts` | **Adapted**; kill request/release participant and new-run latch. |
| `configs/pi-agent/packages/pi-procedure/extensions/procedure/run.ts` | **Adapted**; stop controller and `whenSettled()`. |
| `configs/pi-agent/packages/pi-procedure/extensions/procedure/runner/scheduler.ts` | **Adapted**; abortable waiter removal. |
| `configs/pi-agent/packages/pi-procedure/extensions/procedure/runner/agent-runner.ts` | **Adapted**; signal-based stop instead of polling and abort-aware confirmation. |
| `configs/pi-agent/packages/pi-procedure/extensions/procedure/sandbox/safety-bridge.ts` | **Adapted**; signal-aware fail-closed confirmation. |
| `configs/pi-agent/packages/pi-procedure/extensions/procedure/sandbox/tools-filter.ts` | **Adapted**; forward tool execution signals. |
| `configs/pi-agent/packages/pi-procedure/test/e2e/phase4-stop-sandbox.mjs` | **Adapted**; running/queued/waiting cancellation, journal settlement, no late starts. |
| `configs/pi-agent/packages/pi-procedure/README.md` | **Adapted**; global kill behavior and resumable journal guarantee. |
| `configs/pi-agent/packages/pi-queue/extensions/queue/index.ts` | **Adapted**; replayable clear operation, generation latch, kill participant. |
| `configs/pi-agent/packages/pi-queue/test/kill.test.mjs` | **New**; atomic replay clear, dispatch race, persistence failure, reload. |
| `configs/pi-agent/packages/pi-queue/README.md` | **Adapted**; `/kill` permanently discards managed entries. |

### Auxiliary LLM owners

| File | Provenance and contents |
|---|---|
| `configs/pi-agent/packages/pi-changes/extensions/changes/ask.ts` | **Adapted**; lifecycle callback for active-answer registration. |
| `configs/pi-agent/packages/pi-changes/extensions/changes/index.ts` | **Adapted**; extension-scope registry and kill participant. |
| `configs/pi-agent/packages/pi-changes/test/kill.test.mjs` | **New**; active process-group termination and unregister. |
| `configs/pi-agent/packages/pi-changes/README.md` | **Adapted**; global kill integration. |
| `configs/pi-agent/packages/pi-commit/extensions/commit/kill-registry.ts` | **New, adapted from** `pi-changes/ask.ts`; tracked controllers/process answers and epoch checks. |
| `configs/pi-agent/packages/pi-commit/extensions/commit/index.ts` | **Adapted**; registry ownership, kill participant, epoch checks in the review flow. |
| `configs/pi-agent/packages/pi-commit/extensions/commit/review-panel.ts` | **Adapted**; accept and dispose a tracked description controller. |
| `configs/pi-agent/packages/pi-commit/extensions/commit/chat.ts` | **Adapted from** `pi-changes/ask.ts`; registration and POSIX process-group termination. |
| `configs/pi-agent/packages/pi-commit/test/kill.test.mjs` | **New**; description abort, chat descendants, late-result suppression. |
| `configs/pi-agent/packages/pi-commit/README.md` | **Adapted**; global kill integration. |
| `configs/pi-agent/packages/pi-merge/extensions/merge/index.ts` | **Adapted from** its current terminate path and `pi-changes/ask.ts`; active terminator registry, detached group, epoch guards. |
| `configs/pi-agent/packages/pi-merge/test/kill.test.mjs` | **New**; process-group termination and no post-kill session mutation. |
| `configs/pi-agent/packages/pi-merge/README.md` | **Adapted**; global kill integration and cancellation behavior. |

### Registration and agent documentation

| File | Provenance and contents |
|---|---|
| `<pi-agent-dir>/settings.json` | **Adapted outside the repository**; enable `pi-kill`, preferably before participant packages. |
| `configs/pi-agent/MANIFEST.md` | **Adapted**; list `/kill`, its scope, release rule, and core limitation. |
| `AGENTS.md` | **Adapted**; update the PiAgent layout with the coordinated kill behavior. |
| `configs/pi-agent/docs/agents/notes/pi-agent/global-kill-command/global-kill-command.md` | **New after implementation**; project-specific implementation outcome, verified tests, and remaining core gap. |
| `plans/agent-systems/global-cancellation/global-cancellation.md` | **New reusable artifact**; sanitized cross-extension synchronous barrier pattern without project/host specifics. |

## 5. Changes outside the deliverable

1. Enable the package in the active Pi package list and run `/reload`; no package installation or network access is required.
2. Keep the protocol structural and event-based. Participant packages must not import source from `pi-kill`, so any one package can be removed without breaking module loading.
3. Do not change existing `/subagents stop`, team stop keys, `/procedures stop`, Esc behavior, or package-specific UIs; `/kill` is an additional coordinator.
4. Do not change Git state, commit, or push as part of implementation unless separately requested.
5. Capture the generic claim/barrier/generation pattern in the reusable `plans/agent-systems/global-cancellation/` note and implementation-specific findings in `configs/pi-agent/docs/agents/notes/`.

## 6. Risks and open questions

| Risk | Disposition |
|---|---|
| Pi 0.80.10 exposes no extension API for active retry-delay or compaction controllers. | **Accepted scope limitation.** Cancel not-yet-started compaction via `session_before_compact`; bound the wait and warn instead of claiming success. Track an upstream core `abortAll()` API as a follow-up. |
| Pi's private `nextTurn` context-aside queue is not clearable. | **Out of scope.** No enabled package creates it, and it cannot start work by itself. Reassess if a package begins using `deliverAs: "nextTurn"`. |
| `pi.events` does not await async handlers. | **Mitigated** by synchronous claims before any await, registration closure after `emit`, and direct protocol-order tests. |
| A participant may be missing, duplicated after a bad reload, throw, or hang. | **Mitigated** by structural optional claims, duplicate warnings, `allSettled`, generations, and a ten-second deadline. |
| A modal confirmation or full-screen overlay owns keyboard input, so the user may not be able to type `/kill` until dismissing it. | **Known TUI limitation.** Esc already aborts the owning panel/process. Event-level tests still verify waiting-state cancellation once the command/event can run; a global non-modal keybinding is a separate feature. |
| POSIX process-group termination is not portable to Windows. | **Mitigated** with detached group signaling on POSIX and immediate-child `proc.kill()` fallback on Windows; the current host is POSIX. |
| A child process may ignore TERM or close without all descendants. | **Mitigated** by three-second KILL escalation and orphan-process tests. Never scan/kill unrelated processes. |
| Queue persistence can fail during destructive clear. | **Mitigated** by append-clear-before-memory-clear and explicit warning; do not silently clear only memory. |
| Release could race a stale kill completion. | **Mitigated** by monotonically increasing generations/epochs and matching release checks. |
| Runtime abort may leave a registry row in working state after an unexpected exception. | **Mitigated** by `whenIdle()` plus final dormant normalization and reload tests. |
| Repository package APIs may change while implementation is in progress. | **Verify during implementation** by re-reading touched signatures and running each package loadcheck before live testing. |

## 7. Verification

### Automated gates

1. From `configs/pi-agent/packages/pi-kill`, run `node --experimental-strip-types --test test/kill.test.mjs`; verify command ordering, claims-before-abort, idempotence, generations, deadline, partial failure, duplicate claims, and truthful summaries. **[R1, R6, R7]**
2. Run subagent wake/control/sandbox suites with `node --experimental-strip-types test/e2e/phase5-wake.mjs`, `phase6-control.mjs`, and `phase8-sandbox.mjs`; then run `loadcheck.mjs`. **[R2, R4, R5, R7]**
3. Run team runtime/sandbox/auto-wake suites with `node --experimental-strip-types test/e2e/phase2-runtime.mjs`, `phase5-sandbox.mjs`, and `phase9-auto-wake.mjs`; then run `loadcheck.mjs`. **[R2, R4, R5, R7]**
4. Run procedure `node --experimental-strip-types test/e2e/phase4-stop-sandbox.mjs` and its existing phase1–phase3 suites, followed by `loadcheck.mjs`; verify queued scheduler waiters are removed, running/waiting sessions abort, and the journal ends `stopped`. **[R2, R4, R5]**
5. Run `node --experimental-strip-types --test test/kill.test.mjs` in `pi-queue`, `pi-changes`, `pi-commit`, and `pi-merge`. **[R2, R3, R6]**
6. In auxiliary process tests, use a harmless child that spawns a descendant; verify TERM then KILL reaches the owned process group and no descendant remains. **[R2, R9]**
7. Test a participant that throws synchronously, one that rejects asynchronously, and one that never settles; assert the other participants and main abort still execute and the command returns a warning within ten seconds. **[R6]**
8. Test two kill generations followed by a stale release; assert only the latest matching release resumes pumps/runtimes. **[R4, R6, R7]**
9. Test kill during each runtime boundary: before scheduler acquisition, while queued, during async handle creation, immediately before prompt, while streaming, and while waiting on confirmation. Assert zero post-kill prompt starts. **[R2, R4, R9]**
10. Replay a `pi-queue` session log containing enqueue → clear → later enqueue. Assert only the later entry restores; inject persistence failure and assert memory remains intact with a warning. **[R3, R6, R9]**
11. Run all unchanged package suites for subagents, teams, procedure, queue-adjacent UI, changes, commit, and merge to catch regressions in ordinary stop, wake, review, and resume flows. **[R5]**
12. Run every modified package's loadcheck under Node strip-types and load Pi once with all active packages; verify no duplicate command, missing import, or extension-load diagnostics. **[R8]**

### Live TUI acceptance

13. Enable `pi-kill`, run `/reload`, enter `/kill extra`, and verify it reports `Usage: /kill` without cancelling anything. Run `/kill` while idle and verify a clean zero-work summary. **[R1, R6]**
14. Start a deliberately long main response. While it streams, create native steer and follow-up messages plus several `pi-queue` entries, then enter `/kill`. Verify the response stops, native pending counts go to zero, the editor is blank, and `/queue` is empty. **[R1, R3]**
15. Reload the same session and verify discarded `pi-queue` entries do not return. **[R3]**
16. Prepare subagents and teams in running, concurrency-queued, pre-prompt, and waiting states; include durable unread mail and stable identities. Run `/kill` and verify every working row becomes dormant, no row retires, identities/transcripts remain, and mail remains pending. **[R2, R4, R5]**
17. Wait longer than a normal auto-wake interval without sending input. Verify no child agent, procedure agent, main-mail pump, or queued prompt starts an LLM. **[R4]**
18. Start a procedure with more agent calls than its concurrency cap and at least one sandbox confirmation. Run `/kill`; verify running and waiting sessions abort, queued calls never start, the procedure reaches `stopped`, and its run ID remains resumable. **[R2, R4, R5]**
19. Exercise each auxiliary owner separately: a `/changes` subanswer, `/commit` description/chat, and `/merge` synthesis. Trigger kill through the coordinator test hook or dismiss the owning modal and invoke `/kill`; verify the owned request/process stops and no late result is cached, displayed as success, or used to create a merged session. **[R2, R6]**
20. Run `/kill` twice around the same settling work. Verify no exception, duplicate mutation, or stale release, and that the second summary reports only remaining work. **[R6]**
21. After kill, send one ordinary interactive prompt. Verify background latches release, the main prompt runs, and later normal settling may deliver preserved mail; verify no killed turn is silently reconstructed from a consumed trigger. **[R5, R7]**
22. Kill again, then run an explicit foreground slash command such as `/merge` or `/changes`. Verify only that explicitly requested work can start and old background agents remain quiesced until an ordinary prompt releases them. **[R4, R7]**
23. Kill and then `/reload` or switch/resume sessions. Verify ephemeral latches do not strand the new runtime, persisted queues remain cleared, and durable identities/mail/journals restore correctly. **[R3, R5, R7]**
24. Start manual compaction, invoke `/kill` while it is active, and verify the command does not falsely report complete if Pi remains busy. Then kill immediately before a threshold/overflow compaction and verify the pre-compaction guard cancels it. Record the already-active case as the documented Pi-core limitation. **[R6, R8]**
25. Inspect active processes after every child-process scenario and after Pi reload/shutdown. Verify no owned child `pi` or descendant remains and no timers keep the process alive. **[R2, R9]**
26. Inspect session/procedure storage after tests. Verify no agent/team registry deletion, mailbox loss, transcript deletion, journal deletion, stray temporary files, or unrelated state mutation. **[R5, R9]**
27. Review the final diff for only the files in this plan, update the project implementation note and reusable protocol note with actual verified results, and leave commit/push to a separate explicit request. **[R8, R9]**
