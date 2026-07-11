# Pi configuration manifest

Pi packages live under `packages/pi-<name>/` and are enabled through absolute paths in `~/.pi/agent/settings.json`.

## Enabled extensions

| Package | Main surface |
|---|---|
| `pi-agents` | Persistent subagents, mailboxes, teams, collection, rails, and `/subagents` |
| `pi-bookmark` | `/bookmark` and `/unbookmark` session-tree labels |
| `pi-browse` | `/browse-files` native file browser |
| `pi-changes` | `/browse-edits` session edit review and undo |
| `pi-clear` | `/clear` alias |
| `pi-codex-usage` | Codex five-hour usage status and `/codex-usage` |
| `pi-commit` | `/commit [--dry-run]` grouped Git review, lazy model-generated descriptions, and path-scoped commits |
| `pi-git-status` | Above-editor CWD/Git/model/thinking row |
| `pi-groovebox-cycle` | `/groovebox-cycle [on\|off]` animated theme colors |
| `pi-merge` | `/merge` current-session branch synthesis |
| `pi-notify-user` | LLM-callable `notify_user` notices |
| `pi-questions` | LLM-callable `ask_user` TUI questions |
| `pi-queue` | Managed, session-persistent steer/follow-up messages with `/queue` |
| `pi-run-guard` | Confirmation before interrupting an active run |
| `pi-safety` | Main-agent Bash confirmation modes and privacy-preserving `/safety-log` |
| `pi-session-name` | Session naming commands |
| `pi-show-files` | LLM-callable `show_files` curated file browser |
| `pi-status-line` | Two-line footer and shared extension statuses |
| `pi-tool-monitor` | Active-tool footer indicator and `/tools` |

## Theme

The active theme is `groovebox`, stored at `.pi/agent/themes/groovebox.json`.

## Layout and activation

Each package contains `package.json` with the `pi-package` keyword and one or more extension entry points under `extensions/`. After changing enabled packages, run `/reload` in Pi or restart it.

The older `plan-commit` skill remains under `.pi/agent/skills/plan-commit/` as reference material; it is not linked into the active global skills directory.
