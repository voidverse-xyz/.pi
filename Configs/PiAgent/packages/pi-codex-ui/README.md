# pi-codex-ui

A Codex CLI-inspired presentation layer for Pi. It pairs with the global `codex`
theme and leaves Pi's registered tool definitions untouched, preserving configured
shells, safety/sandbox wrappers, mutation previews, diffs, and expansion behavior.

## UI changes

- borderless, full-width `#373739` prompt field with a bold `›` prompt and one outer row of breathing room above and below
- a randomly selected animated spinner (accent-colored, options include a Claude Code-style blinking star pulse `· ✢ ✳ ✶ ✻ ✽`) and capitalized work-related label per agent run, formatted as `Building… (21m 29s · ↓ 62.3k tokens)` — hours-aware elapsed time and run-cumulative output tokens in dim parentheses, the token segment hidden until the first tokens arrive
- the working indicator renders as a three-line full-width animated background block — a tinted padding row above and below, the status text centered on the middle row — spanning the full range from black to the theme's prompt-field gray (`userMessageBg`, falling back to a darkened accent), one style picked at random per agent run with lightly randomized timing: `breathe` (soft pulse), `aurora` (slow drifting wash), `comet` (glow sweeping the empty runway), or `shimmer` (scrolling brightness wave). Sparse theme-green Matrix character rain falls across all three rows over that background without obscuring the status label. Implemented as a presentation-only runtime patch of the built-in `WorkingStatusIndicator` renderer, restored on shutdown; truecolor themes only
- one dim, full-width separator after each completed tool row
- transparent tool result backgrounds instead of colored cards
- hidden Pi startup header
- no footer or widget replacement: existing status lines and above/below-editor widget positions stay intact

Tool calls and output use Pi's original renderers, including its normal expansion
keybinding. A presentation-only runtime patch adds a divider to the existing tool-row
component after it renders; it does not replace tool execution or tool definitions.
The patch is restored during session shutdown and reinstalled after reload.
Working-token counts accumulate across the whole agent run — finalized
assistant messages plus the currently streaming one — using the provider's
exact output usage when available and a chars/4 text-length estimate
otherwise. (`pi-todo` renders its own separate status line — `✻ <LLM-set
phrase>…` — as the first line of its todo widget; that one carries no time or
token stats.)

## Commands

- `/matrix [on|off|status]` independently controls Matrix rain while leaving the animated background block intact.
- `/working-animation [on|off|status]` is the master switch for the three-line background block and Matrix layer. Turning it off restores Pi's standard single-row loader while keeping the custom spinner and status text.

Calling either command without an argument toggles its setting. Both settings persist across reloads and restarts.

## Verify

- Live preview: `node test/preview-working-sweep.mjs`
- Static preview frames: `node test/preview-working-sweep.mjs --frames`
- Runtime renderer regression: `node test/working-background.test.mjs`

## Install

1. Add this package path to Pi's `packages` setting.
2. Set `"theme": "codex"`.
3. Disable `pi-groovebox-cycle` if installed, because it deliberately replaces the
   active theme with an animated Groovebox palette.
4. Run `/reload` or restart Pi.
