# Pi Swarm

Swarm coordinates persistent Pi workers around an approved objective. The main agent
starts and manages the run, workers claim tasks and files, and independent review plus
recorded verification determines completion. Loading, reload, inspection, and restoring
a saved run never authorize worker execution.

## Use through the main agent

Ask the main agent to start Swarm with your complete objective, inspect progress, pause,
restore a run, resume, restart, or reconcile interrupted work. It chooses sensible settings,
explains the objective and complete configuration in chat, and asks for your explicit
confirmation before starting. Swarm opens no confirmation dialogs.

1. The agent prepares a proposal with `swarm_start`. Inspection returns the full agreement;
   no run starts and no worker is dispatched.
2. Review the objective, criteria, scope/exclusions, selected coding tools and instructions,
   model/thinking level, provider/outbound context, integrations, existing files and limits.
   Ask for changes if needed; the agent must prepare a fresh proposal for revised settings.
3. Reply with exactly **`start`** as the entire message in the owning main chat to confirm
   the single current ordinary proposal (launch, resume, restart or configure). Only standalone
   lowercase `start` is accepted: no whitespace, punctuation or additional text. Other input,
   including `yes` or `confirm`, cancels the pending proposal rather than guessing your intent.
   Recovery and settlement retain their separate evidence-bearing replies described below.
4. The agent calls `swarm_start` again with **only** the returned `proposalId` (for lifecycle
   controls, only `action` and `proposalId`). This consumes one-shot
   authorization only after rechecking the exact configuration, workspace and host context.
   The tool returns after launch, before worker completion.

Proposal IDs are tool bookkeeping, not a command you must type. Only a real interactive
owner input can confirm; tool arguments, model output, transcript quotations, worker mail,
and extension/RPC input cannot approve work. The agent must wait for your reply, not infer
consent from the original request. While a proposal is pending, it must ask only its explicit
Swarm confirmation question, not unrelated questions. Native UI prompts cancel pending
confirmation. The reserved standalone `start` reply approves only the current Swarm proposal;
this question discipline is still required.

**`/swarm stop` is the only direct user command.** It immediately fences new work,
cancels pending approvals and worker requests, and aborts native Bash process trees
without an extra model call. It is recognized before focused dialogs and overlays:
type the literal command and press Enter, even while an independent Safety prompt is open.
The captured command appears in the status area; Escape cancels it. Pasting the command
still requires a separate Enter. Other `/swarm` arguments display guidance without
changing state. Immediate notifications distinguish a requested stop from established
settlement. Uncertain operations retain ownership; stopping never invents settlement
or kills the main Pi process or unrelated processes.

| Main-agent tool | Behavior |
|---|---|
| `swarm_start` | Prepares a chat proposal from `objective` and optional `criteria`, `scope`, `limits`, `codingTools`, `instructions`, `model` and `workerModels`. A later call with `proposalId` consumes actual owner chat confirmation and launches after revalidation. |
| `swarm_status` | Returns the run ID, bounded progress, workers, tasks and unresolved-operation counts; never wakes workers. |
| `swarm_control` | `pause` and `stop` act immediately. `resume`, `restart` and `reconcile` prepare fresh chat proposals, then consume confirmation with `proposalId`. `restore` requires `runId` and attaches paused; `reconcile` accepts `runId` for a crashed controller. `recover` prepares one guided agreement covering required recovery steps and optional continuation (`resume: false` by default); `configure` proposes user-requested model/thinking changes and applies confirmed settings between worker turns; `view` inspects; `send` delivers mail within an approved running run. |
| `swarm_history` | Reads bounded pages of worker history without constructing or waking workers. |

Existing work and Swarm changes are **kept by default**, without a disposition question.
Swarm performs no automatic stash, reset, discard, staging, commit or push. Disclosure does not make
unrelated existing changes part of the objective; conflicting or unclear work still needs
clarification. The objective is preserved in full. Defaults seed criteria and scope without
a model call; the main agent can choose settings appropriate to the task.

No affirmative reply means no execution. Chat proposals have no time limit: taking a break
before replying, or before the main agent consumes confirmation, does not expire them.
Confirmation is still single-use and bound to the owning session/project, host model and
thinking level, provider, mode, ownership, run revision and inspected workspace. Execution
revalidates the complete agreement and current workspace; changes invalidate it and require
a fresh proposal rather than replaying confirmation. Inspection, host approval callbacks and
independent Safety requests retain their separate bounded timeouts. Pause, stop, reload and
shutdown cancel pending proposals. Resume preserves allowances; restart explicitly
begins a fresh cycle. Neither undoes changes, and unsettled work blocks continuation.

