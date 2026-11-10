# pi-plan

Host-managed Discuss, Plan, and Quick modes for Pi. Off remains the normal unrestricted coding agent.

## Modes

| Mode | Response behavior | Main-agent tools |
|---|---|---|
| **Off** | Normal Pi behavior | The exact tool set that was active before entering a restricted mode |
| **Discuss** (`󰍩`) | Normal response length and structure | Quick tools plus trusted `ask_user` and `show_files` |
| **Plan** (``) | Read-only work, plus saving a Markdown plan document | trusted read/UI/session tools, `save_plan`, and scoped read-only `subagent_*` tools |
| **Quick** (`󱐋`) | Quick chat, normally 1–4 short sentences | trusted built-in `read`, `grep`, `find`, `ls` only |

Quick's length rule is a host-injected prompt rule, not a provider-level token cap. The tool restrictions are host-enforced with both active-tool filtering and a default-deny `tool_call` guard.

## Usage

- `/discuss` — toggle Discuss mode; `/discuss <message>` enables it and sends the message.
- `/plan` — toggle Plan mode.
- `/plan <task>` — enable Plan mode and send the task.
- `/quick` — toggle Quick mode; `/quick <message>` enables it and sends the message.
- `/discuss|plan|quick on|off|exit|toggle|status` — explicit mode control.
- `Shift+Tab` — cycle `Off → Discuss → Plan → Quick → Off` at any time.

Mode controls are accepted while the agent is running. Selecting a different mode aborts the old run so its prompt and tool policy cannot carry into later work; the latest selection is persisted and becomes effective after `agent_settled`. If the user submits ordinary interactive input or an RPC `prompt` during that short transition, `pi-plan` holds it and starts it as a fresh top-level turn after settlement. Multiple held messages start one at a time on successive settled turns, and an item remains queued until its replacement run reaches `agent_start`. A busy `/discuss <message>`, `/plan <task>`, or `/quick <message>` follows the same fresh-turn boundary. A newer mode request cancels an older waiting command task. Explicit RPC `steer` and `follow_up` operations retain their native meaning and are not rerouted.

Routine mode transitions are silent because the footer already shows the selected next-turn state. Invalid-command errors, deferred-input notices, queued-task cancellation notices, and explicit `status` responses remain visible.

Every provider request receives an authoritative current-mode prompt block, including native custom-message/mail wakeups. In Off mode, that block disables only pi-plan's Discuss, Plan, and Quick restrictions, marks earlier mode claims as historical, and preserves every other current instruction, safety policy, and active-tool restriction.

The selected mode, authorized Plan path, and Plan-spawned subagent scope are persisted as branch-local session state. Reload, resume, fork, and `/tree` restore state from the active branch; legacy `{ enabled: boolean }` Plan entries migrate to `plan` or `off`. A new session starts Off.

While a restricted mode is active, `pi-plan` publishes its plain mode label under the legacy-compatible `plan-mode` status key. `pi-status-line` renders that dedicated footer segment.

## Inter-extension mode bridge

Other trusted extensions can observe mode authority through the public `pi.events` bus; no package-internal imports or session-entry parsing are needed:

```ts
pi.events.on("pi-plan:mode-changed", (snapshot) => { /* invalidate stale permissions */ });
pi.events.emit("pi-plan:query-mode", {
  version: 1,
  respond(snapshot) { /* called synchronously before emit returns */ },
});
```

Both channels supply the same read-only snapshot shape:

```ts
{
  version: 1,
  instanceId: string,
  revision: number,
  contextRevision: number,
  ready: boolean,
  sessionId: string | null,
  selectedMode: "off" | "discuss" | "plan" | "quick",
  enforcedMode: "off" | "discuss" | "plan" | "quick",
  runMode: "off" | "discuss" | "plan" | "quick" | null,
  pendingChange: boolean,
}
```

`instanceId` is unique to the extension instance. `revision` starts at zero and increases on coherent observable changes; duplicate publications are silent. `contextRevision` starts at zero and increases on every branch/session restore and at shutdown, even when the mode stays Off. Ordinary Off run start/end changes `revision`, not `contextRevision`, so consumers can distinguish harmless run bookkeeping from approval-invalidating context changes. Reload and session replacement recreate the extension and therefore change `instanceId`.

`ready` is false before the first restore and from the beginning of shutdown. `sessionId` is null before restore; `runMode` is null when no run is latched. Restore uses `session_start` and `session_tree`. Mode changes publish synchronously before the mode-change abort request; pending transitions retain the old run's enforced mode. Settlement publishes the coherent final state, including overlapping preflights and custom-turn fallback starts.

Consumers requiring unrestricted mode must require a ready snapshot for their current session, **both selected and enforced modes Off**, and no pending change. Missing, malformed, unsupported, or stale responses must not grant permission. Bind approvals to the instance/session/context epoch and revoke on restrictive snapshots or epoch changes; becoming Off again is not renewed approval. Queries validate `version: 1` and a callable `respond`, and never persist state or change mode. This cooperative bridge is not a security boundary against other installed extensions.

## Plan instructions

Plan mode does not tell the agent how to plan and does not load a planning skill or template. Its host-injected instructions cover only the mode boundary, the enforced tool policy, Plan-subagent limits, and how to save through `save_plan`. Ask the agent to follow whichever planning guide applies, such as a shared planning document.

## Tool policy

