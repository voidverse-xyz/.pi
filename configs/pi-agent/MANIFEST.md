# Pi configuration manifest

Pi packages live under `packages/<name>/` and are enabled through portable relative paths in root `settings.json` and mirrored `agent/settings.json`. The tracked `agent/` compatibility shims expose the same activation surface from Pi's effective global agent directory when the repository is cloned as `~/.pi`; when cloned directly to `~/.pi/agent`, the root files are active and the nested shims are dormant.

## Enabled extensions

| Package | Main surface |
|---|---|
| `pi-teams` | **Teams** — persistent Pi subagents (`/teams`). Eight `team_*` tools, disk-backed mailboxes, explicit `team_await`, flat peer communication, pi-safety-gated tool calls, and a session-viewer TUI. See `configs/subagent-docs/` (D1'–D27'). |
| `pi-bookmark` | `/bookmark` and `/unbookmark` session-tree labels |
| `pi-browse` | `/browse` native file browser |
| `pi-changes` | `/changes` session edit review/undo and read-only `/git-changes` repository diff browser |
| `pi-clear` | `/clear` alias |
| `pi-sessions` | `/sessions` alias for Pi's native `/resume` session selector |
| `pi-codex-usage` | Shortest available Codex rate-limit status and all-window `/codex-usage` details |
| `pi-codex-web-search` | LLM-callable `web_search` backed by an isolated ephemeral Codex app-server turn and ChatGPT login |
| `pi-mcp-client` | Local stdio MCP client with machine-local multi-server config, namespaced tools, confirmation gates, and progressive discovery |
| `void-agent` | Bundled Void Agent theme family and presentation extension, plus a pre-trust guard that prevents the portable global `.pi` tree from loading again as project config through a bind-mount/path alias and suppresses the resulting misleading warning. Ships palettes `void-agent` (default) plus `void-agent-{gruvbox,tokyo-night,nord,one-dark,catppuccin,kanagawa}` (identical role-map, colors only) — Pi's native picker owns selection/persistence; the default is seeded once on first run, never re-forced. Prompt field, working indicator (random accent spinners incl. blinking star pulse, `label… (elapsed · ↓ tokens)` with run-cumulative counts, three-line full-width black↔prompt-gray background block with theme-green Matrix rain and a random per-run animation: breathe/aurora/comet/shimmer; persistent `/matrix` and `/working-animation` controls), and tool-turn separators without replacing tool definitions, status lines, or widgets |
| `pi-commit` | `/commit [--dry-run]` grouped Git review, lazy model-generated descriptions, and path-scoped commits |
| `pi-git-status` | CWD and rich Git status producer for the shared status row |
| `pi-merge` | `/merge` current-session branch synthesis |
| `pi-model-thinking` | Model/thinking producer for the shared status row |
| `pi-notify-user` | LLM-callable `notify_user` notices |
| `pi-plan` | Branch-persistent, hard read-only Plan mode with automatic tagged-skill routing, explicit `--skill` override, and a user-authorized `save_plan` path |
| `pi-questions` | LLM-callable `ask_user` TUI questions with defaults and non-selecting recommendations |
| `pi-queue` | Coalesced, session-persistent busy/compaction messages with wrapped display and editor retrieval |
| `pi-run-guard` | Confirmation before interrupting an active run |
| `pi-turn-stats` | One-line `agent_settled` TUI notice with theme-aware Nerd Font uncached input/output counters and elapsed time for the full user turn; no summary generation, prompt injection, message rewriting, or non-TUI output |
| `pi-safety` | Main-agent Bash confirmation modes and privacy-preserving `/safety-log` |
| `pi-session-name` | Session naming commands |
| `pi-show-files` | LLM-callable `show_files` curated file browser |
| `pi-status-line` | Shared above-editor row plus dynamic two-line footer layout |
| `pi-subagents` | **Subagents** — labeled background fan-out workers (`/subagents`): seven `subagent_*` tools, typed or ad-hoc spawns, persistent or oneshot lifetimes, parallel under a configurable cap, join by `subagent_await` or idle auto-wake. `subagent_spawn` requires an LLM-authored display label; the above-editor tree shows that label plus live tool count, cumulative tokens, context fill, and current tool. Strict hub-and-spoke (no peer mail, no nesting); pi-safety-gated tool calls (`subagents:confirm-request`); narrow-width metric preservation; `alt+a` stop brake; no footer segment. Runs alongside `pi-teams`. Plan: `configs/pi-agent/docs/agents/plans/pi-agent/pi-subagents/pi-subagents.md`. |
| `pi-timers` | Main-agent-only `manage_timers` tool for up to five in-process recurring wake-ups with unlimited recurrence by default and optional finite run limits, plus a live countdown tree, `Alt+R` cancellation picker, `/timers` status/cancel command, busy-tick coalescing, and shutdown cleanup |
| `pi-todo` | LLM-callable `todo_write` Claude Code-style task list: above-editor checklist widget under a simple always-on `󰝖 Todos · n/m` title (shown working or idle) with bottom padding and active-item truncation windowing, `Alt+O` expand/collapse/hide cycle (the only user control — no slash command), and restore-on-resume |
| `pi-tool-monitor` | Plain active-tool status producer and `/tools` |
| `pi-procedure` | **Procedure** — LLM-callable `procedure` tool running deterministic JS orchestration scripts (`agent`/`parallel`/`pipeline`/`phase`/`log`) over one-shot sandboxed subagents; journal-backed `resumeFromRunId`, saved procedures + `/procedures`, expandable live progress tree (`alt+e`) with provider-visible thinking/tool activity and preserved padding above the shared status row, `alt+w` stop brake, pi-safety gating over `procedure:confirm-request` |

## Theme and keybindings

The active theme is `void-agent-one-dark`, bundled at `packages/void-agent/themes/void-agent-one-dark.json` and selected by root `settings.json` plus `agent/settings.json`.

Keybindings are stored at root `keybindings.json` and mirrored in `agent/keybindings.json`. `Shift+Tab` is reserved for Plan mode, thinking-level cycling uses `Alt+T`, and forward model cycling uses `Alt+M`.

## Layout and activation

Each package contains `package.json` with the `pi-package` keyword and one or more extension entry points under `extensions/`. Root `skills/` is Pi's global skill library, and root `subagents/` is the production type-definition library shared by Pi Subagents and Pi Teams. The `agent/` shims expose those same resources from the effective Pi agent directory without tracking credentials or runtime state. After changing enabled packages or resources, run `/reload` in Pi or restart it.

Only reviewed portable source and configuration belong in the tracked global configuration.
