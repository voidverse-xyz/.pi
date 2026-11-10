# pi-subagents

Background fan-out workers for Pi with a strict hub-and-spoke model: subagents
can report to the main agent but cannot spawn, inspect, or message peers.

## Worker context selection

Main selects `contextMode: "auto" | "focus" | "fork"` when spawning a worker. Auto
is the default: prefer copied main chat strictly below 30% context usage, otherwise
prefer focused role/task context. Unknown usage defaults to focus. Explicit focus
or fork overrides the preference at any percentage.

Fork copies one snapshot of the active, compaction-aware conversation after context
edits, then appends the new assignment. No model call prepares a summary. The worker
keeps its own system instructions, identity, tools and permissions. Completed calls
are historical, unfinished calls are excluded, and old approval text grants no consent.
Explicit fork requires readable canonical main history.

Only new workers are seeded. Reusing an address preserves existing memory regardless
of a later contextMode; use a new ID for a new fork. Taskless forks save their history
before receiving work and survive reload. Spawn returns contextMode as fork, focus or
existing. Copied parent usage is excluded from worker token/cost/turn totals while
native context estimates remain intact. Token/cache savings have not been measured.

The helper is bundled under this package's `extensions/subagents/context/` directory.
This package has no runtime dependency on either other extension or the parent repository.
The repository maintains identical copies from a canonical source; installing this
package alone includes everything needed for context selection.

## Main-agent tools

- `subagent_spawn` — create or wake a typed or ad-hoc worker
- `subagent_send` / `subagent_steer` — assign follow-up or in-flight guidance
- `subagent_await` — join one, several, or all open assignments
- `subagent_cancel` / `subagent_retire` — stop a turn or permanently archive an agent
- `subagent_status` — inspect the owning-session `ownerScopeId`, roster, vitals, open tasks, and transcript tails

Every one-shot spawn requires a non-empty `task`; it runs once and retires after
its final report. An ad-hoc `prompt` defines the worker's role and does not count
as its assignment. Taskless creation remains available for persistent workers
that will receive work later through `subagent_send`.

Explicit `subagent_await` targets must refer to a currently open assignment or a
retired agent. Unknown address/anchor pairs fail immediately with guidance to
use the anchor returned by `subagent_spawn` or `subagent_send`.

## Await outcomes and scope

Capture the `taskEnvelopeId` returned by a spawn with a task, or the `envelopeId`
returned by `subagent_send`, and await that exact `{ to, anchorId }` pair.
Omitting targets snapshots all currently open assignments.

`subagent_await` returns terminal entries in `outcomes`: `completed` includes a
final report, `error` includes an agent error, and `retired` means the target
agent disappeared. A timeout leaves unresolved assignments pending; it is not
completion. A final waiting/blocked report consumes its anchor. Answer through
`subagent_send` and await the new envelope ID, not the consumed anchor.

Terminal results cover only the assignments consumed by their executing turn.
Assignments arriving during execution belong to a later turn. An explicitly
empty terminal-anchor set resolves no assignment; legacy unscoped errors retain
compatibility handling without widening modern results to every sender task.

Mutable agent state belongs to one owning main session. The opaque `ownerScopeId`
remains stable through reload/resume but changes for a new or forked session.
When continuity matters, persist and verify that identity; do not silently
recreate a missing persistent agent or adopt a different session's memory.

## Delivery and completion

Tool results use compact JSON. A successfully delivered `report { final: true }`
ends the worker's automatic follow-up only when every tool result in that batch
also terminates; progress reports and failures never terminate. One-shot
retirement is armed only after durable report delivery.

Idle completions coalesce for 300 ms from the first event (later arrivals cannot
extend the deadline). User input or a new run cancels that wake. Mail is consumed
only after its envelope IDs appear in the persisted host transcript, not when
Pi's void `sendMessage` returns. Failed/interrupted deliveries remain pending;
subsequent lifecycle/mail events or session resume retry them. Persisted
injections are not repeated merely because inference failed afterward.

## Display labels

`subagent_spawn` requires the LLM to provide a concise, task-specific `label`.
The ambient widget, roster picker, and viewer use that label instead of exposing
an anonymous address such as `adhoc/tmp-a1b2c3d4`.

A persistent agent keeps the label from its first creation. Later get-or-create
spawns cannot silently rename it. Labels persist in the session-scoped registry
and retirement marker, so they survive restart and remain visible for archived
agents. Pre-label tool calls receive a deterministic compatibility label before
validation; old registries and archive markers without labels still load.

## Activity widget

While agents are working, the above-editor tree shows one row per agent:

```text
 2 running · 1 waiting · 󰇮 3 · alt+a stop
├─ test runner ·  10 tools ·  12k tokens ·  18%
│  └ Bash: npm test
└─ source scout ·  3 tools ·  8.1k tokens ·  11%
   └ Read: src/index.ts
```

Metric semantics:

- **tools** — exact tool executions started during the current mail-driven turn;
- **tokens** — cumulative Pi session tokens for that subagent;
- **context** — current model-context fill on Pi's 0–100 percent scale, or `?`
  before Pi can calculate it.

Current-tool text follows `tool_execution_start`/`tool_execution_end`. Before any
provider-visible thought arrives, the row shows `thinking…`; afterward it keeps
the latest thought visible as `<thought> · thinking…` while the model continues.
At ordinary widths, the label is truncated before metrics. At narrow widths the
widget moves all three metrics to a compact second row so telemetry remains
visible.

The `/subagents` picker and full-screen viewer also show labels, compact token
counts, and corrected context percentages. `alt+a` stops all working subagents
without retiring them.

## Verification

Run the strict typecheck and all standalone harnesses:

```bash
./test/e2e/run.sh
```

## Keyboard agent navigation

With `pi-status-line` loaded, **Alt+N** cycles through subagents and team agents,
then back to the main chat. **Escape** also returns to main. The footer shows the
available count; the focused full-screen view shows the selected agent and its
position. **PageUp/PageDown** scroll its transcript. Live main-agent work continues
in the background. Opening a native dialog returns focus to main.

The focused editor sends text mail only to the selected agent: dormant persistent
agents wake and busy agents queue it. One-shot workers remain subject to their
normal retirement rules; unavailable recipients report a delivery failure. Drafts
are retained while cycling, and failed mail is retained for retry when reopening
the agent. Images are unsupported and are explicitly rejected. Paste text using
your terminal's text-paste command. Commands beginning with `/` or `!` return to
the main editor as a draft; press Enter there to execute them normally.

Packages communicate through plain-data events and remain independently loadable.
Without `pi-status-line`, the existing roster command and viewer remain available.
Session changes, reload, and shutdown release navigation listeners and views.
