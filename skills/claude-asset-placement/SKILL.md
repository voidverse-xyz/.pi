---
name: claude-asset-placement
description: Where to put agent/Claude assets that must be committed (skills, prompts, configs) vs. kept machine-local. Use whenever creating, moving, or committing Claude/agent files in a repo, or before staging anything under .claude/.
---

# Claude Asset Placement: commit from `Agents/`, never from `.claude/`

`.claude/` is **machine-local and gitignored** — it holds per-machine settings
(`settings.local.json`), local symlinks, and harness state. **Never commit anything
from `.claude/`** and never `git add .claude/...`.

Committed agent assets — skills, prompt templates, agent definitions, anything that
should travel with the repo to GitHub — live in a top-level **`Agents/`** directory
instead:

- `Agents/skills/<skill-name>/SKILL.md` — committed skills (source of truth).
- `Agents/...` — any other shareable agent/Claude assets.

## When creating or moving a shareable Claude file

1. Put it under `Agents/` (e.g. `Agents/skills/`), **not** `.claude/`.
2. If it already exists under `.claude/`, `git mv` it into `Agents/`.
3. Make sure `.gitignore` ignores `.claude/` (the whole dir), so local-only files
   never leak. Personal/machine config stays in `.claude/` and is never committed.
4. Point the repo's `CLAUDE.md` at `Agents/` so agents know where the assets live.

## Keeping skills auto-discoverable locally

Claude Code only auto-loads skills from `.claude/skills/`. To use the committed
`Agents/skills/` as real invokable skills on your machine, symlink it:

```
ln -s ../Agents/skills .claude/skills   # gitignored, per-machine
```

Some filesystems don't support symlinks (`ln` → "Operation not supported"). When that
happens, skip the symlink — the skills still work as **reference** via the `CLAUDE.md`
pointer; they just won't auto-register as `Skill` tools in that checkout.

## Mirror of the user-level setup

Same split globally: `~/.claude/` is machine-local; this portable Pi global
configuration keeps canonical shared skills in `~/.pi/agent/skills/`. When the
same skills should be available to Claude Code, use a machine-local
`~/.claude/skills` symlink or copy and keep it untracked.

## Why this exists

Committing from `.claude/` mixes machine-local config (settings, tokens, paths) into
the repo and risks leaking it. Keeping the committed source of truth in `Agents/` and
gitignoring `.claude/` keeps the boundary clean. See also the `privacy` skill.
