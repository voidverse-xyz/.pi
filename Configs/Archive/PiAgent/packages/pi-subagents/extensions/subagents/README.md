# subagents

Two things over one shared set of agent definitions: a **switcher** (pick which
agent *you* are talking to) and an LLM-callable **delegation tool** (the live agent
hands a task to an isolated child agent).

## 1. Switcher — Alt+A or `/agents`

Lists the available agents and switches which one you're talking to. Switching
re-skins **this** session (same conversation thread) — it does **not** spin up a
separate process. The active agent shows on the left of the footer status line:

```
 planner  replace   1      🖴 42% | codex 3h
```

The ` N` (sitemap icon) on the left is the subagent nesting cap for this session
(see §3).

| Trigger             | Effect                                                      |
|---------------------|------------------------------------------------------------|
| **Alt+A**           | Cycle to the next agent (`main` → …agents… → `main`)        |
| `/agents`         | Menu: Switch agent · Task persistence · Nesting depth · Ask-parent limit · Running tasks |
| `/agents running` | List live delegations; pick one to cancel it (see §2)      |
| `/agents <name>`  | Switch to `<name>` directly                                |
| `/agents main`    | Restore the plain Pi agent                                 |
| `/agents new`     | Scaffold a new agent file in `~/.pi/agent/agents/`         |
| `/agents depth`   | Set the subagent nesting cap (see §3)                       |

- Selecting an agent applies its `model`, `tools`, and system prompt for your
  subsequent turns; `main` restores what the session started with.
