# Pi Agent Packages

Active package-backed Pi extensions and their project documentation live here.
The repository root—not this directory—is the portable global configuration
cloned to `~/.pi/agent`.

- `packages/`: active local Pi packages enabled through relative entries in root
  `settings.json`.
- `docs/`: PiAgent-specific plans, notes, and implementation records.
- `MANIFEST.md`: active package and resource inventory.

Global skills, keybindings, subagent definitions, and team definitions live at
root `skills/`, `keybindings.json`, `subagents/`, and `teams/`. Keep
machine-local and sensitive state outside the tracked tree.