Launch, resume, restart and recovery require the interactive main chat in a TUI. Print,
JSON and RPC contexts cannot supply approval. Checkout inspection and each approval
revalidation run without blocking the host event loop: Git is asynchronous and content
fingerprints run in a cancellable worker.
Git checkouts fingerprint tracked and non-ignored files plus Git control state, not entire
ignored dependency/build/worktree trees. The approval packet discloses this scope. Tracked
files remain covered even if an ignore rule matches them. Without Git, inspection retains
a full-directory fallback off-thread. Each inspection has a separate 120-second deadline and a 64 MiB Git output limit.
File lists are revalidated after hashing. Snapshot paths cannot follow replaced directory
symlinks. Git submodules are inspected with their own tracked/non-ignored file lists,
recursively; direct submodule mutations require a separate workspace.
Workspace attachment and receipt/candidate checks use the same nonblocking inspection.
Explicit edit/write targets are additionally fingerprinted even when ignored; fresh-read,
claim and immediate pre-edit checks remain mandatory. Explicit target observations survive
controller reload through the recorded operation receipts. Ignored files changed indirectly by
shell commands are not globally detected: receipts are observations of this scope, not proof
that ignored content was unchanged. Shell authorization is still required. Stop, shutdown and
reload cancel pending admission inspection without granting authority; scoped changes still
require fresh approval. Post-execution settlement observations remain bounded and are not
aborted merely because execution was cancelled, so receipts can record its effects.
Independent Safety requests remain bounded by their confirmation deadline. A refusal or
timeout does not start an automatic retry.

Failed main-agent tool calls return a constant, safe diagnostic with the failing phase
and an error code. Inspection timeouts and output limits are distinguished from user
cancellation; approval, attachment and storage errors can be identified without disclosing
filesystem paths, credentials, provider responses or raw exception text. Failures never
approve work or start an automatic retry.

## Compact observations and allowances

Default status contains no rolling message bodies. `budgets` separates retained worker
identities, cycle task creations (not task count), native turns, assigned tasks and known
queued worker wakeups. Missing runtime queue/native information is `null`, not zero.
Duration uses authoritative reducer `elapsedMs` at `sampledAtMs`: running, verifying
and draining states charge active time at journal events. Unsampled time since that event
is not included. Paused time is not charged; `deadline: null` deliberately avoids an
unconditional wall-clock deadline or speculative exhaustion estimate.

`swarm_status { warningThreshold: 0.2 }` warns when remaining/allowed is at most that
fraction. The default is 0.2, validated range 0–0.5; this is presentation only and never
changes persisted limits, permissions, admission or auto-extension. Exhausted fields name
the admission they block. Task `failureAllowance` counts settled failed/rejected attempts,
not successful assignments or SDK retry calls; `pendingSettlement` can mean the next
failure charge has not yet occurred. Recorded worker usage is exposed separately and cost remains unknown,
not a measured zero or subscription/API-price estimate.

Status caps workers at 8, tasks at 10 and assigned IDs per worker at 20, with explicit
truncation flags. `swarm_history { channel: "tasks", offset: 50, limit: 10 }` retrieves
additional task detail; `taskId` selects a task. Message and native-history pages remain
available explicitly with `channel: "messages"` or `workerId`, `offset` and `limit`
(1–20). Message/transcript text is capped at 2000 characters and marked when truncated;
full messages remain in the journal and read-only view. Inspection never wakes workers.

Ordinary send returns the durable operation/revision receipt and compact safety/budget
state, not unrelated history. `persisted` means recorded mail. `dispatch: "enqueued"`
and `enqueuedRecipients` report wakeups admitted to the queue at send time, not eventual
execution; subsequent pause/stop can cancel them. `dispatch: "not-enqueued"` reports
no admitted wakeups (for example, pause/stop interleaving after persistence). Neither
state is **worker acknowledgment** (`acknowledged: false`). Unknown
operation outcomes and unsettled execution remain visible; receipts do not prove success
of worker work or grant continuation authority.

## A fresh objective in the same chat

After the attached run is **stopped, completed or failed and fully settled**, ask the
main agent for another bounded objective using `swarm_start`. No `/clear`, metadata
removal or restart of old work is needed. Running, paused, draining or unsettled runs
cannot be replaced. The owning session must still match, persistence and ownership
must be certain, and SDK queues/turns, operations and coordination claims must be idle.
Recover uncertain execution using the evidence-bearing controls below first.

The proposal names the previous run and discloses **fresh worker contexts**: the new
objective uses a new run ID and new native worker sessions, not old worker conversation
contexts. Prior journals, native history, main-chat cards and workspace changes remain
intact. New defaults copy the current main selection and stay pinned in that proposal.
Inspection or rejected approval never closes the prior driver or changes its journal.
Only a fresh standalone `start` reply and exact-context revalidation authorize transition.

