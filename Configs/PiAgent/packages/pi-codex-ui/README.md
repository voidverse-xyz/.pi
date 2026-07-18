# pi-codex-ui

A Codex CLI-inspired presentation layer for Pi. It pairs with the global `codex`
theme and leaves Pi's registered tool definitions untouched, preserving configured
shells, safety/sandbox wrappers, mutation previews, diffs, and expansion behavior.

## UI changes

- borderless, full-width `#373739` prompt field with a bold `›` prompt and one outer row of breathing room above and below
- a randomly selected animated indicator per agent run for the built-in working loader (braille, blocks, quadrants, orbit, arrows, and a Claude Code-style blinking star pulse `· ✢ ✳ ✶ ✻ ✽`); the message next to it stays core's default
- one dim, full-width separator after each completed tool row
- transparent tool result backgrounds instead of colored cards
- hidden Pi startup header
- no footer or widget replacement: existing status lines and above/below-editor widget positions stay intact

Tool calls and output use Pi's original renderers, including its normal expansion
keybinding. A presentation-only runtime patch adds a divider to the existing tool-row
component after it renders; it does not replace tool execution or tool definitions.
The patch is restored during session shutdown and reinstalled after reload. The
working/spinner row is not touched here: `pi-todo` renders its own dynamic
header as the first line of its todo widget
(`✻ Fixing sandbox/typedefs… (21m 29s · ↓ 62.3k tokens)`).

## Install

1. Add this package path to Pi's `packages` setting.
2. Set `"theme": "codex"`.
3. Disable `pi-groovebox-cycle` if installed, because it deliberately replaces the
   active theme with an animated Groovebox palette.
4. Run `/reload` or restart Pi.
