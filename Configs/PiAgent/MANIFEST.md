# Pi Skills & Extensions

Extensions live as packages under `packages/pi-<name>/`, each enabled by listing its
absolute path in `~/.pi/agent/settings.json` → `packages[]` (kept alphabetical). See
"Layout & install" below.

## Skills (1)

| Skill | Path | Description |
|-------|------|-------------|
| plan-commit | `.pi/agent/skills/plan-commit/` | Layered git review and commit workflow |

## Extensions (18)

Alphabetical, matching `settings.json` `packages[]`.

| Extension | Path | Description |
|-----------|------|-------------|
| ask-user | `packages/pi-ask-user/extensions/ask-user/` | LLM-callable `ask_user` tool — ask the user optional/defaulted/validated text, list, number, boolean, datetime, and file questions in a TUI panel; headless subagents forward to the parent via the optional `ipc` extension |
| bookmark | `packages/pi-bookmark/extensions/bookmark/` | Bookmark entries with labels for `/tree` navigation via `setLabel` (`/bookmark`, `/unbookmark`) |
| browse | `packages/pi-browse/extensions/browse/` | `/browse-files` — native two-pane file/dir tree browser; preview files/dirs and add `@file`, `@dir/`, or `@file:12-40` line-range references into the editor (add-to-chat) |
| changes | `packages/pi-changes/extensions/changes/` | `/browse-edits` — native TUI to browse, diff, question, and undo the agent's own file changes this session (git-free) |
| codex-usage | `packages/pi-codex-usage/extensions/codex-usage/` | Codex usage/limits (5h window) polled from the codex app-server, in the footer + an above-editor widget (`/codex-usage`) |
| command-safety | `packages/pi-command-safety/extensions/command-safety/` | Gates agent `bash` by risk category with delayed confirms (`/safety off\|on\|max`); forwards headless-subagent confirms to the parent via the optional `ipc` extension (see its `README.md` to edit categories) |
| confirm-stop-agent | `packages/pi-confirm-stop-agent/extensions/confirm-stop-agent/` | Confirms before actions that would interrupt an in-flight agent run (session switch/fork/tree) |
| dir-git | `packages/pi-dir-git/extensions/dir-git/` | Above-editor status row: home-relative cwd, compact git state, and model/thinking, width-aware |
| ipc | `packages/pi-ipc/extensions/ipc/` | Parent↔subagent IPC transport, exposed to other extensions over `pi.events` (use-if-present, degrade-if-absent) |
| notify-user | `packages/pi-notify-user/extensions/notify-user/` | `notify_user` tool — surface a severity-banded notice (explicit `severity: success\|info\|warning\|error` or inferred; `successes`/`info`/`warnings`/`errors` sections) as a padded block at end of turn; `urgent: true` also pops an immediate toast |
| plan-commit | `packages/pi-plan-commit/extensions/plan-commit/` | `/git-commit` — native TUI for layered git review and staged commits. Opens on the Files list (content pane focused); per file, `v` toggles unified/side-by-side and `t` toggles diff-hunks/full-file; `Ask` picks main-agent vs isolated subagent, then a persistent multi-turn chat panel that stays open until closed |
| session-merge | `packages/pi-session-merge/extensions/session-merge/` | `/session-merge` — synthesize multiple session branches into a new session via a one-off child `pi` process |
| session-name | `packages/pi-session-name/extensions/session-name/` | Name sessions for the session selector via `setSessionName` (`/session-rename`) |
| show-files | `packages/pi-show-files/extensions/show-files/` | LLM-callable `show_files` tool — the agent presents a curated, annotated file set in a full-screen TUI (per-file title/description/group, highlighted line regions with notes, add-to-chat @-mentions, `m` note back to the agent); the tool result reports what the user opened/added/noted. `/show-files` reopens the last presentation |
| status-line | `packages/pi-status-line/extensions/status-line/` | Two-line footer status: subagent chips, context gauge, other extensions' statuses, and token/cost usage |
| steer-queue | `packages/pi-steer-queue/extensions/steer-queue/` | Owns a message typed while the agent is busy — steer, queue, or cancel — via an above-editor widget |
| subagents | `packages/pi-subagents/extensions/subagents/` | Foreground agent switcher (`Alt+A` / `/agents`) re-skins the session's model+tools+prompt in the same thread (active shown on the status line) **plus** LLM-callable `delegate` delegation (single/parallel/chain, isolated `pi` processes) and `ask_parent`. Nesting is depth-capped (`/agents depth`, default 1) and privilege-gated; the switcher is disabled inside subagents. **Session subagent-persistence** (`/agents persistent on\|off`, session-scoped): when on, single-mode delegation to an agent reuses that agent's own persistent child session (linked via `parentSession`) so the same agent remembers its prior work across calls; parallel/chain stay ephemeral |
| subagents-v2 | `packages/pi-subagents-v2/extensions/subagents/` | Persistent subagents with durable memory and mailbox communication: seven LLM-callable `subagent_*` tools (spawn/send/steer/status/collect/interrupt/retire), markdown+frontmatter type definitions (`<project>/.pi/subagents/` overrides `~/.pi/agent/subagents/`), team-scoped peer mail with non-blocking questions, oneshot lifetimes (auto-retire → `.archive/` + N-day GC), escalate-to-human sandbox (writePaths/readOnly/bash-guard; approve-once modal via `alt+e`), autonomy rails with pause-never-kill (`/subagents resume`), and a session-viewer TUI (`/subagents`, `ctrl+j`). Settings: `~/.pi/agent/subagents.json` + `<project>/.pi/subagents.json`; see its `README.md` |
| tool-monitor | `packages/pi-tool-monitor/extensions/tool-monitor/` | Running-tool indicator with a spinner in the footer, plus a `/tools` detail panel |

