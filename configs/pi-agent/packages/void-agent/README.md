# void-agent

Void Agent bundles a family of color themes with a UI extension that leaves Pi's
registered tool definitions untouched, preserving configured shells, safety/sandbox
wrappers, mutation previews, diffs, and expansion behavior. It also includes a small
pre-trust guard for the portable global-config layout described below.

## UI changes

- borderless, full-width `#373739` prompt field with a bold `›` prompt and one outer row of breathing room above and below
- a randomly selected animated spinner (accent-colored, options include a Claude Code-style blinking star pulse `· ✢ ✳ ✶ ✻ ✽`) and capitalized work-related label per agent run, formatted as `Building… (21m 29s · ↓ 62.3k tokens)` — hours-aware elapsed time and run-cumulative output tokens in dim parentheses, the token segment hidden until the first tokens arrive
- optional working-indicator animation, disabled by default: when enabled with `/working-animation on`, the status renders as a three-line full-width animated background block — a tinted padding row above and below, the status text centered on the middle row — spanning the full range from black to the theme's prompt-field gray (`userMessageBg`, falling back to a darkened accent), one style picked at random per agent run with lightly randomized timing: `breathe` (soft pulse), `aurora` (slow drifting wash), `comet` (glow sweeping the empty runway), or `shimmer` (scrolling brightness wave). Sparse theme-green Matrix character rain can be enabled separately with `/matrix on` and falls across all three rows over that background without obscuring the status label. Implemented as a presentation-only interception through Pi's root-exported `InteractiveMode`, which decorates each built-in working indicator without resolving private files beside the executable; restored on shutdown, allowlisted for Pi 0.80.10, 0.81.0, 0.81.1, 0.83.0, and 0.84.2, and truecolor themes only
- one dim, full-width separator after each completed tool row
- transparent tool result backgrounds instead of colored cards
- hidden Pi startup header
- no footer or widget replacement: existing status lines and above/below-editor widget positions stay intact

Tool calls and output use Pi's original renderers, including its normal expansion
keybinding. A presentation-only runtime patch adds a divider to the existing tool-row
component after it renders; it does not replace tool execution or tool definitions.
The tool patch uses Pi's root-exported `ToolExecutionComponent`, so npm and
standalone builds patch the same bundled class without a private filesystem
import. Both patches are restored during session shutdown and reinstalled after
reload. The renderer patches are pinned to Pi 0.80.10, 0.81.0, 0.81.1, 0.83.0, and 0.84.2. Working-token counts accumulate across the whole agent run — finalized
assistant messages plus the currently streaming one — using the provider's
exact output usage when available and a chars/4 text-length estimate
otherwise. (`pi-todo` renders its own separate status line — `✻ <LLM-set
phrase>…` — as the first line of its todo widget; that one carries no time or
token stats.)

## Commands

- `/matrix [on|off|status]` independently controls Matrix rain while leaving the animated background block intact.
- `/working-animation [on|off|status]` is the master switch for the three-line background block and Matrix layer. Turning it off restores Pi's standard single-row loader while keeping the custom spinner and status text.

Calling either command without an argument toggles its setting. Both settings default to off and persist across reloads and restarts.

## Themes

The package ships several palettes that all share the exact same role mapping, so the
UI layout and behavior are identical across them — only the colors change:

- `void-agent` (default — Catppuccin Mocha)
- `void-agent-gruvbox`, `void-agent-tokyo-night`, `void-agent-nord`,
  `void-agent-one-dark`, `void-agent-catppuccin` (Macchiato), `void-agent-kanagawa`

Pi discovers these automatically (via the package's `pi.themes` entry) and owns theme
selection: switch between them from Pi's native theme picker, which persists your
choice in `settings.theme`. On the very first run the extension seeds `void-agent`
once (so a fresh install looks "void" immediately) and then never overrides your
selection again. If enabled, the animated working block requires a truecolor theme;
all bundled themes are truecolor.

## Portable config alias guard

When the portable global configuration is mounted into a container and the host home
is also the workspace, the same `.pi` tree can appear once as global config and again
as project config under different pathnames. Pi can otherwise load the package set
twice and report conflicting tool registrations.

The package's global `config-alias-guard` extension compares filesystem identity for
the project `.pi` directory and the global config root during `project_trust`. It
declines project loading only when they are the same entry, preventing the aliased
package set from loading twice. Unrelated projects remain undecided and follow Pi's
normal trust policy. Do not launch the aliased home workspace with `--approve`/`-a`:
Pi applies explicit trust overrides before `project_trust`, so that mode bypasses the
guard and can load the duplicate project package set.

Pi 0.80.10, 0.81.0, and 0.81.1 still render their generic untrusted-project warning after an extension
declines trust. That message is misleading for this alias because the same resources
are already loaded globally. The guard therefore installs a narrowly scoped,
idempotent presentation patch that skips only this alias warning and forwards every
other project to Pi's original warning renderer. The shim is pinned to the verified
Pi version, restores on shutdown, and migrates the older non-restoring patch during
reload; on a version mismatch or missing private renderer it fails open and the
warning remains visible.

## Verify

- Live preview: `node test/preview-working-sweep.mjs`
- Static preview frames: `node test/preview-working-sweep.mjs --frames`
- Working renderer regression: `node test/working-background.test.mjs`
- Tool separator regression: `node test/tool-separator.test.mjs`
- Config-alias trust regression: `node test/config-alias-guard.test.mjs`

## Install

1. Add this package path to Pi's `packages` setting.
2. Run `/reload` or restart Pi. The `void-agent` theme is applied automatically on
   first run; switch palettes anytime from Pi's native theme picker.
