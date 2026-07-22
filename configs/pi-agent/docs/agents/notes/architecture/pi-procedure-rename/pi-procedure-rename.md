# Pi procedure rename

## Decision

The orchestration extension and the repository-wide reusable process category now use **procedure** terminology exclusively. This is an intentional clean break: no command aliases, tool aliases, compatibility fields, or storage migration paths remain.

## Public surfaces

- Package: `pi-procedure`
- LLM tool: `procedure`
- Slash command: `/procedures`, including `/procedures <name>` and `/procedures stop`
- Safety event: `procedure:confirm-request`
- Saved scripts: global and project `procedures/` directories
- Settings: `procedures.json`
- Run journals: per-project `procedures/<runId>/` state directories
- Repository artifacts: root `procedures/` and project-local `docs/agents/procedures/`

Internal classes, types, constants, widget keys, entry types, tests, comments, package metadata, instructions, plans, notes, and validation rules use the same terminology.

## Compatibility boundary

Previous command, tool, event, package, path, and identifier names are not accepted. Existing ignored runtime state under the previous storage layout is left untouched and is not discovered by `pi-procedure`.

## Verification

1. Run `node --test "extensions/procedure/**/*.test.ts"` from `configs/pi-agent/packages/pi-procedure/`.
2. Load `extensions/index.ts` with standalone Pi in offline mode.
3. Run `node scripts/validate-global-config.mjs` from the repository root after the renamed paths are tracked.
4. Search all non-runtime repository paths and text case-insensitively for the previous terminology; the result must be empty.