Entering the first effective restricted mode snapshots the current active tools. Moving between Discuss, Plan, and Quick re-filters from that same snapshot; returning Off restores it exactly, except `save_plan` remains disabled outside Plan. A mode selected during a run does not change that run's tools or guards; reconciliation happens only after the run settles.

Every allowed tool must match its expected Pi built-in or local-package provenance, so a colliding custom tool cannot gain access merely by registering an approved name. A default-deny `tool_call` guard remains authoritative if another extension activates a tool after the mode begins.

### Discuss

Discuss enables Quick's read-only tools plus the trusted local `ask_user` and `show_files` tools. It cannot mutate, run shell commands, save plans, or delegate.

### Plan

Plan enables:

- always: `read`, `grep`, `find`, `ls`, `save_plan`;
- when they were active before restriction: `ask_user`, `show_files`, `todo_write`;
- from the trusted local `pi-subagents` package: `subagent_spawn`, `subagent_send`, `subagent_steer`, `subagent_await`, `subagent_cancel`, `subagent_retire`, `subagent_status`.

Plan delegation is narrower than ordinary `pi-subagents` use:

- `subagent_spawn` rejects typed agents, explicit ids, and persistent lifetime;
- every accepted spawn is normalized to a fresh ad-hoc one-shot worker with coding tools exactly `read`, `grep`, `find`, and `ls`;
- the worker address is added to branch-local Plan state only after a successful newly-created spawn result;
- send, steer, cancel, retire, detailed status, and explicit await targets may reference only those Plan-created addresses;
- `subagent_await` requires explicit targets, so it cannot consume unrelated open work;
- teams and procedures remain blocked.

One-shot workers also receive only the subagent runtime's `report` companion tool; they cannot spawn nested agents or message peers.

`todo_write` changes only the session checklist and remains available so Plan mode can track and clear complex planning work without granting project-file mutation. Bash, general mutation tools, teams, procedures, and unknown custom tools remain unavailable to the main agent.

These are agent-tool guards, not an operating-system sandbox. They do not prevent user-entered `!` commands, manually invoked slash commands, subagents that were already running before a restricted mode began, other extension background work, or external processes from changing the workspace. Static symlinks are rejected for plan saving, but a concurrent external filesystem actor can still race path-based Node filesystem operations; use a read-only container or mount when that threat is in scope.

### Quick

Quick enables only Pi's trusted built-in `read`, `grep`, `find`, and `ls`. It cannot mutate, run shell commands, use companion UI tools, or delegate.

## Saving a plan

`save_plan` is the only project-file mutation allowed in Plan mode. The model chooses a project-relative Markdown path from the project's instructions and conventions and asks the user only when those do not determine a path.

Before the first write, Pi asks the user to authorize the exact path. That authorization is bound to both the canonical project root and relative path and remembered on the active session branch; changing projects or paths asks again. An authorized existing plan is atomically replaced with the complete revised document. RPC confirmation has a two-minute timeout; JSON and print modes fail immediately because they have no UI.

The tool fails closed when confirmation UI is unavailable and rejects:

- absolute paths and `..` traversal;
- targets outside the project;
- non-`.md` paths;
- symlink targets or symlinked parent directories;
- non-regular existing targets;
- empty plans and plans larger than 256 KiB.

Writes use Pi's shared per-file mutation queue and an fsynced same-directory temporary file. Existing plans preserve their permission bits and are replaced by rename; new paths use a create-only hard link so a file that appears after authorization is never silently overwritten.

## Shortcut requirement

This global setup reserves `Shift+Tab` for mode cycling by remapping Pi's built-in thinking-cycle action to `Alt+T` in root `keybindings.json`. Without that companion remap, Pi treats `Shift+Tab` as a reserved built-in shortcut and skips the extension shortcut; the slash commands remain available.

## Tests

```bash
node --test \
  packages/pi-plan/extensions/plan/mode-bridge.test.ts \
  packages/pi-plan/extensions/plan/mode-lifecycle.test.ts \
  packages/pi-plan/extensions/plan/policy.test.ts \
  packages/pi-plan/extensions/plan/prompts.test.ts \
  packages/pi-plan/extensions/plan/save.test.ts
```

Factory-level bridge tests use the real public SDK event bus and stubbed host handlers, without starting a session or calling a model. With the package's SDK peers resolvable (or an installed-SDK resolution preloader), run:

```bash
node --test packages/pi-plan/extensions/plan/mode-bridge.integration.test.ts
```

An offline RPC `get_commands` smoke test should report `discuss`, `plan`, and `quick`, confirming that the package loads successfully.


## Stable request prefixes

Mode instructions are projected through the public `context_with_system` hook
into the leading system message's owned `pi_plan_mode` section. The extension
preserves other system sections, conversation history and tool declarations.
It does not use a transient `before_agent_start` forced-string replacement:
native mail wakes skip that hook after the SDK clears the forced run prompt.
That old path changed the cacheable prefix and omitted current-mode instructions
on custom wakes.

Unchanged mode instructions now produce a consistent prefix for ordinary input,
retries and native mail wakes. A real mode change intentionally
changes instructions; cache reuse must never preserve obsolete restrictions.
A cold Plan wake receives the same Plan instructions as an ordinary turn.

The managed-SDK regression exercises actual Swarm mail delivery and the real
Codex payload serializer, stopping at `onPayload` before headers/transport:

```bash
node --experimental-import-meta-resolve --import ./packages/pi-swarm/test/sdk-register.mjs \
  --test packages/pi-plan/extensions/plan/cache-prefix.integration.test.mjs
```
