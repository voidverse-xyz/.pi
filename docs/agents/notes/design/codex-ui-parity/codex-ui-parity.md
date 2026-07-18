# Codex UI parity for Pi

## Reference capture

The local Codex CLI 0.144.1 TUI used these stable presentation details:

- prompt/user surface background: `#373739`
- active prompt marker: bold `›`
- assistant/work marker: dim `•`
- tool/turn divider: dim full-width `─`
- command/code blue: `#89b4fa`
- syntax palette: muted `#9399b2`, red `#eba0ac`, cyan `#94e2d5`, green `#a6e3a1`, text `#cdd6f4`
- footer model/thinking: warm `#f6e2b7`
- footer working directory: green `#abdfa7` (represented by the theme's green token)
- working row: a randomly selected spinner and work label per agent run, elapsed duration in dim gray, run-cumulative output count, and a three-line full-width background animation spanning black through the prompt-field gray `#373739`, with sparse theme-green Matrix character rain layered over it

## Pi implementation

Color tokens live in `Configs/PiAgent/.pi/agent/themes/codex.json`.
Structural presentation lives in `Configs/PiAgent/packages/pi-codex-ui/` because a
Pi JSON theme cannot change editor geometry, tool framing, separators, or headers.
The package deliberately leaves existing status-line extensions and above/below-editor
widgets untouched so their content and positions remain stable.

The extension subclasses `CustomEditor`, preserving Pi's input behavior and app
keybindings while replacing only rendered borders with a full-width Codex-style
background surface. It does not replace or wrap tool definitions. Instead, a
presentation-only runtime patches append a divider after Pi's existing completed tool
rows and repaint the built-in working indicator after it renders. The working-row patch
removes only Pi's render-added trailing spaces before measuring the status text, which
preserves the per-column animation across the remaining runway. Deterministic one-cell
Matrix glyphs animate over the padding rows and the middle-row runway while leaving the
status label unobscured. Configured shells,
safety/sandbox wrappers, mutation queues, previews, diffs, prompt metadata, and tool
expansion therefore remain canonical. The internal component patches are
version-sensitive and are restored during session shutdown; the custom editor, header,
and working indicator are restored there as well.

The extension intentionally does not rewrite assistant or user session messages.
Pi does not expose a renderer hook for its built-in message roles, so exact Codex
assistant bullets and historical-user prompt markers would require a core Pi patch.
