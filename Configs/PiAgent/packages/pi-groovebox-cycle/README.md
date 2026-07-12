# pi-groovebox-cycle

Animates the Groovebox theme by continuously rotating a Gruvbox-inspired gradient
through accent, Markdown, tool-title, syntax, and bash-mode colors. Semantic status
colors, backgrounds, text contrast, diffs, and thinking-level colors remain stable.

## Command

- `/groovebox-cycle` — toggle animation on or off.
- `/groovebox-cycle on` — enable animation.
- `/groovebox-cycle off` — disable animation and restore the theme that was active before cycling.

The toggle persists in `groovebox-cycle.json` under Pi's agent configuration directory.
Animation defaults to on, advances every 250 ms, and completes one cycle every 12 seconds.
