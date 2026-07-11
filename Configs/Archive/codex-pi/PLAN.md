# codex-pi evolution plan — best of Codex + Claude Code

Status: proposed · Target runtime: `@earendil-works/pi-coding-agent` **0.80.3** (installed) ·
Scope: extend `codex-core` (functionality) while keeping `codex-look`/`claude-look`
(appearance) swappable and independently exportable.

---

## 1. Context

`codex-pi` today is three exportable pi plugins: `codex-core` (commands, approvals,
6 subagent tools, plan/review — renders nothing) plus swappable `codex-look` / `claude-look`
(all chrome). The subagent layer is a simplified subset of Codex's, there is no MCP, no
hooks, no memory, no web search, and approvals are a 3-mode `tool_call` gate with no OS
sandbox. This plan picks the strongest design from each of the two reference CLIs (real
Codex v0.143 and Claude Code v2.1.205, both installed and studied this session) and lays out
a phased path to build them on pi's actual extension API.

**Confirmed requirements** (each maps to a Design subsection and a Verification step):

1. **Declarative agents** — define subagents as files (`.pi/agents/*.md`, frontmatter +
   prompt), loaded at startup, usable across projects — Claude Code's model, which is more
   portable/versionable than Codex's runtime-only definition.
2. **Auto-delegation + explicit spawn** — a `delegate` tool that routes by agent
   `description`, alongside the existing explicit `spawn_agent`.
3. **Per-agent least privilege** — each agent runs with only its declared tools and its
   declared model.
4. **Filesystem isolation** — optional `isolation: worktree` (Claude Code) via a real git
   worktree, auto-removed if unchanged.
5. **Live mailbox orchestration** — Codex's `send_message` / `followup_task` /
   `interrupt` / `resume`, so a running agent can be messaged, redirected, and resumed.
6. **Agent identity** — nickname + role + color, shown in the live widget (both CLIs).
7. **Permission modes** — Claude Code's richer mode set (`default`/`acceptEdits`/`plan`/
   `bypassPermissions`/…) layered on the existing `tool_call` gate, plus an *optional* real
   `bwrap` sandbox when the binary is present (Codex's edge).
8. **Lifecycle hooks** — a config-driven hooks system mapped onto pi events
   (`SubagentStart`/`Stop`, `PreToolUse`/`PostToolUse`, etc.).
9. **File-based memory** — durable memory the agent reads/writes (`AGENTS.md` context +
   `.pi/memory/*.md`), with a per-agent `memory` scope.
10. **Web search** — a pluggable `web_search` tool (both CLIs ship one; pi does not).
11. **MCP support** — an MCP client that surfaces MCP server tools as pi tools (both CLIs
    have it; pi has none — the single biggest ecosystem gap).
12. **Collaboration modes** — round out Codex's `plan`/`execute`/`pair` personas (we have
    `plan`).
13. **Keep the look swappable** — every feature above emits data / uses the active theme so
    `codex-look` ↔ `claude-look` continues to work unchanged.

---

## 2. Grounded key findings (verified this session)

All citations are to the **installed** `dist/` of `@earendil-works/pi-coding-agent@0.80.3`
unless noted (`.../dist` abbreviated `D`).

### Session spawning (foundation for every subagent)
- `createAgentSession(opts)` accepts `cwd?`, `model?`, `tools?: string[]` (allowlist),
  `excludeTools?: string[]` (denylist), `noTools?: "all"|"builtin"`, `customTools?:
  ToolDefinition[]`, `resourceLoader?`, `sessionManager?` — `D/core/sdk.d.ts:13-52`.
  → per-agent least privilege and per-agent model are natively supported (req 3).
- `SessionManager.inMemory(cwd?)` — `D/core/session-manager.d.ts:309` (used in `codex-core`
  today). In-memory subagents don't pollute the on-disk session tree.
