---
name: use-claude
description: Delegate work to the locally installed Claude Code CLI from Codex. Use when the user asks Codex to use Claude, consult Claude, delegate implementation or review work to Claude, get an independent second pass, or run Claude Code inside the VM; the workflow always tells Claude to read AGENTS.md/agents.md from the project level or the user's home level before doing work.
---

# Use Claude

## Overview

Use the local `claude` CLI as a delegated worker or second reviewer. Always ensure Claude is told to read `AGENTS.md`, `agents.md`, or `Agents.md` at the project level first, falling back to the user's home directory (`$HOME`) when no project-level instruction file is found.

## Quick Start

Prefer the bundled wrapper so AGENTS.md discovery is handled consistently:

```bash
/path/to/use-claude/scripts/run_claude.sh --workdir /path/to/repo -- "Review the current diff for correctness risks."
```

If invoking Claude directly, use non-interactive mode and include the project-level or home-level AGENTS.md instruction in the prompt:

```bash
claude -p "Before doing any work, read and follow AGENTS.md/agents.md at the project level or home user level if present. Task: <task>"
```

## Workflow

1. Verify `claude` is available with `command -v claude` when the environment is unfamiliar.
2. Run Claude from the relevant repository or task directory.
3. Use `scripts/run_claude.sh` for normal delegation. Pass a specific task, expected output, and any constraints Claude must respect.
4. Treat Claude output as another engineer's work: inspect suggested commands, patches, and conclusions before applying them or reporting them to the user.
5. If Claude changes files, review the resulting diff and run the same verification you would run for Codex-authored edits.

## Guardrails

- Do not pass secrets, tokens, private credentials, or irrelevant sensitive files into a Claude prompt.
- Do not ask Claude to bypass permissions or run destructive commands unless the user explicitly requested that behavior and approved it.
- Keep Claude prompts concrete: name the files, tests, errors, or diffs Claude should inspect.
- Ask Claude for independent analysis when reviewing a bug or design; avoid telling it your expected answer unless the goal is implementation from a fixed spec.

## Script

`scripts/run_claude.sh`:

- Accepts `--workdir DIR` to run Claude in a specific project directory.
- Reads the task from command-line arguments, or from stdin when no prompt arguments are provided.
- Searches for `AGENTS.md`, `agents.md`, or `Agents.md` at the project/workdir level by walking upward from the working directory.
- Falls back to the home user level by checking `$HOME/AGENTS.md`, `$HOME/agents.md`, and `$HOME/Agents.md`.
- Prepends a mandatory instruction telling Claude to read that file before doing work, or to state that no project-level or home-level instruction file was found.