Failures remain fenced, without replay or automatic rollback. If opening new storage
fails, the prior attachment/history remains available; status identifies the attempted
new run and transition stage. A proven fresh creation that never published a controller
or dispatched workers releases only its own reservation on failure, retaining its journal.
Changed ownership or an ambiguous pre-existing reservation (even with the same run ID) must be
recovered, not removed or bypassed. Retry requires a new proposal and approval. If new
storage opens but SDK attachment fails, the new run stays attached without authority;
stop it through the main agent or `/swarm stop`, then propose again, or use a fresh
recovery agreement. The latest durable main-session run link is used on reload;
reload never dispatches either objective.

## Requirements and optional integrations

Use managed **Pi 1.0.4** and **Node 22.19+**. Linux is the verified runtime and PTY test
platform. Storage avoids POSIX-only ownership checks and directory fsync on Windows;
Windows terminal/process behavior has not been verified by this test run. Journal
paths are checked independently of OS no-follow flags before reading or writing. Native Windows end-to-end behavior remains unverified. Bash must be
available for the native Bash tool. Git is optional: Swarm does not initialize repositories
or edit ignore files. Existing project files and Git changes are disclosed and fingerprinted.

- With **pi-plan**, the current mode must be ready and Off. Without a responding provider,
  a gate that has never observed one treats the mode as Off. A provider appearing later
  revokes existing approval; disappearance, duplicate responses and malformed responses
  fail closed.
- With **pi-safety**, worker writes, edits and commands still use its confirmation bridge.
  Its independently configured policy may display operation dialogs or deny requests;
  chat approval does not bypass it. A fully dialog-free run is therefore incompatible with
  Safety settings that require dialogs; Swarm does not silently change those settings.
- Without a Safety provider, your explicit chat approval authorizes the selected worker
  coding tools under the disclosed bounded run policy, not per-operation Swarm prompts.
  Objective/scope, limits, current-task admission, claims, fresh reads, serialized mutations,
  exclusive Bash access, submodule read-only boundaries and settlement safeguards remain.
  These are cooperative controls, not an OS sandbox. Losing a previously observed Safety
  provider or receiving malformed/duplicate claims denies access rather than falling back.

Swarm imports Pi and Node APIs, with no runtime imports from sibling packages. Normal
package loading uses the current public Pi model registry, physical model and thinking
selection. By default the Swarm copies the main-agent model and thinking level when preparing its
launch proposal. Workers inherit this pinned default unless individually overridden.
Later main-chat model/thinking changes neither change nor pause the Swarm.
Main-selection events alone also leave pending pinned proposals intact; the unrelated
input/dialog cancellation rules above still apply. Changes to the actual approved worker
model metadata or provider implementation still fence execution. Pi owns
credentials, OAuth and provider routing; the displayed endpoint is informational.
No credentials are copied into run records. Provider context includes the
objective, instructions, workspace content, tool results, history and compaction summaries.

## Independent model and thinking settings

Ask the main agent to select a different Swarm default or settings for individual workers.
It may recommend alternatives, but must ask the user before applying a change; a model's
own recommendation does not authorize it. Defaults copy the main chat only at launch,
not continuously. All selected models must be physical chat models in Pi's existing
catalog, with a supported thinking level. Credentials and provider routing stay with Pi.

`swarm_start` accepts partial `model` settings and `workerModels` entries:

```json
{
  "objective": "Implement and independently review the requested feature",
  "model": { "thinkingLevel": "high" },
  "workerModels": [
    {
      "workerId": "reviewer",
      "selection": { "provider": "example", "modelId": "review-model", "thinkingLevel": "medium" }
    }
  ]
}
```

The provider/model in this example are placeholders, not installed models. Missing default
fields copy the main chat; missing override fields inherit the resolved Swarm default.
Overrides may name future worker IDs, so a later recruited reviewer gets its approved
settings without another model choice. Every effective selection and provider/context
disclosure appears in the agreement before any worker request. Status reports show the
Swarm default, overrides, and each worker's effective settings.

For a cost-conscious team, the main tool's planning guidance recommends low thinking
and a cheaper default for routine inspection, extraction, documentation and bounded
test work. Reserve stronger per-worker overrides for complex implementation, debugging
and independent review. Check `pi --list-models` first; catalog availability varies.
For a catalog containing these models, a proposal can include:

```json
{
  "model": { "provider": "openai-codex", "modelId": "gpt-6-luna", "thinkingLevel": "low" },
  "workerModels": [
    { "workerId": "implementer", "selection": { "modelId": "gpt-6.1-sol", "thinkingLevel": "low" } },
    { "workerId": "reviewer", "selection": { "modelId": "gpt-6.1-sol", "thinkingLevel": "low" } }
  ]
}
```

