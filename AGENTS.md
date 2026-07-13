# Agent Instructions

Cross-project defaults for agents working on this machine.

## Public And Outbound Content

Treat anything written outside the local working context as potentially public and
long-lived. Before writing PR descriptions, commit messages, issue bodies, review
comments, docs, or content sent to an external service:

- Do not name ignored, redacted, local-only, or environment files, and do not
  describe what was excluded.
- Do not include home paths, private network addresses, unrelated projects,
  secrets, tokens, credentials, personal contact details, or account identifiers.
- Keep local-only details in chat with me, not in public artifacts.
- Do not put my personal email or contact details into commands, headers, code,
  config, logs, telemetry, User-Agent strings, or external requests. Use a neutral
  placeholder such as `noreply@example.com`, or omit the field.

## Git And GitHub

- Default branch is `main`. Use `develop` for integration when the project has
  that branch, and open PRs into `main` unless project instructions say otherwise.
- Use the `gh` CLI for GitHub operations.
- Commit or push only when I ask.
- Do not add agent attribution, session trailers, generated-by footers, internal
  model details, or tool runtime details to commits, PRs, issues, or review
  comments.

## Local Organization

- Reusable context lives in this file.
- Reusable skills, MCP definitions, workflows, subagents, and related agent
  documents live in sibling directories alongside this file, including:

- `Codex/` for Codex configs, local plugin sources, and plugin marketplace metadata
- `Configs/` for non-Codex local agent tool configs and setup bundles
- `Plans/` for reusable, project-agnostic plans and operating notes
- `Skills/`
- `MCP/`
- `Workflows/`
- `Subagents/`

When the user asks about a skill, workflow, MCP definition, or subagent, check
these sibling directories in this workspace before checking global or installed
agent locations.

When editing or updating reusable agent materials, update the sibling
directories alongside this file, such as `Skills/`, `MCP/`, `Workflows/`, and
`Subagents/`.

Keep reusable or project-agnostic material in the shared directories. Keep
host-specific tool configuration under `Configs/` or `Codex/Configs/`, and do
not add auth tokens, session logs, caches, local history, or runtime databases
there.

When creating local Codex plugins for this workspace, scaffold plugin source
directories into `Codex/Plugins/plugins/`. For marketplace-backed plugins, use
`Codex/Plugins/marketplace.json` as the workspace marketplace file.

## Reusable Artifact Capture

When an agent creates or substantially improves a plan, skill, workflow,
subagent, MCP definition, Codex plugin pattern, setup procedure, or related
agent material for a project, also create a generic reusable version and save it
in this repository under the matching shared directory.

The reusable version must be project-agnostic and host-agnostic. Remove or
generalize project names, repo names, customer names, home paths, hostnames,
LAN addresses, account identifiers, credentials, tokens, private URLs, local
ports that only apply to one setup, generated logs, and environment-specific
state. Use placeholders such as `<project-root>`, `<service-name>`,
`<workspace>`, or `noreply@example.com` when an example needs a value.

Route reusable materials by type:

- Plans and operating notes go in `Plans/`.
- Skills go in `Skills/`.
- Workflows go in `Workflows/`.
- Subagents or agent definitions go in `Subagents/`.
- MCP definitions and notes go in `MCP/`.
- Codex plugin source or patterns go in `Codex/Plugins/`.
- Non-Codex setup/config patterns go in `Configs/`.

If the project-specific artifact is not safe to preserve directly, write a short
generic pattern or procedure instead of copying sensitive or local-only content.

## Project Agent Documentation

When creating a new project, working in an existing project, or refactoring a
project, create and maintain a project-local `docs/agents/` directory. Any plan,
skill, workflow, subagent, MCP note, implementation note, memory, review note,
setup note, or similar agent-generated material that is useful for the project
must be written to disk there, not only left in chat.

Use this project-local layout:

- `docs/agents/plans/<domain>/<plan-name>/<plan-name>.md`
- `docs/agents/skills/<domain>/<skill-name>/<skill-name>.md`
- `docs/agents/workflows/<domain>/<workflow-name>/<workflow-name>.md`
- `docs/agents/subagents/<domain>/<subagent-name>/<subagent-name>.md`
- `docs/agents/mcp/<domain>/<mcp-name>/<mcp-name>.md`
- `docs/agents/notes/<domain>/<note-name>/<note-name>.md`
- `docs/agents/memories/<domain>/<memory-name>/<memory-name>.md`

Use lowercase hyphen-case for `<domain>` and artifact names. Pick a domain that
describes the work area, such as `frontend`, `backend`, `auth`, `deployment`,
`testing`, `data`, `design`, `ops`, or `general`.

For example, a build plan for a backend API should be saved as:

`docs/agents/plans/backend/api-build-plan/api-build-plan.md`

Project-local artifacts may include project-specific details, but must still
exclude secrets, credentials, private keys, auth tokens, local-only absolute
paths, personal contact details, and generated logs. When an artifact also has
reusable value beyond the project, save a sanitized generic version in this
shared repository using the `Reusable Artifact Capture` rules above.

## Directory Map

