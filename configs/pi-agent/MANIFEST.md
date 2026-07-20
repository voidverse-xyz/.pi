# Pi configuration manifest

Pi packages live under `packages/<name>/` and are enabled through portable relative paths in repository-root `settings.json` when the repository is cloned to `~/.pi/agent`.

## Enabled extensions

| Package | Main surface |
|---|---|
| `pi-teams` | **Teams** — persistent Pi subagents (`/teams`). Eight `team_*` tools, disk-backed mailboxes, explicit `team_await`, flat peer communication, pi-safety-gated tool calls, and a session-viewer TUI. See `configs/subagent-docs/` (D1'–D27'). |
| `pi-bookmark` | `/bookmark` and `/unbookmark` session-tree labels |
| `pi-browse` | `/browse-files` native file browser |
| `pi-changes` | `/changes` session edit review/undo and read-only `/git-changes` repository diff browser |
| `pi-clear` | `/clear` alias |
| `pi-codex-usage` | Codex five-hour usage status and `/codex-usage` |
| `void-agent` | Bundled Void Agent theme family and presentation extension. Ships palettes `void-agent` (default) plus `void-agent-{gruvbox,tokyo-night,nord,one-dark,catppuccin,kanagawa}` (identical role-map, colors only) — Pi's native picker owns selection/persistence; the default is seeded once on first run, never re-forced. Prompt field, working indicator (random accent spinners incl. blinking star pulse, `label… (elapsed · ↓ tokens)` with run-cumulative counts, three-line full-width black↔prompt-gray background block with theme-green Matrix rain and a random per-run animation: breathe/aurora/comet/shimmer; persistent `/matrix` and `/working-animation` controls), and tool-turn separators without replacing tool definitions, status lines, or widgets |
| `pi-commit` | `/commit [--dry-run]` grouped Git review, lazy model-generated descriptions, and path-scoped commits |
| `pi-git-status` | CWD and rich Git status producer for the shared status row |
| `pi-merge` | `/merge` current-session branch synthesis |
| `pi-model-thinking` | Model/thinking producer for the shared status row |
| `pi-notify-user` | LLM-callable `notify_user` notices |
| `pi-plan` | Branch-persistent, hard read-only Plan mode with automatic tagged-skill routing, explicit `--skill` override, and a user-authorized `save_plan` path |
| `pi-questions` | LLM-callable `ask_user` TUI questions with defaults and non-selecting recommendations |
| `pi-queue` | Managed, session-persistent steer/follow-up messages with an above-working queue card and `/queue` |
| `pi-run-guard` | Confirmation before interrupting an active run |
| `pi-run-summary` | Muted `agent_settled` completion line with Nerd Font input/output/clock icons, per-run usage, elapsed time, and a local final-response outcome summary |
| `pi-safety` | Main-agent Bash confirmation modes and privacy-preserving `/safety-log` |
| `pi-session-name` | Session naming commands |
| `pi-show-files` | LLM-callable `show_files` curated file browser |
| `pi-status-line` | Shared above-editor row plus dynamic two-line footer layout |
| `pi-subagents` | **Subagents** — labeled background fan-out workers (`/subagents`): seven `subagent_*` tools, typed or ad-hoc spawns, persistent or oneshot lifetimes, parallel under a configurable cap, join by `subagent_await` or idle auto-wake. `subagent_spawn` requires an LLM-authored display label; the above-editor tree shows that label plus live tool count, cumulative tokens, context fill, and current tool. Strict hub-and-spoke (no peer mail, no nesting); pi-safety-gated tool calls (`subagents:confirm-request`); narrow-width metric preservation; `alt+a` stop brake; no footer segment. Runs alongside `pi-teams`. Plan: `configs/pi-agent/docs/agents/plans/pi-agent/pi-subagents/pi-subagents.md`. |
| `pi-todo` | LLM-callable `todo_write` Claude Code-style task list: above-editor checklist widget under a simple always-on `󰝖 Todos · n/m` title (shown working or idle) with bottom padding and active-item truncation windowing, `Alt+O` expand/collapse/hide cycle (the only user control — no slash command), and restore-on-resume |
| `pi-tool-monitor` | Plain active-tool status producer and `/tools` |
| `pi-workflow` | **Workflow** — LLM-callable `workflow` tool running deterministic JS orchestration scripts (`agent`/`parallel`/`pipeline`/`phase`/`log`) over one-shot sandboxed subagents; journal-backed `resumeFromRunId`, saved workflows + `/workflows`, expandable live progress tree (`alt+e`) with preserved padding above the shared status row, `alt+w` stop brake, pi-safety gating over `workflow:confirm-request` |

## Theme and keybindings

The active theme is `void-agent-tokyo-night`, bundled at `packages/void-agent/themes/void-agent-tokyo-night.json` and selected by root `settings.json`.

Keybindings are stored at root `keybindings.json`. `Shift+Tab` is reserved for Plan mode, thinking-level cycling uses `Alt+T`, and forward model cycling uses `Alt+M`.

## Layout and activation

Each package contains `package.json` with the `pi-package` keyword and one or more extension entry points under `extensions/`. Root `skills/` is Pi's global skill library, and root `subagents/` plus `teams/` provide production type definitions for their respective runtimes. After changing enabled packages or resources, run `/reload` in Pi or restart it.

Only reviewed portable source and configuration belong in the tracked global configuration.