Use the exact planned worker IDs. This is proposal guidance, not automatic routing:
the approved choices stay pinned, unavailable models are not silently substituted,
and the role-to-model mapping is disclosed before `start`. Existing runs retain their
recorded settings. Higher thinking can be proposed separately when task difficulty
justifies it. OpenAI describes Luna as the cost-efficient choice for focused work
and Sol as suited to complex technical work in its
[model-selection guide](https://developers.openai.com/api/docs/guides/model-selection)
(checked 2026-10-08). Actual account usage depends on the provider and plan; this
policy does not assume API pricing equals subscription usage.

To change settings in an existing running or paused run, the main agent uses
`swarm_control` with `action: "configure"` and `model` and/or `workerModels`. Partial
`model` fields update the pinned default. `workerModels` replaces the entire override
list; omit it to preserve overrides, or use `[]` to clear them. Non-overridden workers
follow the Swarm default; overridden workers keep their explicit settings.

Configuration prepares a fresh agreement and uses the same owner-chat confirmation
protocol as launch. New worker starts wait while existing native turns, edits, commands,
retries and compaction finish normally; they are not aborted to change models.
Configuration preserves worker identity/history, task state, claims, cycle and allowances.
A running run stays running and a paused run stays paused. Stop and policy revocation
still fence execution; unknown or orphaned operations require reconciliation rather
than treating silence as settlement. A failed or cancelled proposal grants no settings
change. If applying a recorded change fails, execution is fenced rather than continuing
under stale SDK settings. Reload/restore recovers the recorded settings independently
of the main-chat selection and never resumes automatically. Legacy single-model journals
remain readable.

## Submodule workspaces

A parent checkout may contain clean or dirty Git submodules. Inspection recognizes
Git index gitlinks and fingerprints the indexed commits, checked-out HEADs, each
initialized submodule's tracked/non-ignored contents, and Git control state. Nested
submodules use their own Git scopes, up to 32 levels. Dirty-to-dirty file edits are
covered by content hashes, not just status flags. Every repository's file list and
status are revalidated after hashing under the same inspection deadline and cancellation.
Ignored dependency/build trees remain excluded in each repository.

Missing or empty uninitialized submodules are recorded without fetching or initializing
them. A nonempty directory without checkout metadata, aliased checkout, or unexpected
directory in a regular file scope fails closed. Arbitrary nested repositories are not
automatically treated as submodules.

Workers may read ordinary submodule files, including instructions. Parent-workspace
claims, edits and writes into submodules are denied, including missing checkouts and
Windows case aliases. To change submodule files, use a separate Swarm workspace rooted
at that submodule. Bash remains a cooperative, host-authorized operation, not an OS
sandbox: shell commands must not bypass this boundary. Non-ignored submodule effects
are included in before/after receipts; indirect ignored-file effects remain outside
coverage. No submodule commits, resets, updates or cleanup are performed by inspection.

## Workers and safeguards

Workers use Pi's native `read`, `edit`, `write` and `bash` definitions, schemas, rendering,
file queues and cancellation. Swarm wraps execution with current-task and admission checks,
file claims, explicit policy approval, serialized mutations, exclusive Bash access and
durable before/after receipts. Existing files must be read after acquiring their claim
before editing or overwriting; creating a missing claimed file does not require a failing
read first. Claim identities use workspace-relative forward slashes on every platform;
Windows case aliases share a claim without changing the path spelling used for IO.
Traversal, outside-workspace drive/share paths and filesystem aliases remain denied.
Mutations recheck the fingerprint after approval. Native read options and Bash
timeouts are preserved. Receipt IDs are returned alongside native tool output.

Exclusive shell, candidate and review requests fail **before queuing** when another
assignment retains file claims. They never revoke that assignment's ownership or block
its next edit while waiting for those claims. Release idle claims and coordinate a quiet
verification window; do not retry-loop behind a peer who still needs to edit. Admitted
exclusives remain FIFO and block new mutations; own already-admitted mutations drain first.
Main and worker status show bounded claim owners, task IDs, operation purposes and stages
(queued, Safety approval, inspection, execution, settlement or unknown settlement), without
commands or target paths. Cancellation is only a request until the callback/process settles.

A refused or timed-out worker approval fences further writes/edits/shell requests for that
assignment/cycle/generation without reopening Safety. Guidance updates do not clear that
fence; reads, idle claim release and an honest yield/handoff remain available. New authorized
continuation never replays the denied operation. Independent Safety remains authoritative.

Candidate receipt rejection retains `EVIDENCE` with a precise reason: missing receipt,
wrong kind/task/assignment/cycle/generation, changed guidance, unsuccessful outcome/exit,
or stale before/after/current fingerprints. Exit zero does not preserve freshness across a
later creation or edit. Rejected reports do not produce candidates or leak queued locks;
fresh current verification may recover. Investigations/planning use messages and yield,
not fabricated verified candidates. Every later workspace mutation invalidates old evidence.

Pi's default retries and automatic compaction are enabled; cache warming is off. Admission
is checked on initial requests, tool follow-ups, retries and compaction summaries. An
exhausted retry sequence counts as one task failure. Pausing aborts retries/compaction and
waits for Pi to settle. Authoritative run state is supplied each worker turn.

Defaults are eight worker identities, four active assignments, 100 tasks per cycle, three
failed/rejected attempts per task and 60 minutes of active cycle time. Resume preserves
allowances; an approved restart begins a new cycle. Usage/cost are not yet aggregated.
These are cooperative controls, not an OS sandbox or protection against outside writers
and commands that deliberately detach processes. Native Bash owns process cancellation;
unknown custom-runner outcomes require explicit reconciliation and are never replayed.

## Conversations and agent navigation

Swarm uses Pi's existing agent indicator and **Alt+N** navigation when
`pi-status-line` is loaded. It joins the same cycle as Teams and Subagents.
**Escape** returns to the main chat. Independent Safety dialogs dismiss the focused view;
main-agent work continues in the background. Ask the main agent to open the view
(`swarm_control`, action `view`) when the status-line package is not loaded.

**Alt+N initially opens the general Messages overview**, with no message editor.
It does not open the focused worker's transcript or draft. Messages, Agents and
Topics remain read-only; **Steer** is the only page with messaging.

- **Messages:** inter-agent mail and main-agent exchanges, not the native worker
  chat transcript. Tool calls/results and internal context stay out of this view.
- **Agents:** the main agent and worker roster, live activity, focus and assigned
  tasks. Each worker shows its effective approved model/provider and thinking
  level, including worker overrides. These are the run's recorded settings, not
  the main chat's current selection; unavailable metadata is labeled explicitly.
  Enter opens read-only agent mail, without an editor. Agent mail and Steer also
  show the selected worker's model/thinking above its history when space allows.
- **Topics:** task discussions and named conversation topics in compact rows,
  with status badges, explicit message counts and participant summaries. The
  selected topic reveals its latest message and any title shortened to fit the
  row. Enter filters Messages using the original topic identity; `q` returns to
  Topics and `a` shows all messages again. Selection stays on the same topic
  during live updates.
- **Steer:** select a worker and press Enter to see its native Pi user/assistant
  transcript, tool calls/results and activity, with a visibly bordered multiline
  message editor. This is distinct from agent mail. Selecting main returns to
  Pi's main chat.

Use `1`–`4`, Tab, or `h`/`l` to switch tabs; `j`/`k` or arrows select agents and
topics or scroll messages. PageUp/PageDown scroll, `/` searches literally, `n`/`N`
move between matches, and `f` follows new messages. `q`/Escape closes or returns
from agent mail in the inspection dashboard. On the focused **Steer** worker page,
text and ordinary keys belong to the message editor instead: **Enter sends**, **Tab**
switches panes, **PageUp/PageDown** scroll history and leave follow mode,
**Ctrl+End** returns to the latest transcript and resumes following, **Escape**
returns to main, and **Alt+N** selects the next agent. Steer opens at the latest
transcript and follows additions until you scroll history; ordinary `f` remains
editor text. Slash commands and `!` drafts move to the main editor
without executing; press Enter there to run them. Agent mail is text-only; image paste
is rejected. Native focus/cursor handling and multiline input are preserved.
Transcript replay shows finalized active-branch messages plus working/queued
activity, not token-by-token streaming or partial tool results. Attachments use
text-only placeholders; opaque tool metadata is excluded.

Sending uses the same guarded host path as main-agent mail and requires the current
owned, running, approved Swarm. It can wake the recipient within that approved run;
opening or navigating the view never dispatches work. Pending sends cannot be submitted
twice. Paused, stopped or unowned runs cannot send. Drafts survive agent and page
switching and failed/unavailable sends for the same run;
feedback appears beside the editor. Delivery uncertainty is reported without automatic
retry. Drafts are in-memory only and do not survive reload or a new run. The generic
`swarm_control` inspection dashboard remains read-only. Lifecycle controls go through the
main agent, and `/swarm stop` remains the sole direct command.

The main agent sends mail with `swarm_control { action: "send", to, text, topic? }`.
Use a worker ID for a direct message, or `to: "@board"` with a topic for a team
board. Worker `swarm_message` accepts peer IDs, `@main`, or `@board` with a topic.
Board messages reach peers once each, excluding their sender. `main` and `board`
remain convenient aliases when no worker has that name; explicit `@` recipients
always address the coordinator or board and never shadow an existing peer. Worker conversations
inherit their assigned task as a topic when no topic is supplied. Candidate/review
reports also appear in the main chat with their task topic; they still require independent
review and final verification before completion. Messages never grant approval.

Main-chat conversation cards are rendered, non-context session entries: they are
visual-only and add no model input, including on later prompts or reload. There is no
Swarm progress status row; important failures and stops remain passive user notifications.
Actionable messages addressed to main still use Pi's native message queue and wake it
while Swarm is running. That delivery is hidden from the chat and provides the text the
model needs to respond; it is separate from the visual card and still uses model context.
Explicit Swarm tool results also supply requested information to the model. Legacy visible
mail remains readable without adding duplicate cards. Pausing/stopping never requests a
turn for routine progress. Mail is acknowledged only after a complete native message entry
exists in the main session file; a visual card alone never proves delivery to the model.
Interrupted deliveries remain available after reload; durable mail is not repeated. The
next user input or worker event retries pending mail without using chat text as approval. `swarm_history { channel: "messages", workerId?, topic?,
offset?, limit? }` reads bounded conversation pages without waking workers. Full
message text remains available in the user view and run journal.

History inspection reads live in-memory branches when available, so it does not
reopen or rewrite active worker session files. Loading a view never starts a worker.

## Storage and recovery

State lives beside Pi's project sessions, keyed by project and run:

```text
<agent-dir>/sessions/<Pi cwd slug>/swarm/
  reservation.json
  controller.lock/owner.json
  <run-id>/events.jsonl
  <run-id>/sessions/<native-Pi-session>.jsonl
```

The append-only journal retains its sequence checks and hash chain to detect corruption
or incomplete writes. A reservation prevents another run from taking the project while a
run is paused. The controller lease records its owning session and PID. Leases never expire
or get stolen automatically. Worker tools are the only Swarm operations that write to the
project itself; run state and recovery metadata remain outside it.

Ask the main agent to restore a known run ID in any later session in the same project.
Restore takes exclusive ownership and attaches **paused**, without worker requests. Saved
worker model settings are independent of the main-chat selection. Resume requires a fresh
agreement and workspace reconciliation.
Reload discovers the active-branch run link but never resumes execution automatically.

### Managed SDK storage hot-reload limitation

On managed Pi 1.0.4, pure `.mjs` native dependency exports can survive `/reload`
even when the extension and controller are freshly loaded. After a storage-module
upgrade, Swarm's stale-runtime guard returns `RUNTIME_STALE` before launch approval
or storage creation, rather than continuing with incompatible exports.

Cold-exit Pi, then run `pi --session <same-session-file>` from the same project directory to retain the same main chat
and history with a fresh module cache. Never clear the chat or delete run, lease,
reservation or session metadata to work around this error. Workers never resume
automatically; continuation still needs its own fresh approval. The first new
objective also needs fresh approval. Subsequent objectives A and B can use the same
process once the preceding run is fully settled; no per-objective restart is needed.
This is a narrow SDK hot-reload limitation, not a normal run-transition requirement.

### One guided recovery agreement

Ask the main agent to recover a known run. It uses `swarm_control` with
`action: "recover"`, the saved `runId` (optional when already attached or linked), and
optional `resume: true`. The default recovers without dispatch. Recovery is not restart:
cycle, elapsed allowance, limits, objective, worker identities/history and pinned model
settings are preserved.

The first call reads the validated saved journal, reservation, previous lease and current
workspace without acquiring/releasing a lease, repairing storage, appending events or
starting workers. It presents one complete agreement containing the required stages,
previous owner/PID, interrupted operations/turns, saved settings/provider disclosures,
remaining allowances and chosen outcome. The main agent must explain that agreement.

Independently establish that all listed prior execution has stopped, then confirm once:

- **Recover without dispatch:** `I confirm recovery: <independent settlement evidence>`
- **Recover and resume:** `I confirm recovery and resume: <independent settlement evidence>`

Generic `start`, `yes`, the old settlement-only phrase, tool arguments, worker mail and quoted
history cannot approve this combined plan. The main agent consumes the confirmed proposal
with only `action: "recover"` and `proposalId`; it cannot alter the outcome during consumption.

Execution revalidates workspace, journal, reservation, lease identity, ownership and policy
before side effects. It performs only needed stages: stale lease release, paused restore,
durable settlement attestation/reconciliation, and optionally continuation under the
same approved settings. No second confirmation is requested for those disclosed stages.
Unknown command effects remain unknown and commands are never replayed. Native live
frames must actually settle before continuation; a timeout retains fencing and does not
prove settlement. Resume cannot renew exhausted allowances or override a saved stop/fail
intent. Recovery without dispatch preserves that intent even when its settled status is
stopped or failed rather than paused.

On partial failure, tool/status results identify completed recovery stages, the blocked
stage, whether ownership is held and whether workers are running. Earlier successful
stages are not rolled back or retried automatically. Inspect the resulting state and use a
fresh agreement for any subsequent attempt. Stop, cancellation and policy/context changes
revoke pending authorization; loading/reload never continues recovery automatically.

Stale lease release still requires the **original owning Pi session**. Missing/foreign
recorded owners, live controller PIDs, changed leases or corrupted journals refuse recovery;
there is no automatic takeover. If the original session is unavailable, this feature does
not authorize deleting its lease metadata. Read-only inspection does not repair incomplete
journal writes or migrate legacy runs.

### Individual recovery controls

The existing controls remain available. If a crashed controller's lease blocks restore,
reopen its **original owning Pi session** and ask the main agent there to reconcile that run ID. Lease release is refused from other
sessions or when the recorded owner is missing/unknown, including legacy leases. There is
no automatic takeover; recovery when that session is unavailable remains a user-only/manual
design question, not permission to remove lease metadata or bypass fencing.

The chat proposal identifies the previous session and PID. Independently establish that the
old process **and its commands** have stopped, then reply in the owning main chat:
**`I confirm settlement: <how you independently established settlement>`**. Plain `start` or
`yes` is insufficient for recovery. Missing PID, timeout or silence alone is not evidence of
settlement. A live PID or changed lease refuses release. The reservation and journal are
retained. Restore again, then reconcile any journaled interrupted operations with the same
explicit evidence-bearing chat attestation. Reconciliation does not resume execution;
request and confirm a fresh resume/restart proposal afterward. Unknown effects remain
unknown; reconciliation does not manufacture success or replay them.

Runs from the former project-local `.swarms/` layout cannot be restored by this version.
They receive a specific legacy-run error and are left untouched. No automatic migration
or deletion occurs.

## Implementation map

| Modules | Responsibility |
|---|---|
| `extension.mjs`, `main-tools.mjs` | Main-agent tools, stop-only slash command, context fencing and host lifecycle |
| `host.mjs`, `host-gates.mjs`, `ui.mjs`, `recovery-inspection.mjs` | Agreement disclosures, optional integrations, bounded run policy and guided read-only recovery inspection |
| `core.mjs`, `state.mjs`, `*-state.mjs` | Journaled controller, pure reducers, task/session/workspace state |
| `sessions.mjs`, `sdk-session.mjs`, `native-provider.mjs` | Native Pi sessions, host runtime selection, retries/compaction admission |
| `session-tools.mjs`, `workspace.mjs`, `workspace-scheduler.mjs`, `workspace-files.mjs` | Native tool wrappers, claims, receipts and read-only fingerprints |
| `store/` | External layout, durable files, journal and explicit lease recovery |
| `dashboard.mjs`, `focus.mjs`, `composer.mjs`, `transcript.mjs`, `progress.mjs` | Read-only mail inspection, Steer transcripts/composer and event-driven notices |

## Verification

Tests resolve the managed installation automatically. `PI_SDK_DIR` overrides the SDK
package directory; `PI_BIN` overrides the JavaScript CLI entry, **not** the managed shell
launcher. Tests do not install dependencies, read personal credentials, or contact live
providers. Disposable agent directories and projects isolate state. The shared PTY
`test/terminal/packet.py` helper reconstructs VT viewport cells from diff redraws, waits
for a fresh no-execution/confirmation footer, pages the fullscreen transcript to the
current proposal header and verifies every original agreement line/value against rendered
pages before owner input. Offline result metadata is only a comparison oracle, never consent.
Pi 1.0.4 uses plain PageUp/PageDown for fullscreen transcript paging, not editor
Ctrl+PageUp/PageDown; Ctrl+End returns to output. Fixture settings explicitly select
fullscreen with `fullscreenScrollbar: "always"` in disposable agent settings only,
so body geometry is deterministic rather than using the default auto-hidden track.
`test/terminal/packet_test.py` provides pure offline capture regressions,
also indexed by `test/terminal-packet.test.mjs`. It discovers Python3 (including Windows
`python3.10`); `SWARM_TEST_PYTHON` selects a test interpreter. No interpreter is installed.

```bash
npm --prefix packages/pi-swarm test
python3 packages/pi-swarm/test/terminal/run.py
python3 packages/pi-swarm/test/terminal/production.py
python3 packages/pi-swarm/test/terminal/native.py
python3 packages/pi-swarm/test/terminal/entry.py
python3 packages/pi-swarm/test/terminal/entry.py --package-root
python3 packages/pi-swarm/test/terminal/entry.py --storage-reload
python3 packages/pi-swarm/test/terminal/focus.py --composer
```

`entry.py --storage-reload` runs only an isolated offline storage regression: it
warms old native storage exports inside real Pi, restores current disposable sources,
uses `/reload`, and checks fail-closed storage admission plus a successful paused
cold-process open and stop/settlement without workers. It prefers the repository's
managed `agent/bin/pi` wrapper; when unavailable it uses the verified `pi_cli()`
JavaScript entry via Node and reports the launcher used. Diagnostic sources and
privacy-safe tool diagnostics (never raw exceptions or stacks) stay in the disposable fixture.
It also warms the pre-change `errors.mjs` allowlist, verifies that its direct mapping
would return generic `FAILED`, and requires the actual rendered main-tool output to
retain the static `RUNTIME_STALE` restart instruction.

Unit/integration checks cover native coding, fresh-read/claim/permission guards,
retries, automatic compaction, fencing, exactly-once task failure, bounded run policy,
chat proposal/owner-confirmation binding, cross-session restore, legacy refusal and explicit
lease recovery. POSIX PTY checks exercise real main-agent tools and interactive owner
chat confirmation with offline scripted models, plus independent Safety policy dialogs. The fixture-only
`/fixture-swarm` command in some harnesses drives the registered main tools; it is never
registered by the production package. No paid/live-provider trial is part of these checks.

On Windows, `scripts/swarm-wsl-test.sh --pty` tests the current worktree inside WSL.
Read the script's prerequisites first. It retains a unique test checkout and logs under
`~/swarm-runs/`, without replacing prior runs. This verifies Linux behavior, not Windows.

The separately authorized [bounded live trial](test/live/README.md) remains opt-in;
its default invocation is a dry run. Historical live outcomes are not validation of
this migration, and no live provider request is part of the completion checks.

## Low-usage workflow

The repository defaults the main Pi model to `gpt-6.1-sol` with medium thinking.
Swarm choices remain explicit and pinned through the normal `start` agreement;
no model is silently substituted. For bounded work, propose `initialWorker` with
`id`, `specialization` and `brief` to start one implementer immediately. Recruit
an independent reviewer after the candidate settles. Omit it for the legacy
planner entry. Use `workerModels` to reserve Sol/low for difficult implementation
or review; do not create a third planning worker merely to forward instructions.

At an idle, stopped/settled objective boundary, `/swarm prepare` uses Pi's public
compaction API to preserve current constraints and unresolved safety state while
summarizing old coordination. It refuses running/unsettled work and pending
approval/input. Status exposes `ownerContextTokens` and recommends preparation
at 40,000 tokens. This command does not start or resume any workers.

Prefer `swarm_wait` over shell sleep/status loops. It subscribes to settled task,
guidance, lifecycle, ownership and safety transitions, ignoring clock ticks and
routine counters. Its bounded timeout is not completion or settlement evidence;
return control instead of polling. A local journal watcher can monitor without
any model calls; see the project observations guide.

Worker status returns 20 compact task rows with explicit detail access via
`swarm_tasks` (offset/limit or taskId for candidate/review details). It excludes
rolling messages, repeated approved scope, candidate receipts and review bodies.
Stable system instructions retain the full approved objective/scope/criteria;
current guidance remains complete in each turn. Incoming direct and board mail
is delivered in full, in batches of at most 10 messages and about 32k text
characters (one full maximum-size message always fits). Only admitted message
IDs can be acknowledged; remaining mail is queued after successful settlement.
No failed/interrupted turn causes an automatic mail retry.

### Worker usage budgets

Optional launch `limits` fields are `modelRequests`, `uncachedInputTokens` and
`outputTokens` (positive integers). `workerModelRequests`,
`workerUncachedInputTokens` and `workerOutputTokens` apply separate allowances
to each worker rather than the aggregate. Exhausting any configured worker cap
fences new run requests; peers already executing still settle normally. They appear in the inspected agreement and
persist in the journal. Existing journals without these limits remain readable;
the limits are opt-in and never silently added to an existing run.

`usage` reports admitted requests and measured input/cache/output per worker for
the current cycle. Owner/Codex usage and historical requests predating the ledger
are excluded. Missing response usage remains unknown; reasoning is already in
output and is not counted twice. The Agents page displays the recorded counters.
The existing presentation warning threshold applies to aggregate usage budgets.
Per-worker near-limit warnings use a 20% remaining threshold; UI notifications
are emitted once per near/exhausted transition without model wakeups.

The SDK gate covers initial logical calls, follow-ups and SDK retry invocations.
Transport-level HTTP retries are not separately measured. Request caps are
admission caps; an admission recorded before a later dispatch failure is still
charged conservatively. Token ceilings are checked after response measurement
and before another request, so in-flight responses can exceed a token ceiling.
They are not a preflight billing estimate or a strict stream-output limit.

On exhaustion, new requests are fenced and admitted commands/other turns settle
normally before the run pauses. Resume cannot clear exhausted/unknown allowance.
An explicit approved restart resets current-cycle counters; a fresh objective
gets a fresh allowance. Durable events remain preserved. Unresolved/missing
response usage fences token-limited continuation rather than assuming zero.
Automatic compaction does not grant extra allowance or bypass these checks.