- `AgentSession.subscribe(listener)`, `.prompt(text, {source})`, `.abort()`, `.dispose()` —
  `D/core/agent-session.d.ts:244,330,406,260`. `agent_end` event carries `messages:
  AgentMessage[]` — `:41-45`. This is how `codex-core` already collects results and how
  mailbox delivery (req 5) will re-prompt a live session.

### Model resolution (per-agent model by id/alias)
- `ExtensionContext.modelRegistry: ModelRegistry` — `D/core/extensions/types.d.ts:220`.
- `ModelRegistry.getAll(): Model[]` (`D/core/model-registry.d.ts:52`) and
  `find(provider, modelId)` (`:61`) → resolve a declared `model:` string to a `Model`
  (mirror Claude Code's alias→model resolution). No alias table exists; we map
  `sonnet/opus/haiku/fable` → concrete ids ourselves against `getAll()`.

### Resource discovery (why declarative agents are *our* loader, not pi's)
- `resources_discover` result type exposes only `skillPaths?`, `promptPaths?`,
  `themePaths?` — `D/core/extensions/types.d.ts:400-402`. **There is no `agentPaths`.**
  → `.pi/agents/*.md` must be discovered and parsed by our extension (read dir + parse
  frontmatter), then turned into `createAgentSession` calls. We reuse the same
  `resources_discover` hook we already use for themes to also surface agents-as-prompts if
  we want `/agent:name` expansion.
- `Skill` interface = `{name, description, filePath, baseDir, sourceInfo,
  disableModelInvocation}` — `D/core/skills.d.ts:9-15`. Agents are *not* skills, but the
  frontmatter+markdown+`~/.pi` discovery pattern is the prior art to copy.

### Extension API surfaces the plan builds on (all exercised in `codex-core` already)
- `pi.registerTool(def)`, `pi.registerCommand(name, {description, handler})`,
  `pi.registerMessageRenderer`, `pi.registerShortcut`, `pi.sendMessage({customType, content,
  display, details}, {triggerTurn})`, `pi.exec(cmd, args)` → `{stdout, stderr, code}` —
  `D/core/extensions/types.d.ts` (used throughout `codex-core/src/*`).
- Cross-extension bus `pi.events.emit/on(channel, data)` —
  `D/core/event-bus.d.ts:1-3` (core↔look contract already relies on it).
- `tool_call` event returns `{block?, reason?}` and lets you mutate `event.input` in place —
  used today in `codex-core/src/approvals.ts` (req 7 extends this).
- `before_agent_start` may return `{systemPrompt?}` to replace the turn's prompt — used
  today in `codex-core/src/plan.ts`/`commands.ts` (req 12 collaboration modes reuse it).
- `ctx.ui.setWidget/setStatus/setEditorComponent/setTheme` — all used by the look plugins;
  new state is broadcast on `pi.events`, rendered by whichever look is loaded (req 13).

### What pi does NOT provide (so these are from-scratch, not wiring)
- **No MCP** — no `Mcp*`/`mcp*` symbols anywhere in `D/core/*.d.ts` or `D/index.d.ts`
  (grep empty). MCP (req 11) is a new client we write: spawn the server process with
  `pi.exec`/child_process, speak JSON-RPC over stdio, and `registerTool` one pi tool per
  discovered MCP tool.
- **No web search / fetch tool** — no `web_search`/`createWeb*` in `D/core/tools`
  (grep empty). Req 10 is a custom `registerTool` with a pluggable HTTP backend.
- **No agent-definition loader** — see resource-discovery finding above.

### Environment
- `git version 2.55.0` in the container → `git worktree add/remove` via `pi.exec` for req 4.
- Packaged extensions may only import pi's bundled modules
  (`@earendil-works/pi-coding-agent`, `/pi-tui`, `/pi-agent-core`, `/pi-ai`, `typebox`) — no
  third-party npm. MCP/web-search backends must use Node built-ins (`node:child_process`,
  `node:http`/`fetch`) only.

---

## 3. Best-of-both selection table

| # | Capability | Codex (v0.143) | Claude Code (v2.1.205) | **Our pick** | Rationale |
|---|---|---|---|---|---|
| 1 | Agent definition | runtime `spawn_agent` + TOML roles | **declarative `.claude/agents/*.md`** | **Claude: `.pi/agents/*.md` loader** | portable, versionable, no-code; maps cleanly to `createAgentSession` per-agent `tools`/`model` |
| 2 | Invocation | explicit, opt-in, "don't spawn unless asked" | **auto-delegate by `description`** + explicit | **Both**: `delegate` (auto by description) **and** `spawn_agent` (explicit) | ergonomics of auto + control of explicit |
| 3 | Least privilege | agent inherits parent tools | **per-agent `tools`/`disallowedTools`** | **Claude per-agent tools** via `createAgentSession.tools/excludeTools` | native pi support; safer |
| 4 | Context inheritance | `fork_turns` none/all/N | fresh isolated **or** `fork` (inherit) | **Both**: `fork_turns` none/all + a `fork` flag | flexible per task |
| 5 | FS isolation | — | **`isolation: worktree`** | **Claude worktree** via `git worktree` (`pi.exec`) | safe parallel edits; git present |
| 6 | Live orchestration | **mailbox: send/followup/interrupt/wait/resume** | delegate-then-`SendMessage` | **Codex mailbox tools** over the declarative agents | richest control; agents stay addressable |
| 7 | Identity | nickname + role | name + color | **Both**: nickname + role + color | best UX, cheap |
| 8 | Concurrency/depth | `max_threads`/`max_depth` config | fixed depth 5 | **configurable caps** (Codex-style) | explicit safety valve |
| 9 | Approvals | approval enum + **real OS sandbox** (bwrap/seatbelt) | **permission modes** (7) + settings allow-rules | **Claude modes** on `tool_call` gate + **optional bwrap** when present | modes are richer & portable; add real sandbox opportunistically |
| 10 | MCP | full client | full client | **build MCP stdio client** → `registerTool` per tool | both have it; pi's biggest gap |
| 11 | Hooks | hooks engine | lifecycle hooks | **`.pi/hooks.json` → pi events** | both have; pi events are the substrate |
| 12 | Memory | memories system | per-agent `memory` + CLAUDE.md | **file memory**: `AGENTS.md` + `.pi/memory/*.md` + per-agent scope | durable across restart; both converge on files |
| 13 | Web search | hosted tool | `web_search` tool | **pluggable `web_search` tool** | both have; simple custom tool |
| 14 | Collab modes | plan/execute/pair/default | plan permission mode | **Codex modes** (add execute/pair to our plan) | richest persona set |
| 15 | Look | fixed theme | themes + output styles | **swappable look plugins** (done) | already best-of-both |

---

## 4. Design (by requirement)

### Phase 1 — Declarative agents (`req 1,2,3,4,6-identity,8`)  ← highest value, most pi-idiomatic

**Definition format** (copy Claude Code's, adapt paths). `.pi/agents/*.md` (project) and
`~/.pi/agents/*.md` (global), discovered recursively; identity from `name` frontmatter, not
path (mirrors Claude Code docs). Frontmatter fields (subset we can honor on pi 0.80.3):

```
---
name: code-reviewer          # required; lowercase-hyphen
description: Use to review a diff for bugs   # required; drives auto-delegation
tools: read, grep, find, ls  # optional allowlist → createAgentSession.tools
disallowedTools: bash        # optional denylist → excludeTools
model: haiku | opus | sonnet | fable | <id> | inherit   # optional
isolation: worktree          # optional → git worktree
role: worker                 # optional label
color: cyan                  # optional widget color
maxTurns: 8                  # optional (enforced by counting agent_end)
memory: project              # optional scope (Phase 4)
---
<system prompt body>
```

**Loader** (`codex-core/src/agents/loader.ts`, **new**): on `session_start`, read both dirs,
parse frontmatter (hand-rolled YAML-subset parser — no external dep), validate `name`+
`description`, resolve `model` against `ctx.modelRegistry.getAll()` (alias map
`{sonnet,opus,haiku,fable}`→newest matching id; `inherit`→`ctx.model`), and hold an
`AgentDef[]` registry. Re-read on `resources_discover` `reason:"reload"`.

**State & persistence:** agent *definitions* live on disk (source of truth) — nothing to
persist; the registry is rebuilt from files on every `session_start`/reload. Running agent
*instances* are in-memory `AgentSession`s (as today) and intentionally do **not** survive
restart (matches Codex/Claude — a killed CLI drops its live subagents).

**Spawn path:** extend today's `spawn_agent` and add `delegate`:
- `spawn_agent(agent, task, ...)` — `agent` names a definition; we call
  `createAgentSession({cwd, model: def.model ?? ctx.model, tools: def.tools, excludeTools:
  def.disallowedTools ?? [...always exclude spawn tools], sessionManager:
  inMemory(cwd)})`, seed with `def.body + task`.
- `delegate(task, hint?)` — pick the best `AgentDef` by matching `task`/`hint` against
  `description` (simple scored keyword match; the model already chose to call this), then
  spawn as above. Returns the chosen agent + `agent_id`.

**Least privilege (req 3):** `tools`/`excludeTools` are passed straight to
`createAgentSession`; **always** add the mailbox/spawn tool names to `excludeTools` unless
`def` opts into nesting, so a subagent can't recurse by default (we already do this with a
hard-coded coding-tools allowlist — generalize it).

**Worktree isolation (req 4):** if `def.isolation === "worktree"`:
1. `git rev-parse --is-inside-work-tree` (skip + warn if not a repo).
2. `wt=$(mktemp -d)/agent-<nick>`; `git worktree add --detach "$wt" HEAD`.
3. spawn with `cwd: wt`.
4. on close: if `git -C "$wt" status --porcelain` is empty → `git worktree remove "$wt"`;
   else keep and report the path (never auto-discard changes — *precision on destructive
   ops*).
   *Drift/failure:* if `worktree add` fails, fall back to `cwd` with a warning, don't abort
   the spawn.

**Identity (req 7):** `{nickname (from a fixed list), role: def.role, color: def.color}`
attached to the record and broadcast on `pi.events` (`cpx:agents`) — the look renders it
(claude-look uses `color`, codex-look uses `[role]`). No contract change needed beyond
adding `color` to the `AgentSummary` shape in `contract.ts`.

**Caps (req 8):** read `maxConcurrent`/`maxDepth` from `.pi/agents.config.json` (optional);
default 4/1 (Codex defaults). Enforce concurrency with a counting semaphore around spawn;
enforce depth by refusing to give nested spawns the spawn tool past `maxDepth`.

### Phase 2 — Live mailbox orchestration (`req 5`)

Add Codex-parity tools over the Phase-1 agents (each an `AgentSession` we keep addressable):
- `send_message(agent_id, message)` — queue-only: store on the record's mailbox; do **not**
  prompt. (Codex `MessageDeliveryMode::QueueOnly`.)
- `followup_task(agent_id, message)` — if idle, `session.prompt(message)`; if running,
  enqueue and flush at next idle (Codex `TriggerTurn`).
- `interrupt(agent_id)` — `session.abort()`, status→`interrupted`, keep addressable.
- `resume(agent_id, message?)` — re-prompt a completed/interrupted session with full history
  (the in-memory `AgentSession` retains it); Codex `resume_agent`.
- `wait_agent` (extend today's): resolve when **any** targeted agent reaches a final status
  **or** a mailbox flush completes, with `timeout_ms`. Implemented by racing each record's
  `turn` promise + a mailbox-update promise.

**Event ordering / two-phase:** a record moves `running→completed` only on the `agent_end`
we observe in `subscribe` (commit), never on prompt-dispatch (about-to-happen). A prompt
that throws sets `errored` in the `.catch`. Mailbox messages delivered while running are
flushed exactly once in the `.finally` idle transition (guard with a "flushing" flag to
avoid double-send).

**Persistence:** mailboxes and records are in-memory (live orchestration is inherently a
running-process concern; both reference CLIs drop it on exit). Documented as such.

### Phase 3 — Permission modes + optional real sandbox (`req 7→9`)

Replace the 3-preset `/permissions` with Claude Code's mode set, enforced in the existing
`tool_call` gate:
`default` (ask on writes/unsafe exec) · `acceptEdits` (auto-allow edits, ask exec) ·
`plan` (block all mutation — pairs with plan mode) · `dontAsk`/`auto` (allow, log) ·
`bypassPermissions` (never ask). Mode is broadcast on `pi.events` (`cpx:policy`) so the
footer shows it (contract already carries approval/sandbox).

**Optional bwrap (Codex's real-sandbox edge):** if `which bwrap` succeeds and mode is
`default`, wrap bash exec in a `bwrap --ro-bind / / --bind <cwd> <cwd> --unshare-net` shell
so writes are confined to cwd and network is off — a genuine OS sandbox when available,
silently skipped otherwise. *Least privilege on children:* subagents inherit the parent's
mode but never a *looser* one.

### Phase 4 — Hooks + file memory (`req 8-hooks,9`)

**Hooks (`.pi/hooks.json`)** mapping declarative rules to pi events:
`{ "PreToolUse": [{ "matcher": "bash", "command": "…" }], "PostToolUse": …,
"SubagentStop": …, "SessionStart": … }`. On the matching pi event
(`tool_call`/`tool_result`/agent lifecycle/`session_start`), run `command` via `pi.exec`;
a non-zero exit on a `PreToolUse` hook `{block:true}`s the tool (Claude-Code semantics).
State: config re-read on reload; nothing else persists.

**Memory (files):** context memory = the existing `AGENTS.md` load (already in `/init`) plus
`.pi/memory/*.md` injected via `before_agent_start` (append to system prompt). Per-agent
`memory: project|user|local` scope selects which memory dir a subagent reads/writes. Durable
by construction (files); rebuilt from disk each run.

### Phase 5 — MCP client + web search (`req 10,11`)  ← largest build

**MCP (`codex-core/src/mcp/*`, new):** read `.pi/mcp.json`
(`{ servers: { name: { command, args, env } } }`); for each, `child_process.spawn` the
server, perform the MCP `initialize` handshake and `tools/list` over stdio JSON-RPC, then
`pi.registerTool` one pi tool per MCP tool whose `execute` proxies `tools/call`. Lifecycle:
spawn on `session_start`, kill on `session_shutdown`; a dead server disables its tools with
a status note (never crashes pi). No third-party SDK — hand-write the framing (Content-Length
headers + JSON) using `node:child_process`.

**Web search (`req 13`):** `registerTool("web_search", …)` with a pluggable backend chosen
from `.pi/websearch.json` (`{ provider, apiKey }` — e.g. an HTTPS search API via global
`fetch`); returns titled snippets. Absent config → the tool reports "web search not
configured" rather than erroring.

### Phase 6 — Collaboration modes + polish (`req 12`)

Add `execute` and `pair` collaboration templates (we ship `plan`) as `before_agent_start`
system-prompt injections, selected by `/mode <name>`; broadcast on `pi:mode` so the footer
shows it. Reuse the existing plan-mode plumbing.

### Keeping the look swappable (`req 13`) — cross-cutting

Every new surface follows the established contract: **core emits data, look renders.** New
custom-message types (`cpx.agentList` already exists as `cpx:agents` event; add
`cpx.mcp` status, `cpx.search` result card) and any new footer/widget state go through
`pi.sendMessage`/`pi.events`; `codex-look` and `claude-look` each add a renderer. No core
code sets a color/border directly.

---

## 5. Deliverable file tree

```
codex-core/
  src/
    agents/
      loader.ts        NEW  — discover+parse .pi/agents/*.md, resolve model, registry
      frontmatter.ts   NEW  — tiny YAML-subset parser (no external dep)
      spawn.ts         ADAPTED from src/subagents.ts — createAgentSession per AgentDef,
                             tools/excludeTools/worktree, nickname/role/color
      mailbox.ts       NEW  — send_message/followup_task/interrupt/resume/wait, two-phase commit
      delegate.ts      NEW  — description-matched auto-delegation tool
      worktree.ts      NEW  — git worktree add/remove via pi.exec, precise cleanup
    permissions.ts     ADAPTED from src/approvals.ts — Claude permission modes + optional bwrap
    hooks.ts           NEW  — .pi/hooks.json → pi events, PreToolUse blocking
    memory.ts          NEW  — AGENTS.md + .pi/memory/*.md system-prompt injection, per-agent scope
    modes.ts           ADAPTED from src/plan.ts — plan/execute/pair collaboration templates
    mcp/
      client.ts        NEW  — stdio JSON-RPC MCP client (node:child_process), handshake, tools/list
      register.ts      NEW  — registerTool per MCP tool, proxy tools/call, lifecycle
    websearch.ts       NEW  — pluggable web_search tool
    contract.ts        ADAPTED — add color to AgentSummary; add cpx.mcp/cpx.search types
    core.ts            ADAPTED — compose the new modules
  assets/
    collab/execute.md  COPIED from codex/codex-rs/collaboration-mode-templates/templates/execute.md
    collab/pair.md     COPIED from …/pair_programming.md
codex-look/src/cards.ts    ADAPTED — renderers for cpx.mcp, cpx.search, agent color
claude-look/src/cards.ts   ADAPTED — same, Claude-styled
tests/
  agents-check.mjs     NEW  — loader parses fixtures; spawn respects tools/model; mailbox two-phase
  mcp-check.mjs        NEW  — stub MCP server over stdio; tools/list→registerTool→tools/call
docs/AGENTS.md         NEW  — how to write a .pi/agents/*.md file (mirrors Claude Code docs)
```

## 6. Changes outside the deliverable

- `README.md` — document `.pi/agents/`, `.pi/hooks.json`, `.pi/mcp.json`, permission modes.
- `contract.ts` is duplicated per package (core + both looks) — the added
  `color`/`cpx.mcp`/`cpx.search` entries must be copied to all three (existing constraint).
- `two-plugin-check.mjs` — extend to assert the new card renderers exist in each look.
- No pi settings.json changes required; all config is extension-local `.pi/*` files.

## 7. Risks & open questions

- **MCP is a full protocol implementation, not wiring** (verified: pi has zero MCP symbols).
  Hand-written stdio JSON-RPC is non-trivial; scope Phase 5 as its own project. *Disposition:
  isolate; ship Phases 1–4 first.*
- **Per-agent model resolution** relies on mapping aliases to ids via `getAll()`; the alias
  set and newest-id choice are heuristic. *Verify during implementation against the
  container's `getAll()` output.*
- **`before_agent_start` fires in subagent sessions too** — memory/mode injection must guard
  so it only augments the *main* session's prompt, not every nested agent (could double-inject).
  *Verify during implementation; gate on a "is main session" flag.*
- **bwrap availability** varies by host/container; treat as opportunistic, never required.
  *Mitigated: feature-detect `which bwrap`, silent fallback.*
- **Worktree cleanup on crash** — a killed CLI leaves worktrees on disk. *Disposition:
  a `/agents gc` command + startup sweep of stale `agent-*` worktrees with empty diffs;
  never auto-remove a dirty worktree.*
- **maxTurns enforcement** — pi has no per-session turn cap; we count `agent_end` events and
  `abort()`. *Verify the count matches turns, not messages.*
- **Concurrency of in-memory subagents** — many parallel `AgentSession`s share the host
  event loop and API rate limits. *Out of scope for v1: cap at `maxConcurrent` (default 4).*
- **No live LLM key in the container** — end-to-end subagent runs are currently unverifiable
  here. *Disposition: verify logic with a stubbed `createAgentSession` (as tests do today);
  flag live-run verification for when a key is available.*

## 8. Verification (executable script)

Run each in the container unless noted. "✅" = expected observable result.

1. **Loader — happy path.** Create `.pi/agents/reviewer.md` (frontmatter: name, description,
   `tools: read, grep`, `model: haiku`). `node tests/agents-check.mjs` → ✅ registry has
   `reviewer`; resolved model id is a real Haiku id from `getAll()`; `createAgentSession`
   called with `tools:["read","grep"]` and the spawn tool in `excludeTools`.
2. **Loader — malformed.** Agent file missing `description` → ✅ skipped with a diagnostic,
   other agents still load (no crash).
3. **Auto-delegate.** Call `delegate("review this diff for bugs")` → ✅ picks `reviewer` by
   description; returns its `agent_id`.
4. **Least privilege.** Spawn `reviewer`; assert the child session's active tools = the
   allowlist and exclude bash/spawn → ✅.
5. **Worktree — git repo.** `isolation: worktree` agent that makes no change → close →
   ✅ worktree removed. One that writes a file → close → ✅ worktree **kept**, path reported,
   user edits elsewhere untouched (precision).
6. **Worktree — non-git dir.** ✅ warns, falls back to cwd, spawn still succeeds.
7. **Mailbox two-phase.** `send_message` to a running agent → ✅ queued, not delivered until
   idle; delivered exactly once (no double-send). `interrupt` mid-run → status `interrupted`,
   still addressable; `resume` → continues with prior history.
8. **wait_agent.** Race two agents + a 200ms timeout → ✅ returns on first final status;
   returns a timeout summary when neither finishes.
9. **Permission modes.** `plan` mode blocks all edit/write/exec; `acceptEdits` auto-allows
   edit but prompts bash; `bypassPermissions` never prompts → ✅ each via the `tool_call`
   harness. With `bwrap` present, a `default`-mode bash write outside cwd is denied by the
   sandbox; **and** re-run on a host without bwrap → ✅ silently falls back (no error).
10. **Hooks.** `.pi/hooks.json` PreToolUse matcher `bash` with a command that exits 1 →
    ✅ the bash tool is blocked with the hook's reason; exit 0 → allowed.
11. **Memory.** Put a note in `.pi/memory/notes.md` → new session → ✅ the note appears in the
    system prompt (assert via `getSystemPrompt()`), and **not** duplicated in a spawned
    subagent's prompt.
12. **MCP.** `node tests/mcp-check.mjs` starts a stub stdio MCP server exposing one tool →
    ✅ that tool is `registerTool`'d and a `tools/call` round-trips; kill the server →
    ✅ tool reports unavailable, pi stays alive.
13. **Web search.** No config → ✅ tool returns "not configured". With a stub backend →
    ✅ returns titled snippets.
14. **Collaboration modes.** `/mode execute` → ✅ footer shows `execute`; `before_agent_start`
    injects the execute template into the **main** prompt only.
15. **Look swap (regression).** `node tests/two-plugin-check.mjs codex-core codex-look` and
    `… claude-look` → ✅ both green; new cpx.mcp/cpx.search cards render in each look; agent
    widget shows nickname/role (codex) / color (claude).
16. **Cleanup.** After the suite: ✅ no orphan MCP child processes, no leftover
    `agent-*` worktrees with empty diffs, no stray temp dirs.

---

### Phasing summary (build order)

1. **Phase 1 — declarative agents** (loader, spawn, delegate, worktree, identity). *Highest
   value, most pi-idiomatic, unblocks everything else.*
2. **Phase 2 — mailbox orchestration** (send/followup/interrupt/resume/wait).
3. **Phase 3 — permission modes** (+ optional bwrap).
4. **Phase 4 — hooks + file memory.**
5. **Phase 5 — MCP client + web search** (largest; isolate).
6. **Phase 6 — collaboration modes + polish.**

Each phase is independently shippable and keeps `codex-look`/`claude-look` swappable.
