# Pi Skills & Extensions

Collected from `C:\Users\DenTeach\.pi\agent\` on 2026-07-03.

## Skills (1)

| Skill | Path | Description |
|-------|------|-------------|
| plan-commit | `skills/plan-commit/` | Layered git review and commit workflow |

## Extensions (9)

| Extension | Path | Description |
|-----------|------|-------------|
| status-line | `extensions/status-line/` | Single footer line — tokens/cost (left); context % + extension statuses (right) |
| plan-commit | `extensions/plan-commit/` | Native TUI for `/plan-commit` layered review |
| confirm-stop-agent | `extensions/confirm-stop-agent/` | Confirm before interrupting an in-flight agent run |
| codex-usage | `extensions/codex-usage/` | Codex 5h/weekly rate-limit windows in the footer status |
| command-safety | `extensions/command-safety/` | Gate agent `bash` by category with countdown confirms; `/safety off\|on\|max` (see its `README.md` to edit categories) |
| dir-git | `extensions/dir-git/` | Row above the input: cwd + git (branch, dirty/ahead/behind) + model/thinking |
| tool-monitor | `extensions/tool-monitor/` | Live tool-call indicator in the footer + `/tools` overlay of running/recent calls |
| user-inputs | `extensions/user-inputs/` | `user_inputs` tool: agent asks the user text / pick-one / pick-many questions (with "Something else…" + note) |
| subagents | `extensions/subagents/` | Agent switcher (`Alt+A` / `/subagent`) re-skins the session's model+tools+prompt in the same thread (active shown on the status line) **plus** an LLM-callable `subagent` delegation tool (single/parallel/chain, isolated `pi` processes, result returned to the main agent). Nesting is depth-capped (`/subagent depth`, default 1) and privilege-gated; the switcher is disabled inside subagents |

## Agents

Markdown agent definitions shared by the `subagents` switcher and delegation tool.
They live in the workspace's top-level `Subagents/` directory (the repo convention
for reusable agent definitions), not inside this bundle.
Symlink into place from the workspace root: `ln -sfn "$PWD/Subagents" ~/.pi/agent/agents`.

| Agent | Path | Model | Tools |
|-------|------|-------|-------|
| scout | `Subagents/scout.md` | inherit | read, grep, find, ls, bash (read-only) |
| planner | `Subagents/planner.md` | inherit | read, grep, find, ls |
| reviewer | `Subagents/reviewer.md` | inherit | read, grep, find, ls, bash (read-only) |
| worker | `Subagents/worker.md` | inherit | all |

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
