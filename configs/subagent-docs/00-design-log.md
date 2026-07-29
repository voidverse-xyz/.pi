# Pi Subagents Extension — Design Log

> **Historical — superseded.** This decision log preserves earlier designs and retired APIs. Do not use it as an active contract; use `03-tool-surface.md` and the current implementation note.

Working doc. One decision per entry, with rationale. Specs split into their own files as they firm up.

## Process
- Design first, build only on explicit go-ahead.
- One design question discussed at a time, in depth.
- Terminology: user says "agents"; docs/specs say "subagents".

## Decisions

### D1 — Clean slate (2026-07-09)
New design from scratch. Not an evolution of the existing pi-subagents extension
(delegate tool / guard.ts). Prior learnings (sandbox caps, outputSchema, /agents UI)
may be re-derived if they earn their place, but nothing is carried over by default.

### D2 — Subagents are persistent (2026-07-09)
A subagent is a long-lived identity with durable memory, not a fire-and-forget task.
It survives process restarts and accumulates history across runs.

### D3 — Project-scoped persistence, colocated with Pi sessions (2026-07-09)
Subagent state lives beside the main agent's sessions, in Pi's native session format:

```
~/.pi/agent/sessions/<cwd-slug>/
  <timestamp>_<uuid>.jsonl        # main agent sessions (Pi's own, untouched)
  subagents/
    <name>/
      <timestamp>_<uuid>.jsonl    # subagent session — REAL Pi session format (resumable by Pi)
      files/                      # non-session artifacts (notes, outputs, mailbox later)
```

Scope: per project dir (cwd-slug). Every main session in that cwd sees the same
persistent subagents with accumulated memory; other cwds don't. Rationale for
native Pi JSONL: debugging = open the session in Pi; persistence = append on wake;
format evolves with Pi for free.

### D4 (proposed) — <name> is a unique instance identity; type is metadata
Two same-type spawns (e.g. two refactorers) must be distinct instances — memory is
the agent, so identities can't be shared. Main agent must give each instance a
meaningful purview-based name (auth-refactorer, api-refactorer); agent.json carries
`type:`. The name doubles as the messaging address (`to: "auth-refactorer"`) and
the mailbox path. Auto-suffixing (refactorer-2) rejected: meaningless after a week,
un-addressable. Collision semantics leaning: spawn = get-or-create (re-spawning an
existing name wakes it, memory intact; result reports created: true|false);
fresh instance is the explicit rarer op. — collision semantics UNDECIDED

### D5 (proposed) — Two-level instance layout: subagents/<type>/<id>/
```
subagents/
  refactorer/
    auth/                # instance id = spawner-provided purview slug
      <ts>_<uuid>.jsonl  # sessions (Pi-native)
      files/
    api/
```
- <id> is a meaningful slug, never auto-numbered; defaults to `main` when omitted
  (singleton types: spawn(type:"docs-keeper") → docs-keeper/main).
- Address = "<type>/<id>" (e.g. refactorer/auth); mailbox path = address.
- Spawn = get-or-create on address; tool result reports created: true|false.
- Enumeration free: ls subagents/refactorer/.

