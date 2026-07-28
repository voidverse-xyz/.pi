# Tool surface — what the main agent sees

Current Pi Subagents exposes seven hub-and-spoke tools. Subagents cannot spawn or message one another; the main agent is the sole coordinator.

## `subagent_spawn`

```text
(type?, prompt?, id?, label, lifetime?, task?, model?, thinking?, tools?)
```

- Use either a named type definition or an ad-hoc prompt.
- Typed agents default to persistent; ad-hoc agents default to one-shot.
- Persistent typed addresses are get-or-create on `<type>/<id>` and resume with memory inside the same owning main session.
- One-shot IDs are generated when omitted and auto-retire after their final report.
- `label` is required for the user-facing widget.
- An optional task returns `taskEnvelopeId`, the exact await anchor for that assignment.
- Model, thinking, and tool overrides apply only to ad-hoc agents; typed definitions own those fields.

## `subagent_send`

```text
(to, text) -> { envelopeId, delivery, disposition, ... }
```

The send never interrupts a running turn. It wakes a dormant agent or queues the assignment at a busy agent's turn boundary. `envelopeId` is the await anchor for this new assignment.

## `subagent_steer`

```text
(to, text) -> { steered }
```

Steering affects only the recipient's current running turn. It is a no-op when the recipient is not running; use `subagent_send` for a follow-up assignment.

## `subagent_await`

```text
(targets?: [{ to, anchorId }], mode?: "all" | "any", timeoutSeconds?)
```

- Omitting targets snapshots all currently open assignments.
- Top-level status is `completed`, `timeout`, or `empty`.
- Terminal per-target entries are returned in `outcomes` with status `completed`, `error`, or `retired`.
- `completed` contains the final report; `error` contains the agent error; `retired` means the target disappeared.
- `timeout` leaves unresolved assignments in `pending`; it consumes no pending result.
- A final waiting/blocked report consumes its anchor. Answer its question with `subagent_send` and await the new envelope ID rather than reusing the old anchor.

There is no collection mode or separate collection tool.

## `subagent_cancel`

```text
(to) -> { cancelled }
```

Cancel aborts the current turn without deleting the agent. Its triggering mail remains pending, so a later send can resume it.

## `subagent_retire`

```text
(to) -> { retired, archiveDir }
```

Retirement is destructive: it deregisters the persistent address and archives its state. One-shot agents normally retire themselves after their final report.

## `subagent_status`

```text
(address?, tail?)
```

Without an address, status returns:

```text
{ ownerScopeId, agents, count, openTasks }
```

`ownerScopeId` is a stable opaque fingerprint of the owning main Pi session. It remains equal across reload/resume of that session and differs for `/new`, forks, or another main session. Persist it when a workflow must prove that a persistent address still refers to the same session-scoped agent memory.

With an address, status returns that agent's details and recent transcript entries without perturbing it.

## Session and result rules

- Mutable agent state is scoped to one owning main Pi session. Reload/resume retains it; `/new` and forks start another scope.
- Capture each assignment's exact anchor and await it explicitly when its result is required in the current response.
- Treat timeout as pending and `error`/`retired` as non-completion.
- Questions are final waiting/blocked reports followed by a new send and a new anchor.
- Do not retire a one-shot before its report is delivered, and do not silently recreate a missing persistent agent when memory continuity matters.