## Agents

Markdown agent definitions shared by the `subagents` switcher and delegation tool.
They live in the workspace's top-level `Subagents/` directory (the repo convention
for reusable agent definitions), not inside this bundle.
Symlink into place from the workspace root: `ln -sfn "$PWD/Subagents" ~/.pi/agent/agents`.

| Agent | Path | Can call | Model | Tools |
|-------|------|----------|-------|-------|
| scout | `Subagents/scout.md` | — | inherit | read, grep, find, ls, bash (read-only) |
| planner | `Subagents/planner.md` | — | inherit | read, grep, find, ls |
| reviewer | `Subagents/reviewer.md` | — | inherit | read, grep, find, ls, bash (read-only) |
| worker | `Subagents/worker.md` | scout, planner, reviewer | inherit | all |

## Layout & install

Extensions are pi packages, not auto-discovered files. Each `packages/pi-<name>/` has a
`package.json` (`keywords:["pi-package"]`, `pi.extensions:["./extensions"]`, peerDep
`@earendil-works/pi-coding-agent`) and source at `extensions/<name>/index.ts`.

To enable an extension, add its **absolute path** to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/home/john/Agents/Documents/Configs/PiAgent/packages/pi-bookmark",
    "…one entry per package, alphabetical…"
  ]
}
```

Then `/reload` in a running Pi session (or restart it — the `Alt+A` subagent shortcut only
registers on start). Themes and agents are symlinked into Pi's real config
(`~/.pi/agent/themes` → this repo's `.pi/agent/themes`; `~/.pi/agent/agents` → the workspace
`Subagents/`). The `plan-commit` skill under `.pi/agent/skills/` is **not** currently linked in
— to enable it, `ln -sfn "$PWD/.pi/agent/skills" ~/.pi/agent/skills` from the PiAgent root.

`typebox`, `@sinclair/typebox`, and `@earendil-works/pi-{tui,ai,agent-core}` are bundled and
aliased by Pi's extension loader, so importing them needs no local `node_modules`.

## Bundled examples (reference)

~100 example extensions ship with pi-coding-agent at:
`~/.local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
