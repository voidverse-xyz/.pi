# subagents

Two complementary ways to use specialized agents in Pi, over one shared set of
agent definitions.

## 1. Foreground switcher — "who am I talking to"

The footer status line lists every agent as a chip on its left, active one
highlighted (`main` = the plain Pi agent), sharing the line with the context /
token / other-extension statuses on the right:

```
agent  main · scout · planner · reviewer · worker  augment      🖴 42% | codex 3h
```

The highlighted chip is the only active-agent indicator (no separate row, no
duplicate). This is wired via `setStatus` + the `status-line` extension.

- **Alt+A** or **`/subagent`** opens a keyboard picker.
- Selecting an agent re-skins *this* session: its `model`, `tools`, and system
  prompt take over for your subsequent turns.
- At switch time you choose, in the TUI, how the agent's instructions apply:
  - **Augment** — keep Pi's base prompt, append the agent's instructions.
  - **Replace** — the agent's markdown body becomes the entire system prompt.
- **`/subagent main`** (or `off`/`none`) restores the model, tools, and prompt the
  session started with.
- The active agent + mode persist as a session entry, so a resumed session comes
  back wearing the same agent.

### `/subagent` subcommands

| Command             | Effect                                                   |
|---------------------|----------------------------------------------------------|
| `/subagent`         | Open the picker                                           |
| `/subagent <name>`  | Switch to `<name>` (asks augment/replace)                |
| `/subagent main`    | Restore the plain Pi agent                               |
| `/subagent new`     | Scaffold a new agent file in `~/.pi/agent/agents/`       |
| `/subagent list`    | List discovered agents                                   |

## 2. Delegation tool — "hand this off"

An LLM-callable `subagent` tool the main agent uses to delegate a self-contained
task to an agent running in its own isolated `pi` process. The parent passes all
context through the task string, so the child starts fresh with just the agent's
system prompt + that task.

- **single** — `{ agent, task }`
- **parallel** — `{ tasks: [{ agent, task }, …] }` (max 8, 4 concurrent)
- **chain** — `{ chain: [{ agent, task }, …] }` (sequential, `{previous}` placeholder)

Output streams live (tool calls, progress, per-agent usage). Ctrl+C propagates to
kill the child processes. Adapted from Pi's bundled `subagent` example.

## Agent definitions

Markdown files with YAML frontmatter, shared by both features:

```markdown
---
name: reviewer
description: Code review specialist
tools: read, grep, find, ls, bash   # optional — omit to inherit all tools
model: gpt-5.5                       # optional — bare id or "provider/id"; omit to inherit
---

System prompt / instructions for the agent go here.
```

**Locations**
- `~/.pi/agent/agents/*.md` — user scope, always loaded.
- `<repo>/.pi/agents/*.md` — project scope; surfaced but **confirmed** before a
  project agent is activated or delegated to (repo-controlled instructions).

Bundled starters: `scout`, `planner`, `reviewer`, `worker`.

## Install

The agent files must live at `~/.pi/agent/agents/`. In this repo they are kept in
`.pi/agent/agents/` and symlinked into place alongside `extensions/` and `themes/`:

```bash
ln -sfn "$PWD/.pi/agent/agents" ~/.pi/agent/agents
```

Then `/reload` (restart Pi once so the Alt+A shortcut registers).

## Notes / limits

- Switching swaps model/tools/prompt only; it does **not** fork conversation
  history — you keep talking in the same thread.
- Full-replace mode drops Pi's base prompt entirely (tool docs, environment). The
  tools still work; the agent just isn't told about them, so write replace-mode
  prompts to be self-contained.
- Delegation runs real child `pi` turns (tokens/cost). Parallel is capped at 8
  tasks / 4 concurrent; per-task model-visible output capped at 50 KB.
