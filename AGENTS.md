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

This repository is both the shared reusable-material workspace and a portable Pi
global configuration. Its root is designed to be cloned directly to
`~/.pi/agent`. Keep `AGENTS.md` at this root with its exact uppercase filename;
Pi loads `~/.pi/agent/AGENTS.md` as global instructions.

- `settings.json`, `keybindings.json`, `skills/`, and `subagents/` are active
  global Pi configuration.
- `configs/pi-agent/packages/` contains the local Pi packages enabled by relative
  paths from root `settings.json`.
- Machine-local and sensitive state is ignored; never commit it.
- Name repository-owned directories with lowercase hyphen-case. Preserve the
  published casing of vendored assets and external specification directories.
- Reusable context lives in this file.
- Other reusable materials live in sibling directories alongside this file:
  - `codex/` for Codex configs, local plugin sources, and marketplace metadata
  - `configs/` for non-Codex tool configs and setup bundles
  - `plans/` for reusable project-agnostic plans and operating notes
  - `skills/` for global Pi skills and reusable skill packages
  - `mcp/` for MCP definitions and notes
  - `procedures/` for reusable Markdown procedures
  - `subagents/` for reusable definitions shared by Pi Subagents and Pi Teams

When the user asks about a skill, procedure, MCP definition, or subagent, check
these repository directories before checking other global or installed locations.
`subagents/` is the single source of truth for production definitions used by
both runtimes; do not create a separate root `teams/` definition library.

Keep reusable or project-agnostic material in the shared directories. Keep
host-specific tool configuration under `configs/` or `codex/configs/`, and do
not add auth tokens, session logs, caches, local history, or runtime databases.

When creating local Codex plugins for this workspace, scaffold plugin source
directories into `codex/plugins/plugins/`. For marketplace-backed plugins, use
`codex/plugins/marketplace.json` as the workspace marketplace file.

## Reusable Artifact Capture

When an agent creates or substantially improves a plan, skill, procedure,
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

- Plans and operating notes go in `plans/`.
- Skills go in `skills/`.
- Markdown procedures go in `procedures/`; executable saved Pi procedures
  use root `procedures/*.js` only when that library is intentionally created.
- Definitions used by Pi Subagents or Pi Teams go in the shared `subagents/`
  library.
- MCP definitions and notes go in `mcp/`.
- Codex plugin source or patterns go in `codex/plugins/`.
- Non-Codex setup/config patterns go in `configs/`.

If the project-specific artifact is not safe to preserve directly, write a short
generic pattern or procedure instead of copying sensitive or local-only content.

## Project Agent Documentation

When creating a new project, working in an existing project, or refactoring a
project, create and maintain a project-local `docs/agents/` directory. Any plan,
skill, procedure, subagent, MCP note, implementation note, memory, review note,
setup note, or similar agent-generated material that is useful for the project
must be written to disk there, not only left in chat.

Use this project-local layout:

- `docs/agents/plans/<domain>/<plan-name>/<plan-name>.md`
- `docs/agents/skills/<domain>/<skill-name>/<skill-name>.md`
- `docs/agents/procedures/<domain>/<procedure-name>/<procedure-name>.md`
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

For this shared repository, keep the top-level `skills/`, `plans/`, `procedures/`,
`subagents/`, `mcp/`, and `configs/` directories reusable and project-agnostic.
Do not place project-specific artifacts in a root `docs/agents/` tree here;
instead, put them under the relevant contained project's own documentation tree,
such as `configs/pi-agent/docs/agents/` for PiAgent-specific work.

## Directory Map

- `AGENTS.md`: global and repository agent instructions.
- `settings.json`: portable Pi settings with relative local-package paths.
- `keybindings.json`: portable global Pi keybindings.
- `skills/`: auto-discovered global Pi skills and reusable skill packages.
- `subagents/`: shared global definitions for `pi-subagents` and `pi-teams`.
- `codex/`: Codex configs, local plugin sources, and marketplace metadata.
- `configs/`: non-Codex tool configs, active Pi packages, and setup materials.
- `mcp/`: reusable MCP definitions and notes.
- `plans/`: reusable plans, procedures, and operating notes.
- `procedures/`: reusable Markdown procedures.

