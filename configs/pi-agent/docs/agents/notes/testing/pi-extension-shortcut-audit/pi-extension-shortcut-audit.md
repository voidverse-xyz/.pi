# Pi extension shortcut audit

## Scope

Audited every production `registerShortcut` call under `configs/pi-agent/packages/`.

The scan excluded dependencies and test-only mock APIs. Constants and imported shortcut values were resolved to concrete keys, modifier order was normalized, and the results were compared with Pi's effective built-in keybindings, including root `keybindings.json`.

## Verdict

- 8 active shortcut registrations were found, representing 8 semantic keys.
- The currently configured package set has no built-in or extension-to-extension shortcut conflicts.
- A TUI startup smoke test produced zero `Extension shortcut conflict` diagnostics.
- Archived and superseded packages were removed from the tracked global configuration during the portable-layout migration, so they cannot be accidentally co-loaded from a clean clone.
- `pi-plan` remains dependent on root `keybindings.json` moving Pi's built-in thinking-cycle action off `shift+tab`.

## Currently configured shortcuts

| Package | Key | Registration | Purpose | Current conflict |
|---|---|---|---|---|
| `pi-teams` | `alt+s` | `configs/pi-agent/packages/pi-teams/extensions/teams/index.ts:196` | Stop working team agents | None |
| `pi-subagents` | `alt+a` | `configs/pi-agent/packages/pi-subagents/extensions/subagents/index.ts:166` | Stop working subagents | None |
| `pi-plan` | `shift+tab` | `configs/pi-agent/packages/pi-plan/extensions/plan/index.ts:405` | Toggle Plan mode | None with the current override |
| `pi-queue` | `alt+x` | `configs/pi-agent/packages/pi-queue/extensions/queue/index.ts:278` | Cancel newest managed message | None |
| `pi-queue` | `alt+q` | `configs/pi-agent/packages/pi-queue/extensions/queue/index.ts:287` | Toggle steer/follow-up mode | None |
| `pi-todo` | `alt+o` | `configs/pi-agent/packages/pi-todo/extensions/todo/index.ts:207` | Cycle expanded/collapsed/hidden | None |
| `pi-procedure` | `alt+w` | `configs/pi-agent/packages/pi-procedure/extensions/index.ts:143` | Stop active procedure | None |
| `pi-procedure` | `alt+e` | `configs/pi-agent/packages/pi-procedure/extensions/index.ts:148` | Expand/collapse a truncated procedure tree | None |

The other currently configured packages do not call `registerShortcut`.

## Historical archive note

Earlier audits also catalogued conflicts in superseded packages. Those packages are no longer part of the tracked global configuration; they were preserved only in the ignored local migration quarantine and must receive a fresh shortcut review before any revival.

## Configuration-dependent risk

Pi defaults `app.thinking.cycle` to `shift+tab`, and that built-in action is reserved against extension overrides. The current user configuration remaps it to `alt+t`, making `shift+tab` available to `pi-plan`. Removing that override would cause Pi to skip the Plan-mode shortcut and emit a built-in conflict warning.

## Recommendation

No active shortcut change is needed. Preserve the `shift+tab` remap while `pi-plan` owns that key. If any quarantined package is revived, treat it as new code and audit its shortcuts before activation.
