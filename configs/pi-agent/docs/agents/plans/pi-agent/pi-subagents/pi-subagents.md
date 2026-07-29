# pi-subagents — implementation plan

A new clean-room Pi extension: the main agent spawns background subagents (persistent or
one-shot), runs them in parallel under a cap, and joins their results by awaiting or by
idle auto-wake. Strict hub-and-spoke; subagents cannot spawn. Runs **alongside** pi-teams.

Path abbreviations used in citations:

- **TEAMS** = `configs/pi-agent/packages/pi-teams/extensions/teams`
- **PCA** = `<pi-install-dir>/dist`
- **SAFETY** = `configs/pi-agent/packages/pi-safety/extensions/safety`

---

## 1. Context

pi-teams covers collaborative persistent fleets (peer mail, questions, collect). The user
wants a second, simpler extension — `pi-subagents` — for fire-and-forget fan-out work,
confirmed spec (all decisions locked in conversation):

1. **R1 — Spawn, no nesting.** Main agent spawns subagents; a subagent can never spawn
   (its toolset simply contains no spawn/await/steer tools).
2. **R2 — Async spawn + two join paths.** Spawn always returns immediately. Results
   arrive by (a) an await tool, or (b) ending the turn — each finishing subagent wakes
   the idle main agent (per-finish wake; mid-turn results queue to the turn boundary).
3. **R3 — Parallel with configurable cap.** Default cap 4, set in `subagents.json`;
   over-cap spawns queue FIFO and start as slots free.
4. **R4 — Type-def AND ad-hoc agents.** Type defs at `~/.pi/agent/subagents/<type>.md`
   and `<cwd>/.pi/subagents/<type>.md` (project wins, trust-gated), same frontmatter
   schema as pi-teams v2 but parsed **tolerantly** (unknown keys like `peers` are
   ignored with a warning, so a copied teams def just works). Ad-hoc spawns supply the
   full role prompt at spawn time, no def file.
5. **R5 — Per-type model/provider/thinking overrides**, defaulting to the host session's
   model. Ad-hoc spawns can override too.
6. **R6 — Lifetime chosen per spawn call only.** `persistent` = addressable
   `<type>/<id>`, keeps history, accepts follow-ups, survives session resume.
   `oneshot` = auto-named, delivers final report, auto-retires; transcript stays on disk.
7. **R7 — Hub-and-spoke comms.** Main ↔ subagent only. No peer messaging. No mid-task
   ask-back: task in → result out; a subagent appends open questions to its (early)
   final report. System prompt tells it to surface blocking ambiguity early; the spawn
   tool description nudges persistent mode for long/underspecified tasks.
8. **R8 — Full control.** Main agent can steer a running subagent, cancel its turn, and
   retire persistent agents.
9. **R9 — Await one, many, or all + timeout.** Any/all modes; on timeout return whatever
   has finished so far.
10. **R10 — Safety like teams.** Guarded bash/edit/write confirm through pi-safety
    (fail-closed); state tree + type-def dirs hard-denied; per-type `tools` allowlist.
11. **R11 — Same cwd.** No worktree isolation in v1.
12. **R12 — UI.** `/subagents` command with picker + viewer, one live tree/status
    widget above the editor (running/waiting/mail summary, activity rows, bottom
    padding, no footer segment), and a stop brake (command + shortcut).

Non-goals (explicit): peer messaging, blocking ask, collect-with-schema, hops guard,
worktrees, replacing pi-teams.

---

## 2. Grounded key findings

### 2.1 Extension surface (SDK)

- Extension entry: `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`
  (`PCA/core/extensions/types.d.ts:1060`). Registration: `registerTool` (`:874`),
  `registerCommand(name, {description?, getArgumentCompletions?, handler(args, ctx)})`
  (`:876`, shape `:824-830`), `registerShortcut(keyId, {description?, handler})` (`:878`).
- Events: `pi.on("session_start"|"session_shutdown"|"input"|"before_agent_start"|
  "agent_settled", handler(event, ctx))` (`:842-858`). `SessionStartEvent.reason ∈
  startup|reload|new|resume|fork` (`:405-411`).
- Session info via `ctx.sessionManager.getSessionId()/getSessionFile()/getSessionDir()`
  (`PCA/core/session-manager.d.ts:201-203`); `ctx.cwd` (`types.d.ts:215`), `ctx.model`
  (`:222`), `ctx.modelRegistry` (`:220`), `ctx.mode` (`:212`).
- UI: `ctx.ui.setStatus(key, text|undefined)` (`types.d.ts:79`), `ctx.ui.setWidget(key,
  lines|factory|undefined, {placement: "aboveEditor"|"belowEditor"})` (`:96-99`),
  `ctx.ui.notify` (`:75`), `ctx.ui.custom<T>(factory, {overlay, overlayOptions})`
  (`:116-126`), `ctx.ui.theme`. Custom components implement `{render(width): string[];
  handleInput?(data); invalidate()}` (`pi-tui/dist/tui.d.ts:10-31`).
