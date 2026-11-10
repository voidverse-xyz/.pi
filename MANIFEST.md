# Pi configuration manifest

Pi packages live under `packages/<name>/` and are enabled through portable paths in `agent/settings.json`, relative to the effective agent directory. Clone the whole repository to `~/.pi`; the `agent/` resource shims expose its packages and shared resources. MCP uses Pi's built-in support (Pi 0.99.0 or later), not a local package. See the root README's MCP migration instructions before reusing an existing server configuration.

## Enabled extensions

| Package | Main surface |
|---|---|
| `pi-teams` | **Teams** — persistent Pi subagents (`/teams`). Eight `team_*` tools, disk-backed mailboxes, explicit `team_await`, flat peer communication, pi-safety-gated tool calls, and a session-viewer TUI. See `packages/pi-teams/README.md` for usage. |
| `pi-bookmark` | `/bookmark` and `/unbookmark` session-tree labels |
| `pi-browse` | `/browse` native file browser |
| `pi-changes` | `/changes` session edit review/undo and read-only `/git-changes` repository diff browser |
| `pi-clear` | `/clear` alias |
| `pi-sessions` | `/sessions` alias for Pi's native `/resume` session selector |
| `pi-prune` | `/prune` lifecycle-safe session replacement followed by trash-backed cleanup of the previous session file |
| `pi-handoff` | `/handoff [focus]` editable active-branch summary transferred into a fresh, parent-linked session |
| `pi-codex-usage` | Shortest available Codex rate-limit status and all-window `/codex-usage` details |
| `pi-codex-web-search` | LLM-callable `web_search` backed by an isolated ephemeral Codex app-server turn and ChatGPT login |
| `pi-codex-image-generation` | LLM-callable `image_generation` backed by an isolated ephemeral Codex image-generation turn and ChatGPT login |
| `void-agent` | Bundled Void Agent theme family and presentation extension, plus a pre-trust guard that prevents the portable global `.pi` tree from loading again as project config through a bind-mount/path alias and suppresses the resulting misleading warning. Ships palettes `void-agent` (default) plus `void-agent-{gruvbox,tokyo-night,nord,one-dark,catppuccin,kanagawa}` (identical role-map, colors only) — Pi's native picker owns selection/persistence; the default is seeded once on first run, never re-forced. Prompt field, working indicator (random accent spinners incl. blinking star pulse, `label… (elapsed · ↓ tokens)` with run-cumulative counts through Pi's public loader APIs; no background animation or Matrix layer), and tool-turn separators without replacing tool definitions, status lines, or widgets |
| `pi-commit` | `/commit [--dry-run]` grouped Git review, lazy model-generated descriptions, and path-scoped commits |
| `pi-git-status` | CWD and rich Git status producer for the shared status row |
| `pi-merge` | `/merge` current-session branch synthesis |
| `pi-model-thinking` | Model/thinking producer for the shared status row |
| `pi-notify-user` | LLM-callable `notify_user` notices |
| `pi-plan` | Branch-persistent, hard read-only Plan mode with a user-authorized `save_plan` path and no injected planning instructions |
| `pi-questions` | LLM-callable `ask_user` TUI questions with defaults and non-selecting recommendations |
| `pi-queue` | Coalesced, session-persistent busy/compaction messages with wrapped display and editor retrieval |
| `pi-run-guard` | Confirmation before interrupting an active run |
| `pi-turn-stats` | One-line `agent_settled` TUI notice with theme-aware Nerd Font uncached input/output counters and elapsed time for the full user turn; no summary generation, prompt injection, message rewriting, or non-TUI output |
| `pi-safety` | Main-agent Bash confirmation modes and privacy-preserving `/safety-log` |
| `pi-session-name` | Session naming commands |
| `pi-show-files` | LLM-callable `show_files` curated file browser |
| `pi-status-line` | Shared above-editor row plus dynamic two-line footer layout |
| `pi-subagents` | **Subagents** — labeled background fan-out workers (`/subagents`): seven `subagent_*` tools, typed or ad-hoc spawns, persistent or oneshot lifetimes, parallel under a configurable cap, join by `subagent_await` or idle auto-wake. `subagent_spawn` requires an LLM-authored display label, and oneshots require a non-empty initial task; explicit awaits reject unknown assignment anchors. The above-editor tree shows each label plus live tool count, cumulative tokens, context fill, and current tool. Strict hub-and-spoke (no peer mail, no nesting); pi-safety-gated tool calls (`subagents:confirm-request`); narrow-width metric preservation; `alt+a` stop brake; no footer segment. Runs alongside `pi-teams`. See `packages/pi-subagents/README.md` for usage. |
| `pi-swarm` | **Swarm** — main-agent start/status/control/history tools; full configuration proposals and explicit user confirmation in chat, without Swarm confirmation dialogs; existing work preserved by default; optional Plan/Safety, with independent Safety policy retained; guarded native coding tools; external run storage and cross-session restore. The only direct user command is `/swarm stop`; Messages/Agents/Topics remain read-only, while Steer offers worker selection, native Pi transcripts and a bordered message editor. All join Pi agent navigation. Main-agent tools handle lifecycle controls. Runtime baseline: managed Pi 1.0.4/Linux. |
| `pi-timers` | Main-agent-only `manage_timers` tool for up to five in-process recurring wake-ups with unlimited recurrence by default and optional finite run limits, plus a live countdown tree, `Alt+R` cancellation picker, `/timers` status/cancel command, busy-tick coalescing, and shutdown cleanup |
| `pi-todo` | LLM-callable `todo_write` Claude Code-style task list: above-editor checklist widget under a simple always-on `󰝖 Todos · n/m` title (shown working or idle) with bottom padding and active-item truncation windowing, `Alt+O` expand/collapse/hide cycle (the only user control — no slash command), and restore-on-resume |
| `pi-tool-monitor` | Plain active-tool status producer and `/tools` |
| `pi-procedure` | **Procedure** — LLM-callable `procedure` tool running deterministic JS orchestration scripts (`agent`/`parallel`/`pipeline`/`phase`/`log`) over one-shot sandboxed subagents; journal-backed `resumeFromRunId`, saved procedures + `/procedures`, expandable live progress tree (`alt+e`) with provider-visible thinking/tool activity and preserved padding above the shared status row, `alt+w` stop brake, pi-safety gating over `procedure:confirm-request` |

## Theme and keybindings

The active theme is selected by `agent/settings.json` from the bundled themes under `packages/void-agent/themes/`.

Keybindings are stored at root `keybindings.json` and mirrored in `agent/keybindings.json`. `Shift+Tab` is reserved for Plan mode, thinking-level cycling uses `Alt+T`, and forward model cycling uses `Alt+M`.

## Layout and activation

Each package contains `package.json` with the `pi-package` keyword and one or more extension entry points under `extensions/`. Root `.agents/skills/` is Pi's global skill library, and root `.agents/subagents/` is the production type-definition library shared by Pi Subagents and Pi Teams. The `agent/` shims expose those same resources from the effective Pi agent directory without tracking credentials or runtime state. After changing enabled packages or resources, run `/reload` in Pi or restart it.

Only reviewed portable source and configuration belong in the tracked global configuration.
