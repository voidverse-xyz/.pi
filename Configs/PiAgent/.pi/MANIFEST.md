# Pi Skills & Extensions

Collected from `%USERPROFILE%\.pi\agent\` on 2026-07-03.

## Skills (1)

| Skill | Path | Description |
|-------|------|-------------|
| plan-commit | `skills/plan-commit/` | Layered git review and commit workflow |

## Extensions (4)

| Extension | Path | Description |
|-----------|------|-------------|
| status-line | `extensions/status-line/` | Full status line — tokens, cost, model, context %, git branch, cwd |
| plan-commit | `extensions/plan-commit/` | Native TUI for `/plan-commit` layered review |
| confirm-stop-agent | `extensions/confirm-stop-agent/` | Confirm before interrupting an in-flight agent run |
| cursor | `extensions/cursor/` | Cursor provider (app/CLI login + API keys) |

## Copy to Desktop

Run from PowerShell:

```powershell
$src = "<export-folder>"
$dest = "%USERPROFILE%\Desktop\New folder"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path "$src\*" -Destination $dest -Recurse -Force
```

## Install back to Pi

Copy `skills\` and `extensions\` into `%USERPROFILE%\.pi\agent\`, then `/reload`.

## Bundled examples (not included)

~100 example extensions ship with pi-coding-agent at:
`%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\`
