# pi-agents — persistent subagents with mailbox communication

A Pi extension that gives the main agent a roster of **persistent subagents**:
long-lived identities with durable memory (each one is a REAL Pi session JSONL
stored beside the project's own sessions, resumable by Pi itself), addressed
as `<type>/<id>` and owned by one main Pi conversation. Independent Pi sessions
in the same cwd have isolated rosters, memory, teams, and mail. Agents are
connected only through **disk-backed mailboxes** with a
single envelope contract (`message | question | answer | report | escalation |
error`). Mail never interrupts a running turn; questions never block (the
asker goes dormant and the answer wakes it with its question quoted back);
teams scope which peers may talk; everything destructive escalates to the
human. Design docs are authoritative:
`Configs/Subagent-Docs/` (00-design-log.md,
01-power-matrix, 02-envelope-contract, 03-tool-surface, 04-type-schema,
05-tui-spec, 06-architecture).

## Install / enable

1. Add this package's **absolute path** to `~/.pi/agent/settings.json` →
   `packages[]` (kept alphabetical), e.g.
   `"<shared-config>/PiAgent/packages/pi-agents"`.
2. `/reload` in a running Pi session (or restart Pi — shortcuts register on
   start).
3. Author at least one type definition (below), then ask the main agent to
   spawn it, or watch it decide to on its own.

## The eight main-agent tools (03-tool-surface)

| Tool | Power |
|------|-------|
| `subagent_spawn` | Get-or-create `<type>/<id>` (existing = wake, memory intact; `created:false`). `team` joins/creates a team; `lifetime:"oneshot"` = disposable (auto `tmp-<short>` id — oneshots never take an explicit id); `task` = first message and returns `taskEnvelopeId`. Task-bearing calls join the current user-turn completion barrier unless `background:true` |
| `subagent_send` | Mail to an agent and return `envelopeId`: send (`when:"now"`), queue (`when:"after-turn"`), answer (`correlationId` = the question's envelope id). Uncorrelated sends join the completion barrier unless `background:true`. Never interrupts a running turn |
| `subagent_steer` | Inject into a RUNNING turn (main-agent-only; `steered:false` if idle) |
| `subagent_status` | Roster (state, lifetime, teams, vitals: ctx %, tokens, cost, turns) or per-agent detail + transcript tail. Read-only |
| `subagent_collect` | Sends a collect request carrying a JSON schema and returns `requestId`; the result is validated on arrival. The tool call itself is non-blocking, but the current user turn waits unless `background:true` |
| `subagent_await` | Cancellably wait for a final report correlated to `taskEnvelopeId`/`envelopeId`, or a collect result correlated to `requestId`. Searches pending/parked/finalized durable mail; questions/escalations/errors return generation-fenced `attention`; timeout consumes nothing |
| `subagent_interrupt` | Abort the current turn; agent stays alive, goes dormant |
| `subagent_retire` | The ONLY destructive tool: deregister, scrub from teams, move the dir to `.archive/` (post-mortem viewable, GC'd after N days) |

**Subagent-side tools** (injected per session, address pinned by the runtime):
`send_message` (peer send/queue; `expectReply:true` = question,
`correlationId` = answer), `report` (progress, or `final:true` — a oneshot's
final report retires it; collect results ride `data` + `correlationId`), and
`ask` (non-blocking question to main). Plus the type-filtered, sandbox-wrapped
coding tools (`read/bash/edit/write/grep/find/ls`).

## Type definitions (04-type-schema)

A type is a markdown file with YAML frontmatter; the body is the system-prompt
role text. Discovery (project wins on name conflict):

```
<project>/.pi/subagents/<type>.md    # repo-shipped
~/.pi/agent/subagents/<type>.md      # global personal library
```

```markdown
---
name: refactorer                # required, must equal the filename stem
description: Refactors code within a defined purview   # required; written for the LLM choosing types
model: anthropic/claude-opus-4-8   # optional; omit = inherit the session's model
thinking: medium                # optional; omit = inherit
projectContext: true            # include AGENTS.md etc. (default true)
tools: [read, grep, edit, bash] # allowlist; omit = all coding tools
readOnly: false                 # true strips every mutator (beats tools/writePaths)
writePaths: ["src/auth/**"]     # mutations outside → escalation to the human
denyPaths: ["migrations/**"]    # beats writePaths
maxTokensTotal: 500000          # whole-life warning thresholds (optional)
maxTurnMinutes: 15              # warnings never stop the agent
maxContextCompactions: 3
---

You are a refactoring specialist. You own a specific purview of the codebase.
```

Frontmatter is **type-fixed** (D19): spawn carries only instance identity
(`id`, `team`, `lifetime`, `task`) — need a variant, write another type file.
Types are live-resolved at wake: editing a `.md` retunes every instance at its
next wake (memory persists, constitution is live). Type definitions must be
independent regular files; symbolic links and multiply-linked files are ignored
so an agent cannot retune its constitution through an unprotected alias path.

## Teams (D12)

Membership lives in `teams.json`, not the path: sub→sub mail is allowed iff
sender and recipient share ≥1 team (out-of-team mail bounces with an error
envelope). A teamless agent is a solo worker — reverse channel to main only.
Spawn with `team:` to create/join; retire scrubs membership; roster changes
arrive in the affected agents' next wake digest.

## Lifecycle (D13)

Unlimited existence, capped concurrency (`maxConcurrent` turn slots; extra
turns queue, visibly). `dormant` = asleep with open mailbox and intact
memory — the normal end-of-turn state. **Persistent** agents are never
auto-retired. **Oneshots** ("named = persistent, anonymous = disposable")
auto-retire after their final report or a fatal runtime error; warning thresholds never retire them. The dir moves
to `.archive/<type>/<id>/` and stays viewable until GC (default 7 days).

Mutable state is owned by the current main Pi session; project type libraries
and settings remain shared. `/reload` and `/resume` restore the same scope;
`/new` starts empty; `/fork` starts empty and shows an explicit non-inheritance
notice. The same persisted session cannot have two live host consumers.
Non-persisted host sessions permit oneshots only and use temporary state.

State on disk, beside Pi's own sessions:

```
~/.pi/agent/sessions/<cwd-slug>/subagents-by-main-session-<cwd-digest>/
  owners/<main-session-id>/
    scope.json  autonomy.json  registry.json  teams.json
    .main/mailbox/  .main/escalations/  .archive/
    <type>/<id>/{<ts>_<uuid>.jsonl, mailbox/, files/}
```

Older cwd-wide state is never silently assigned. Close other Pi processes and
run `/agents adopt-legacy` to copy it into the current persisted session while
retaining an inactive backup. `/agents rollback-legacy` restores that backup only
while the adopted scope remains unchanged; after divergence, export/recover
manually rather than guessing at a merge. Host and per-agent ownership markers
include process-start identity so PID reuse cannot strand a scope or agent.
Retirement archives memory and scrubs teams before deregistration publishes the
address as reusable; startup completes any crash-interrupted funeral.

## Safety model (D10/D20/D21)

- **Approvals never flow downhill.** A guarded tool call outside the type's
  write scope (or an unclear mutating bash command) blocks the agent in
  `waiting` and raises an **escalation**: a record for the human (TUI modal)
  plus an escalation envelope to the main agent. The human can approve-once
  or deny(+note); the main agent can only DENY — by replying with
  `correlationId` = the escalation envelope's id (its text becomes the note
  the failing tool returns). Repeat escalations are fixed by editing
  frontmatter, never by session-wide grants.
- **Implicit system denials**: no agent can ever write the subagents state
  tree or any type-definition dir (self-retuning / mail forging), realpath-
  anchored against symlink tricks. Path-qualified shell executables never
  inherit trust from a safe basename; they require human review.
- **Rails** (D21): session thresholds (`autonomousTurns` /
  `autonomousTokens`) emit one warning per user-input accounting window;
  **maxHops** (default 8) still terminates question ping-pong. Thresholds never
  pause, abort, retire, or queue otherwise-runnable work. Counters persist in
  the owning session scope and reset on genuine user input.
- **Per-agent thresholds** (D15): per-type (frontmatter) or global (settings)
  `maxTokensTotal` / `maxTurnMinutes` / `maxContextCompactions`. Crossing emits
  a targeted warning while the agent continues. Token totals are **whole-life**:
  cumulative across wakes and session-file rotations (persisted in registry
  vitals). Only a human interrupt, explicit retirement, fatal runtime error, or
  host shutdown stops work.

## TUI (05-tui-spec)

- Plain compact status producer: `󰚩 2 running · 1 waiting · 󰇮 3 · 󰔛 budget
  21/40` (Nerd Font icons; non-zero segments only; hidden when idle).
  `pi-status-line` styles and places it on footer line 1-left; tool-monitor moves
  to line 2 while it is visible. The timer-sand means threshold consumption,
  not a pause. Crossing a threshold opens a persistent non-blocking widget for
  the affected agent: `alt+ctrl+x` interrupts only that agent's current turn;
  `alt+ctrl+i` dismisses the warning and lets it continue.
- `/agents` — compact roster picker shown in the main input area, grouped by
  team (`Enter` view, `x` interrupt, `X` retire with confirm, `Esc`), with a
  collapsed `.archive (n)` section. Selecting an agent opens its full-screen viewer.
- `/agents <type>/<id>` — jump straight into the session viewer.
- `/agents adopt-legacy` — human-confirmed assignment of inactive cwd-wide
  state into the current empty persisted session scope.
- `/agents rollback-legacy` — restore the inactive backup only if the adopted
  scope's fingerprint has not diverged.
- `alt+j` — cycle main → agent 1 → … → main through the full-screen viewer
  (Pi-native transcript replay + live tail; envelope traffic as compact Nerd
  Font `󰇮` entries). The input line is the agent's *user*: `Enter` mails at the turn
  boundary, `alt+Enter` steers mid-turn, `x` (empty editor) interrupts.
  Direct user→subagent messages drop an FYI report to the main agent.
- `alt+e` — review pending escalations in a compact prompt at the main input:
  `a` approve once, `d` deny, `D` deny with note, `v` view the session,
  `Esc` keep queued.

## Settings

Extension settings live in their **own JSON sidecar files** (Pi's
settings.json schema is closed; this mirrors the pi-plan-commit convention),
merged field by field:

```
~/.pi/agent/subagents.json      # global
<project>/.pi/subagents.json    # per-project overrides
```

```json
{
	"maxConcurrent": 5,        // D13 running-turn slots (applies at session start / reload)
	"maxHops": 8,              // D21 chain-depth cap
	"autonomousTurns": 40,     // warning threshold since last user input
	"autonomousTokens": 500000,
	"archiveGcDays": 7,        // retention for .archive/, mailbox .done/, resolved escalations
	"maxTokensTotal": null,    // optional global warning defaults (frontmatter overrides
	"maxTurnMinutes": null,    //   per type; null/omitted = no warning)
	"maxContextCompactions": null
}
```

Main mail never auto-wakes an idle host. A real user turn drains queued mail;
required task results instead continue the same main run through the completion
barrier. Questions, escalations, provider waits, peer delegations, interruptions,
and missing finals stay joined. Set `background:true` only for an intentional
explicit detachment.

Files are re-read at every real user turn, so edits apply **live** (only
`maxConcurrent` waits for the next session/reload). Unknown keys and bad
values are ignored with warnings, never fatal. Retention GC (archive, `.done`
mail, resolved escalation records) runs automatically on session start.

## Tests

```
cd packages/pi-agents
bash test/e2e/run.sh
```

One command: strict typecheck (tsc — resolved from PATH or installed
on demand into a temp dir via `npm install typescript`; pin with `TSC=...`),
then the phase 1–7, lifecycle, runtime, and session-scope/await harnesses plus
the Pi extension-loader check. The harnesses
use the jiti-alias pattern with a scripted mock LLM provider — real
AgentSession turns, **no network, no real model**. Prereqs: node ≥ 22 and a
global pi install (set `PI_SDK_DIR=/path/to/@earendil-works/pi-coding-agent`
if it lives somewhere unusual). Individual files run standalone:
`node test/e2e/phase7-full-story.mjs`.

## Design docs

`Configs/Subagent-Docs/` — the design log and six specs (01–06) are the source
of truth; deviations are marked `// DEVIATION:` in the source. For a visual,
dark-mode tour of the complete current system, open
`Configs/Subagent-Docs/pi-agents-current-implementation.html`.