### D6 (proposed) — Type definitions: markdown + YAML frontmatter, project/home discovery
A type is an authored .md file: YAML frontmatter for config (name, description,
model, tools, caps), markdown body = system prompt. Rationale: type defs are ~90%
prose; TOML multiline strings are miserable; matches .claude/agents/*.md convention.
TOML rejected. Discovery (project wins on name conflict, merged for listing):
```
~/.pi/agent/subagents/<type>.md      # global personal library
<project>/.pi/subagents/<type>.md    # repo-shipped types
```
Consequence: instances live-reference their type by name, resolved at wake — editing
a type .md retunes all existing instances on next wake (memory persists,
constitution is live). Record resolved type-file hash in instance state for
visibility. Supersedes the type.json-in-instance-tree sketch from D5 discussion.
Main agent authoring new types on the fly = just writing a .md — allowed? UNDECIDED

### D7 — In-process runtime v1, behind a SubagentRuntime interface (2026-07-09)
Subagents run as AgentSession loops inside the main Pi process via the SDK
(createAgentSession / SessionManager — all exported from the package root).
Surveyed alternatives: one-shot child `pi --mode json -p` (official example;
fire-and-forget, fights persistence), long-lived `pi --mode rpc` child per agent
(isolation + steering, heavy lifecycle), daemon hosting all agents (only route to
true offline auto-wake; most plumbing). Decision drivers:
- Session-viewer TUI: in-process gives direct AgentSessionEvent streams; Pi exports
  its real transcript components (AssistantMessageComponent, ToolExecutionComponent,
  SessionSelectorComponent...) so subagent sessions render exactly like Pi sessions.
- D3 layout: we control the Pi-native JSONL directly via SessionManager; dormant
  viewing = replay file, running = replay + live-tail. One code path.
- Sandboxing: wrap exported tool factories (createCodingTools et al) directly.
- Parallelism is adequate: agent time ≈ awaiting LLM; tools spawn own processes.
Trade-offs accepted: no crash isolation; agents only run while a main Pi session is
open → wake semantics are session-scoped by construction (mail queues on disk
otherwise). Mitigation/future: all runtime access goes through a small
SubagentRuntime interface (spawn/wake/send/kill/events) so an RPC-child or daemon
runtime is a swap, not a rewrite. Daemon = the future path to autonomous auto-wake.

### D8 (proposed) — Session-viewer TUI shape
/subagents command → picker overlay (type/id tree, status, last activity) →
full-screen viewer: JSONL replay + live event tail, key to cycle agents, Esc back.
Ambient main-session widget with running-agent count. Later: input box in viewer to
message/steer the focused subagent directly.

### D9 — "The main agent is the user of its subagents" (2026-07-09)
Governing principle for the interaction contract: don't invent an interaction
model — expose the surface a human user already has over a Pi session, as tools.
Full user-powers inventory (contract checklist):
1. send (new turn when idle; delivered on wake if dormant)
2. steer (inject mid-run)
3. queue (deliver after current turn) — steer-queue extension is prior art
4. stop, split three ways: interrupt (abort turn, stays alive) / suspend (dormant,
   mail queues) / retire (delete identity + memory; only destructive op)
5. observe without messaging: status (idle/running/waiting/dormant) + transcript peek
6. answer approval requests — subagent tool confirmations route to the main agent
   as its "user", with policy escalation of destructive classes to the real human.
   This decision defines the safety model.
7. answer subagent questions (ask_user-style → answered by main agent or escalated)
8. wake/resume dormant (mostly covered by get-or-create spawn)
9. retune mid-flight: change model / thinking level
10. compact a bloated long-lived session (user analog: /compact)
11. collect structured results (schema-conforming final output)
12. fork a session (Pi session trees; parked for later, don't preclude)
13. list/inspect the roster
Inverse channel is explicit: a real user watches the screen; the main agent instead
gets events (turn finished / question / approval request / error) delivered into
its context or queued for its next turn. Recursion: subagent→subagent communication
= sender acts as a limited "user" of the recipient. One interaction model everywhere.

### D10 — Trimmed power matrix (2026-07-09)
D9's full user-powers inventory reduced to the decided contract; full matrix lives
in 01-power-matrix.md. Highlights: main→sub gets 10 clean powers (spawn/send/queue/
steer/interrupt/status/list/collect/retire/answer); approvals inverted — type
frontmatter declares what's auto-allowed, anything outside escalates to the HUMAN,
main agent can deny or escalate but never grant; suspend deleted (dormancy is
automatic); retune/compact/fork deferred (compact becomes automatic runtime policy).
Sub→sub: send + queue ONLY — no steer/stop/spawn/observe. Sub→main reverse channel
is envelope types: report | question | escalation | error.

### D11 — Mailboxes only; mail never interrupts (2026-07-09)
Topology closed: v1 communication is point-to-point mailboxes only — exactly the
send/queue powers in the D10 matrix. No broadcast topics in v1; a topic can be
added later as a special address (e.g. topic/<name>) without breaking the envelope.
Delivery semantics: arriving mail NEVER interrupts a running turn — it always waits
for the turn boundary. Steering is a strictly separate, main-agent-only verb, never
an envelope side effect. Predictability over immediacy. (Supersedes the P1 bus/
topics sketch — bus/ dropped from the layout.)

### D12 — Teams: comm scoping as membership metadata, not path (2026-07-09)
Peer communication is scoped by TEAMS. Rejected: encoding group in the path
(subagents/{groupId}/{type}/{id}/) — ties durable identity to ephemeral grouping
(moving teams would orphan or duplicate memory), can't express multi-membership,
makes addresses group-relative. Decided:
- Layout unchanged (subagents/<type>/<id>/); membership lives in subagents/teams.json:
  `{"billing-refactor": ["refactorer/auth", "refactorer/api", "docs-keeper/main"]}`
- Comm rule: sub→sub send allowed iff sender and recipient share ≥1 team; runtime
  enforces at delivery — out-of-team envelopes bounce with an error.
- Teamless agent = solo worker: reverse channel to main agent only. No-comm is the
  safe default; teams are the explicit opt-in.
- Main agent organizes teams: spawn(type, id, team?) — naming a team creates it;
  list shows the roster grouped by team; disband = delete the entry (agents persist,
  just fall silent to each other). Multi-team membership allowed.
- Word choice: "team" (over group/task) — matches the org-chart metaphor; "task"
  rejected as it conflates work assignment with comm ACL.

### D13 — Unlimited existence, capped concurrency; one-shots as a lifetime flag (CONFIRMED 2026-07-09)
Count: no limit on existing (dormant = just directories). Running is capped by a
maxConcurrent setting (default ~5); spawns past the cap never fail — first turn
waits in a run queue (state: queued, visible in list/TUI); runtime drains.
One-shots: NOT a second mechanism — spawn(type, id?, team?, lifetime:
"persistent"|"oneshot"), default persistent. A oneshot is a full subagent (same
layout/session JSONL/envelopes/TUI) with: (1) auto-retire after final report or
error — not on collect; the report envelope in the main agent's mailbox survives
the agent; (2) relaxed naming — omitted id → auto `tmp-<short>` (D5's meaningful-id
rule is persistence-motivated); (3) retire moves the dir to subagents/.archive/,
GC'd after N days, so post-mortem viewing still works. One-shots may join teams.
CONFIRMED: auto-retire fires on final report/error — the oneshot never enters
dormant; the report envelope in the main agent's mailbox survives the agent, so
late collection loses nothing. Retire-on-collect rejected (dormant zombie clutter).
Clarified state model: dormant = asleep (roster entry, live address, open mailbox,
memory intact; the default end-of-turn state for ALL agents) vs retire = dead
(deregistered, address bounces, scrubbed from teams.json — empty teams deleted —
dir moved to .archive/ for N-day post-mortem). "Oneshot" is purely lifecycle
policy — every agent persists identically on disk; a oneshot is a persistent agent
with a scheduled funeral. Persistent agents are NEVER auto-retired.

### D14 — Questions are non-blocking; wake digest kills re-orientation cost (2026-07-09)
question envelopes never block: the asker ends its turn and goes dormant; the
answer arrives as mail that wakes it. No blocked loops; no deadlock when two agents
ask each other simultaneously. Re-orientation mitigations:
1. Session continuity (D3 payoff): wake ≠ cold start — the agent resumes its own
   continuous JSONL transcript; task, progress, and its question are already in
   context at the tail.
2. Wake digest: runtime composes the wake injection deterministically (no LLM):
   quotes each original question next to its correlated answer (correlationId
   lookup), then lists all other mail queued during dormancy, ordered and labeled.
   Agent never digs for what it asked.
3. Convention (type-def guidance, not machinery): before ending a turn on a
   question, jot a one-line checkpoint ("paused mid-X; next: Y").

### D15 — Context vitals in status/list; compact-first ladder before retire (2026-07-09)
In-process AgentSession exposes SessionStats/ContextUsage (SDK exports) — the
runtime reads each subagent's context fill, tokens, cost, turn count directly.
- status/list gain live vitals per agent: state, ctx %, tokens, cost, turns
  (shown in TUI picker too). "See the level" = observable fact, no new power;
  "retire at a level" composes with the existing retire power.
- Judgment ladder for high context on PERSISTENT agents (memory is the value —
  don't kill it to free context):
  1. auto-compact at threshold (~80%, runtime policy per D10);
  2. chronic saturation (≥2 compactions and climbing) → runtime sends main agent a
     report envelope — the judgment-call signal;
  3. main agent decides: retire / split purview into fresh agents / let it ride.
- Optional type-frontmatter hard ceilings (maxContextCompactions, maxTokensTotal):
  crossing emits an error envelope + interrupt; retire stays a main-agent decision
  (auto-retire on ceiling only for oneshots — no memory worth saving).

### D16 — Tool surface: seven intent-grouped tools; selective auto-wake for main (2026-07-09; tool count superseded by D26)
Rejected: one multiplexed subagent(action=...) mega-tool (sparse schema, weak
validation) and 10+ one-per-power tools (context bloat). Decided seven tools, full
spec in 03-tool-surface.md: subagent_spawn (task? = first message; get-or-create),
subagent_send (when: now|after-turn; correlationId covers answer), subagent_steer
(own tool per D11), subagent_status (roster+vitals or detail+tail), subagent_collect
(non-blocking; result arrives as report envelope), subagent_interrupt,
subagent_retire (own tool so Pi per-tool permissioning can gate the one destructive
power alone).
Main-agent mailbox rides Pi turn mechanics; when the main agent is IDLE, selective
auto-wake (option c): question | escalation | error auto-start a main-agent turn
with the wake digest (a subagent blocked on its "user" gets unblocked immediately);
plain report mail queues quietly for the next user turn, unread count shown as TUI
widget (📬 n). Config toggle to drop to fully-manual queueing. Mid-turn mail always
waits for the turn boundary (D11).

### D17 — User switching UX; direct user→subagent messages notify the main agent (2026-07-09)
Entry points (all land in the same viewer): /subagents → picker overlay (roster
grouped by team; state, vitals, unread per row; x interrupt, X retire-with-confirm);
/subagents <type>/<id> → jump direct; keybinding (alt+j; ctrl+j is the SDK's
built-in newline) → cycle main → agent
1 → ... → main. Viewer = full-screen session rendered with Pi's own transcript
components (replay JSONL + live tail), header strip with identity + vitals. NOT
read-only: input line sends as that agent's *user* (superuser row of the power
matrix), delivered under normal rules (turn boundary / wake). Esc back; main
session untouched — switching is purely a view change.
Transparency rule: when the user messages a subagent directly, the runtime drops an
FYI envelope to the main agent ("user messaged refactorer/auth directly: ..."),
queued as a plain report (no auto-wake per D16) — the orchestrator's mental model
of its workers never goes stale; user↔subagent traffic is never secret.

### D18 — Subagent context composition (2026-07-09)
Six fixed layers:
1. Pi base (real Pi session: system prompt, sandbox-filtered tools, cwd)
2. Project instructions (AGENTS.md) — default ON, type-frontmatter opt-out
   (projectContext: false)
3. Type body (role prose from the type .md; live-resolved at wake, D6)
4. Runtime identity block (deterministic): address, purview, team + teammate roster
   WITH purviews (roster is what makes peer messaging usable), comm powers,
   non-blocking-question + checkpoint conventions. Roster changes arrive as wake-
   digest lines.
5. Own session history (persistent JSONL; auto-compacted per D15)
6. Per-turn input: task/mail via wake digest (D14)
Deliberately NOT in context: main agent's conversation ("context by briefing, not
osmosis" — spawn task must carry the brief), other agents' transcripts (peers share
via messages; only main may peek), mail not addressed to it (a team scopes who may
talk, not a shared feed). Only config knob exposed: projectContext.

### D19 — Frontmatter is type-fixed; spawn carries only instance identity (2026-07-09)
projectContext (and every other frontmatter field) is decided by the type author in
the .md file — never by the main agent at spawn. Rationale: type-invariant config
belongs to the type (a researcher's irrelevance to repo conventions doesn't vary by
spawn); consistency with D10 (capability granted statically — main agent picks
types, doesn't tune them); same-type instances must behave identically (debuggable);
spawn tool schema stays lean. Doctrine: frontmatter = type-fixed; subagent_spawn
carries ONLY instance identity: id, team, lifetime, task. Need a variant → write
another type .md (visible, auditable) — same answer as permissions.

### D20 — Frontmatter schema settled; lifetime is spawn-only; denyPaths kept (2026-07-09)
Full schema in 04-type-schema.md. Fields: name, description (required; written for
the LLM choosing types), model, thinking (omit = inherit session), projectContext
(D18), tools allowlist, readOnly shorthand, writePaths, denyPaths, budgets
(maxTokensTotal, maxTurnMinutes, maxContextCompactions). User overrides to my
proposal: lifetime REMOVED from frontmatter (main-agent decision at spawn; type
files never constrain it) and denyPaths KEPT.
Side effects handled:
- Get-or-create × per-instance lifetime collision: dissolved by tightening D13 —
  oneshots NEVER take an explicit id (always auto tmp-<short>). Rule: named =
  persistent, anonymous = disposable. Lifetime mismatch impossible by construction.
- Type-intent drift (throwaway type spawned persistent): accepted; description
  advises, list/retire keep it fixable.
- Path precedence: readOnly > denyPaths > writePaths > default-cwd; real-path
  resolution before checks (symlink defense).
- Bash hole: path sandboxes extend to bash via mutation heuristics — mutating
  commands not provably inside writePaths → escalation envelope (fails safe:
  false positives become human decisions, not silent writes).
- Implicit system denials (non-overridable, all agents): the subagents/ state tree
  (mailboxes, sessions, teams.json, registry) and type-definition dirs — otherwise
  an agent could rewrite its own type .md (self-granted privilege escalation) or a
  teammate's mailbox (forged mail).

### D21 — Runaway protection: autonomy budget + chain hops + pause-never-kill (2026-07-09)
Per-agent budgets (D15/D20) cap single agents; these rails cap INTERACTIONS —
loops of many small legal turns (ping-pong questions; unattended auto-wake
cascades survive per-agent caps while the system spins).
1. Autonomy budget (master rail, shape-agnostic): autonomous subagent turns use
   one session pool since the user's last message: autonomousTurns: 40 and
   autonomousTokens: 500k; user input resets it. D24 later exempts main-agent
   mailbox wakeups from this pool.
2. Chain hops (kills ping-pong early): envelope field `hops` = parent.hops + 1
   when a message-triggered turn sends a message; fresh work = 0. maxHops: 8 per
   causal chain; over-cap envelopes bounce with "8 rounds unresolved — report to
   the main agent instead" (failure converts to escalation upward).
3. Pause, never kill: tripping destroys nothing (mailbox design payoff) — agents
   finish current turn and go dormant, mail queues on disk, TUI banner + 📬 count;
   next user message / resume keypress refills and drains. False trip costs one
   keypress → defaults can be conservative.
Placement: extension settings (global, per-project override) — NOT type frontmatter
(system properties, not type properties). hops added to envelope contract.
Known limitation: a "productive-looking" loop (real tool work in circles) only hits
rail 1, and no rail can tell useful circling from useless — human-attention reset
is the actual answer.

### D22 — TUI spec confirmed (2026-07-09)
Full spec in 05-tui-spec.md. Four components: ambient footer widget (running/
waiting/📬/budget segments, non-zero only, hidden at zero agents), /agents
picker (team-grouped rows + .archive section; Enter/x/X/Esc), full-screen viewer
(header vitals, Pi-native transcript replay+tail, envelope traffic as distinct 📨
entries, superuser input line), escalation modal (approve-once/deny/deny-with-note/
view; waiting = async pause awaiting tool result).
Confirmed judgment calls: (1) viewer input Enter = mail at turn boundary,
alt+Enter = steer — keyboard mirrors the send/steer tool split; (2) approve-once
ONLY, no session-wide grants — repeat escalations are fixed by editing type
frontmatter, keeping D10's static-policy model intact.

### D23 — Package architecture + build order (2026-07-09)
Full spec in 06-architecture.md. packages/pi-subagents/ per monorepo conventions.
Modules: runtime/ (SubagentRuntime interface + in-process impl + scheduler),
store/ (layout.ts owns EVERY path; registry/teams/archive), typedefs/, mail/
(envelope/mailbox/deliver/digest), rails/, sandbox/, context/, tools/, tui/.
Structural rules: core.ts facade — tools/tui never import the runtime impl (D7
swap-point kept structurally; the interface mirrors the power matrix — the matrix
IS the API); store/layout.ts is the single path authority; digest/paths/hops/
parse/compose stay pure for unit testing, e2e harness (jiti-alias pattern) covers
wiring. Build order: 1 data layer → 2 one-agent-runs → 3 mail → 4 teams+rails →
5 sandbox → 6 TUI → 7 polish. Phases 1–3 usable, 4–5 safe, 6 pleasant.

### D24 — All-mail main auto-wake; abort-latched user control (2026-07-12)
Supersedes D16's selective main-mail wake policy and narrows D21's pool scope.
Every envelope type sent to main auto-wakes it when idle; mid-turn mail waits for
`agent_settled`. Any main run ending with `stopReason: aborted` durably latches
mailbox auto-wake off across reload/restart until the next interactive/RPC user
input. Pi exposes the aborted
result but not its source, so Esc and programmatic aborts are intentionally treated
the same. Main mailbox turns neither consume nor obey the subagent autonomy pool;
D21 turn/token budgets continue to govern subagent turns. `autoWake: false` remains
an explicit fully-manual override.

### D25 — Main-session-owned mutable state (2026-07-12)
Supersedes D3's cwd-wide ownership while retaining its Pi-native JSONL and
project-colocation decisions. Project type definitions, settings, trust, cwd, and
context remain shared resources; registry, agents, teams, mailboxes, escalations,
autonomy counters, and archives are keyed by the stable owning main Pi session ID.
Reload/resume restore the scope; new/fork start empty (fork visibly discloses
non-inheritance). One host-scope lease prevents two processes from consuming the
same session. Non-persisted sessions are temporary and oneshot-only. Older
cwd-wide state is never auto-assigned; `/agents adopt-legacy` is a human-confirmed,
backup-retaining migration into one empty persisted session. A human-only
`/agents rollback-legacy` restores the backup only while the scoped fingerprint
is unchanged; divergence requires export/manual recovery.

### D26 — Anchored durable await/join and cancellation-aware retirement (2026-07-12)
The main tool surface grows to eight with `subagent_await`. Spawn/send/collect
return envelope anchors; final reports persist `payload.final:true`. Await matches
an anchored final or correlated collect report, returns early for questions,
escalations, and errors, and consumes nothing on timeout/cancellation. Main-mail
digest and await delivery share an atomic claim-first `.delivering` protocol and
finalize only after the host JSONL contains envelope ID plus delivery marker.
Manual retirement quietly audits pending owner/user messages instead of bouncing
them back as cleanup noise, but still bounces peer mail so peers cannot strand.
Delegated review completion must not be claimed before the anchored report is
received; verdict/findings precede orchestration details.

### D27 — Current-turn completion barrier; warning-only limits (2026-07-14)
Supersedes D24's notification-driven main auto-wake and D21/D15 execution stops.
Every task anchor created by spawn, uncorrelated main send, collect, or transitive
uncorrelated peer delegation during the current user turn is required by default.
Before main can publish a final response, the host waits for exact correlated
final/error/retirement outcomes and feeds results or attention back with Pi
`followUp` delivery inside the same run. Questions, escalations, provider/tool
waits, scheduler contention, main interruption, and missing final reports remain
joined. `background:true` is the only explicit per-call detachment. Persistent
agent lifetimes are never themselves joined.

Main mail remains durable but never auto-wakes an idle host; unrelated mail joins
the next genuine user turn. `/agents resume`, the abort latch, and paused-autonomy
queue draining are removed. Session turn/token and per-agent lifetime/time/
compaction values are warning thresholds only: crossing emits a one-shot targeted
warning while execution continues. A persistent non-blocking TUI widget offers
`alt+ctrl+x` to interrupt only the affected subagent turn and `alt+ctrl+i` to
ignore. Only manual interruption/retirement, fatal runtime failure, host shutdown,
or host crash stops work.

## Proposed (under discussion)

### P1 — Disk-backed actor model
Each subagent = durable identity + private memory + mailbox. Layout sketch:

```
Agents/
  registry.json              # who exists, role, status (dormant|running), last-seen
  <agent-name>/
    agent.json               # identity: name, role, capabilities, caps (sandbox, limits)
    session.jsonl            # full conversation history = memory
    mailbox/                 # inbound envelopes, one file per message
  bus/
    <topic>.jsonl            # shared blackboard topics, append-only
```

- Direct message = envelope file written into recipient's mailbox/.
- Broadcast = append to a bus/ topic agents subscribe to.
- Same envelope schema for both → hybrid topology with one mechanism.
- Actor rule: an agent processes its mailbox one message at a time; agents
  parallelize across, never within, an identity.
- Everything observable (cat-able) and git-versionable.

Envelope sketch: `{id, from, to|topic, type, correlationId?, payload, timestamp}`
with types like task, question, answer, report, event.

## Open questions

### Q2 (RESOLVED by D7/D11) — Wake semantics
Resolution: session-scoped by construction — in-process agents can only run while a
main Pi session is open; otherwise mail queues on disk. Mail never interrupts a
running turn (D11). Daemon = future path to autonomous auto-wake. Original options:
What happens when mail lands in a dormant agent's mailbox?
- (a) auto-wake daemon: full autonomy; needs scheduler, concurrency limits,
  runaway-conversation (ping-pong) protection.
- (b) wake on demand only: mail queues until user/orchestrator runs the agent.
- (c) session-scoped auto-wake: supervisor auto-delivers while a work session is
  active (with token budget + depth limit); dormant + queueing otherwise.
Claude's leaning: (c). — UNDECIDED

### Later
- Envelope contract details (types, ack/timeout semantics, correlation).
- Lifecycle: who creates/retires agents; registry ownership.
- Where Agents/ root lives (global vs project-scoped).
- Memory growth: session.jsonl compaction strategy.
- Sandbox/caps model for persistent agents.