- Tool shape: `ToolDefinition{name, label, description, parameters: TypeBox TSchema,
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>}`
  (`types.d.ts:335-366`); errors are **thrown** from execute
  (`pi-agent-core/dist/types.d.ts:335`). pi-teams' `tools/results.ts` wraps this as
  `jsonResult`/`errorResult` (`TEAMS/tools/results.ts:1-13`).
- Wake injection: `pi.sendMessage({content, customType, display, details}, {deliverAs:
  "followUp", triggerTurn: true})` — streaming → queued into the running turn; idle →
  starts a new turn. Exact shape proven at `TEAMS/index.ts:54,84`.
- Cross-extension bus: `pi.events.emit/on(channel, data)`
  (`PCA/core/event-bus.d.ts:1-4`) — the safety rendezvous.

### 2.2 Running an in-process subagent session

- `createAgentSession(options): Promise<{session: AgentSession, ...}>`
  (`PCA/core/sdk.d.ts:108`). Relevant options (`sdk.d.ts:11-57`): `cwd`, `agentDir`,
  `sessionManager`, `resourceLoader`, `modelRegistry`, `model`, `thinkingLevel`,
  `noTools: "builtin"`, `customTools: ToolDefinition[]`. **No `systemPrompt` field** —
  role prose goes in via `DefaultResourceLoader({..., appendSystemPrompt: string[]})`,
  exactly as pi-teams does (`TEAMS/runtime/in-process.ts:817-828`).
- Drive a turn: `await session.prompt(text)` then `await session.waitForIdle()`
  (`PCA/core/agent-session.d.ts:343,420`; usage `TEAMS/runtime/in-process.ts:732-733`).
  Steer: `session.steer(text)` (`:359`); abort: `session.abort()` (`:419`);
  `session.isStreaming` (`:279`); observe: `session.subscribe(listener)` (`:255`),
  `entry_appended` / `agent_end` events used for activity + failure detection
  (`TEAMS/runtime/in-process.ts:712-730`).
- Persistence: Pi-native JSONL, resumed via `SessionManager.open(path, dir, cwd)` /
  created via `SessionManager.create(cwd, dir)` (`PCA/core/session-manager.d.ts:313,320`;
  usage `TEAMS/runtime/in-process.ts:812`). Stats: `session.getSessionStats()`
  (`agent-session.d.ts:593`; vitals mapping `TEAMS/runtime/in-process.ts:137-146`).
- Model resolution: `resolveCliModel({cliModel: "provider/id", modelRegistry})`
  (`TEAMS/runtime/in-process.ts:866-877`); host model captured per spawn as
  `ctx.model.provider + "/" + ctx.model.id` (`TEAMS/tools/main-agent.ts:54`).
- Sandboxed coding tools: `createReadToolDefinition(cwd)` etc., wrapped with deny +
  confirm (`TEAMS/sandbox/tools-filter.ts:19-143`).

### 2.3 Prior art to copy/adapt (pi-teams, all read this session)

- **Lifecycle wiring**: session_start acquires layout + host lease + settings + core,
  non-persisted sessions get a clear unavailable reason, teardown on shutdown, wake pump
  bound to input/before_agent_start/agent_settled (`TEAMS/index.ts:56-339`).
- **Wake pump**: pure idle-tracking state machine; flips non-idle **before** inject;
  commit after synchronous accept (`TEAMS/mail/wake-pump.ts:51-85`).
- **Runtime**: per-address turn chains, FIFO scheduler, mail-driven turns, digest →
  `prompt()`, mark-done only after durable completion, interrupt/pendingInterrupt,
  retire-with-archive, oneshot auto-retire via `retireAfterTurn`, typedef live-resolve +
  hash fence, build locks, activity tracking (`TEAMS/runtime/in-process.ts` whole file).
- **Await**: poll the main mailbox for exact `{to, anchorId}` targets; return per-target
  `completed`/`error`/`retired` outcomes and preserve unresolved targets on timeout
  (`TEAMS/runtime/in-process.ts:475-515`).
- **Mail**: `Envelope{id: msg_<ulid>, from, to, type, correlationId, hops, payload{text,
  data?, final?}, sentAt}` (`TEAMS/mail/envelope.ts:164-181`); file-per-envelope mailbox
  with `.done/`, `.corrupt/`, `.attempt` redelivery markers
  (`TEAMS/mail/mailbox.ts:36-132`); `Deliverer` routes + wakes dormant recipients
  (`TEAMS/mail/deliver.ts:64-133`); deterministic wake digest (`TEAMS/mail/digest.ts:111`).
