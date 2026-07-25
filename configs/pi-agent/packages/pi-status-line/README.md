# pi-status-line

Owns Pi's shared status layout:

- **Above-editor row** — CWD/Git from `pi-git-status` on the left; model and
  thinking level from `pi-model-thinking` on the right. This status row stays
  below content widgets; late-mounted widgets may emit `status-line:pin-header`
  to request an immediate re-pin.
- **Footer line 1** — the active `pi-plan` restricted mode (`󰍩 discuss mode`,
  ` plan mode`, or `󱐋 quick mode`) appears on the left in mode-specific yellow,
  green, or blue, followed by subagent activity when present; otherwise
  tool-monitor moves up into that space.
  Context and other extension statuses stay right.
- **Footer line 2** — tool-monitor moves here when subagent status occupies line 1;
  session token/cost usage (plus trailing 1h) stays right.

The producer extensions publish plain values. This extension owns positioning,
ANSI-aware truncation/alignment, producer styling, theme-aware thinking colors,
and footer separators. Reserved producer keys are excluded from the footer's
generic extension segment.

## Segments

Every segment has a stable id used by the config file and the `/status-line`
command. Most segments render in a fixed slot. Tool-monitor dynamically uses line 1-left
when subagent status is absent and line 2-left when it is present. `order`
reorders segments within their effective slot and sets narrow-width drop priority.

| id | slot | verbose | compact |
|----|------|---------|---------|
| `plan-mode` | line 1, left | Discuss yellow, Plan green, Quick blue | same |
| `subagents` | line 1, left | activity from `pi-agents`, dimmed | same |
| `context` | line 1, right | hard-drive icon + `NN%` context usage, colored by fullness | `NN%` (icon dropped) |
| `extension-statuses` | line 1, right | every other extension's `setStatus()` text, ` \| `-joined | space-joined |
| `tool-monitor` | line 1-left alone; line 2-left with subagents | running-tool indicator with themed activity band | same |
| `tokens` | line 2, right | ` 12k  3.4k` session tokens | same |
| `cost` | line 2, right | `$0.123` session cost | `$0.12` |
| `hourly` | line 2, right | ` last 1h: 42k` | ` 1h 42k` |

Default order: `plan-mode, subagents, context, extension-statuses, tool-monitor, tokens, cost, hourly`.

## Configuration — `~/.pi/agent/status-line.json`

```json
{
	"order": ["plan-mode", "subagents", "context", "extension-statuses", "tool-monitor", "tokens", "cost", "hourly"],
	"hidden": ["hourly"],
	"mode": "verbose"
}
```

- `order` — segment ids in the order you want them. Ids you leave out append in
  default order; unknown ids are ignored.
- `hidden` — segment ids to never render. The legacy `extensions` id is read as
  `extension-statuses` for compatibility.
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
