# pi-plan

Host-managed, hard read-only Plan mode for Pi, backed by the shared `plan` skill.

## Usage

- `/plan` — toggle Plan mode.
- `/plan <task>` — enable Plan mode, automatically select the best tagged supplemental Plan skill, and begin planning.
- `/plan --skill <name> <task>` — force one tagged supplemental Plan skill for the task.
- `/plan on|off|exit|toggle|status` — explicit mode control; `status` reports automatic versus forced template selection.
- `Shift+Tab` — toggle Plan mode while Pi is idle.
- `/skill:plan <task>` — invoke the underlying planning workflow for one task without enabling the host-enforced tool guard or `save_plan`.

Plan mode, an explicitly selected Plan skill, and the authorized plan path are persisted as branch-local session state. Reload, resume, fork, and `/tree` restore the state on the active branch; a new session starts with Plan mode off.

## Plan-skill templates

The base `plan` skill always supplies the host-controlled planning and save boundaries. Supplemental skills opt into routing with this top-level frontmatter field:

```yaml
---
name: specialized-planning
plan-template: true
description: Describe precisely which planning tasks should select this template.
---
```

For `/plan <task>`, Plan mode presents up to 20 tagged, model-invocable skill names, descriptions, and paths to the model. Descriptions are capped at Pi's 1024-character skill limit. The model selects at most one matching template and loads its `SKILL.md` with `read`, preserving Pi's bounded progressive-disclosure behavior instead of injecting every template body. If none is relevant, it follows only the base skill. Skills with `disable-model-invocation: true` are excluded from automatic routing.

`/plan --skill <name> <task>` is an explicit user invocation, so it may select a tagged skill with `disable-model-invocation: true`. The command validates that the skill is loaded, tagged, readable, and at most 50 KiB, then injects that template directly on every turn for the current plan. A later automatic `/plan <task>` clears the explicit selection. If a selected template disappears or becomes invalid after reload/resume, the persisted override is cleared and routing falls back to automatic selection.

When a supplemental template defines a mandatory output structure, that structure overrides the base skill's default section layout; the base safety and save boundaries still apply.

The extension contributes only tagged skill directories from the shared `Skills/` tree during Pi resource discovery (up to 100), so adding a future shared template requires only `plan-template: true`; it does not load every unrelated shared skill. The current tagged shared templates are `general-planning` and `software-implementation-planning`. Tagged, model-invocable skills from Pi's other normal global, project, package, settings, or CLI locations also become automatic candidates.

## Tool policy

Plan mode snapshots the current active tools, enables Pi's trusted core read tools, retains trusted companion UI tools that were already active, adds `save_plan`, and restores the snapshot when Plan mode ends:

- always while planning: `read`, `grep`, `find`, `ls`, `save_plan`
- when already active: `ask_user`, `show_files`

A default-deny `tool_call` guard also blocks every other main-agent tool, including tools activated by another extension after Plan mode starts. Allowed tools must match their expected Pi built-in or local package provenance, so a colliding custom tool cannot gain access merely by registering an approved name. Bash, general mutation tools, subagent spawning, and unknown custom tools are therefore unavailable to the main agent.

This is a main-agent guard, not an operating-system sandbox. It does not prevent user-entered `!` commands, manually invoked slash commands, already-running subagents, other extension background work, or external processes from changing the workspace. Static symlinks are rejected, but a concurrent external filesystem actor can still race path-based Node filesystem operations; use a read-only container/mount when that threat is in scope.

## Saving a plan

`save_plan` is the only project-file mutation allowed in Plan mode. The model chooses a project-relative Markdown path from the project's instructions and conventions and asks the user only when those do not determine a path.

Before the first write, Pi asks the user to authorize the exact path. That authorization is bound to both the canonical project root and relative path and remembered on the active session branch; changing projects or paths asks again. An authorized existing plan is atomically replaced with the complete revised document. RPC confirmation has a two-minute timeout; JSON and print modes fail immediately because they have no UI.

The tool fails closed when confirmation UI is unavailable and rejects:

- absolute paths and `..` traversal;
- targets outside the project;
- non-`.md` paths;
- symlink targets or symlinked parent directories;
- non-regular existing targets;
- empty plans and plans larger than 256 KiB.

Writes use Pi's shared per-file mutation queue and an fsynced same-directory temporary file. Existing plans preserve their permission bits and are replaced by rename; new paths use a create-only hard link so a file that appears after authorization is never silently overwritten.

## Shortcut requirement

This local setup reserves `Shift+Tab` for Plan mode by remapping Pi's built-in thinking-cycle action to `Alt+T` in `Configs/PiAgent/.pi/agent/keybindings.json`. Without that companion remap, Pi treats `Shift+Tab` as a reserved built-in shortcut and skips the extension shortcut; `/plan` remains available.

## Shared skill

The package manifest loads the canonical shared skill from `../../../../Skills/plan`, so this local configuration package and the reusable skill keep one source of truth.

## Tests

```bash
node --test \
  Configs/PiAgent/packages/pi-plan/extensions/plan/policy.test.ts \
  Configs/PiAgent/packages/pi-plan/extensions/plan/save.test.ts \
  Configs/PiAgent/packages/pi-plan/extensions/plan/templates.test.ts
```