- **Store**: atomic tmp+rename+fsync JSON writes (`TEAMS/store/atomic.ts:34`);
  registry.json roster with identity-repair on corrupt vitals
  (`TEAMS/store/registry.ts:49-200`); host lease via exclusive-link `.host-owner.json` +
  heartbeat + pid/start-time liveness (`TEAMS/store/host-lease.ts:26-221`); archive =
  move + `.retired-at` marker + N-day GC (`TEAMS/store/archive.ts:14-146`); layered
  settings, fail-closed int validation (`TEAMS/store/settings.ts:23-116`).
- **Layout is the single path authority** — the entire on-disk namespace hangs on three
  `"teams"` literals (`TEAMS/store/layout.ts:172,177,178`); settings files are
  `settingsFileSiblingOf(typeDefsDir)` = `<dir>.json` (`:97,205-206`).
- **Type defs**: tiny YAML-subset parser, schema `{name, description, model?, thinking?,
  projectContext?, tools?, peers?}`, unknown fields are **errors** today
  (`TEAMS/typedefs/parse.ts:46,170`) — ours relaxes this to warnings (R4); discovery is
  symlink/hardlink-hardened O_NOFOLLOW reads, project defs trust-gated
  (`TEAMS/typedefs/discover.ts:51-108`).
- **Safety bridge**: emit `{method:"confirm", request, claim}` on a channel; provider
  claims synchronously during emit; unclaimed → fail closed; 10-min claimant timeout
  (`TEAMS/sandbox/safety-bridge.ts:53-84`). **pi-safety currently listens ONLY on
  `teams:confirm-request`** (`SAFETY/index.ts:164`), classifier + mode gating + human
  confirm at `SAFETY/index.ts:164-204`.
- **System deny**: realpath-anchored bidirectional containment for edit/write targets +
  best-effort text scan for bash (`TEAMS/sandbox/system-deny.ts:65-109`).
- **TUI**: ambient status via `setStatus` (`TEAMS/tui/widget.ts:67`, published
  `TEAMS/index.ts:278`); tree widget with `WIDGET_KEY`, 400 ms poll + event refresh,
  `STOP_KEY="alt+s"` (`TEAMS/tui/tree-widget.ts:28,62-77`); picker/viewer overlays via
  `ctx.ui.custom` replaying the agent's JSONL through Pi's own transcript components
  (`TEAMS/tui/viewer.ts:48-77`); viewer input line: Enter = sendAsUser, alt+Enter =
  steer (`TEAMS/tui/viewer.ts:120,144`).
- **Test harness**: no build step — the SDK's bundled jiti loads raw `.ts` with aliases;
  only the LLM is mocked (scripted `streamSimple` on a real in-memory ModelRegistry);
  everything else (fs, sessions, scheduler) is real in a tmp dir
  (`pi-teams/test/e2e/env.mjs:21-53`, `phase3-mail.mjs:56-101`, `run.sh`).
- Taken `alt+` shortcuts across loaded packages: d, e, j, q, s, x (grep this session);
  user keybindings take t, m. **`alt+a` is free.**

---

## 3. Design

Everything below is the pi-teams architecture with three structural deletions (peers,
questions/collect, hops) and three additions (ad-hoc types, multi-await, open-task
index). Module-for-module provenance is in §4.

### 3.1 Package & naming (R1, R12)

- Package `configs/pi-agent/packages/pi-subagents`, `package.json` with
  `"pi": {"extensions": ["./extensions"]}` and the same peerDependencies as pi-teams
  (`pi-teams/package.json`).
- Extension dir `extensions/subagents/`. Command `/subagents`. Tools:
  `subagent_spawn`, `subagent_send`, `subagent_steer`, `subagent_await`,
  `subagent_cancel`, `subagent_retire`, `subagent_status`. Subagent-side tool: `report`.
- Identifiers: `STATUS_KEY="subagents"`, `customType:"subagents-mail"`,
  `WIDGET_KEY="subagents-tree"`, stop key `alt+a`.

### 3.2 State & persistence (R2, R6)

Layout is a rename of TEAMS layout — the three literals become `"subagents"`
(`TEAMS/store/layout.ts:172,177,178`), everything else byte-compatible:

```
~/.pi/agent/sessions/<cwd-slug>/subagents/<mainSessionId>/
  scope.json  .host-owner.json  registry.json
  .main/mailbox/            # main agent's inbox (.done/, .corrupt/)
  .main/open-tasks.json     # NEW — anchor index for await-all (see 3.5)
  .archive/<type>/<id>/     # retired agents (transcripts kept — R6 oneshot)
  <type>/<id>/              # instance dir: Pi-native JSONL + mailbox/
~/.pi/agent/subagents/<type>.md      # global type defs (R4)
<cwd>/.pi/subagents/<type>.md        # project type defs (trust-gated)
~/.pi/agent/subagents.json           # global settings
<cwd>/.pi/subagents.json             # project settings
```

