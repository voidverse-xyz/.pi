# Pi configuration manifest

Pi packages live under `packages/<name>/` and are enabled through absolute paths in `~/.pi/agent/settings.json`.

## Enabled extensions

| Package | Main surface |
|---|---|
| `pi-teams` | **Teams** — persistent Pi subagents (`/teams`), clean-slate rebuild of pi-agents. Eight `team_*` tools, disk-backed mailboxes, explicit `team_await`, flat peer comm, pi-safety-gated tool calls, session-viewer TUI. v1 archived at `packages/_archive/pi-agents-v1/`. See `Configs/Subagent-Docs/` (D1'–D27'). |
| `pi-bookmark` | `/bookmark` and `/unbookmark` session-tree labels |
| `pi-browse` | `/browse-files` native file browser |
| `pi-changes` | `/changes` session edit review/undo and read-only `/git-changes` repository diff browser |
| `pi-clear` | `/clear` alias |
| `pi-codex-usage` | Codex five-hour usage status and `/codex-usage` |
| `void-agent` | Bundled Void Agent theme and presentation extension: prompt field, working indicator (random accent spinners incl. blinking star pulse, `label… (elapsed · ↓ tokens)` with run-cumulative counts, three-line full-width black↔prompt-gray background block with theme-green Matrix rain and a random per-run animation: breathe/aurora/comet/shimmer; persistent `/matrix` and `/working-animation` controls), and tool-turn separators without replacing tool definitions, status lines, or widgets |
| `pi-commit` | `/commit [--dry-run]` grouped Git review, lazy model-generated descriptions, and path-scoped commits |
| `pi-git-status` | CWD and rich Git status producer for the shared status row |
| `pi-merge` | `/merge` current-session branch synthesis |
| `pi-model-thinking` | Model/thinking producer for the shared status row |
| `pi-notify-user` | LLM-callable `notify_user` notices |
| `pi-plan` | Branch-persistent, hard read-only Plan mode with automatic tagged-skill routing, explicit `--skill` override, and a user-authorized `save_plan` path |
| `pi-questions` | LLM-callable `ask_user` TUI questions with defaults and non-selecting recommendations |
| `pi-queue` | Managed, session-persistent steer/follow-up messages with an above-working queue card and `/queue` |
| `pi-run-guard` | Confirmation before interrupting an active run |
| `pi-run-summary` | Muted `agent_settled` completion line with elapsed time, per-run `↑`/`↓` usage, and a local final-response outcome summary |
| `pi-safety` | Main-agent Bash confirmation modes and privacy-preserving `/safety-log` |
| `pi-session-name` | Session naming commands |
| `pi-show-files` | LLM-callable `show_files` curated file browser |
| `pi-status-line` | Shared above-editor row plus dynamic two-line footer layout |
| `pi-subagents` | **Subagents** — labeled background fan-out workers (`/subagents`): seven `subagent_*` tools, typed or ad-hoc spawns, persistent or oneshot lifetimes, parallel under a configurable cap, join by `subagent_await` or idle auto-wake. `subagent_spawn` requires an LLM-authored display label; the above-editor tree shows that label plus live tool count, cumulative tokens, context fill, and current tool. Strict hub-and-spoke (no peer mail, no nesting); pi-safety-gated tool calls (`subagents:confirm-request`); narrow-width metric preservation; `alt+a` stop brake; no footer segment. Runs alongside `pi-teams`. Plan: `Plans/PiAgent/pi-subagents/plan.md`. |
| `pi-todo` | LLM-callable `todo_write` Claude Code-style task list: above-editor checklist widget under a simple always-on `󰝖 Todos · n/m` title (shown working or idle) with bottom padding and active-item truncation windowing, `alt+d` expand/collapse/hide cycle (the only user control — no slash command), and restore-on-resume |
| `pi-tool-monitor` | Plain active-tool status producer and `/tools` |
| `pi-workflow` | **Workflow** — LLM-callable `workflow` tool running deterministic JS orchestration scripts (`agent`/`parallel`/`pipeline`/`phase`/`log`) over one-shot sandboxed subagents; journal-backed `resumeFromRunId`, saved workflows + `/workflows`, live progress tree, `alt+w` stop brake, pi-safety gating over `workflow:confirm-request` |

## Theme and keybindings

The active theme is `void-agent`, bundled at `packages/void-agent/themes/void-agent.json`.

Keybindings are stored at `.pi/agent/keybindings.json`. `Shift+Tab` is reserved for Plan mode, thinking-level cycling uses `Alt+T`, and forward model cycling uses `Alt+M`.

## Layout and activation

Each package contains `package.json` with the `pi-package` keyword and one or more extension entry points under `extensions/`. After changing enabled packages, run `/reload` in Pi or restart it.

The older `plan-commit` skill remains under `.pi/agent/skills/plan-commit/` as reference material; it is not linked into the active global skills directory.
