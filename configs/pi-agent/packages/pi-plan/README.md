# pi-plan

Host-managed Discuss, Plan, and Quick modes for Pi. Off remains the normal unrestricted coding agent.

## Modes

| Mode | Response behavior | Main-agent tools |
|---|---|---|
| **Off** | Normal Pi behavior | The exact tool set that was active before entering a restricted mode |
| **Discuss** (`󰍩`) | Normal response length and structure | Quick tools plus trusted `ask_user` and `show_files` |
| **Plan** (``) | Research and save a decision-complete Markdown plan | trusted read/UI/session tools, `save_plan`, and scoped read-only `subagent_*` tools |
| **Quick** (`󱐋`) | Quick chat, normally 1–4 short sentences | trusted built-in `read`, `grep`, `find`, `ls` only |

Quick's length rule is a host-injected prompt rule, not a provider-level token cap. The tool restrictions are host-enforced with both active-tool filtering and a default-deny `tool_call` guard.

## Usage

- `/discuss` — toggle Discuss mode; `/discuss <message>` enables it and sends the message.
- `/plan` — toggle Plan mode.
- `/plan <task>` — enable Plan mode, automatically select the best tagged supplemental Plan skill, and begin planning.
- `/plan --skill <name> <task>` — force one tagged supplemental Plan skill for the task.
- `/quick` — toggle Quick mode; `/quick <message>` enables it and sends the message.
- `/discuss|plan|quick on|off|exit|toggle|status` — explicit mode control.
- `Shift+Tab` — cycle `Off → Discuss → Plan → Quick → Off` while Pi is idle.
- `/skill:plan <task>` — invoke the underlying planning procedure for one task without enabling the host-enforced mode guard or `save_plan`.

Routine mode transitions are silent because the footer already shows the active state. Busy-state warnings, invalid-command errors, fallback warnings, and explicit `status` responses remain visible.

The active mode, explicit Plan skill, authorized Plan path, and Plan-spawned subagent scope are persisted as branch-local session state. Reload, resume, fork, and `/tree` restore state from the active branch; legacy `{ enabled: boolean }` Plan entries migrate to `plan` or `off`. A new session starts Off.

While a restricted mode is active, `pi-plan` publishes its plain mode label under the legacy-compatible `plan-mode` status key. `pi-status-line` renders that dedicated footer segment.

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

The directly cloneable global configuration exposes the repository's root `skills/` directory through Pi's normal global discovery. The extension consumes Pi's loaded skill descriptors instead of hard-coding a repository path or contributing duplicate resources. Adding a future shared template requires only `plan-template: true`; the current tagged templates are `general-planning` and `software-implementation-planning`. Tagged, model-invocable skills from any normal global, project, package, settings, or CLI location become automatic candidates.

## Tool policy

Entering the first restricted mode snapshots the current active tools. Moving between Discuss, Plan, and Quick re-filters from that same snapshot; returning Off restores it exactly, except `save_plan` remains disabled outside Plan.

Every allowed tool must match its expected Pi built-in or local-package provenance, so a colliding custom tool cannot gain access merely by registering an approved name. A default-deny `tool_call` guard remains authoritative if another extension activates a tool after the mode begins.

### Discuss

Discuss enables Quick's read-only tools plus the trusted local `ask_user` and `show_files` tools. It cannot mutate, run shell commands, save plans, or delegate.

### Plan

Plan enables:

- always: `read`, `grep`, `find`, `ls`, `save_plan`;
- when they were active before restriction: `ask_user`, `show_files`, `todo_write`;
- from the trusted local `pi-subagents` package: `subagent_spawn`, `subagent_send`, `subagent_steer`, `subagent_await`, `subagent_cancel`, `subagent_retire`, `subagent_status`.

Plan delegation is narrower than ordinary `pi-subagents` use:

- `subagent_spawn` rejects typed agents, explicit ids, and persistent lifetime;
- every accepted spawn is normalized to a fresh ad-hoc one-shot worker with coding tools exactly `read`, `grep`, `find`, and `ls`;
- the worker address is added to branch-local Plan state only after a successful newly-created spawn result;
- send, steer, cancel, retire, detailed status, and explicit await targets may reference only those Plan-created addresses;
- `subagent_await` requires explicit targets, so it cannot consume unrelated open work;
- teams and procedures remain blocked.

One-shot workers also receive only the subagent runtime's `report` companion tool; they cannot spawn nested agents or message peers.

`todo_write` changes only the session checklist and remains available so Plan mode can track and clear complex planning work without granting project-file mutation. Bash, general mutation tools, teams, procedures, and unknown custom tools remain unavailable to the main agent.

These are agent-tool guards, not an operating-system sandbox. They do not prevent user-entered `!` commands, manually invoked slash commands, subagents that were already running before a restricted mode began, other extension background work, or external processes from changing the workspace. Static symlinks are rejected for plan saving, but a concurrent external filesystem actor can still race path-based Node filesystem operations; use a read-only container or mount when that threat is in scope.

### Quick

Quick enables only Pi's trusted built-in `read`, `grep`, `find`, and `ls`. It cannot mutate, run shell commands, use companion UI tools, or delegate.

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

This global setup reserves `Shift+Tab` for mode cycling by remapping Pi's built-in thinking-cycle action to `Alt+T` in root `keybindings.json`. Without that companion remap, Pi treats `Shift+Tab` as a reserved built-in shortcut and skips the extension shortcut; the slash commands remain available.

## Shared skill

The canonical base skill is root `skills/plan/SKILL.md`. Pi discovers it as a normal global skill when this repository is cloned to `~/.pi/agent`; the package manifest therefore registers only the extension and does not duplicate the skill.

## Tests

```bash
node --test \
  configs/pi-agent/packages/pi-plan/extensions/plan/policy.test.ts \
  configs/pi-agent/packages/pi-plan/extensions/plan/save.test.ts \
  configs/pi-agent/packages/pi-plan/extensions/plan/templates.test.ts
```

An offline RPC `get_commands` smoke test should report `discuss`, `plan`, `quick`, and `skill:plan`, confirming that the package and shared skill load successfully.
