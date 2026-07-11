# pi-status-line

A two-line footer for Pi that aggregates every extension's status into one place:

- **Line 1** — `pi-agents` activity on the left; the context-usage gauge plus
  every other extension's `setStatus()` text on the right.
- **Line 2** — tool-monitor's shell/tool-call indicator on the left; session
  token/cost usage (plus trailing 1h) on the right.

This extension owns the separators between right-side segments, so individual
extensions emit bare content.

## Segments

Every segment has a stable id used by the config file and the `/status-line`
command. Each segment renders in a fixed slot (line and side); `order` reorders
segments *within* their slot and sets the drop priority for narrow terminals.

| id | slot | verbose | compact |
|----|------|---------|---------|
| `subagents` | line 1, left | activity from `pi-agents` (pass-through) | same |
| `context` | line 1, right | hard-drive icon + `NN%` context usage, colored by fullness | `NN%` (icon dropped) |
| `extensions` | line 1, right | every other extension's `setStatus()` text, ` \| `-joined | space-joined |
| `tool-monitor` | line 2, left | shell/tool-call indicator (pass-through) | same |
| `tokens` | line 2, right | `↑12k ↓3.4k` session tokens | same |
| `cost` | line 2, right | `$0.123` session cost | `$0.12` |
| `hourly` | line 2, right | `↑/↓ last 1h: 42k` | `1h 42k` |

Default order: `subagents, context, extensions, tool-monitor, tokens, cost, hourly`.

## Configuration — `~/.pi/agent/status-line.json`

```json
{
	"order": ["subagents", "context", "extensions", "tool-monitor", "tokens", "cost", "hourly"],
	"hidden": ["hourly"],
	"mode": "verbose"
}
```

- `order` — segment ids in the order you want them. Ids you leave out append in
  default order; unknown ids are ignored.
- `hidden` — segment ids to never render.
- `mode` — `"verbose"` (default; today's full rendering) or `"compact"`
  (labels dropped, values kept, separators shrunk to a space).

A missing or malformed file (bad JSON, wrong types, unknown ids) silently falls
back to the defaults — the footer never crashes on config.

## Narrow terminals

Below **80 columns** the footer auto-degrades to compact mode regardless of the
configured mode. If a line still doesn't fit, whole segments are dropped from the
**end** of the effective order until everything fits — a segment is never
truncated mid-way into garbage.

## `/status-line` command

- `/status-line` — show the current config: mode, effective order (hidden
  segments annotated), hidden list, and the config file path.
- `/status-line mode <verbose|compact>` — switch mode.
- `/status-line hide <id>` — hide a segment.
- `/status-line show <id>` — un-hide a segment.
- `/status-line reset` — restore all defaults.

Every subcommand persists to the JSON file and refreshes the footer immediately.
Argument completion is aware of state (only hidden segments complete for `show`,
only visible ones for `hide`).

## Install

Enable the `pi-status-line` package in Pi's `packages` setting, then reload with
`/reload`. The extension replaces Pi's built-in footer while active.
