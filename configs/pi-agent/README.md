# Pi Agent Packages

Active package-backed Pi extensions and their project documentation live here.
The repository root—not this directory—is the portable global configuration
cloned to `~/.pi` (or directly to `~/.pi/agent`, where the nested `agent/` shims
are dormant).

- `packages/`: active local Pi packages enabled through relative entries in root
  `settings.json`.
- `docs/`: PiAgent-specific plans, notes, and implementation records.
- `MANIFEST.md`: active package and resource inventory.

Global skills, keybindings, and definitions shared by Pi Subagents and Pi Teams
live at root `skills/`, `keybindings.json`, and `subagents/`; `agent/` exposes
them to Pi when the checkout sits one level above the effective agent dir. Keep
machine-local and sensitive state outside the tracked tree.
