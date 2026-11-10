# pi-status-line

Owns Pi's shared status layout:

- **Above-editor row** — CWD/Git from `pi-git-status` on the left; model and
  thinking level from `pi-model-thinking` on the right. This status row stays
  below content widgets; content widgets emit `status-line:pin-header` on mount
  to request an immediate re-pin. No periodic idle re-pinning is performed, so
  terminal-owned selections are not disturbed by a one-second status refresh.
- **Footer line 1** — Plan mode and tool activity left; context and extension statuses right.
- **Footer line 2** — agent navigation left; session token/cost usage right.

**Alt+N** cycles through available subagents, team agents and Swarm agents in a full-screen chat
view, then back to main. **Escape** returns to main; **PageUp/PageDown** scroll the
focused transcript. The indicator shows `[N]` at main and `[n/N] Name` when focused.
Teams and Subagents route text to the selected agent; image attachments are explicitly unsupported.
Swarm opens a read-only Messages/Agents/Topics view and sends mail through main-agent tools.
Slash and shell commands return to the main editor for normal submission. Native
dialogs clear agent focus, and background main-agent work continues. The producers
remain standalone and coordinate using plain-data events, without package imports.

The producer extensions publish plain values. This extension owns positioning,
ANSI-aware truncation/alignment, producer styling, theme-aware thinking colors,
and footer separators. Reserved producer keys are excluded from the footer's
generic extension segment.

## Segments

Every segment has a stable id used by the config file and the `/status-line`
command. All segments render in fixed slots. `order`
reorders segments within their effective slot and sets narrow-width drop priority.

| id | slot | verbose | compact |
|----|------|---------|---------|
| `plan-mode` | line 1, left | Discuss yellow, Plan green, Quick blue | same |
| `subagents` | line 2, left | available-agent count or focused-agent label | same |
| `context` | line 1, right | hard-drive icon + `NN%` context usage, colored by fullness | `NN%` (icon dropped) |
| `extension-statuses` | line 1, right | every other extension's `setStatus()` text, ` \| `-joined | space-joined |
| `tool-monitor` | line 1, left | running-tool indicator with themed activity band | same |
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

## Verification

`node test/agent-focus.test.mjs` covers the protocol, routing, draft recovery and
lifecycle. From the repository root, `node --import ./tests/register.mjs --test
packages/pi-status-line/test/idle-render.test.mjs` covers idle redraw suppression,
event-driven widget ordering, countdown updates, cleanup, and zero idle writes
through Pi's real terminal renderer. From the repository root,
`python3 packages/pi-status-line/test/focus-terminal.py` exercises
Alt+N/Escape and native-dialog cleanup while a scripted main model is streaming.
It uses disposable offline state and the managed Pi installation, with `PI_SDK_DIR`
and `PI_BIN` overrides. The terminal harness requires POSIX and the repository
Swarm test helpers; it does not send requests to a live provider.

Swarm publishes into the same agent cycle. Its focused view has Messages, Agents
and Topics/Boards tabs; it is read-only and routes control and message requests
through the main agent. Escape returns to main, and native dialogs clear focus.
