# Pi Skills & Extensions

Collected from `C:\Users\DenTeach\.pi\agent\` on 2026-07-03.

## Skills (1)

| Skill | Path | Description |
|-------|------|-------------|
| plan-commit | `skills/plan-commit/` | Layered git review and commit workflow |

## Extensions (6)

| Extension | Path | Description |
|-----------|------|-------------|
| status-line | `extensions/status-line/` | Single footer line — tokens/cost (left); context % + extension statuses (right) |
| plan-commit | `extensions/plan-commit/` | Native TUI for `/plan-commit` layered review |
| confirm-stop-agent | `extensions/confirm-stop-agent/` | Confirm before interrupting an in-flight agent run |
| codex-usage | `extensions/codex-usage/` | Codex 5h/weekly rate-limit windows in the footer status |
| command-safety | `extensions/command-safety/` | Gate agent `bash` by category with countdown confirms; `/safety off\|on\|max` |
| dir-git | `extensions/dir-git/` | Row above the input: cwd + git (branch, dirty/ahead/behind) + model/thinking |

## Copy to Desktop

Run from PowerShell:

```powershell
$src = "C:\Projects\imanus\pi-export"
$dest = "C:\Users\DenTeach\Desktop\New folder"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path "$src\*" -Destination $dest -Recurse -Force
```

## Install back to Pi

Copy `skills\` and `extensions\` into `%USERPROFILE%\.pi\agent\`, then `/reload`.

## Bundled examples (not included)

~100 example extensions ship with pi-coding-agent at:
`%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\`
