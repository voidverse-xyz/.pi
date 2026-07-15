# Pi configuration manifest

Pi packages live under `packages/pi-<name>/` and are enabled through absolute paths in `~/.pi/agent/settings.json`.

## Enabled extensions

| Package | Main surface |
|---|---|
| `pi-teams` | **Teams** — persistent Pi subagents (`/teams`), clean-slate rebuild of pi-agents. Eight `team_*` tools, disk-backed mailboxes, explicit `team_await`, flat peer comm, pi-safety-gated tool calls, session-viewer TUI. v1 archived at `packages/_archive/pi-agents-v1/`. See `Configs/Subagent-Docs/` (D1'–D27'). |
| `pi-bookmark` | `/bookmark` and `/unbookmark` session-tree labels |
| `pi-browse` | `/browse-files` native file browser |
| `pi-changes` | `/changes` session edit review/undo and read-only `/git-changes` repository diff browser |
| `pi-clear` | `/clear` alias |
| `pi-codex-usage` | Codex five-hour usage status and `/codex-usage` |
| `pi-codex-ui` | Codex-style theme, prompt field, working indicator, and tool-turn separators without replacing tool definitions, status lines, or widgets |
| `pi-commit` | `/commit [--dry-run]` grouped Git review, lazy model-generated descriptions, and path-scoped commits |
| `pi-git-status` | CWD and rich Git status producer for the shared status row |
| `pi-groovebox-cycle` | `/groovebox-cycle [on\|off]` animated theme colors |
| `pi-merge` | `/merge` current-session branch synthesis |
| `pi-model-thinking` | Model/thinking producer for the shared status row |
| `pi-notify-user` | LLM-callable `notify_user` notices |
| `pi-plan` | Branch-persistent, hard read-only Plan mode with automatic tagged-skill routing, explicit `--skill` override, and a user-authorized `save_plan` path |
| `pi-questions` | LLM-callable `ask_user` TUI questions with defaults and non-selecting recommendations |
| `pi-queue` | Managed, session-persistent steer/follow-up messages with an above-working queue card and `/queue` |
| `pi-run-guard` | Confirmation before interrupting an active run |
| `pi-safety` | Main-agent Bash confirmation modes and privacy-preserving `/safety-log` |
| `pi-session-name` | Session naming commands |
| `pi-show-files` | LLM-callable `show_files` curated file browser |
| `pi-status-line` | Shared above-editor row plus dynamic two-line footer layout |
| `pi-tool-monitor` | Plain active-tool status producer and `/tools` |

## Theme and keybindings

The active theme is `codex`, stored at `.pi/agent/themes/codex.json`. The `pi-groovebox-cycle` package remains installed but is disabled in its local runtime config so it does not replace the selected theme.

Keybindings are stored at `.pi/agent/keybindings.json`. `Shift+Tab` is reserved for Plan mode, thinking-level cycling uses `Alt+T`, and forward model cycling uses `Alt+M`.

## Layout and activation

Each package contains `package.json` with the `pi-package` keyword and one or more extension entry points under `extensions/`. After changing enabled packages, run `/reload` in Pi or restart it.

The older `plan-commit` skill remains under `.pi/agent/skills/plan-commit/` as reference material; it is not linked into the active global skills directory.
