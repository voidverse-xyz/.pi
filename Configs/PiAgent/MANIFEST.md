# Pi Skills & Extensions

Collected from `C:\Users\DenTeach\.pi\agent\` on 2026-07-03.

## Skills (1)

| Skill | Path | Description |
|-------|------|-------------|
| plan-commit | `skills/plan-commit/` | Layered git review and commit workflow |

## Extensions (13)

| Extension | Path | Description |
|-----------|------|-------------|
| status-line | `packages/pi-status-line/extensions/status-line/` | Single footer line — tokens/cost (left); context % + extension statuses (right) |
| plan-commit | `packages/pi-plan-commit/extensions/plan-commit/` | Native TUI for `/plan-commit` layered review |
| confirm-stop-agent | `packages/pi-confirm-stop-agent/extensions/confirm-stop-agent/` | Confirm before interrupting an in-flight agent run |
| codex-usage | `packages/pi-codex-usage/extensions/codex-usage/` | Codex 5h/weekly rate-limit windows in the footer status |
| command-safety | `packages/pi-command-safety/extensions/command-safety/` | Gate agent `bash` by category with countdown confirms; `/safety off\|on\|max` (see its `README.md` to edit categories) |
| dir-git | `packages/pi-dir-git/extensions/dir-git/` | Row above the input: cwd + git (branch, dirty/ahead/behind) + model/thinking |
| ipc | `packages/pi-ipc/extensions/ipc/` | Parent/subagent IPC transport used by headless subagents for TUI-bound requests |
| tool-monitor | `packages/pi-tool-monitor/extensions/tool-monitor/` | Live tool-call indicator in the footer + `/tools` overlay of running/recent calls |
| user-inputs | `packages/pi-user-inputs/extensions/user-inputs/` | `user_inputs` tool: agent asks the user text / pick-one / pick-many questions (with "Something else..." + note) |
| user-summary | `packages/pi-user-summary/extensions/user-summary/` | `user_summary` tool: appends an end-of-turn transcript summary with padded muted summary, info, warning, and error bands |
| session-merge | `packages/pi-session-merge/extensions/session-merge/` | `/merge` command that synthesizes selected session branches into a new merged session without rewriting source history |
| steer-queue | `packages/pi-steer-queue/extensions/steer-queue/` | Queue steering/follow-up messages while an agent turn is running |
| subagents | `packages/pi-subagents/extensions/subagents/` | Agent switcher (`Alt+A` / `/subagent`) re-skins the session's model+tools+prompt in the same thread (active shown on the status line) **plus** LLM-callable `subagent` delegation and `ask_parent`. Nesting is depth-capped (`/subagent depth`, default 1) and privilege-gated; the switcher is disabled inside subagents |

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

## Copy to Desktop

Run from PowerShell:

```powershell
$src = "C:\Projects\imanus\pi-export"
$dest = "C:\Users\DenTeach\Desktop\New folder"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path "$src\*" -Destination $dest -Recurse -Force
```

## Install back to Pi

Copy `skills\`, `extensions\`, and `agents\` into `%USERPROFILE%\.pi\agent\`, then `/reload`.
(On this host they are symlinked: `~/.pi/agent/{extensions,themes,agents}` → this repo.)

## Bundled examples (not included)

~100 example extensions ship with pi-coding-agent at:
`%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\`