## Codex Layout

- `codex/configs/`: Codex configuration. On this host, `~/.codex/config.toml`
  points to `codex/configs/config.toml`.
- `codex/plugins/marketplace.json`: Codex plugin marketplace metadata when
  marketplace-backed plugins exist.
- `codex/plugins/plugins/<plugin-name>/`: local Codex plugin source directory.

## PiAgent Layout

- `configs/pi-agent/packages/` is the source of truth for active package-backed
  Pi extensions. Root `settings.json` enables them with portable relative paths.
- Root `skills/` is the canonical global skill library. The old inactive
  `plan-commit` export and superseded package snapshots were removed from the
  tracked clone and preserved locally in the migration quarantine.
- `pi-plan` provides four branch-persistent states: unrestricted Off plus
  hard-restricted Discuss, Plan, and Quick modes via `/discuss`, `/plan`, `/quick`,
  and an `Off → Discuss → Plan → Quick → Off` `Shift+Tab` cycle. Quick is concise
  chat (normally 1–4 sentences) with only trusted read tools; Discuss has normal
  response length with read tools plus `ask_user`/`show_files`; Plan keeps tagged
  `plan-template: true` routing, `/plan --skill <name> <task>`, and authorized
  `save_plan`. Plan may use only
  fresh ad-hoc one-shot `pi-subagents` workers whose coding tools are forced to
  `read`/`grep`/`find`/`ls`; follow-up/control calls are scoped to Plan-created
  workers. The shared base instructions live in `skills/plan/`.
- `pi-mcp-client` loads machine-local `mcp.json` server definitions, launches
  local stdio MCP servers per session with a minimal environment, and exposes
  namespaced `mcp_*` tools. Calls confirm by default; large catalogs use
  `mcp_search_tools`, unsupported client callbacks fail closed, and
  `session_shutdown` owns process cleanup. Remote HTTP, resources, prompts,
  roots, sampling, elicitation, and MCP tasks are intentionally out of scope.
- `pi-codex-image-generation` exposes `image_generation` for creating or editing
  image files through Codex native image generation and the existing ChatGPT
  login. Each call uses a clean temporary Codex home and ephemeral image-only
  app-server thread, accepts up to four explicit source images, confines atomic
  output writes to the current working directory, and returns an inline preview.
- `pi-timers` gives only the owning main agent a `manage_timers` tool for up to
  five in-process recurring wake-ups. Each timer fires after one full interval,
  coalesces overlapping ticks until the main agent settles, repeats until
  cancellation by default, and may use an optional uncapped finite run limit.
  Timers are cleared on reload, session replacement, or exit.
  A live above-editor tree shows countdowns, run progress, and pending/coalesced
  state; `Alt+R` opens its cancellation picker. `/timers` lists or cancels active
  timers; subagents and procedure workers load no extensions and cannot access
  the tool.
- `pi-clear` registers `/clear` as a muscle-memory alias for `/new` using
  `ctx.newSession()`, so existing session-switch hooks still apply.
  `pi-sessions` registers `/sessions` as an alias for `/resume`, reusing Pi's
  native session selector and switching through `ctx.switchSession()`.
  `pi-prune` registers `/prune`, which replaces the current session through the
  same lifecycle-safe API, then moves the previous session file to trash (or
  permanently deletes it when trash is unavailable).