- `AGENTS.md`: instructions agents read before working in this repository.
- `Codex/`: Codex configs, local plugin source directories, and plugin marketplace metadata.
- `Configs/`: non-Codex local agent tool configs and setup bundles.
- `MCP/`: reusable MCP definitions and notes.
- `Plans/`: reusable plans, procedures, and operating notes.
- `Skills/`: shared skill packages and source material.
- `Subagents/`: reusable subagent definitions.
- `Workflows/`: reusable agent workflows.

## Codex Layout

- `Codex/Configs/`: Codex configuration. On this host, `~/.codex/config.toml`
  points to `Codex/Configs/config.toml`.
- `Codex/Plugins/marketplace.json`: Codex plugin marketplace metadata when
  marketplace-backed plugins exist.
- `Codex/Plugins/plugins/<plugin-name>/`: local Codex plugin source directory.

## PiAgent Layout

- `Configs/Archive/PiAgent/packages/`: archive for the 19 Pi extension packages
  moved on 2026-07-09. Pi no longer loads them; `~/.pi/agent/settings.json`
  has an empty `packages` list. The extension descriptions below are historical.
- `Configs/PiAgent/.pi/agent/skills/`: source of truth for the `plan-commit`
  skill.
  `clear-alias` (added 2026-07-07) registers `/clear` as a muscle-memory alias
  for `/new` using `ctx.newSession()`, so existing session-switch hooks still
  apply.
  `command-safety` gates agent `bash` commands by category (destructive /
  network / exec / other) with countdown confirmations and a `/safety off|on|max`
  mode; `max` (default) confirms everything except a read-only safe-list (ls,
  cat, grep, git status/log/diff, …), `on` confirms destructive only, `off`
  none. It persists that mode to `~/.pi/agent/command-safety.json` (real home,
  untracked), which is also where the startup default is configured. Only the
  agent's `bash` tool calls are gated, not user-typed `!` commands.
  `pi-git-status` publishes cwd + Git state and `pi-model-thinking` publishes
  the selected model + thinking level through reserved `setStatus` keys.
  `pi-status-line` owns their shared above-editor row — Git pinned left and
  model/thinking pinned right, with Git truncated first when narrow — plus its
  two-line footer. Git includes repo/branch, worktree name, in-progress operation
  (rebase/merge/cherry-pick/revert/bisect), and conflict/dirty/ahead/behind/stash
  counts only when relevant. The active Codex theme grades thinking levels from
  gray (off) through blue and purple to red (max).
  `pi-tool-monitor` tracks tool calls via `tool_execution_start/update/end` and
  publishes plain running-tool text under a reserved status key. `pi-agents`
  likewise publishes plain subagent activity. `pi-status-line` styles and places
  both: tool activity uses footer line 1-left when subagent status is absent and
  moves to line 2-left when subagent status occupies line 1. `/tools` opens a
  full-screen overlay (inset via `overlayOptions.margin`) to browse running/recent
  calls, inspect live output, and abort the whole turn with `ctx.abort()` (Pi has
  no per-tool-call cancel).
  `session-merge` (added 2026-07-05) provides `/merge`, a synthesis merge for
  selected session branches: it summarizes the shared base plus branch deltas
  into a visible custom message in a new session, optionally drafts or runs a
  kickoff prompt, and leaves source branches intact.
  `notify-user` (added 2026-07-05 as `user-summary`; renamed 2026-07-06)
  provides the LLM-callable `notify_user` tool: an end-of-turn notice rendered
  as a custom message with optional `title`, `successes`, `info`, `warnings`,
  and `errors` bands, color-banded by `severity` (`success|info|warning|error`,
  inferred when omitted), plus an optional `urgent` immediate toast. There is no
  `summary` field (removed 2026-07-07, no back-compat) and no demo command. The
  bands have top/bottom padding and muted backgrounds.
  `changes` (added 2026-07-05) tracks the *main agent's own* `edit`/`write`
  file changes this session via `tool_call`/`tool_execution_end`, persisting
  first-touch pre-image baselines as `changes.baseline`/`changes.touch` session
  entries (so they survive `/reload` and resume). `/changes` opens a full-screen
  overlay to browse per-file diffs (git-free, via the SDK's
  `generateUnifiedPatch`) and syntax-highlighted file contents (`highlightCode`),
  ask about a change (routed to the main agent via `sendUserMessage`, or to an
  isolated read-only child `pi` whose answer streams into the overlay), and undo
  a file precisely (baseline restore; delete for agent-created files;
  best-effort inverse edit replay when the baseline predates the extension).
  Works in non-git directories; nothing here shells out to git. Bash-made
  changes are out of scope by design.
- `Configs/PiAgent/.pi/agent/themes/`: source of truth for custom Pi themes
  (`black-white`, a grayscale theme, added 2026-07-03).
- `~/.pi/agent/extensions` is a dangling legacy symlink; no legacy extensions
  are present. `~/.pi/agent/themes` is symlinked to
  `Configs/PiAgent/.pi/agent/themes/`. Re-run `pi`'s `/reload` (or restart)
  after changing a skill or theme.

## Working Style

- If something I ask for is technically wrong or impossible, say so and propose a
  workable approach.
- When giving me app or server URLs in chat, use this machine's LAN IP instead of
  `localhost`, because I often access local services from other devices.
- When giving me an app URL for a project with any kind of login, include working
  demo credentials when available: email, password, and role. Source them from
  the project's seed/demo data or fixtures. If they require a seed step that may
  not have run, say so and offer to run it.