- The active agent persists as a session entry, so a resume comes back wearing it.
- **Prompt mode** is a property of the agent (frontmatter `mode:`), not asked on
  every switch: `augment` (default — Pi's base prompt + the agent's instructions)
  or `replace` (the agent's body becomes the whole prompt). Only `replace` is
  tagged in the status line.

## 2. Delegation tool — "the live agent hands this off"

An LLM-callable `delegate` tool the main agent uses to delegate a self-contained
task to an agent running in its own isolated child `pi` process. The child runs to
completion and its final output is **returned to the main agent as the tool
result** (so the agent can use it). The parent passes all context through the task
string, so the child starts fresh with just the agent's system prompt + that task.

- **single** — `{ agent, task }`
- **parallel** — `{ tasks: [{ agent, task }, …] }` (max 8, 4 concurrent)
- **chain** — `{ chain: [{ agent, task }, …] }` (sequential, `{previous}` placeholder)

Output streams live (tool calls, progress, per-agent usage). Ctrl+C propagates to
kill the child processes. Adapted from Pi's bundled `subagent` example.

### Session persistence — reuse the same subagent

By default every delegation is one-shot: the child runs `--no-session` and starts
blank each call. Turn on **subagent persistence** to make an agent a *durable
collaborator* for the session instead — the same agent keeps its memory across calls.

| Command                     | Effect                                            |
|-----------------------------|---------------------------------------------------|
| `/agents persistent`      | Toggle persistence for this session               |
| `/agents persistent on`   | Enable                                            |
| `/agents persistent off`  | Disable                                           |

Also available from the `/agents` menu as **Task persistence**. When on, a `persist`
tag shows in the footer next to the active agent.

When enabled, **single-mode** `delegate { agent, task }` runs the agent in its own
persistent child session, keyed by agent name and linked to this session via
`parentSession` (so it appears under this session in `/tree` and the session selector
as `subagent: <name>`). The first call creates it; every later call to the **same
agent** resumes it, so you can hand that agent a series of related tasks without
re-explaining — it remembers what it already did.

- **Scope:** persistence affects **single-agent** delegation only. `parallel` and
  `chain` always run ephemeral — they're fan-out/pipeline patterns, not a durable
  collaborator, and keeping them ephemeral avoids two children writing one session
  file at once. Concurrent single-mode calls to the same agent are serialized.
- **Session-scoped & durable:** the toggle is stored on the session, so `/reload` and
  resume keep it. Nested subagents never persist (the setting is top-level only).
- Persistent agent sessions are ordinary sessions on disk — browse or resume them
  from the session selector like any other.

### Sandboxing — `readOnly` and `allowedPaths` (hard-enforced)

Delegated runs can be sandboxed beyond a `tools:` allowlist. Both knobs live in the
agent's frontmatter **and** as per-call / per-task-item delegate params; the layers
combine so a call (or a nested spawn) can only ever **tighten** — `readOnly` is
sticky once set anywhere, `allowedPaths` intersect.

- **`readOnly: true`** — the child cannot mutate: `edit`/`write` are blocked (and
  excluded from its tool set), and `bash` runs only commands the command-safety
  classifier proves read-only (`ls`, `cat`, `grep`, `rg`, `git status/log/diff`, … —
  no redirections, no command substitution).
- **`allowedPaths: src, docs/api`** — the file tools (`read`, `edit`, `write`, `ls`,
  `find`, `grep`) may only touch paths inside the listed roots (relative entries
  resolve against the run's cwd). `bash` is additionally restricted to read-only
  commands with no `..` traversal whose absolute/`~` path tokens stay inside the
  roots — and is blocked outright when the child's cwd is outside them.

Enforcement is a blocking `tool_call` handler (guard.ts) inside the child process —
the policy travels via `PI_SUBAGENT_READONLY` / `PI_SUBAGENT_ALLOWED_PATHS` env, so
grandchildren inherit it automatically. The child's system prompt states the sandbox
so it works within it instead of retrying blocked calls. Limits: containment is
lexical (a pre-existing symlink inside a root can point outside), and path checks
cover the built-in file tools; bash stays classified regardless.

### Caps — `maxRuntime` and `maxTokens`

Also frontmatter **and** per-call/per-item params (minimum wins when both set):

- **`maxRuntime: 300`** — wall-clock seconds; the child is stopped when exceeded.
- **`maxTokens: 200000`** — cumulative input+output tokens across the child's turns
  (cache traffic excluded).

A capped run isn't discarded: the tool result is labeled (`⏱ … stopped after
exceeding its cap`) and carries the partial output, so the parent can decide whether
to narrow the task and retry.

### Structured output — `outputSchema`

Pass a JSON Schema (single mode, or per task/chain item) and the child is instructed
to make its **final message nothing but conforming JSON**. The parent validates it
(typebox `Value.Check`; markdown fences stripped) and returns the canonical JSON as
the tool result — chain `{previous}` gets the validated JSON too. On a parse or
validation failure the result is an error listing the violations plus the raw
output, so the parent LLM can correct the task and retry.

### Live view & cancel — `/agents running`

While delegations run, the parent LLM is frozen inside the tool call — so cancelling
a runaway child is the **user's** move. The footer shows `▶N` while N children run;
`/agents running` (or the menu's **Running tasks**) lists them (agent, elapsed,
tokens, task) and cancelling one kills just that child. Its task returns
`⛔ cancelled by the user` with partial output — parallel siblings keep going, a
chain stops at that step. (A detached/background mode with an LLM-callable cancel is
a possible follow-up; today the roster is user-facing only.)

## 3. Nesting limits — depth cap + privilege

Delegated children load this same extension, so an unrestricted agent could
otherwise spawn its own subagents without bound. Two guards prevent that:

**Depth cap.** Each `pi` process carries its nesting depth (`PI_SUBAGENT_DEPTH`,
0 at the top-level interactive session) and the cap (`PI_SUBAGENT_MAX_DEPTH`) in
its environment; a process may spawn only while `depth < maxDepth`. The **default
is 1** — the interactive session can delegate, but subagents can't spawn their own.

Configure the cap (persists across sessions):

| Command               | Effect                               |
|-----------------------|--------------------------------------|
| `/agents depth`     | Show the current cap + pick a preset |
| `/agents depth <N>` | Set the cap to `N`                   |

The `/agents` menu exposes the same via **Nesting depth**. Either way the value is
written to `~/.pi/agent/agents-depth.json` and applies to this and future sessions.

Resolution order (top level): config file
(`~/.pi/agent/agents-depth.json`) → hard default `1`. Nested children inherit the
resolved cap from the environment. The effective cap shows in the footer status line
next to the active agent (` N`, sitemap icon).

**Privilege (call-list).** Each agent declares which agents it may delegate to
(frontmatter `canDelegateTo:` — `*` for any, a name list for specific agents, unset for
**none**). A **nested** call may only target an agent on the caller's list, so a
subagent can't reach an agent it wasn't granted. The top-level session is exempt (the
user is in control). Bundled: `worker` may call `scout`, `planner`, `reviewer`; the
specialists call nothing.

**Switcher off in subagents.** The persona switcher (Alt+A / `/agents`) is inert
inside any subagent process (`PI_SUBAGENT_DEPTH > 0`) — a subagent can't re-skin
itself into another persona.

## 4. Pause & ask the parent — `ask_parent`

A subagent that hits a decision above its scope can stop and ask the agent that
delegated to it, instead of guessing. The `ask_parent` tool (extension
`../ask-parent/`) takes `{ summary, question }`; calling it **ends the subagent's
run**. `delegate.ts` detects the `ask_parent` tool call in the child's output stream,
captures the summary + question, cleanly stops the child, and surfaces the pause as
the `delegate` tool result — rendered `⏸`. The **parent agent** (whose turn resumes
when the tool returns) answers from its broader context and delegates a continuation
(same agent, another, or itself), passing the goal + summary + question + answer.

Why "summarize → exit" and not a live round-trip: while a subagent runs, the parent
LLM is frozen inside the `delegate` call and cannot answer; it can only answer once
its turn resumes, i.e. after the child returns. The answer therefore arrives as the
*direct* parent's business — this does **not** bubble to the top-level human (unlike
`ask_user`/command-safety).

**Per-agent allowance, capped per request.** Each agent may call `ask_parent` a limited
number of times per user request. The limit is the agent's own `askLimit:` frontmatter,
or — when it sets none — the **user-configurable default** (`/agents asklimit`, or the
"Ask-parent limit" menu entry; `0` = off). `delegate.ts` counts each agent's asks per
request and, once an agent hits its limit, spawns its re-runs **without** `ask_parent`
(so an ask → answer → re-run → ask loop can't run away); the budget refills on the next
request. Enforcement is the `PI_ASK_PARENT` env flag delegate.ts sets on a spawned child
— the extension registers the tool only when present, so the top-level agent (never
spawned with it) also never sees it.

The default resolves like the depth cap — env → config file (`subagent-asklimit.json`,
written by `/agents asklimit N`) → hard default (1) — and is carried down so nested
parents apply the same default. An agent overrides it with `askLimit:` in its own file
(e.g. `askLimit: 0` to opt a specific agent out).

## Agent definitions

Markdown files with YAML frontmatter, shared by both features:

```markdown
---
name: reviewer
description: Code review specialist
tools: read, grep, find, ls, bash   # optional — omit to inherit all tools
skills: none                         # optional — "none", a skill-name list, or omit to inherit the catalog
model: gpt-5.5                       # optional — bare id or "provider/id"; omit to inherit
mode: replace                        # optional — "replace" or "augment" (default)
canDelegateTo: scout, planner        # optional — agents this one may delegate to ("*"=any; unset=none)
askLimit: 2                          # optional — overrides the /agents asklimit default for this agent (0=off; see §4)
readOnly: true                       # optional — hard read-only sandbox for delegated runs (see §2)
allowedPaths: src, docs/api          # optional — path sandbox for delegated runs (relative → run cwd; see §2)
maxRuntime: 300                      # optional — wall-clock cap in seconds for a delegated run
maxTokens: 200000                    # optional — cumulative input+output token cap for a delegated run
---

System prompt / instructions for the agent go here.
```

**Locations**
- `~/.pi/agent/agents/*.md` — user scope, always loaded.
- `<repo>/.pi/agents/*.md` — project scope; surfaced but **confirmed** before a
  project agent is activated or delegated to (repo-controlled instructions).

Bundled starters: `scout`, `planner`, `reviewer`, `worker`.

## Install

The agent files must live at `~/.pi/agent/agents/`. In this workspace they are kept
in the top-level `Subagents/` directory (the repo convention for reusable agent
definitions) and symlinked into place. Run from the workspace root:

```bash
ln -sfn "$PWD/Subagents" ~/.pi/agent/agents
```

(`extensions/` and `themes/` are still symlinked from this bundle's `.pi/agent/`;
only the agent definitions were hoisted out to `Subagents/`.)

Then `/reload` (restart Pi once so the Alt+A shortcut registers).

## Notes / limits

- Switching swaps model/tools/prompt only; it does **not** fork conversation
  history — you keep talking in the same thread.
- `mode: replace` drops Pi's base prompt entirely (tool docs, environment). The
  tools still work; the agent just isn't told about them, so write replace-mode
  prompts to be self-contained.
- The delegation tool runs real child `pi` turns (tokens/cost) and returns each
  child's final output to the main agent. Parallel is capped at 8 tasks /
  4 concurrent; per-task model-visible output capped at 50 KB.
- Subagent nesting is capped (default depth 1 = no nesting) and privilege-gated —
  see §3. Raise the cap with `/agents depth` if you want subagents to delegate.
