# pi-codex — Codex functionality for pi, with swappable looks

Turn bare-bones [pi](https://github.com/earendil-works/pi) into [OpenAI Codex CLI](https://github.com/openai/codex) — or Claude Code — using **separately-exportable plugins**. One plugin owns the *functionality*; a second, swappable plugin owns the *look*.

```
codex-core   ← functionality (commands, approvals, subagents, plan, review)
   +
codex-look   ← Codex appearance      ⇄   claude-look  ← Claude Code appearance
```

Load `codex-core` plus **exactly one** look. Swap the look plugin and only the appearance changes — every command, tool, and behavior stays identical.

## Install

Each package is self-contained (no cross-package imports) and drops into any pi extensions directory:

```bash
# Codex look:
cp -r codex-core  ~/.pi/agent/extensions/codex-core
cp -r codex-look  ~/.pi/agent/extensions/codex-look

# …or the same functionality with the Claude Code look — swap the look package:
cp -r codex-core  ~/.pi/agent/extensions/codex-core
cp -r claude-look ~/.pi/agent/extensions/claude-look
```

Targets published **`@earendil-works/pi-coding-agent` 0.80.3**.

## How the split works

`codex-core` renders nothing. It emits **semantic cards** as custom messages and broadcasts state on pi's shared **event bus**; the loaded look plugin registers renderers for those cards and paints the chrome. The entire contract is a handful of strings in `contract.ts` (duplicated verbatim in each package so they stay independent):

| Core emits | Look renders |
|---|---|
| `cpx.status` / `cpx.diff` / `cpx.plan` / `cpx.review` / `cpx.agentResult` (custom messages) | its own card style |
| `cpx:mode` / `cpx:policy` / `cpx:goal` / `cpx:agents` (event bus) | footer, widgets |

Because the look owns the theme, header, footer, working indicator, composer, tool rendering, and card renderers, a look plugin fully re-skins pi. Because the core owns commands, tools, approvals, subagents, plan, and review, functionality is untouched by the swap.

## Packages

- **`codex-core/`** — `/status /diff /init /mention /goal /personality /permissions /plan /review /agents /agent /subagents`; approval gate + sandbox policy; **declarative subagents** (`.pi/agents/*.md`) via `spawn_agent`/`delegate`/`wait_agent`/`list_agents`/`interrupt_agent`/`close_agent`; `update_plan` + Plan Mode; nested-session code review.

### Declarative subagents (`.pi/agents/*.md`)

Define specialists as Markdown files with YAML frontmatter (Claude Code's model), in
`<project>/.pi/agents/` or `~/.pi/agents/`:

```markdown
---
name: code-reviewer
description: Use to review a code diff for correctness bugs and security issues
tools: read, grep, find        # allowlist (omit to inherit default coding tools)
disallowedTools: bash          # denylist
model: haiku                   # opus|sonnet|haiku|fable | <full-id> | inherit
isolation: worktree            # optional: run in an isolated git worktree
role: reviewer
color: cyan
---
You are a meticulous code reviewer…
```

The model routes to them via `delegate` (auto-pick by `description`) or `spawn_agent`
(by name). Each runs in its own in-memory session with only its declared tools/model,
optionally in a git worktree (removed on close only if clean — a dirty worktree is kept).
`/agents` lists what's defined and inspects live ones. Edit a file → effective next session.
- **`codex-look/`** — Codex CLI look: `>_ OpenAI Codex` header, `<model> <mode> · <cwd>` footer, shimmering **Working**, shaded `›` composer, Codex tool rendering (`• Ran`/`Edited`, `└`), codex-dark/light themes.
- **`claude-look/`** — Claude Code look: `✻ Welcome to Claude Code` header, rounded `>` composer, `⏺`/`⎿` tool rendering, orange sparkle + gerund working indicator, claude-dark/light themes.

`codex-pi/` is the original single-package build, kept for reference.

## Development

```bash
# Contract test: load a core + a look together, drive core→look end-to-end
node tests/two-plugin-check.mjs codex-core codex-look
node tests/two-plugin-check.mjs codex-core claude-look

# Live screenshot of either combination
./screenshot.sh out.png
```