Rebuild story (verified in prior art): on every `session_start` (startup/reload/resume)
the core re-reads `registry.json`, re-seeds the ULID clock from on-disk mail, and
resumes each agent's latest JSONL lazily on first wake via `SessionManager.open`
(`TEAMS/index.ts:205-296`, `TEAMS/runtime/in-process.ts:177-185,806-813`). Non-persisted
Pi sessions get `unavailableReason` and no tools work (`TEAMS/index.ts:210-214`). The
host lease guarantees one owning process; a second process sees
`HostScopeLockedError.ownerPid` and reports it (`TEAMS/index.ts:218-226`).

### 3.3 Spawning: type-def and ad-hoc (R4, R5, R6)

`subagent_spawn` params (TypeBox):

- `type?: string` — a def name; **or** `prompt?: string` — ad-hoc role prose. Exactly one
  required (both/neither → error).
- `id?: string` — persistent instance id. `lifetime?: "persistent"|"oneshot"` — default
  `oneshot` for ad-hoc, `persistent` for typed (typed keeps teams' semantics: named =
  persistent, oneshots must not pass an id, `TEAMS/runtime/in-process.ts:207-212`).
- `task?: string` — first assignment (becomes the first envelope, the await anchor).
- `model?: string`, `thinking?: ThinkingLevel` — ad-hoc only; typed agents configure
  these in frontmatter (def wins, spawn-level for typed is rejected to keep one source
  of truth).
- `tools?: string[]` — ad-hoc only; typed use frontmatter `tools`.

Ad-hoc mechanics (**new**): reserved type name `adhoc` (a def file named `adhoc.md` is
rejected at discovery with a clear error). On ad-hoc spawn the runtime writes
`<instanceDir>/def.md` — a synthesized type file (frontmatter: `name: adhoc`,
`description`, optional `model`/`thinking`/`tools`; body = the prompt) using the same
atomic write. Resolution order in the runtime's `resolveDef(record)`: type `adhoc` →
read `<instanceDir>/def.md`; otherwise → typedef discovery as today
(`TEAMS/typedefs/discover.ts:115-128`). Because the def is a real file hashed like any
other, the existing `typeFileHash` fence and live-reload logic apply unchanged — and a
**persistent ad-hoc agent survives resume** because its constitution is on disk, not in
memory. Addresses: `adhoc/<id>` (persistent, user-named) or `adhoc/tmp-<hex>` (oneshot,
`TEAMS/runtime/in-process.ts:545-550`).

Tolerant parsing (R4): `validateConfig` collects unknown-field notices as **warnings**
returned alongside the config instead of errors (`TEAMS/typedefs/parse.ts:170` changes
from `errors.push` to `warnings.push`); `peers` is dropped from the schema entirely and
lands in the ignored bucket. Warnings surface once per session via `ctx.ui.notify` and
in `subagent_status`'s type catalog.

### 3.4 Runtime: turns, cap, control (R1, R3, R8)

Adapted from `TEAMS/runtime/in-process.ts` with deletions:

- **No peers**: `sendFromAgent` accepts only `to: "main"`; the peer gate, `PeerMode`,
  `refreshDormantHandles`, `team_peers`, and envelope types `question`/`answer`/
  `escalation` are removed. Envelope types: `message` (main/user → agent), `report`
  (agent → main), `error` (runtime → main, or bounce). The mailbox question/collect
  indexes (`.sent-questions.json`, `.collect-requests.json`) are dropped.
- **No hops guard**: depth is structurally ≤ 1 (main → agent → main), so `hops` stays in
  the envelope (harmless, keeps redelivery/audit shape) but no guard is constructed.
- **No nesting (R1)**: a subagent's toolset = `report` + its sandboxed coding tools,
  built with `noTools: "builtin"` + `customTools` exactly like
  `TEAMS/runtime/in-process.ts:838-856` — there is no spawn/await/steer surface to
  filter out; least privilege by construction.
- Scheduler copied verbatim (FIFO slot pool, `TEAMS/runtime/scheduler.ts`), default
  `maxConcurrent: 4` (settings, §3.7).
- **Cancel (R8)** = teams' interrupt semantics, renamed: abort the streaming turn (or
  record `pendingInterrupt` for queued turns, `TEAMS/runtime/in-process.ts:352-368`);
  the agent stays alive, dormant, its triggering mail pending — recoverable. The tool
  result states `{cancelled: true}`; for oneshots the description reminds the main agent
  to `subagent_retire` if it won't resume it.
