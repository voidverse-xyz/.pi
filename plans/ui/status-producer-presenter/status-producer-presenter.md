# Status producer/presenter pattern

Use this pattern when several independent extensions or services contribute data to one coordinated status layout.

## Pattern

1. Give each producer a stable reserved status key.
2. Publish plain, human-readable values rather than pre-styled terminal output.
3. Let one presenter own layout: slots, alignment, truncation, separators, theme styling, and responsive behavior.
4. Filter reserved producer keys out of generic status aggregation so they are not rendered twice.
5. Publish on startup and relevant change events; clear on shutdown.
6. Have the presenter install and remove every UI surface it owns during the same lifecycle.

Plain producer values degrade cleanly if the presenter is disabled, avoid stale styling after theme changes, and keep producers independent of layout. When segments must share a physical row, or one segment should move into another's vacated slot, a single presenter should compose them; separate widgets cannot reliably coordinate row occupancy.
