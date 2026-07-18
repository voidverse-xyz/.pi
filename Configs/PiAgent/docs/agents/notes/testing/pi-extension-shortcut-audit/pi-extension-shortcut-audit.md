# Pi extension shortcut audit

## Scope

Audited every production `registerShortcut` call under:

- `Configs/PiAgent/packages/`
- `Configs/PiAgent/packages/_archive/`
- `Configs/Archive/PiAgent/packages/`

The scan excluded dependencies and test-only mock APIs. Constants and imported shortcut values were resolved to concrete keys, modifier order was normalized, and the results were compared with Pi's effective built-in keybindings (including the current user overrides).

## Verdict

- 17 shortcut registrations were found, representing 12 semantic keys.
- The currently configured package set has no built-in or extension-to-extension shortcut conflicts.
- A TUI startup smoke test produced zero `Extension shortcut conflict` diagnostics.
- Four conflict groups would appear if certain archived packages were loaded alongside current packages or one another.
- `pi-plan` remains dependent on the user keybinding override that moves Pi's built-in thinking-cycle action off `shift+tab`.

## Currently configured shortcuts

| Package | Key | Registration | Purpose | Current conflict |
|---|---|---|---|---|
| `pi-teams` | `alt+s` | `Configs/PiAgent/packages/pi-teams/extensions/teams/index.ts:196` | Stop working team agents | None |
| `pi-subagents` | `alt+a` | `Configs/PiAgent/packages/pi-subagents/extensions/subagents/index.ts:166` | Stop working subagents | None |
| `pi-plan` | `shift+tab` | `Configs/PiAgent/packages/pi-plan/extensions/plan/index.ts:322` | Toggle Plan mode | None with the current override |
| `pi-queue` | `alt+x` | `Configs/PiAgent/packages/pi-queue/extensions/queue/index.ts:275` | Cancel newest managed message | None |
| `pi-queue` | `alt+q` | `Configs/PiAgent/packages/pi-queue/extensions/queue/index.ts:284` | Toggle steer/follow-up mode | None |
| `pi-todo` | `alt+o` | `Configs/PiAgent/packages/pi-todo/extensions/todo/index.ts:193` | Cycle expanded/collapsed/hidden | None |
| `pi-workflow` | `alt+w` | `Configs/PiAgent/packages/pi-workflow/extensions/index.ts:142` | Stop active workflow | None |

The other currently configured packages do not call `registerShortcut`.

## Archived co-load conflicts

These archived packages are not currently configured, so they do not produce warnings now.

| Key | Current registration | Archived registration | Result if co-loaded |
|---|---|---|---|
| `alt+a` | `pi-subagents` stop-all at `Configs/PiAgent/packages/pi-subagents/extensions/subagents/index.ts:166` | old subagent switcher at `Configs/Archive/PiAgent/packages/pi-subagents/extensions/subagents/switcher.ts:567` | Duplicate; last-loaded extension wins |
| `alt+x` | `pi-queue` cancel at `Configs/PiAgent/packages/pi-queue/extensions/queue/index.ts:275` | `pi-steer-queue` cancel at `Configs/Archive/PiAgent/packages/pi-steer-queue/extensions/steer-queue/index.ts:253` | Duplicate; last-loaded extension wins |
| `alt+q` | `pi-queue` toggle at `Configs/PiAgent/packages/pi-queue/extensions/queue/index.ts:284` | `pi-steer-queue` toggle at `Configs/Archive/PiAgent/packages/pi-steer-queue/extensions/steer-queue/index.ts:264` | Duplicate; last-loaded extension wins |
| `?` | — | `codex-pi` at `Configs/Archive/PiAgent/packages/codex-pi/src/composer.ts:164`; `claude-look` at `Configs/Archive/PiAgent/packages/claude-look/src/composer.ts:108`; `codex-look` at `Configs/Archive/PiAgent/packages/codex-look/src/composer.ts:164` | The archived look packages conflict with one another if co-loaded |

The three `?` registrations belong to alternative archived UI packages, so the collision is harmless while only one look package is selected.

## Other archived shortcuts

The in-place `pi-agents-v1` archive contains four globally unique shortcuts:

| Key | Registration | Purpose |
|---|---|---|
| `alt+j` | `Configs/PiAgent/packages/_archive/pi-agents-v1/extensions/subagents/index.ts:486` | Open/cycle the session viewer |
| `alt+e` | `Configs/PiAgent/packages/_archive/pi-agents-v1/extensions/subagents/index.ts:504` | Review escalations |
| `alt+ctrl+x` | `Configs/PiAgent/packages/_archive/pi-agents-v1/extensions/subagents/index.ts:517` | Interrupt a warned agent turn |
| `alt+ctrl+i` | `Configs/PiAgent/packages/_archive/pi-agents-v1/extensions/subagents/index.ts:536` | Dismiss a limit warning |

None conflicts with the effective built-in or current extension shortcuts.

## Configuration-dependent risk

Pi defaults `app.thinking.cycle` to `shift+tab`, and that built-in action is reserved against extension overrides. The current user configuration remaps it to `alt+t`, making `shift+tab` available to `pi-plan`. Removing that override would cause Pi to skip the Plan-mode shortcut and emit a built-in conflict warning.

## Ancillary stale reference

`Configs/PiAgent/packages/pi-workflow/extensions/workflow/tui/tree-widget.ts:23` still describes `pi-todo` as using `alt+d`; the live `pi-todo` binding is now `alt+o`. This is documentation-only and does not affect registration.

## Recommendation

No active shortcut change is needed. If an archived package is revived, do not co-load the old and replacement packages without first changing or removing the duplicate shortcut. Preserve the `shift+tab` remap while `pi-plan` owns that key.