- **Steer (R8)**: verbatim (`TEAMS/runtime/in-process.ts:345-350`).
- **Retire (R8, R6)**: verbatim minus the peer-mail bounce loop
  (`TEAMS/runtime/in-process.ts:370-414`; owner/user pending mail dropped quietly, as
  teams already does) — archive keeps the transcript, satisfying oneshot post-mortems.
- Oneshot auto-retire after final report: verbatim (`retireAfterTurn`,
  `TEAMS/runtime/in-process.ts:306-313,775-778`).
- Failure surfacing: an errored turn emits `turn-error` and delivers an `error` envelope
  to main (`TEAMS/runtime/in-process.ts:753-757`) — this is how a crashed subagent still
  wakes the idle main agent (commit/cleanup two-phase: mail stays pending on
  abort/interrupt, marked done only after a completed turn,
  `TEAMS/runtime/in-process.ts:738-746`).

### 3.5 Results: anchors, await, auto-wake (R2, R9)

**Anchor bookkeeping (new, small):** every task-bearing envelope from main
(`spawn.task` or `subagent_send`) is recorded in `.main/open-tasks.json`
(`{anchorId: {to, snippet, openedAt}}`, atomic writes). The runtime keeps teams'
`handle.assignment` correlation: a final report is stamped with the exact task-anchor
snapshot drained into its triggering turn (`runtime/in-process.ts:302-307`). When that
terminal report is consumed by await or digest commit, only the stamped anchors are
closed; assignments held for a later turn remain open. Retire and turn-error resolve
the affected target with their terminal outcome. The file is tiny and self-healing:
entries for unknown agents are pruned on read.

**`subagent_await` (R9):** params `targets?: Array<{to, anchorId}>` (omit = all open
tasks), `mode: "any"|"all"` (default `all`), `timeoutSeconds?` (default 300, max 900).
Implementation generalizes teams' poll loop (`TEAMS/runtime/in-process.ts:475-515`):

- Poll the main mailbox for final reports or errors from the target address. Modern
  terminal envelopes persist `payload.terminalAnchors`; a target matches only when its
  anchor is in that drained-turn snapshot. Pre-migration final reports without the list
  fall back to their non-null correlation ID, while a legacy unscoped error retains its
  sender-wide fallback.
- Consume one matched terminal envelope and resolve all and only its stamped targets as
  `completed` or `error`. A retired/vanished target resolves as `retired` using
  per-address liveness, not fleet-wide counts.
- `mode:"any"` returns on the first terminal outcome; `mode:"all"` returns when every
  target is terminal. Timeout returns `{status:"timeout", outcomes: [...], pending:
  [...]}` — partial terminal outcomes are included and unresolved results stay pending.
  Abort signal respected.
- Empty target set (no open tasks) returns immediately with
  `{status:"empty", outcomes: [], pending: [], note}`.

**Auto-wake (R2):** wake pump copied verbatim (`TEAMS/mail/wake-pump.ts`), bound exactly
as `TEAMS/index.ts:54,78-86,299-307`: `turn-finished`/`agent-retired` runtime events →
`onMailArrived` → if host idle, compose digest (peek-then-commit;
`TEAMS/core.ts:152-175` minus collect handling), inject via `pi.sendMessage(...,
{deliverAs:"followUp", triggerTurn:true})`. Per-finish wakes fall out naturally: each
finish pumps; whatever is pending at that moment is one digest. Digest composer is the
teams one minus the Answers section and collect notes (`TEAMS/mail/digest.ts`).

### 3.6 Subagent context & conventions (R7)

`context/compose.ts` adapted: identity block drops the peers roster and peer prose
entirely. New sections:

- *Identity*: address, purview, "you work under a main agent; you cannot message, spawn,
  observe, or steer other agents — your only channel is `report`."
