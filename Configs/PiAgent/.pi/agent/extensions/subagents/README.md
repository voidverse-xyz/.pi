# subagents

Two things over one shared set of agent definitions: a **switcher** (pick which
agent *you* are talking to) and an LLM-callable **delegation tool** (the live agent
hands a task to an isolated child agent).

## 1. Switcher — Alt+A or `/subagent`

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
| `/subagent`         | Menu: Switch agent · Nesting depth · Default nesting depth  |
| `/subagent <name>`  | Switch to `<name>` directly                                |
| `/subagent main`    | Restore the plain Pi agent                                 |
| `/subagent new`     | Scaffold a new agent file in `~/.pi/agent/agents/`         |
| `/subagent depth`   | Set the subagent nesting cap for this session (see §3)      |

- Selecting an agent applies its `model`, `tools`, and system prompt for your
  subsequent turns; `main` restores what the session started with.
- The active agent persists as a session entry, so a resume comes back wearing it.
- **Prompt mode** is a property of the agent (frontmatter `mode:`), not asked on
  every switch: `augment` (default — Pi's base prompt + the agent's instructions)
  or `replace` (the agent's body becomes the whole prompt). Only `replace` is
  tagged in the status line.

## 2. Delegation tool — "the live agent hands this off"

An LLM-callable `subagent` tool the main agent uses to delegate a self-contained
task to an agent running in its own isolated child `pi` process. The child runs to
completion and its final output is **returned to the main agent as the tool
result** (so the agent can use it). The parent passes all context through the task
string, so the child starts fresh with just the agent's system prompt + that task.

- **single** — `{ agent, task }`
- **parallel** — `{ tasks: [{ agent, task }, …] }` (max 8, 4 concurrent)
- **chain** — `{ chain: [{ agent, task }, …] }` (sequential, `{previous}` placeholder)

Output streams live (tool calls, progress, per-agent usage). Ctrl+C propagates to
kill the child processes. Adapted from Pi's bundled `subagent` example.

## 3. Nesting limits — depth cap + privilege

Delegated children load this same extension, so an unrestricted agent could
otherwise spawn its own subagents without bound. Two guards prevent that:

**Depth cap.** Each `pi` process carries its nesting depth (`PI_SUBAGENT_DEPTH`,
0 at the top-level interactive session) and the cap (`PI_SUBAGENT_MAX_DEPTH`) in
its environment; a process may spawn only while `depth < maxDepth`. The **default
is 1** — the interactive session can delegate, but subagents can't spawn their own.

Configure the cap per session (or set a cross-session default):

| Command                      | Effect                                              |
|------------------------------|-----------------------------------------------------|
| `/subagent depth`            | Show the current cap + pick a preset (this session) |
| `/subagent depth <N>`        | Set this session's cap to `N`                       |
| `/subagent depth global <N>` | Set the cross-session default (`subagent-depth.json`) |

The `/subagent` menu exposes the same two without typing: **Nesting depth** (this
session) and **Default nesting depth** (the file).

Resolution order (top level): per-session override → global default file
(`~/.pi/agent/subagent-depth.json`) → hard default `1`. Nested children inherit the
resolved cap from the environment. The effective cap shows in the footer status line
next to the active agent (` N`, sitemap icon).

**Privilege (call-list).** Each agent declares which agents it may delegate to
(frontmatter `canCall:` — `*` for any, a name list for specific agents, unset for
**none**). A **nested** call may only target an agent on the caller's list, so a
subagent can't reach an agent it wasn't granted. The top-level session is exempt (the
user is in control). Bundled: `worker` may call `scout`, `planner`, `reviewer`; the
specialists call nothing.

**Switcher off in subagents.** The persona switcher (Alt+A / `/subagent`) is inert
inside any subagent process (`PI_SUBAGENT_DEPTH > 0`) — a subagent can't re-skin
itself into another persona.

## Agent definitions

Markdown files with YAML frontmatter, shared by both features:

```markdown
---
name: reviewer
description: Code review specialist
tools: read, grep, find, ls, bash   # optional — omit to inherit all tools
model: gpt-5.5                       # optional — bare id or "provider/id"; omit to inherit
mode: replace                        # optional — "replace" or "augment" (default)
canCall: scout, planner              # optional — agents this one may delegate to ("*"=any; unset=none)
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
  see §3. Raise the cap with `/subagent depth` if you want subagents to delegate.