- `pi-safety` gates agent `bash` commands by category with countdown
  confirmations and `/safety off|on|max`. It persists local mode and a
  privacy-preserving audit under ignored root runtime files. Only agent `bash`
  tool calls are gated, not user-typed `!` commands.
  `pi-git-status` publishes cwd + Git state and `pi-model-thinking` publishes
  the selected model + thinking level through reserved `setStatus` keys.
  `pi-status-line` owns their shared above-editor row — Git pinned left and
  model/thinking pinned right, with Git truncated first when narrow — plus its
  two-line footer. Git includes repo/branch, worktree name, in-progress operation
  (rebase/merge/cherry-pick/revert/bisect), and conflict/dirty/ahead/behind/stash
  counts only when relevant. The active Void Agent theme grades thinking levels
  from gray (off) through blue and purple to red (max).
  `pi-tool-monitor` tracks tool calls via `tool_execution_start/update/end` and
  publishes plain running-tool text under a reserved status key.
  `pi-status-line` places that activity on footer line 1-left and keeps usage on
  line 2-right. `/tools` opens a full-screen overlay (inset via
  `overlayOptions.margin`) to browse running/recent calls, inspect live output,
  and abort the whole turn with `ctx.abort()` (Pi has no per-tool-call cancel).
  `pi-subagents` provides the separate above-editor subagent tree. Its spawn tool
  requires an LLM-authored display label, persisted across restart/archive, so
  anonymous `adhoc/tmp-*` addresses stay internal. Each working row shows exact
  current-turn tool starts, cumulative session tokens, context fill, and current
  tool; long labels yield to metrics and narrow layouts move metrics to their own
  compact row.
  `pi-procedure` provides the LLM-callable `procedure` tool and `/procedures`
  command for deterministic one-shot-agent orchestration. Its live above-editor
  tree shows queued/running agents, current tools, and provider-visible thinking
  summaries; `Alt+E` expands long trees and `Alt+W` stops the active run.
  `pi-merge` provides `/merge`, a synthesis merge for selected session branches:
  it summarizes the shared base plus branch deltas into a visible custom message
  in a new session, optionally drafts or runs a kickoff prompt, and leaves source
  branches intact.
  `notify-user` (added 2026-07-05 as `user-summary`; renamed 2026-07-06)
  provides the LLM-callable `notify_user` tool: an end-of-turn notice rendered
  as a custom message with optional `title`, `successes`, `info`, `warnings`,
  and `errors` bands, color-banded by `severity` (`success|info|warning|error`,
  inferred when omitted), plus an optional `urgent` immediate toast. There is no
  `summary` field (removed 2026-07-07, no back-compat) and no demo command. The
  bands have top/bottom padding and muted backgrounds.
  `pi-turn-stats` emits one compact single-line TUI info notice after a truly idle
  `agent_settled`: Pi-style uncached input/output counters plus elapsed wall time
  for the full user turn across retries and continuations. Styling comes entirely
  from the active theme (`muted` icons, `text` values, `dim` separators). It does
  not modify the system prompt or messages, generate an outcome summary, add model
  tokens, or emit outside TUI mode.
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
- `configs/pi-agent/packages/void-agent/themes/` supplies the tracked theme
  family; root `settings.json` selects `void-agent-one-dark`.
- Root `keybindings.json` remaps thinking-level cycling to `Alt+T` and forward
  model cycling to `Alt+M`, leaving `Shift+Tab` for `pi-plan`.
- Root `subagents/` contains the production definitions shared by Pi Subagents
  and Pi Teams. Mutable extension settings and all session/runtime state remain
  ignored.
- No global configuration symlink is required. Run `/reload` or restart Pi after
  changing a package, skill, definition, keybinding, or theme.

## Working Style

- If something I ask for is technically wrong or impossible, say so and propose a
  workable approach.
- When delegated review findings are expected in the current response, follow
  `procedures/reviews/delegated-review-results/delegated-review-results.md`: await
  the anchored report, do not claim completion on timeout/cancellation, and put
  verdict/findings before subagent orchestration or cleanup details.
- When giving me app or server URLs in chat, use this machine's LAN IP instead of
  `localhost`, because I often access local services from other devices.
- When giving me an app URL for a project with any kind of login, include working
  demo credentials when available: email, password, and role. Source them from
  the project's seed/demo data or fixtures. If they require a seed step that may
  not have run, say so and offer to run it.