- *Conventions* (replacing teams' question convention, R7):
  - Final report required (`report` with `final:true`) — never finish silently
    (kept from `TEAMS/context/compose.ts:108-112`).
  - **Surface blocking ambiguity early**: sanity-check the assignment up front; if
    something blocks correct completion, send an early final report stating what you
    did, what's blocked, and your questions under an `Open questions:` heading — do not
    grind through guesswork.
  - Checkpoint line before ending any turn; persistent-memory note for persistent agents
    (kept from `TEAMS/context/compose.ts:117-124`).

`subagent_spawn`'s description carries the counterpart nudge: "for long or
underspecified tasks prefer `lifetime: persistent` so an early return with questions
costs one follow-up send, not a restart."

### 3.7 Settings (R3)

`SubagentsSettings = {maxConcurrent: 4 default (int 1–64), archiveGcDays: 7 default
(0–3650)}` — teams' loader minus `maxHops`/`peers`
(`TEAMS/store/settings.ts:23-116`). Same layered global→project merge, same fail-closed
warnings.

### 3.8 Safety (R10) — and the one pi-safety change

Bridge copied with channel `subagents:confirm-request`
(`TEAMS/sandbox/safety-bridge.ts:18`). pi-safety gets a minimal edit: extract its
existing claim-handler body (`SAFETY/index.ts:164-204`) into a local function and
subscribe it on **both** `teams:confirm-request` and `subagents:confirm-request`. No
behavior change for teams; the request shape is identical (`{agent, tool, command?,
path?}`). Fail-closed default (`denyAllConfirm`) when unclaimed, 10-min claimant
timeout — copied (`TEAMS/sandbox/safety-bridge.ts:41-84`).

System-deny (copied verbatim): protected roots = this extension's state root + its two
type-def dirs (mirroring `TEAMS/runtime/in-process.ts:180-182`). Tools-filter copied
verbatim (per-type `tools` allowlist → R10's read-only types; edit/write deny→confirm→
re-check TOCTOU order, bash text-scan, `TEAMS/sandbox/tools-filter.ts:70-143`).

### 3.9 UI (R12)

Adapted from teams TUI with renames and two deletions (no peers command, no archive
changes):

```
󰚩 2 running · 1 waiting · 󰇮 3 · alt+a stop
├─ adhoc/tmp-3f21 · 4 tool uses
│  └ Bash: npm test
└─ scout/main · 2 tool uses
   └ Read: src/auth/jwt.ts

```

| Surface | Keys / actions |
|---|---|
| `/subagents` | no args → picker; `<type>/<id>` → viewer; `stop` → brake |
| picker | ↑↓/kj move · Enter view · `a` archive section · `x` cancel · `X` retire (y/N) · `S` stop all · Esc close |
| viewer | Esc back · alt+j next agent · Enter send-as-user · alt+Enter steer · live tail |
| global | `alt+a` = stop all working subagents (non-destructive; mail stays pending) |
| ambient | one above-editor widget: running/waiting/mail header + live activity tree + trailing blank line; no shared-footer `setStatus` |

Empty states: picker with no agents shows "No subagents — spawn one with
subagent_spawn"; the ambient widget renders nothing without activity or unread mail,
but remains visible for mail-only status; viewer on a retired address
exits to picker (`TEAMS/index.ts:114-119` idiom).

### 3.10 Least privilege & failure states summary

- Subagents: `report` + allowlisted coding tools only; no session/extension/skill
  loading (`noExtensions/noSkills/noPromptTemplates/noThemes` loader flags,
  `TEAMS/runtime/in-process.ts:817-827`); state tree + def dirs hard-denied; guarded
  tools human-confirmed, fail-closed.
- Main-agent tool errors are thrown `errorResult`s with actionable hints (unknown type →
  catalog list, `TEAMS/tools/main-agent.ts:57-65`).
- Corrupt envelope → quarantined to `.corrupt/`; corrupt registry vitals → repaired;
  corrupt settings → warned + defaults; missing def at wake → turn-error, mail stays
  pending, fixed def retries on next wake (`TEAMS/runtime/in-process.ts:639-643`).
- Interrupted/aborted turns never consume their mail (at-least-once redelivery with
  `redelivered` labeling).

---

## 4. Deliverable file tree

`configs/pi-agent/packages/pi-subagents/` — provenance: **new** / **copy** (verbatim
module, only header/import renames) / **adapt** (structural changes, source noted).

```
package.json                          new — pi-package manifest (modeled on pi-teams/package.json)
extensions/subagents/
  index.ts                            adapt TEAMS/index.ts — registration, lifecycle, wake binding; minus peers command/setPeers; stop key alt+a
  core.ts                             adapt TEAMS/core.ts — facade; minus collect/peers; plus awaitMany + openTasks
  runtime/types.ts                    adapt TEAMS/runtime/types.ts — SubagentRuntime contract; multi-await types; no PeerMode/collect
  runtime/in-process.ts               adapt TEAMS/runtime/in-process.ts — turns/handles/cancel/retire; minus peers/hops/collect/questions; plus adhoc def + open-task closing
  runtime/scheduler.ts                copy TEAMS/runtime/scheduler.ts (default cap fed from settings)
  mail/envelope.ts                    adapt TEAMS/mail/envelope.ts — types narrowed to message|report|error; ULID/address grammar verbatim
  mail/mailbox.ts                     adapt TEAMS/mail/mailbox.ts — minus sent-question/collect indexes
  mail/deliver.ts                     adapt TEAMS/mail/deliver.ts — no hops guard, agent→main only from agents
  mail/digest.ts                      adapt TEAMS/mail/digest.ts — no Answers section / collect notes
  mail/wake-pump.ts                   copy TEAMS/mail/wake-pump.ts
  store/layout.ts                     adapt TEAMS/store/layout.ts — "subagents" literals; + openTasksFile; minus question/collect path helpers
  store/atomic.ts                     copy TEAMS/store/atomic.ts
  store/registry.ts                   copy TEAMS/store/registry.ts
  store/host-lease.ts                 copy TEAMS/store/host-lease.ts (error text reworded)
  store/archive.ts                    copy TEAMS/store/archive.ts
  store/settings.ts                   adapt TEAMS/store/settings.ts — {maxConcurrent:4, archiveGcDays:7} only
  store/open-tasks.ts                 new — anchor index read/record/close/prune (atomic.ts-backed)
  typedefs/parse.ts                   adapt TEAMS/typedefs/parse.ts — unknown keys → warnings; no peers field
  typedefs/discover.ts                adapt TEAMS/typedefs/discover.ts — + reserved-name "adhoc" rejection
  sandbox/tools-filter.ts             copy TEAMS/sandbox/tools-filter.ts
  sandbox/safety-bridge.ts            adapt TEAMS/sandbox/safety-bridge.ts — channel "subagents:confirm-request"
  sandbox/system-deny.ts              copy TEAMS/sandbox/system-deny.ts
  context/compose.ts                  adapt TEAMS/context/compose.ts — hub-and-spoke identity; ambiguity-early convention (§3.6)
  tools/main-agent.ts                 adapt TEAMS/tools/main-agent.ts — subagent_* tools; spawn type|prompt; multi-await; no collect/peers
  tools/sub-agent.ts                  adapt TEAMS/tools/sub-agent.ts — report only (16k text / 64k data caps kept)
  tools/results.ts                    copy TEAMS/tools/results.ts
  tui/widget.ts                       running/waiting/mail snapshot + icons
  tui/tree-widget.ts                  unified status/activity widget + bottom padding, STOP_KEY alt+a
  tui/picker.ts                       adapt TEAMS/tui/picker.ts — header/hints wording
  tui/viewer.ts                       adapt TEAMS/tui/viewer.ts — header wording
test/e2e/
  run.sh                              adapt pi-teams/test/e2e/run.sh — package paths
  tsconfig.template.json              copy pi-teams/test/e2e/tsconfig.template.json
  print-pi-pkg.mjs                    copy pi-teams/test/e2e/print-pi-pkg.mjs
  env.mjs                             adapt pi-teams/test/e2e/env.mjs — EXT=extensions/subagents, WORLDS=pi-subagents-e2e
  phase1-data-layer.mjs               adapt — layout/mailbox/registry/settings/open-tasks round-trips
  phase2-typedefs.mjs                 adapt — tolerant parse (teams def w/ peers key), adhoc reserved-name rejection
  phase3-spawn-turn.mjs               adapt — typed + adhoc spawn, digest turn, final report, vitals
  phase4-await.mjs                    new — any/all/timeout/partial, multi-target, error + retired outcomes, open-task closing
  phase5-wake.mjs                     adapt phase9-auto-wake — per-finish wake, WAKE_DELIVERY shape, commit boundary
  phase6-control.mjs                  adapt — steer, cancel (streaming + queued), retire, stop-all, oneshot auto-retire + archived transcript
  phase7-resume.mjs                   adapt — new process on same scope: lease handoff, registry reload, persistent + adhoc-persistent memory intact
  phase8-sandbox.mjs                  adapt — tools allowlist, system-deny (state tree + def dirs + bash text scan), confirm fail-closed/deny
  loadcheck.mjs                       adapt — extension loads under jiti with zero SDK-version drift
```

## 5. Changes outside the deliverable

1. `~/.pi/agent/settings.json` — append
   `"<workspace>/configs/pi-agent/packages/pi-subagents"` to `packages`.
   (Live file, not in repo — apply with Edit, not a script.)
2. `configs/pi-agent/packages/pi-safety/extensions/safety/index.ts` — extract the
   `teams:confirm-request` handler body (`index.ts:164-204`) into
   `handleConfirmRequest(data)` and subscribe it on both channels (§3.8).
3. `configs/pi-agent/MANIFEST.md` — add the `pi-subagents` row to the enabled-extensions
   table.
4. Memory: update `pi-extensions-packaging.md` note after landing (new package in the
   delegation cluster).

## 6. Risks & open questions

1. **Both extensions loaded = two spawn systems visible to the LLM.** Intended by the
   user (run alongside). Mitigation: tool descriptions state the split ("subagent_* =
   background fan-out workers; team_* = collaborative persistent team"). Out of scope —
   follow-up if the main agent confuses them in practice.
2. **`alt+a` collision** — free per grep of loaded packages + user keybindings this
   session, but Pi core bindings weren't exhaustively enumerated. Verify during
   implementation (press-test in a live TUI; fall back to `alt+g`).
3. **pi-safety dual-channel edit touches a shared extension** — behavior for teams must
   be provably unchanged. Mitigated by extraction-only refactor + running pi-teams'
   existing e2e suite after the edit.
4. **Open-tasks index drift** (e.g. crash between mailbox commit and open-task close):
   self-healing on read (prune anchors whose agent is gone AND has no pending/done
   report) — verify the prune rule during implementation against phase4/5 crash cases.
5. **`ctx.model` absence in headless/print modes** (`types.d.ts:222` is optional):
   spawn's inherit falls back to registry default exactly as teams
   (`TEAMS/tools/main-agent.ts:54`, guarded spread). Verified pattern; low risk.
6. **Two wake pumps (teams + subagents) injecting concurrently**: both use synchronous-
   accept commit; the SDK serializes queued followUps. Believed safe by the same
   argument as one pump (each commit is independent), but **verify during
   implementation** with both extensions live in one session.
7. **CIFS**: extension state lives under `~/.pi` (local fs) and tests under tmpdir, but
   the *source* lives on the CIFS mount — never use in-place `sed -i` during
   implementation (existing repo rule).
8. **Session-file growth for long-lived persistent agents** (no compaction wired):
   same exposure as pi-teams today. Out of scope — follow-up.

## 7. Verification

Automated (from `packages/pi-subagents/test/e2e/`):

1. `./run.sh` — strict typecheck of every extension `.ts` against the installed SDK,
   then phases 1–8 + loadcheck, fail-fast. All green required. This covers: R3 (phase3
   spawns 6 with cap 4 → 2 queued FIFO), R4 (phase2/3), R5 (phase3 model/thinking
   resolution incl. unknown-model error), R6 (phase6 oneshot auto-retire + archived
   transcript readable; phase7 persistent + adhoc-persistent resume), R7 (phase3: agent
   toolset contains exactly report + allowlisted tools; no spawn tool exists), R8
   (phase6), R9 (phase4), R2 (phase5), R10 (phase8).
2. Re-run pi-teams' suite after the pi-safety edit:
   `configs/pi-agent/packages/pi-teams/test/e2e/run.sh` — proves risk #3.

Live (interactive Pi session in a scratch git project; requires the settings.json
registration):

3. Author `~/.pi/agent/subagents/scout.md` by copying a teams def **including its
   `peers:` line** → `/subagents` catalog lists it with a warning, not an error (R4).
4. `subagent_spawn {type:"scout", id:"auth", task:"…"}` → returns immediately with
   `taskEnvelopeId`; tree widget appears with live tool activity (R2, R12).
5. Spawn 5 ad-hoc oneshots in one turn → widget shows 4 running + 1 queued; all complete
   (R3). `subagent_status` roster matches.
6. `subagent_await {mode:"all"}` (no targets) mid-turn → blocks, returns all 5 final
   reports; open-tasks file empties (R9). Repeat with `mode:"any"` and a 5 s timeout on
   a slow task → partial result shape.
7. End the turn while an agent still runs → on its finish the main agent wakes by itself
   with a digest (R2). Then send two tasks to one dormant agent, stay idle → one digest,
   both anchors closed on its final report.
8. `subagent_steer` a running agent (visible mid-turn correction); `subagent_cancel` it
   → dormant, mail pending; send again → resumes from pending mail (R8).
9. Oneshot finishes → auto-retires; `.archive/adhoc/tmp-*/…jsonl` transcript is present
   and viewable (R6).
10. Kill Pi (SIGKILL), relaunch, resume the same session → roster intact, persistent
    agent answers a follow-up remembering prior work; ad-hoc persistent keeps its role
    (R6). While the first instance is alive, open the session from a second terminal →
    clear "another process (pid …) owns" notice.
11. Subagent runs a destructive bash command → pi-safety confirmation shows
    `[adhoc/tmp-…] <command>`; decline → agent told, no execution. Disable pi-safety
    (comment out of settings) → same call fails closed (R10). Subagent attempts
    `echo x > ~/.pi/agent/subagents/scout.md` → hard-denied without prompt.
12. In an **untrusted** project, `.pi/subagents/` defs neither list nor shadow (R10);
    in a non-persisted (`--no-session`) session all subagent_* tools report the
    unavailable reason cleanly.
13. `alt+a` and `/subagents stop` while two agents run → both cancelled non-destructively
    with the notify summary; picker `x`/`X` paths behave; viewer Enter/alt+Enter
    send-vs-steer works (R8, R12).
14. Coexistence: in one session spawn a teams agent AND a subagents agent → both tree
    widgets render, both wake pumps deliver, pi-safety confirms for both
    channels (risk #6); pi-teams behavior unchanged.
15. Cleanup: quit Pi → `.host-owner.json` released, no orphan node processes; scratch
    tmp worlds removed by the suite.
