# Status producer/presenter pattern

Use this pattern when several Pi extensions contribute data to one coordinated
status layout.

## Pattern

1. Give each producer a stable, reserved `setStatus()` key.
2. Publish plain, human-readable text rather than ANSI-styled output.
3. Let one presenter own `setWidget()` / `setFooter()`, fixed or dynamic slot
   selection, alignment, truncation, separators, and theme styling.
4. Filter reserved producer keys out of generic extension-status aggregation so
   they are not rendered twice.
5. Publish on `session_start` and relevant change events; clear on
   `session_shutdown`.
6. Have the presenter install and remove every UI surface it owns during the same
   session lifecycle.

Plain values degrade cleanly if the presenter is disabled, avoid stale ANSI after
theme changes, and keep unrelated producer extensions independent of TUI layout.
When segments must share a physical row, or one segment should move into another's
vacated slot, a single presenter should compose them; separate widgets cannot
reliably coordinate row occupancy.
